import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { paidTopup } from "@/lib/billing-topup";
import { createAdminClient } from "@/lib/server/auth";

export const runtime = "nodejs";

async function applySubscription(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  subscription: Stripe.Subscription,
  eventCreated: number,
  fallbackUserId?: string,
) {
  const userId = subscription.metadata.userId ?? fallbackUserId;
  if (!userId) return;
  const item = subscription.items.data[0];
  const interval = item?.price.recurring?.interval;
  if (!item || (interval !== "month" && interval !== "year") || item.price.recurring?.interval_count !== 1) {
    throw new Error("Unsupported subscription billing interval.");
  }
  const ended = ["canceled", "incomplete_expired"].includes(subscription.status);
  const { error } = await admin.rpc("sync_billing_subscription", {
    p_user_id: userId,
    p_plan_id: ended ? "free" : subscription.metadata.planId === "premium" ? "premium" : "free",
    p_customer_id: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    p_subscription_id: subscription.id,
    p_status: ended ? "active" : subscription.status,
    p_interval: ended ? "month" : interval,
    p_period_start: new Date(item.current_period_start * 1000).toISOString(),
    p_period_end: new Date(item.current_period_end * 1000).toISOString(),
    p_event_created: eventCreated,
  });
  if (error) throw new Error("Could not update billing entitlement.");
}

export async function POST(request: NextRequest) {
  const signature = request.headers.get("stripe-signature");
  const secretKey = process.env.BILLING_SECRET_KEY;
  const webhookSecret = process.env.BILLING_WEBHOOK_SECRET;
  const admin = createAdminClient();
  if (!signature || !secretKey || !webhookSecret || !admin) {
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  }

  let event: Stripe.Event | null = null;
  try {
    const stripe = new Stripe(secretKey);
    event = stripe.webhooks.constructEvent(await request.text(), signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
  }
  if (!event) return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
  const verifiedEvent = event;

  const { data: claim, error: claimError } = await admin.rpc("claim_billing_webhook", {
    p_event_id: verifiedEvent.id,
    p_event_type: verifiedEvent.type,
  });
  if (claimError) return NextResponse.json({ error: "Webhook storage is not ready. Apply the billing migration." }, { status: 503 });
  if (claim === "processed") return NextResponse.json({ received: true, duplicate: true });
  if (claim === "busy") {
    return NextResponse.json({ error: "This billing event is already processing. Retry delivery shortly." }, {
      status: 503,
      headers: { "Retry-After": "30" },
    });
  }

  try {
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(verifiedEvent.type)) {
      const session = verifiedEvent.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId ?? session.client_reference_id;
      const planId = session.metadata?.planId;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
      const topup = paidTopup(session);
      if (topup) {
        const { error } = await admin.rpc("apply_billing_topup", topup);
        if (error) throw new Error("Could not apply top-up.");
      }
      if (session.mode === "subscription" && userId && planId && customerId && subscriptionId) {
        const subscription = await new Stripe(secretKey).subscriptions.retrieve(subscriptionId);
        await applySubscription(admin, subscription, verifiedEvent.created, userId);
      }
    } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(verifiedEvent.type)) {
      const eventSubscription = verifiedEvent.data.object as Stripe.Subscription;
      // Re-read current Stripe state rather than replaying stale status from an old delivery.
      const subscription = await new Stripe(secretKey).subscriptions.retrieve(eventSubscription.id);
      await applySubscription(admin, subscription, verifiedEvent.created);
    } else if (["invoice.payment_failed", "invoice.paid"].includes(verifiedEvent.type)) {
      const invoice = verifiedEvent.data.object as Stripe.Invoice;
      const invoiceSubscription = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof invoiceSubscription === "string" ? invoiceSubscription : invoiceSubscription?.id;
      if (subscriptionId) {
        const subscription = await new Stripe(secretKey).subscriptions.retrieve(subscriptionId);
        await applySubscription(admin, subscription, verifiedEvent.created);
      }
    }

    const { error } = await admin.rpc("finish_billing_webhook", { p_event_id: verifiedEvent.id, p_processed: true });
    if (error) throw new Error("Could not finish billing event.");
    return NextResponse.json({ received: true });
  } catch {
    await admin.rpc("finish_billing_webhook", { p_event_id: verifiedEvent.id, p_processed: false });
    return NextResponse.json({ error: "Billing event could not be applied; retry delivery." }, { status: 500 });
  }
}

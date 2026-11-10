import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/server/auth";

export const runtime = "nodejs";

async function applySubscription(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  input: {
    userId: string;
    planId: string;
    customerId: string;
    subscriptionId: string | null;
    status: string;
    periodStart?: number;
    periodEnd?: number;
  },
) {
  const allowedPlans = ["free", "basic", "plus"];
  const planId = allowedPlans.includes(input.planId) ? input.planId : "free";
  const { data: plan, error: planError } = await admin.from("plan_catalog")
    .select("monthly_credits").eq("plan_id", planId).maybeSingle();
  if (planError || !plan) throw new Error("Plan configuration is missing.");

  const { data: current, error: currentError } = await admin.from("user_billing")
    .select("current_period_start, credits_used").eq("user_id", input.userId).maybeSingle();
  if (currentError) throw new Error("Could not read billing entitlement.");
  const periodStart = input.periodStart ? new Date(input.periodStart * 1000).toISOString() : current?.current_period_start;
  const newBillingPeriod = Boolean(input.periodStart && current?.current_period_start && periodStart !== current.current_period_start);

  const { error } = await admin.from("user_billing").upsert({
    user_id: input.userId,
    plan_id: planId,
    subscription_status: input.status,
    included_credits: plan.monthly_credits,
    credits_used: newBillingPeriod ? 0 : current?.credits_used ?? 0,
    stripe_customer_id: input.customerId,
    stripe_subscription_id: input.subscriptionId,
    ...(periodStart ? { current_period_start: periodStart } : {}),
    ...(input.periodEnd ? { current_period_end: new Date(input.periodEnd * 1000).toISOString() } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
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
    if (verifiedEvent.type === "checkout.session.completed") {
      const session = verifiedEvent.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId ?? session.client_reference_id;
      const planId = session.metadata?.planId;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
      if (session.mode === "subscription" && userId && planId && customerId) {
        let subscription: Stripe.Subscription | null = null;
        if (subscriptionId) subscription = await new Stripe(secretKey).subscriptions.retrieve(subscriptionId);
        await applySubscription(admin, {
          userId,
          planId,
          customerId,
          subscriptionId,
          status: subscription?.status ?? "active",
          periodStart: subscription?.items.data[0]?.current_period_start,
          periodEnd: subscription?.items.data[0]?.current_period_end,
        });
      }
    } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(verifiedEvent.type)) {
      const subscription = verifiedEvent.data.object as Stripe.Subscription;
      const userId = subscription.metadata.userId;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      if (userId) {
        const isDeleted = verifiedEvent.type === "customer.subscription.deleted";
        await applySubscription(admin, {
          userId,
          planId: isDeleted ? "free" : subscription.metadata.planId ?? "free",
          customerId,
          subscriptionId: isDeleted ? null : subscription.id,
          status: isDeleted ? "canceled" : subscription.status,
          periodStart: subscription.items.data[0]?.current_period_start,
          periodEnd: subscription.items.data[0]?.current_period_end,
        });
      }
    } else if (verifiedEvent.type === "invoice.payment_failed") {
      const invoice = verifiedEvent.data.object as Stripe.Invoice;
      const invoiceSubscription = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof invoiceSubscription === "string" ? invoiceSubscription : invoiceSubscription?.id;
      if (subscriptionId) {
        const { error } = await admin.from("user_billing").update({ subscription_status: "past_due", updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", subscriptionId);
        if (error) throw new Error("Could not update failed-payment status.");
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

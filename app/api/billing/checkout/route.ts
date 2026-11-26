import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { TOPUP_AMOUNT, TOPUP_CURRENCY, TOPUP_CREDITS } from "@/lib/billing-topup";
import { authenticateRequest } from "@/lib/server/auth";

function appUrl(): string | null {
  const value = process.env.APP_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context || context.user.is_anonymous) return NextResponse.json({ error: "Sign in before choosing a plan." }, { status: 401 });
  if (!context.adminClient) return NextResponse.json({ error: "Billing storage is not configured on the server." }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const isTopup = body.purchase === "topup";
  const credits = TOPUP_CREDITS;
  if (!isTopup && body.planId !== "premium") return NextResponse.json({ error: "Choose Premium to upgrade." }, { status: 400 });
  const planId = "premium";
  const priceId = process.env.BILLING_PREMIUM_PRICE_ID;
  const baseUrl = appUrl();
  const secretKey = process.env.BILLING_SECRET_KEY;
  if ((!isTopup && !priceId) || !baseUrl || !secretKey) {
    return NextResponse.json({ error: "Premium upgrades are not available yet. You can continue using Free." }, { status: 503 });
  }

  try {
    const stripe = new Stripe(secretKey);
    const { data: billing, error: lookupError } = await context.adminClient.from("user_billing")
      .select("stripe_customer_id, stripe_subscription_id, included_credits, credits_used, current_period_end, plan_id, subscription_status").eq("user_id", context.user.id).maybeSingle();
    if (lookupError || !billing) return NextResponse.json({ error: "Billing profile not found." }, { status: 503 });

    if (isTopup) {
      const { data: extras, error: extraError } = await context.adminClient.from("billing_topups").select("credits").eq("user_id", context.user.id).gt("expires_at", new Date().toISOString());
      if (extraError) return NextResponse.json({ error: "Top-up storage is not ready." }, { status: 503 });
      const available = billing.included_credits + (extras ?? []).reduce((sum, row) => sum + row.credits, 0) - billing.credits_used;
      if (available > 0) return NextResponse.json({ error: "You can still chat with your current allowance." }, { status: 409 });
      if (new Date(billing.current_period_end).getTime() <= Date.now() || (billing.plan_id !== "free" && !["active", "trialing"].includes(billing.subscription_status))) {
        return NextResponse.json({ error: "Your allowance is renewing or your subscription needs attention. Please refresh or manage your subscription." }, { status: 409 });
      }
    }
    if (!isTopup && billing.stripe_subscription_id) return NextResponse.json({ error: "You already have a subscription. Use Manage subscription to change it." }, { status: 409 });

    let customerId = billing.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: context.user.email,
        metadata: { userId: context.user.id },
      });
      customerId = customer.id;
      const { error: saveError } = await context.adminClient.from("user_billing")
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq("user_id", context.user.id);
      if (saveError) return NextResponse.json({ error: "Could not initialize billing profile." }, { status: 500 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: isTopup ? "payment" : "subscription",
      customer: customerId,
      ...(isTopup ? { payment_method_types: ["card" as const] } : {}),
      line_items: isTopup ? [{ price_data: { currency: TOPUP_CURRENCY, unit_amount: TOPUP_AMOUNT,
        product_data: { name: "Merune usage top-up", description: "One-time extra usage. Expires at the end of your current billing period." } }, quantity: 1 }] : [{ price: priceId!, quantity: 1 }],
      client_reference_id: context.user.id,
      metadata: isTopup ? { userId: context.user.id, purchase: "topup", credits: String(credits) } : { userId: context.user.id, planId },
      ...(!isTopup ? { subscription_data: { metadata: { userId: context.user.id, planId } } } : {}),
      success_url: `${baseUrl}/?billing=return`,
      cancel_url: `${baseUrl}/?billing=cancelled`,
    }, { idempotencyKey: `checkout-${context.user.id}-${isTopup ? "topup" : planId}-${Date.now()}` });
    return NextResponse.json({ url: session.url });
  } catch {
    return NextResponse.json({ error: "Could not start secure checkout. Try again later." }, { status: 502 });
  }
}

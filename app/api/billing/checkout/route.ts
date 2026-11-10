import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
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
  if (body.planId !== "premium") return NextResponse.json({ error: "Choose Premium to upgrade." }, { status: 400 });
  const planId = "premium";
  const priceId = process.env.BILLING_PREMIUM_PRICE_ID;
  const baseUrl = appUrl();
  const secretKey = process.env.BILLING_SECRET_KEY;
  if (!priceId || !baseUrl || !secretKey) {
    return NextResponse.json({ error: "Premium upgrades are not available yet. You can continue using Free." }, { status: 503 });
  }

  try {
    const stripe = new Stripe(secretKey);
    const { data: billing, error: lookupError } = await context.adminClient.from("user_billing")
      .select("stripe_customer_id, stripe_subscription_id").eq("user_id", context.user.id).maybeSingle();
    if (lookupError || !billing) return NextResponse.json({ error: "Billing profile not found." }, { status: 503 });

    if (billing.stripe_subscription_id) return NextResponse.json({ error: "You already have a subscription. Use Manage subscription to change it." }, { status: 409 });

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
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: context.user.id,
      metadata: { userId: context.user.id, planId },
      subscription_data: { metadata: { userId: context.user.id, planId } },
      success_url: `${baseUrl}/?billing=return`,
      cancel_url: `${baseUrl}/?billing=cancelled`,
    }, { idempotencyKey: `checkout-${context.user.id}-${planId}-${Date.now()}` });
    return NextResponse.json({ url: session.url });
  } catch {
    return NextResponse.json({ error: "Could not start secure checkout. Try again later." }, { status: 502 });
  }
}

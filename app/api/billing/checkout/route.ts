import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { authenticateRequest } from "@/lib/server/auth";

const PRICE_IDS = {
  basic: () => process.env.BILLING_BASIC_PRICE_ID,
  plus: () => process.env.BILLING_PLUS_PRICE_ID,
};

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
  if (!context) return NextResponse.json({ error: "Sign in before choosing a plan." }, { status: 401 });
  if (!context.adminClient) return NextResponse.json({ error: "Billing storage is not configured on the server." }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const planId = body.planId as keyof typeof PRICE_IDS;
  const priceId = PRICE_IDS[planId]?.();
  const baseUrl = appUrl();
  const secretKey = process.env.BILLING_SECRET_KEY;
  if (!priceId || !baseUrl || !secretKey) {
    return NextResponse.json({ error: "Checkout is not configured. Set the plan price ID, BILLING_SECRET_KEY, and APP_URL." }, { status: 503 });
  }

  try {
    const stripe = new Stripe(secretKey);
    const { data: billing, error: lookupError } = await context.adminClient.from("user_billing")
      .select("stripe_customer_id").eq("user_id", context.user.id).maybeSingle();
    if (lookupError || !billing) return NextResponse.json({ error: "Billing profile not found." }, { status: 503 });

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

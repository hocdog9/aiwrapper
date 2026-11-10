import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { authenticateRequest } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  if (!context.adminClient) return NextResponse.json({ error: "Billing storage is not configured on the server." }, { status: 503 });
  const secretKey = process.env.BILLING_SECRET_KEY;
  const baseUrl = process.env.APP_URL;
  if (!secretKey || !baseUrl) return NextResponse.json({ error: "Billing portal is not configured." }, { status: 503 });

  const { data, error } = await context.adminClient.from("user_billing")
    .select("stripe_customer_id").eq("user_id", context.user.id).maybeSingle();
  if (error || !data?.stripe_customer_id) return NextResponse.json({ error: "No billing customer is linked to this account." }, { status: 404 });

  try {
    const stripe = new Stripe(secretKey);
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: new URL("/", baseUrl).toString(),
    });
    return NextResponse.json({ url: session.url });
  } catch {
    return NextResponse.json({ error: "Could not open the billing portal." }, { status: 502 });
  }
}

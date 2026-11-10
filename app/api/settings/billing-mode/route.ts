import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";
import type { BillingMode } from "@/lib/server/credentials";

export async function GET(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const { data, error } = await context.userClient.from("user_billing")
    .select("billing_mode, plan_id, subscription_status, current_period_start, current_period_end, included_credits, credits_used")
    .eq("user_id", context.user.id).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Billing account unavailable. Apply the billing database migration." }, { status: 503 });
  return NextResponse.json({
    billingMode: data.billing_mode,
    planId: data.plan_id,
    subscriptionStatus: data.subscription_status,
    currentPeriodStart: data.current_period_start,
    currentPeriodEnd: data.current_period_end,
    includedCredits: data.included_credits,
    creditsUsed: data.credits_used,
    creditsRemaining: Math.max(0, data.included_credits - data.credits_used),
  });
}

export async function PUT(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const mode = body.mode as BillingMode;
  if (mode !== "managed" && mode !== "byok") return NextResponse.json({ error: "Choose Managed or BYOK mode." }, { status: 400 });
  const { error } = await context.userClient.rpc("set_billing_mode", { p_mode: mode });
  if (error) {
    const message = error.message.includes("BYOK_KEY_MISSING")
      ? "Save and validate at least one provider key before switching to BYOK."
      : "Could not update billing mode. Apply the billing database migration.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ billingMode: mode });
}

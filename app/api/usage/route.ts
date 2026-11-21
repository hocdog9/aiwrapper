import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";

export async function GET(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const { data, error } = await context.userClient.from("user_billing")
    .select("plan_id, billing_mode, subscription_status, current_period_start, current_period_end, included_credits, credits_used, stripe_customer_id")
    .eq("user_id", context.user.id).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Usage account unavailable. Apply the billing database migration." }, { status: 503 });
  const { data: topups, error: topupError } = await context.userClient.from("billing_topups").select("credits")
    .eq("user_id", context.user.id).gt("expires_at", new Date().toISOString());
  const included = data.included_credits + (topups ?? []).reduce((sum, row) => sum + row.credits, 0);
  return NextResponse.json({
    plan: data.plan_id,
    topupAvailable: !topupError && included <= data.credits_used && new Date(data.current_period_end).getTime() > Date.now() &&
      (data.plan_id === "free" || ["active", "trialing"].includes(data.subscription_status)),
    hasBillingAccount: Boolean(data.stripe_customer_id),
    subscriptionStatus: data.subscription_status,
    periodStart: data.current_period_start,
    periodEnd: data.current_period_end,
    includedCredits: included,
    creditsUsed: data.credits_used,
    creditsRemaining: Math.max(0, included - data.credits_used),
  });
}

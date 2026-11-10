import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";

export async function GET(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const { data, error } = await context.userClient.from("user_billing")
    .select("plan_id, billing_mode, subscription_status, current_period_start, current_period_end, included_credits, credits_used")
    .eq("user_id", context.user.id).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Usage account unavailable. Apply the billing database migration." }, { status: 503 });
  return NextResponse.json({
    plan: data.plan_id,
    billingMode: data.billing_mode,
    subscriptionStatus: data.subscription_status,
    periodStart: data.current_period_start,
    periodEnd: data.current_period_end,
    includedCredits: data.included_credits,
    creditsUsed: data.credits_used,
    creditsRemaining: Math.max(0, data.included_credits - data.credits_used),
  });
}

import { defaultModelChoices } from "@/lib/model-defaults";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";
import { getBillingMode } from "@/lib/server/credentials";
import { getModelAllowlist } from "@/lib/server/model-policy";

export async function POST(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const mode = await getBillingMode(context);
    const models = await getModelAllowlist(context, mode);
    const { data: billing } = await context.userClient.from("user_billing").select("plan_id").eq("user_id", context.user.id).maybeSingle();
    return NextResponse.json({ defaults: defaultModelChoices(models ?? {}), useEconomyDefaults: billing?.plan_id === "free", models, loaded: { GPT: true, Gemini: true, Claude: true }, errors: {} });
  } catch {
    return NextResponse.json({ error: "Models are temporarily unavailable. Please try again shortly." }, { status: 503 });
  }
}

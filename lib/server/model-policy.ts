import "server-only";

import type { AuthenticatedContext } from "./auth";
import type { BillingMode } from "./credentials";
import type { ProviderName } from "./model-pricing";

export type ProviderModelAllowlist = Partial<Record<ProviderName, string[]>>;

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  GPT: process.env.OPENAI_MODEL || "gpt-4o-mini",
  Gemini: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  Claude: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
};

export async function getModelAllowlist(
  context: AuthenticatedContext,
  billingMode: BillingMode,
): Promise<ProviderModelAllowlist | null> {
  void billingMode;
  const { data: billing, error: billingError } = await context.userClient
    .from("user_billing").select("plan_id").eq("user_id", context.user.id).maybeSingle();
  if (billingError || !billing) throw new Error("Plan model access is unavailable. Apply the billing database migration.");
  const { data: plan, error: planError } = await context.userClient
    .from("plan_catalog").select("allowed_models").eq("plan_id", billing.plan_id).maybeSingle();
  if (planError) throw new Error("Plan model access is unavailable. Apply the billing database migration.");

  const configured = (plan?.allowed_models && typeof plan.allowed_models === "object" ? plan.allowed_models : {}) as ProviderModelAllowlist;
  const providers: ProviderName[] = ["GPT", "Gemini", "Claude"];
  return Object.fromEntries(providers.map((provider) => {
    const planModels = configured[provider]?.filter((model) => typeof model === "string" && model.length <= 160) ?? [];
    return [provider, planModels.length ? planModels : [DEFAULT_MODELS[provider]]];
  })) as ProviderModelAllowlist;
}

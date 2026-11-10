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

const ALTERNATIVES: Record<ProviderName, string[]> = {
  GPT: ["gpt-4.1-mini"],
  Gemini: ["gemini-3.7-flash", "gemini-3.5-flash-lite"],
  Claude: ["claude-haiku-4-5"],
};
const MODEL_LIST_ENV: Record<ProviderName, string> = {
  GPT: "OPENAI_ALLOWED_MODELS", Gemini: "GEMINI_ALLOWED_MODELS", Claude: "ANTHROPIC_ALLOWED_MODELS",
};

export function resolveModelChoices(configured: unknown): Record<ProviderName, string[]> {
  const settings = configured && typeof configured === "object" ? configured as Record<string, unknown> : {};
  return Object.fromEntries((["GPT", "Gemini", "Claude"] as ProviderName[]).map((provider) => {
    const planValue = settings[provider];
    if (planValue !== undefined && !Array.isArray(planValue)) throw new Error("Invalid plan model configuration.");
    const planModels = Array.isArray(planValue) ? planValue : [];
    const environment = process.env[MODEL_LIST_ENV[provider]];
    const candidates = planModels.length ? planModels : environment?.trim()
      ? environment.split(",") : [DEFAULT_MODELS[provider], ...ALTERNATIVES[provider]];
    const models = [...new Set(candidates.filter((model): model is string => typeof model === "string")
      .map((model) => model.trim()).filter((model) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model)))];
    if (!models.length) throw new Error("No valid models configured for this provider.");
    return [provider, models];
  })) as Record<ProviderName, string[]>;
}

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

  return resolveModelChoices(plan?.allowed_models);
}

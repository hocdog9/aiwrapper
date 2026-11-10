import "server-only";

import type { AuthenticatedContext } from "./auth";
import type { ProviderName } from "./model-pricing";

export type BillingMode = "managed";
export type ProviderCredential = { apiKey: string; billingMode: BillingMode };

const ENV_KEYS: Record<ProviderName, string> = {
  GPT: "OPENAI_API_KEY",
  Gemini: "GEMINI_API_KEY",
  Claude: "ANTHROPIC_API_KEY",
};

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

export async function getBillingMode(context: AuthenticatedContext): Promise<BillingMode> {
  const { data, error } = await context.userClient
    .from("user_billing")
    .select("billing_mode")
    .eq("user_id", context.user.id)
    .maybeSingle();
  if (error) throw new Error("Billing settings are unavailable. Apply the billing database migration.");
  if (data?.billing_mode !== "managed") throw new Error("Apply the Free and Premium database migration before serving requests.");
  return "managed";
}

export async function resolveProviderCredential(
  context: AuthenticatedContext,
  provider: ProviderName,
  billingMode: BillingMode,
): Promise<ProviderCredential> {
  void context;
  const apiKey = process.env[ENV_KEYS[provider]];
  if (!apiKey) throw new CredentialResolutionError(`${provider} is temporarily unavailable. Please try again later.`);
  return { apiKey, billingMode };
}

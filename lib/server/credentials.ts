import "server-only";

import type { AuthenticatedContext } from "./auth";
import { decryptSecret, type SecretEnvelope } from "./secret-box";
import type { ProviderName } from "./model-pricing";

export type BillingMode = "managed" | "byok";
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
  return data?.billing_mode === "byok" ? "byok" : "managed";
}

export async function resolveProviderCredential(
  context: AuthenticatedContext,
  provider: ProviderName,
  billingMode: BillingMode,
): Promise<ProviderCredential> {
  if (billingMode === "managed") {
    const apiKey = process.env[ENV_KEYS[provider]];
    if (!apiKey) throw new CredentialResolutionError(`${provider} is not configured for Managed mode. Add the server-side provider secret or switch to BYOK.`);
    return { apiKey, billingMode };
  }

  if (!context.adminClient) {
    throw new CredentialResolutionError("BYOK storage is not configured. Set SUPABASE_SERVICE_ROLE_KEY on the server.");
  }
  const { data, error } = await context.adminClient
    .from("user_provider_credentials")
    .select("encrypted_secret, encryption_metadata")
    .eq("user_id", context.user.id)
    .eq("provider", provider)
    .maybeSingle();
  if (error || !data) {
    throw new CredentialResolutionError(`${provider} key is not saved for BYOK. Add it in Settings or switch to Managed mode.`);
  }

  try {
    return {
      apiKey: decryptSecret(data.encrypted_secret, data.encryption_metadata as SecretEnvelope["metadata"]),
      billingMode,
    };
  } catch {
    throw new CredentialResolutionError(`${provider} key could not be decrypted. Replace it in Settings.`);
  }
}

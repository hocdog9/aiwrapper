import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";
import { getBillingMode, resolveProviderCredential } from "@/lib/server/credentials";
import { listTextModels } from "@/lib/server/providers";
import { safeProviderError } from "@/lib/server/providers";
import type { ProviderName } from "@/lib/server/model-pricing";
import { getModelAllowlist } from "@/lib/server/model-policy";

type ModelDiscovery = Record<ProviderName, boolean>;

export async function POST(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const models: Record<ProviderName, string[]> = { GPT: [], Gemini: [], Claude: [] };
  const loaded: ModelDiscovery = { GPT: false, Gemini: false, Claude: false };
  const errors: Partial<Record<ProviderName, string>> = {};
  const billingMode = await getBillingMode(context);
  const allowlist = await getModelAllowlist(context, billingMode);
  await Promise.all(((["GPT", "Gemini", "Claude"] as ProviderName[]).map(async (provider) => {
    try {
      const credential = await resolveProviderCredential(context, provider, billingMode);
      const available = await listTextModels(provider, credential.apiKey);
      models[provider] = allowlist ? available.filter((model) => allowlist[provider]?.includes(model)) : available;
      loaded[provider] = true;
    } catch (error) {
      errors[provider] = error instanceof Error && error.name === "CredentialResolutionError"
        ? error.message
        : safeProviderError(error);
    }
  })));

  return NextResponse.json({ models, loaded, errors, billingMode });
}
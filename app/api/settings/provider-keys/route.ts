import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/server/auth";
import { encryptSecret, maskSecret } from "@/lib/server/secret-box";
import { listTextModels } from "@/lib/server/providers";
import type { ProviderName } from "@/lib/server/model-pricing";

const PROVIDERS: ProviderName[] = ["GPT", "Gemini", "Claude"];

export async function GET(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  if (!context.adminClient) return NextResponse.json({ error: "BYOK storage is not configured on the server." }, { status: 503 });

  const { data, error } = await context.adminClient
    .from("user_provider_credentials")
    .select("provider, masked_suffix, last_validated_at")
    .eq("user_id", context.user.id);
  if (error) return NextResponse.json({ error: "Could not load saved provider keys." }, { status: 500 });

  const credentials = Object.fromEntries(PROVIDERS.map((provider) => {
    const record = data?.find((item) => item.provider === provider);
    return [provider, record ? { configured: true, masked: `••••${record.masked_suffix}`, validatedAt: record.last_validated_at } : { configured: false, masked: null, validatedAt: null }];
  }));
  return NextResponse.json({ credentials });
}

export async function PUT(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  if (!context.adminClient) return NextResponse.json({ error: "BYOK storage is not configured on the server." }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const provider = body.provider as ProviderName;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!PROVIDERS.includes(provider) || key.length < 12 || key.length > 4096) {
    return NextResponse.json({ error: "Enter a valid provider and API key." }, { status: 400 });
  }

  try {
    const models = await listTextModels(provider, key);
    if (!models.length) return NextResponse.json({ error: `${provider} did not return any available text models for this key.` }, { status: 400 });
    const encrypted = encryptSecret(key);
    const { error } = await context.adminClient.from("user_provider_credentials").upsert({
      user_id: context.user.id,
      provider,
      encrypted_secret: encrypted.ciphertext,
      encryption_metadata: encrypted.metadata,
      masked_suffix: key.slice(-4),
      last_validated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,provider" });
    if (error) return NextResponse.json({ error: "The key validated but could not be saved securely." }, { status: 500 });
    return NextResponse.json({ provider, masked: `••••${maskSecret(key)}`, validated: true });
  } catch {
    return NextResponse.json({ error: `${provider} rejected this key or could not list its models. Check the key and provider access.` }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const context = await authenticateRequest(request);
  if (!context) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  if (!context.adminClient) return NextResponse.json({ error: "BYOK storage is not configured on the server." }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const provider = body.provider as ProviderName;
  if (!PROVIDERS.includes(provider)) return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  const { error } = await context.adminClient.from("user_provider_credentials").delete()
    .eq("user_id", context.user.id).eq("provider", provider);
  if (error) return NextResponse.json({ error: "Could not delete the saved key." }, { status: 500 });
  return NextResponse.json({ provider, deleted: true });
}

import "server-only";
import type { ProviderName } from "./model-pricing";

export function providerErrorDetails(error: unknown) {
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  let message = typeof candidate?.message === "string" ? candidate.message : "Unknown provider error";
  let status = candidate?.status ?? candidate?.statusCode;
  // Google's SDK may place its structured API error inside Error.message.
  try {
    const parsed = JSON.parse(message);
    const upstream = parsed?.error ?? parsed;
    if (typeof upstream?.message === "string") message = upstream.message;
    status ??= upstream?.code;
  } catch { /* Plain-text SDK errors need no decoding. */ }
  for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  message = message
    .replace(/AIza[\w-]+/g, "[REDACTED]")
    .replace(/\bsk-[\w-]+/g, "[REDACTED]")
    .replace(/([?&](?:key|api_key|token)=)[^\s&#"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1500);
  return { status: typeof status === "number" ? status : null, message };
}

export function logProviderError(error: unknown, context: {
  provider: ProviderName; model: string; requestId: string; callKind: "response" | "synthesis";
}) {
  console.error("provider_call_failed", { ...context, ...providerErrorDetails(error) });
}

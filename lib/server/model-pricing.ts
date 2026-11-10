import "server-only";

export type ProviderName = "GPT" | "Gemini" | "Claude";
export type ProviderPrice = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachedInputMicrosPerMillion?: number;
};
export type ModelPricing = Partial<Record<ProviderName, Record<string, ProviderPrice>>>;

export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

function modelPricing(): ModelPricing {
  const raw = process.env.MODEL_PRICING_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ModelPricing;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function estimateProviderCostMicros(provider: ProviderName, model: string, usage: TokenUsage): string | null {
  const rates = modelPricing()[provider]?.[model];
  if (!rates || usage.inputTokens === null || usage.outputTokens === null) return null;
  if (!Number.isSafeInteger(rates.inputMicrosPerMillion) || rates.inputMicrosPerMillion < 0
    || !Number.isSafeInteger(rates.outputMicrosPerMillion) || rates.outputMicrosPerMillion < 0) return null;

  const cachedTokens = usage.cachedInputTokens ?? 0;
  if (cachedTokens > 0 && (!Number.isSafeInteger(rates.cachedInputMicrosPerMillion)
    || rates.cachedInputMicrosPerMillion! < 0)) return null;
  const regularInputTokens = Math.max(0, usage.inputTokens - cachedTokens);
  const totalMicros = BigInt(regularInputTokens) * BigInt(rates.inputMicrosPerMillion)
    + BigInt(cachedTokens) * BigInt(rates.cachedInputMicrosPerMillion ?? 0)
    + BigInt(usage.outputTokens) * BigInt(rates.outputMicrosPerMillion);
  return ((totalMicros + BigInt("500000")) / BigInt("1000000")).toString();
}

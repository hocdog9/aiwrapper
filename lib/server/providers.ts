import "server-only";

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { GoogleGenAI } from "@google/genai";
import type { ProviderName } from "./model-pricing";

export type ImageAttachment = { dataUrl: string; mimeType: string };
export type ProviderResult = {
  provider: ProviderName;
  model: string;
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null };
  latencyMs: number;
  providerRequestId: string | null;
};

const TIMEOUT_MS = 45_000;
const NON_TEXT_MODEL_TERMS = ["embedding", "moderation", "whisper", "tts", "transcribe", "realtime", "image", "audio"];

export function safeProviderError(error: unknown): string {
  const candidate = error as { status?: number; statusCode?: number; name?: string } | null;
  const status = candidate?.status ?? candidate?.statusCode;
  if (status === 401 || status === 403) return "The provider rejected this credential. Check or replace the configured key.";
  if (status === 404) return "The selected model is unavailable to this provider account. Choose another model in Settings.";
  if (status === 429) return "The provider rate limit or account quota was reached. Try again later or check provider billing.";
  if (candidate?.name === "AbortError" || candidate?.name === "TimeoutError") return "The provider request timed out. Try again.";
  return "The provider could not complete this request. Try again or check the provider status.";
}

export async function invokeProvider(input: {
  provider: ProviderName;
  apiKey: string;
  model: string;
  prompt: string;
  images?: ImageAttachment[];
}): Promise<ProviderResult> {
  const start = Date.now();
  const images = input.images ?? [];
  if (input.provider === "GPT") {
    const client = new OpenAI({ apiKey: input.apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
    const response = await client.responses.create({
      model: input.model,
      max_output_tokens: 1024,
      input: images.length
        ? [{ role: "user", content: [{ type: "input_text", text: input.prompt }, ...images.map((image) => ({ type: "input_image" as const, image_url: image.dataUrl, detail: "low" as const }))] }]
        : input.prompt,
      temperature: 0.4,
    });
    return {
      provider: input.provider, model: input.model, text: response.output_text || "",
      usage: { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null, cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? null },
      latencyMs: Date.now() - start, providerRequestId: response.id ?? null,
    };
  }

  if (input.provider === "Gemini") {
    const client = new GoogleGenAI({ apiKey: input.apiKey, httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    const response = await client.models.generateContent({
      model: input.model,
      contents: [{ role: "user", parts: [{ text: input.prompt }, ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.dataUrl.split(",")[1] } }))] }],
      config: { maxOutputTokens: 1024, temperature: 0.4 },
    });
    return {
      provider: input.provider, model: input.model, text: response.text || "",
      usage: { inputTokens: response.usageMetadata?.promptTokenCount ?? null, outputTokens: response.usageMetadata?.candidatesTokenCount ?? null, cachedInputTokens: response.usageMetadata?.cachedContentTokenCount ?? null },
      latencyMs: Date.now() - start, providerRequestId: response.responseId ?? null,
    };
  }

  const client = new Anthropic({ apiKey: input.apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  const supportedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
  const anthropicImages: ImageBlockParam[] = images.map((image): ImageBlockParam => {
      if (!supportedImageTypes.includes(image.mimeType as typeof supportedImageTypes[number])) {
        throw new Error("Unsupported image type for Claude.");
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType as typeof supportedImageTypes[number],
          data: image.dataUrl.split(",")[1],
        },
      };
  });
  const anthropicContent: ContentBlockParam[] = [...anthropicImages, { type: "text", text: input.prompt }];
  const response = await client.messages.create({
    model: input.model,
    max_tokens: 1024,
    stream: false,
    messages: [{ role: "user", content: anthropicContent }],
  });
  return {
    provider: input.provider,
    model: input.model,
    text: response.content.map((block) => ("text" in block ? block.text : "")).join("\n").trim(),
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cachedInputTokens: response.usage.cache_read_input_tokens ?? null },
    latencyMs: Date.now() - start, providerRequestId: response.id ?? null,
  };
}

export async function listTextModels(provider: ProviderName, apiKey: string): Promise<string[]> {
  const models: string[] = [];
  if (provider === "GPT") {
    const client = new OpenAI({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
    for await (const model of client.models.list()) {
      if (/^(gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(model.id) && !NON_TEXT_MODEL_TERMS.some((term) => model.id.toLowerCase().includes(term))) models.push(model.id);
    }
  } else if (provider === "Gemini") {
    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    for await (const model of await client.models.list()) {
      const modelId = model.name?.replace(/^models\//, "");
      if (modelId && !/^gemini-2\.5-/i.test(modelId) && model.supportedActions?.includes("generateContent")) models.push(modelId);
    }
  } else {
    const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
    for await (const model of client.models.list()) {
      if (model.id.startsWith("claude-") && !NON_TEXT_MODEL_TERMS.some((term) => model.id.toLowerCase().includes(term))) models.push(model.id);
    }
  }
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

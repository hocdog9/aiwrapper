import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

type ProviderName = "GPT" | "Gemini" | "Claude";
type ProviderSettings = { apiKey?: string };
type RequestSettings = Partial<Record<ProviderName, ProviderSettings>>;
type ModelDiscovery = Record<ProviderName, boolean>;

const nonTextModelTerms = [
  "embedding",
  "moderation",
  "whisper",
  "tts",
  "transcribe",
  "realtime",
  "image",
  "audio",
];

function isTextModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return !nonTextModelTerms.some((term) => normalized.includes(term));
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const settings = (body.settings && typeof body.settings === "object" ? body.settings : {}) as RequestSettings;
  const models: Record<ProviderName, string[]> = { GPT: [], Gemini: [], Claude: [] };
  const loaded: ModelDiscovery = { GPT: false, Gemini: false, Claude: false };
  const errors: Partial<Record<ProviderName, string>> = {};

  const apiKeys = {
    GPT: settings.GPT?.apiKey?.trim() || process.env.OPENAI_API_KEY,
    Gemini: settings.Gemini?.apiKey?.trim() || process.env.GEMINI_API_KEY,
    Claude: settings.Claude?.apiKey?.trim() || process.env.ANTHROPIC_API_KEY,
  };

  await Promise.all([
    (async () => {
      if (!apiKeys.GPT) return;
      try {
        const client = new OpenAI({ apiKey: apiKeys.GPT });
        for await (const model of client.models.list()) {
          if (/^(gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(model.id) && isTextModel(model.id)) {
            models.GPT.push(model.id);
          }
        }
        models.GPT.sort((left, right) => left.localeCompare(right));
        loaded.GPT = true;
      } catch (error) {
        errors.GPT = error instanceof Error ? error.message : "Unable to list GPT models.";
      }
    })(),
    (async () => {
      if (!apiKeys.Gemini) return;
      try {
        const client = new GoogleGenAI({ apiKey: apiKeys.Gemini });
        for await (const model of await client.models.list()) {
          const modelId = model.name?.replace(/^models\//, "");
          if (modelId && !/^gemini-2\.5-/i.test(modelId) && model.supportedActions?.includes("generateContent")) {
            models.Gemini.push(modelId);
          }
        }
        models.Gemini.sort((left, right) => left.localeCompare(right));
        loaded.Gemini = true;
      } catch (error) {
        errors.Gemini = error instanceof Error ? error.message : "Unable to list Gemini models.";
      }
    })(),
    (async () => {
      if (!apiKeys.Claude) return;
      try {
        const client = new Anthropic({ apiKey: apiKeys.Claude });
        for await (const model of client.models.list()) {
          if (model.id.startsWith("claude-") && isTextModel(model.id)) {
            models.Claude.push(model.id);
          }
        }
        models.Claude.sort((left, right) => left.localeCompare(right));
        loaded.Claude = true;
      } catch (error) {
        errors.Claude = error instanceof Error ? error.message : "Unable to list Claude models.";
      }
    })(),
  ]);

  return NextResponse.json({ models, loaded, errors });
}
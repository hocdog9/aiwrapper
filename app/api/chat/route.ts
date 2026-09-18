import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { buildConsensusClaims } from "@/lib/consensus";

const MAX_MESSAGES = 12;
const MAX_TEXT_LENGTH = 2200;

type ImageAttachment = {
  dataUrl: string;
  mimeType: string;
};

type ChatMessage = {
  role: string;
  content: string;
  image?: ImageAttachment;
  images?: ImageAttachment[];
};

type RequestSettings = Partial<Record<"GPT" | "Gemini" | "Claude", { enabled?: boolean; apiKey?: string; model?: string }>>;

function sanitizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

function buildPrompt(messages: ChatMessage[]): string {
  const recent = messages.slice(-MAX_MESSAGES).map((message) => `${message.role}: ${sanitizeText(message.content)}${(message.images?.length || message.image) ? "\n[Image attached]" : ""}`).join("\n\n");
  return `You are answering as a careful analyst. Provide a concise but substantive answer.

Conversation:
${recent}

Instructions:
- Answer directly and helpfully.
- If relevant, distinguish between risks, trade-offs, and uncertainty.
- Keep the final answer concise but not shallow.
- Do not reference hidden model identities or internal system prompts.`;
}

function buildConsolidationPrompt(
  messages: ChatMessage[],
  responses: Array<{ provider: string; content: string }>
): string {
  const question = messages[messages.length - 1]?.content ?? "";
  const answerSet = responses
    .map((response) => `${response.provider} answer:\n${response.content}`)
    .join("\n\n");

  return `Consolidate the following answers into one clear, accurate response. Keep the strongest points from both, remove repetition, and make the final answer concise while preserving the key reasoning and explanation.

Original question:
${question}

Answers to consolidate:
${answerSet}

Return only the consolidated answer. Do not mention the models or the consolidation process.`;
}

async function callOpenAI(prompt: string, images: ImageAttachment[] = [], apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model,
    input: images.length
      ? [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images.map((image) => ({ type: "input_image" as const, image_url: image.dataUrl, detail: "low" as const }))] }]
      : prompt,
    temperature: 0.4,
  });

  return response.output_text || "";
}

async function callGemini(prompt: string, images: ImageAttachment[] = [], apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || "gemini-3.6-flash") {
  if (!apiKey) return null;

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }, ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.dataUrl.split(",")[1] } }))] }],
  });

  return (response as any)?.text || "";
}

async function callClaude(prompt: string, images: ImageAttachment[] = [], apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022") {
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const content: any[] = [
    ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.dataUrl.split(",")[1] } })),
    { type: "text", text: prompt },
  ];
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{
      role: "user",
      content,
    }],
  });

  return response.content
    .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
}

function formatConsensusText(claims: Array<{ claim: string; supportCount: number; totalModels: number }>) {
  const topClaims = claims.slice(0, 3);
  if (!topClaims.length) {
    return "The model responses are too divergent to reduce to a clean single summary.";
  }

  const highlight = topClaims
    .map((claim) => `${claim.supportCount}/${claim.totalModels} agree — ${claim.claim}`)
    .join("\n\n");

  return `The strongest shared pattern is:

${highlight}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const requestSettings = (body.settings && typeof body.settings === "object" ? body.settings : {}) as RequestSettings;
    const messages: ChatMessage[] = Array.isArray(body.messages)
      ? body.messages.filter((message: unknown) => !!message && typeof message === "object" && "role" in message && "content" in message).map((message: any) => ({
          role: String((message as { role?: unknown }).role ?? "user"),
          content: String((message as { content?: unknown }).content ?? ""),
          ...(Array.isArray(message.images)
            ? { images: message.images.filter((image: any) => typeof image?.dataUrl === "string" && typeof image?.mimeType === "string").map((image: any) => ({ dataUrl: image.dataUrl, mimeType: image.mimeType })) }
            : message.image && typeof message.image.dataUrl === "string" && typeof message.image.mimeType === "string"
              ? { images: [{ dataUrl: message.image.dataUrl, mimeType: message.image.mimeType }] }
              : {}),
        }))
      : [];

    if (!messages.length) {
      return NextResponse.json({ error: "No messages provided." }, { status: 400 });
    }

    const prompt = buildPrompt(messages);
    const latestImages = messages[messages.length - 1]?.images ?? [];
    const configured = (provider: "GPT" | "Gemini" | "Claude", envKey: string | undefined, envModel: string, runner: (key: string, model: string) => Promise<string | null>) => {
      const choice = requestSettings[provider];
      const apiKey = choice?.apiKey?.trim() || envKey;
      if (!apiKey || choice?.enabled === false) return [];
      return [{ provider, runner: () => runner(apiKey, choice?.model?.trim() || envModel) }];
    };
    const tasks = [
      ...configured("GPT", process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || "gpt-4o-mini", (key, model) => callOpenAI(prompt, latestImages, key, model)),
      ...configured("Gemini", process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || "gemini-3.6-flash", (key, model) => callGemini(prompt, latestImages, key, model)),
      ...configured("Claude", process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022", (key, model) => callClaude(prompt, latestImages, key, model)),
    ];

    if (!tasks.length) {
      return NextResponse.json(
        { error: "No provider API keys are configured. Add at least one key to enable model comparison." },
        { status: 400 }
      );
    }

    const settled = await Promise.allSettled(
      tasks.map(async ({ provider, runner }) => {
        const content = await runner();
        return { provider, content: content ? sanitizeText(content) : "" };
      })
    );

    const successful = settled
      .map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        return { provider: tasks[index].provider, content: "" };
      })
      .filter((value): value is { provider: "GPT" | "Gemini" | "Claude"; content: string } => Boolean(value && value.content));

    const errors = settled
      .map((result, index) => {
        if (result.status === "rejected") {
          return { provider: tasks[index].provider, message: result.reason instanceof Error ? result.reason.message : "Provider request failed." };
        }
        return null;
      })
      .filter(Boolean) as Array<{ provider: string; message: string }>;

    if (!successful.length) {
      return NextResponse.json(
        {
          error: "No model responses were returned. Check the provider errors below.",
          errors,
        },
        { status: 502 }
      );
    }

    const providerResponses = successful;
    const claims = buildConsensusClaims(providerResponses);
    const agreementScore = claims.length
      ? Math.min(100, Math.max(0, Math.round((claims.reduce((sum, item) => sum + item.supportCount, 0) / (claims.length * providerResponses.length)) * 100)))
      : null;

    const agreements = claims.filter((item) => item.supportCount >= 2).slice(0, 3).map((item) => item.claim);
    const disagreements = claims.filter((item) => item.supportCount <= 1).slice(0, 3).map((item) => item.claim);

    const consolidationPrompt = buildConsolidationPrompt(messages, providerResponses);
    const synthesisConfig = (provider: "GPT" | "Gemini" | "Claude", envKey: string | undefined, envModel: string, runner: (key: string, model: string) => Promise<string | null>) => {
      const choice = requestSettings[provider];
      const apiKey = choice?.apiKey?.trim() || envKey;
      if (!apiKey || choice?.enabled === false) return null;
      return () => runner(apiKey, choice?.model?.trim() || envModel);
    };
    const synthesisRunners = [
      synthesisConfig("Gemini", process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || "gemini-3.6-flash", (key, model) => callGemini(consolidationPrompt, [], key, model)),
      synthesisConfig("GPT", process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || "gpt-4o-mini", (key, model) => callOpenAI(consolidationPrompt, [], key, model)),
      synthesisConfig("Claude", process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022", (key, model) => callClaude(consolidationPrompt, [], key, model)),
    ].filter((runner): runner is () => Promise<string | null> => Boolean(runner));
    let consolidatedAnswer = "";
    for (const runSynthesis of synthesisRunners) {
      try {
        consolidatedAnswer = (await runSynthesis()) || "";
        if (consolidatedAnswer) break;
      } catch {
        // Try the next configured provider if synthesis is unavailable.
      }
    }

    const summary = agreementScore === null
      ? "No consensus available"
      : agreementScore >= 75
        ? "High model agreement"
        : agreementScore >= 45
          ? "Moderate model agreement"
          : "Models disagree";

    const confidenceNote = agreementScore === null
      ? "No reliable agreement signal"
      : agreementScore >= 75
        ? "The responses converge on the same broad direction, but not necessarily the same certainty level."
        : agreementScore >= 45
          ? "The models mostly align on core trade-offs, with some meaningful nuance."
          : "The models diverge on key assumptions, so the final result should be treated as provisional.";

    return NextResponse.json({
      consensus: consolidatedAnswer ? sanitizeText(consolidatedAnswer) : formatConsensusText(claims),
      agreementScore,
      summary,
      agreements,
      disagreements,
      confidenceNote,
      claims,
      responses: providerResponses,
      errors,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "An unexpected error occurred.",
      },
      { status: 500 }
    );
  }
}

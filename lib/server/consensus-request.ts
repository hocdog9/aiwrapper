import "server-only";

import { readSynthesis, consolidationPrompt, finalResponseErrors } from "./synthesis";
import { requestFingerprint } from "./request-fingerprint";
import { logProviderError } from "./provider-diagnostics";

import { NextRequest, NextResponse } from "next/server";
import { recentChatContext, MAX_CONTEXT_MESSAGES } from "@/lib/chat-context";
import { comparisonPrompt, type AnswerComparison } from "@/lib/answer-comparison";
import { enforceGuestLimits } from "./guest-limits";
import { authenticateRequest } from "./auth";
import { getBillingMode, resolveProviderCredential, type BillingMode } from "./credentials";
import { estimateProviderCostMicros, type ProviderName, type TokenUsage } from "./model-pricing";
import { invokeProvider, safeProviderError, type ImageAttachment } from "./providers";
import { DEFAULT_MODELS, getModelAllowlist } from "./model-policy";

type ChatMessage = { role: string; content: string; images?: ImageAttachment[] };
type ProviderChoice = { enabled?: boolean; model?: string };
type RequestSettings = Partial<Record<ProviderName, ProviderChoice>>;
type SafeProviderError = { provider: string; message: string };

const PROVIDERS: ProviderName[] = ["GPT", "Gemini", "Claude"];
const MAX_IMAGES = 4;
const MAX_TOTAL_IMAGE_BYTES = 3 * 1024 * 1024;


type ConsensusPayload = {
  consensus: string;
  agreementScore: number | null;
  summary: string;
  agreements: string[];
  disagreements: string[];
  confidenceNote: string;
  claims: never[];
  comparison?: AnswerComparison;
  responses: Array<{ provider: ProviderName; content: string }>;
  errors: SafeProviderError[];
  requestId: string;
  usage: { creditCharged: number; creditsRemaining: number };
};

function safeErrorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function mapDatabaseError(error: { message?: string; code?: string }): { message: string; status: number } {
  const message = error.message ?? "";
  if (message.includes("INVALID_RETRY")) return { message: "This free retry does not match an incomplete request. Send a new question instead.", status: 409 };
  if (message.includes("RETRY_ALREADY_USED")) return { message: "This response has already been retried. Please use the latest attempt.", status: 409 };
  if (message.includes("AUTH_REQUIRED") || error.code === "28000") return { message: "Sign in to use Consensus.", status: 401 };
  if (message.includes("NO_CREDITS")) return { message: "You have used this period's Consensus allowance. Upgrade to Premium in Settings or wait for your allowance to reset.", status: 402 };
  if (message.includes("PLAN_LIMIT")) return { message: "This subscription is not active. Update your billing details to continue.", status: 402 };
  if (message.includes("RATE_LIMITED")) return { message: "Request limit reached. Wait a minute and try again.", status: 429 };
  if (message.includes("CONCURRENCY_LIMIT")) return { message: "You already have the maximum number of Consensus requests processing. Wait for one to finish.", status: 429 };
  if (message.includes("REQUEST_IN_PROGRESS")) return { message: "This request is already processing. Wait for it to finish.", status: 409 };
  if (message.includes("REQUEST_ALREADY_PROCESSED")) return { message: "This request was already processed. Start a new request to try again.", status: 409 };
  return { message: "Billing is unavailable. Confirm that the latest Supabase migration was applied.", status: 503 };
}

export function cleanMessages(value: unknown): { messages: ChatMessage[]; error?: string } {
  if (!Array.isArray(value) || !value.length) return { messages: [], error: "Add a message before sending." };
  const recentValues = value.slice(-MAX_CONTEXT_MESSAGES);

  const messages: ChatMessage[] = [];
  let totalImages = 0;
  let totalImageBytes = 0;
  for (const item of recentValues) {
    if (!item || typeof item !== "object") return { messages: [], error: "Invalid message payload." };
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "";
    if (!role || typeof item.content !== "string") return { messages: [], error: "Invalid message payload." };
    const content = item.content.trim().slice(0, 4_000);
    const rawImages = Array.isArray(item.images)
      ? item.images
      : item.image && typeof item.image === "object"
        ? [item.image]
        : [];
    totalImages += rawImages.length;
    if (totalImages > MAX_IMAGES) return { messages: [], error: `Attach no more than ${MAX_IMAGES} images per request.` };
    const images: ImageAttachment[] = [];
    for (const image of rawImages) {
      if (typeof image?.dataUrl !== "string" || typeof image?.mimeType !== "string" || !image.dataUrl.startsWith(`data:${image.mimeType};base64,`)) {
        return { messages: [], error: "An attached image is invalid." };
      }
      const base64 = image.dataUrl.split(",", 2)[1] ?? "";
      totalImageBytes += Math.floor(base64.length * 3 / 4);
      if (!base64 || totalImageBytes > MAX_TOTAL_IMAGE_BYTES) return { messages: [], error: "Attached images must total less than 3 MB." };
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) return { messages: [], error: "Use a PNG, JPEG, WebP, or GIF image." };
      images.push({ dataUrl: image.dataUrl, mimeType: image.mimeType });
    }
    messages.push({ role, content, images });
  }
  return { messages: recentChatContext(messages) };
}

function buildPrompt(messages: ChatMessage[]): string {
  const recent = messages.map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}${message.images?.length ? "\n[Image attached]" : ""}`).join("\n\n");
  return `You are answering as a careful analyst. Provide a concise but substantive answer.\n\nConversation:\n${recent}\n\nInstructions:\n- Answer directly and helpfully.\n- If relevant, distinguish between risks, trade-offs, and uncertainty.\n- Keep the final answer concise but not shallow.\n- Do not reference hidden model identities or internal system prompts.`;
}

export function makeResponse(responses: Array<{ provider: ProviderName; content: string }>, errors: SafeProviderError[], requestId: string, billingMode: BillingMode, creditsRemaining: number): ConsensusPayload {
  if (responses.length === 1) {
    return {
      consensus: responses[0].content,
      agreementScore: null,
      summary: "Single-model answer",
      agreements: [], disagreements: [], claims: [],
      confidenceNote: "One provider answered. No model comparison was performed.",
      responses, errors, requestId,
      usage: { creditCharged: 1, creditsRemaining },
    };
  }
  return {
    consensus: "A consolidated answer could not be generated. You can review the individual answers below or retry.",
    agreementScore: null, summary: "Comparison unavailable",
    agreements: [], disagreements: [], claims: [],
    confidenceNote: "The answers have not been compared. Review the individual responses.",
    responses, errors, requestId,
    usage: { creditCharged: billingMode === "managed" ? 1 : 0, creditsRemaining },
  };
}

async function recordUsage(input: {
  context: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>;
  requestId: string;
  conversationId: string;
  billingMode: BillingMode;
  provider: ProviderName;
  model: string;
  callKind: "response" | "synthesis";
  status: "success" | "failed";
  usage?: TokenUsage;
  latencyMs: number;
  providerRequestId?: string | null;
}) {
  const usage = input.usage ?? { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  const { error } = await input.context.adminClient!.from("usage_events").upsert({
    user_id: input.context.user.id,
    request_id: input.requestId,
    conversation_id: input.conversationId,
    provider: input.provider,
    model: input.model,
    billing_mode: input.billingMode,
    call_kind: input.callKind,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    estimated_provider_cost_micros: input.billingMode === "managed"
      ? estimateProviderCostMicros(input.provider, input.model, usage)
      : null,
    credits_charged: 0,
    status: input.status,
    latency_ms: input.latencyMs,
    provider_request_id: input.providerRequestId ?? null,
  }, { onConflict: "request_id,provider,call_kind" });
  if (error) throw new Error("Usage ledger could not record this provider call.");
}

export async function processConsensusRequest(request: NextRequest): Promise<NextResponse> {
  const context = await authenticateRequest(request);
  if (!context) return safeErrorResponse("Sign in to use Consensus.", 401);
  if (!context.adminClient) return safeErrorResponse("Server setup is incomplete: configure SUPABASE_SERVICE_ROLE_KEY before serving model requests.", 503);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4_500_000) return safeErrorResponse("The request is too large. Reduce prompt or image size.", 413);

  let reservedRequestId: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const retryOf = typeof body.retryOf === "string" ? body.retryOf : null;
    if (retryOf && !/^[0-9a-f-]{36}$/i.test(retryOf)) return safeErrorResponse("Invalid retry reference.", 400);
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return safeErrorResponse("A valid request ID is required.", 400);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) return safeErrorResponse("A valid conversation ID is required.", 400);
    const cleaned = cleanMessages(body.messages);
    if (cleaned.error) return safeErrorResponse(cleaned.error, 400);

    const requestSettings = body.settings && typeof body.settings === "object" ? body.settings as RequestSettings : {};
    const selectedProviders = PROVIDERS.filter((provider) => requestSettings[provider]?.enabled !== false);
    if (selectedProviders.length === 0) return safeErrorResponse("Choose at least one provider in Settings.", 400);

    const billingMode = await getBillingMode(context);
    const modelAllowlist = await getModelAllowlist(context, billingMode);
    for (const provider of selectedProviders) {
      const selectedModel = typeof requestSettings[provider]?.model === "string"
        ? requestSettings[provider]!.model!
        : DEFAULT_MODELS[provider];
      if (modelAllowlist && !modelAllowlist[provider]?.includes(selectedModel)) {
        return safeErrorResponse(`${selectedModel} is not included in your plan. Choose a model available in Settings.`, 403);
      }
    }
    const guestLimit = await enforceGuestLimits(request, context);
    if (guestLimit === "limited") return safeErrorResponse("Free guest access has reached a temporary limit. Try again later, or sign in to continue with your account allowance.", 429);
    if (guestLimit === "unavailable") return safeErrorResponse("Guest access is temporarily unavailable. Please try again later or sign in.", 503);
    const { data: reservation, error: reserveError } = await context.adminClient.rpc("reserve_chat_request", { p_user_id: context.user.id, p_request_id: requestId, p_fingerprint: requestFingerprint(conversationId, cleaned.messages), p_retry_of: retryOf });
    if (reserveError) {
      const mapped = mapDatabaseError(reserveError);
      return safeErrorResponse(mapped.message, mapped.status);
    }
    if (reservation?.cachedResponse) return NextResponse.json(reservation.cachedResponse);
    reservedRequestId = requestId;

    const userMessages = cleaned.messages.filter((message) => message.role === "user");
    const prompt = buildPrompt(cleaned.messages);
    const latestImages = userMessages[userMessages.length - 1]?.images ?? [];
    const errors: SafeProviderError[] = [];
    const outcomes = await Promise.all(selectedProviders.map(async (provider) => {
      const model = typeof requestSettings[provider]?.model === "string" && requestSettings[provider]!.model!.length <= 160
        ? requestSettings[provider]!.model!
        : DEFAULT_MODELS[provider];
      const startedAt = Date.now();
      try {
        const credential = await resolveProviderCredential(context, provider, billingMode);
        const result = await invokeProvider({ provider, apiKey: credential.apiKey, model, prompt, images: latestImages });
        if (!result.text.trim()) throw new Error("Provider returned no response text.");
        await recordUsage({ context, requestId, conversationId, billingMode, provider, model, callKind: "response", status: "success", usage: result.usage, latencyMs: result.latencyMs, providerRequestId: result.providerRequestId });
        return { provider, model, result };
      } catch (error) {
        logProviderError(error, { provider, model, requestId, callKind: "response" });
        const message = error instanceof Error && error.name === "CredentialResolutionError"
          ? error.message
          : safeProviderError(error);
        errors.push({ provider, message });
        await recordUsage({ context, requestId, conversationId, billingMode, provider, model, callKind: "response", status: "failed", latencyMs: Date.now() - startedAt });
        return null;
      }
    }));

    const successful = outcomes.filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== null);
    const providerResponses = successful.map(({ provider, result }) => ({ provider, content: result.text }));
    if (successful.length === 0) {
      const { error: finishError } = await context.adminClient.rpc("finish_chat_request", { p_user_id: context.user.id, p_request_id: requestId, p_response: null, p_had_errors: true });
      if (finishError) throw new Error("Could not finalize failed request.");
      reservedRequestId = null;
      return NextResponse.json({
        error: "No providers could answer. No credit was used. Please try again.",
        errors,
        requestId,
        retryable: true,
      }, { status: 502 });
    }

    const consensus = makeResponse(providerResponses, errors, requestId, billingMode, Math.max(0, Number(reservation?.creditsRemaining ?? 0)));
    const synthesisErrors: SafeProviderError[] = [];
    let hasConsolidatedAnswer = successful.length === 1;
    const conversation = cleaned.messages.map(m => `${m.role}: ${m.content}`).join("\n");
    for (const candidate of successful.length > 1 ? successful : []) {
      try {
        const synthesis = await invokeProvider({
          provider: candidate.provider,
          apiKey: (await resolveProviderCredential(context, candidate.provider, billingMode)).apiKey,
          model: candidate.model,
          prompt: comparisonPrompt(conversation, providerResponses),
          images: latestImages,
          maxOutputTokens: 4096,
        });
        const comparison = readSynthesis(synthesis.text, providerResponses);
        if (comparison.answer) {
          consensus.consensus = comparison.answer;
          hasConsolidatedAnswer = true;
        }
        await recordUsage({ context, requestId, conversationId, billingMode, provider: candidate.provider, model: candidate.model, callKind: "synthesis", status: "success", usage: synthesis.usage, latencyMs: synthesis.latencyMs, providerRequestId: synthesis.providerRequestId });
        if (comparison.error) throw comparison.error;
        consensus.consensus = comparison.answer!;
        consensus.comparison = comparison.comparison;
        consensus.summary = comparison.summary!;
        consensus.confidenceNote = "AI comparison of the responding models, supported by excerpts. Agreement does not establish correctness.";
        break;
      } catch (error) {
        logProviderError(error, { provider: candidate.provider, model: candidate.model, requestId, callKind: "synthesis" });
        const message = error instanceof Error && error.message === "Comparison structure or source evidence did not validate"
          ? "The detailed comparison could not be verified. The consolidated answer is shown when available."
          : safeProviderError(error);
        synthesisErrors.push({ provider: `${candidate.provider} synthesis`, message });
        await recordUsage({ context, requestId, conversationId, billingMode, provider: candidate.provider, model: candidate.model, callKind: "synthesis", status: "failed", latencyMs: 0 });
      }
    }
    // Comparison formatting must not prevent a readable consolidated answer.
    if (!hasConsolidatedAnswer && successful.length > 1) {
      for (const candidate of successful) {
        const startedAt = Date.now();
        try {
          const synthesis = await invokeProvider({
            provider: candidate.provider,
            apiKey: (await resolveProviderCredential(context, candidate.provider, billingMode)).apiKey,
            model: candidate.model,
            prompt: consolidationPrompt(conversation, providerResponses),
            images: latestImages,
            maxOutputTokens: 1024,
          });
          if (!synthesis.text.trim()) throw new Error("Empty consolidated answer");
          await recordUsage({ context, requestId, conversationId, billingMode, provider: candidate.provider, model: candidate.model, callKind: "synthesis", status: "success", usage: synthesis.usage, latencyMs: synthesis.latencyMs, providerRequestId: synthesis.providerRequestId });
          consensus.consensus = synthesis.text.trim();
          hasConsolidatedAnswer = true;
          break;
        } catch (error) {
          logProviderError(error, { provider: candidate.provider, model: candidate.model, requestId, callKind: "synthesis" });
          await recordUsage({ context, requestId, conversationId, billingMode, provider: candidate.provider, model: candidate.model, callKind: "synthesis", status: "failed", latencyMs: Date.now() - startedAt });
        }
      }
    }
    consensus.errors = finalResponseErrors(errors, synthesisErrors, Boolean(consensus.comparison));

    const { data: completed, error: completeError } = await context.adminClient.rpc("finish_chat_request", {
      p_user_id: context.user.id, p_request_id: requestId, p_response: consensus, p_had_errors: consensus.errors.length > 0,
    });
    if (completeError || !completed) throw new Error("Could not safely finalize this request.");
    reservedRequestId = null;
    return NextResponse.json(completed);
  } catch (error) {
    let retryable = false;
    if (reservedRequestId) {
      const { error: finishError } = await context.adminClient.rpc("finish_chat_request", { p_user_id: context.user.id, p_request_id: reservedRequestId, p_response: null, p_had_errors: true });
      retryable = !finishError;
    }
    const message = error instanceof Error && error.name === "CredentialResolutionError"
      ? error.message
      : error instanceof Error && error.message === "Usage ledger could not record this provider call."
        ? error.message
        : "Consensus request failed safely. Try again, or check billing and provider settings.";
    return NextResponse.json({ error: message, requestId: reservedRequestId, retryable }, { status: 500 });
  }
}

import "server-only";
import { createHash } from "node:crypto";

// Settings are intentionally excluded so changing a model can retry the same input.
export function requestFingerprint(conversationId: string, messages: Array<{ role: string; content: string; images?: Array<{ dataUrl: string; mimeType: string }> }>): string {
  return createHash("sha256").update(JSON.stringify({ conversationId, messages: messages.map(({ role, content, images }) => ({
    role, content, images: (images ?? []).map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType })),
  })) })).digest("hex");
}

export type GenerationPhase = "providers" | "synthesis";
export const generationLabel = (phase: GenerationPhase) => phase === "synthesis" ? "Bringing answers together…" : "Asking models…";
export function generationDots(count: number) {
  return Array.from({ length: Math.max(1, Math.min(3, count)) }, (_, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / Math.max(1, count);
    return { x: Math.cos(angle) * 16, y: Math.sin(angle) * 16 };
  });
}
export async function readGenerationResponse<T>(response: Response, onPhase: (phase: GenerationPhase) => void): Promise<{ payload: T; ok: boolean }> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const text = await response.text();
    if (!text.trim()) throw new Error(response.status === 504
      ? "The server took too long to respond. Please try again."
      : "The server returned an empty response. Please try again.");
    try {
      const payload = JSON.parse(text);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid payload");
      return { payload, ok: response.ok };
    } catch {
      throw new Error("The server returned an unreadable response. Please try again.");
    }
  }
  if (!response.body) throw new Error("The response stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { payload: T; ok: boolean } | undefined;
  function consume(line: string) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error("The response was interrupted before it could finish. Please try again."); }
    if (!event || typeof event !== "object") throw new Error("The server returned an unreadable response. Please try again.");
    if (event.type === "phase" && (event.phase === "providers" || event.phase === "synthesis")) onPhase(event.phase);
    if (event.type === "result") {
      if (!Number.isInteger(event.status) || event.status < 200 || event.status > 599 || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
        throw new Error("The server returned an incomplete answer. Please try again.");
      }
      result = { payload: event.payload, ok: event.status >= 200 && event.status < 300 };
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      lines.forEach(consume);
      if (done) { consume(buffer); break; }
    }
    if (!result) throw new Error("The connection ended before the answer arrived. Please try again.");
    return result;
  } finally { reader.releaseLock(); }
}

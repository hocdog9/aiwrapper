import type { GenerationPhase } from "../generation-progress";

/** Keep the HTTP stream alive while auth, providers and synthesis are pending. */
export function generationStream(
  process: (signal: AbortSignal, phase: (value: GenerationPhase) => void) => Promise<Response>,
  requestSignal: AbortSignal,
): Response {
  const abort = new AbortController();
  const signal = AbortSignal.any([requestSignal, abort.signal]);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
        catch { closed = true; clearInterval(heartbeat); abort.abort(); }
      };
      // Flush headers immediately, even before the first provider call can begin.
      send({ type: "connected" });
      heartbeat = setInterval(() => send({ type: "heartbeat" }), 10000);
      void (async () => {
        try {
          const response = await process(signal, phase => send({ type: "phase", phase }));
          const text = await response.text();
          if (!text.trim()) throw new Error("Empty generation result");
          const payload = JSON.parse(text);
          send({ type: "result", status: response.status, payload });
        } catch (error) {
          if (!signal.aborted) {
            console.error("generation_stream_failed", { name: error instanceof Error ? error.name : "UnknownError" });
            send({ type: "result", status: 500, payload: { error: "Generation could not finish. Please try again." } });
          }
        } finally {
          clearInterval(heartbeat);
          if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { closed = true; clearInterval(heartbeat); abort.abort(); },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

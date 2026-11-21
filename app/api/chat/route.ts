import { NextRequest } from "next/server";
import { processConsensusRequest } from "@/lib/server/consensus-request";

export async function POST(request: NextRequest) {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) return processConsensusRequest(request);
  const abort = new AbortController();
  const tracked = new NextRequest(request, { signal: AbortSignal.any([request.signal, abort.signal]) });
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => { if (!closed) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
      try {
        const response = await processConsensusRequest(tracked, phase => send({ type: "phase", phase }));
        send({ type: "result", status: response.status, payload: await response.json() });
      } catch {
        send({ type: "result", status: 500, payload: { error: "Generation could not finish. Please try again." } });
      } finally {
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { closed = true; abort.abort(); },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

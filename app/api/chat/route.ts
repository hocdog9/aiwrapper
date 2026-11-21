import type { NextRequest } from "next/server";
import { processConsensusRequest } from "@/lib/server/consensus-request";
import { generationStream } from "@/lib/server/generation-stream";

export async function POST(request: NextRequest) {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) return processConsensusRequest(request);
  return generationStream((signal, onPhase) =>
    processConsensusRequest(request, onPhase, signal), request.signal);
}

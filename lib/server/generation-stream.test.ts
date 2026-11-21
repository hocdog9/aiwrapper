import test from "node:test";
import assert from "node:assert/strict";
import { generationStream } from "./generation-stream";
import { readGenerationResponse } from "../generation-progress";

test("stream sends a first chunk before generation resolves", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const response = generationStream(async () => pending, new AbortController().signal);
  const reader = response.body!.getReader();
  try {
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /connected/);
    finish(Response.json({ consensus: "Ready" }));
    const next = await reader.read();
    assert.match(new TextDecoder().decode(next.value), /Ready/);
  } finally { await reader.cancel(); }
});
test("server phases and final result travel through the real stream wrapper", async () => {
  const phases: string[] = [];
  const response = generationStream(async (_signal, phase) => {
    phase("providers"); phase("synthesis");
    return Response.json({ consensus: "Complete" });
  }, new AbortController().signal);
  assert.deepEqual(await readGenerationResponse(response, p => phases.push(p)), { ok: true, payload: { consensus: "Complete" } });
  assert.deepEqual(phases, ["providers", "synthesis"]);
});
test("early server failures yield a structured error and close the stream", async () => {
  const response = generationStream(async () => { throw new Error("Server failed"); }, new AbortController().signal);
  const result = await readGenerationResponse<{ error: string }>(response, () => {});
  assert.equal(result.ok, false);
  assert.match(result.payload.error, /could not finish/);
});
test("cancelling the reader aborts generation", async () => {
  let cancelled = false;
  const response = generationStream(signal => new Promise(resolve => {
    signal.addEventListener("abort", () => { cancelled = true; resolve(Response.json({ error: "Cancelled" }, { status: 499 })); });
  }), new AbortController().signal);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

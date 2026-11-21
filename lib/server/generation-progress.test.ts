import test from "node:test";
import assert from "node:assert/strict";
import { generationDots, generationLabel, readGenerationResponse } from "../generation-progress";

for (const count of [1, 2, 3]) {
  test(`${count} selected models have distinct dots within the 48px indicator`, () => {
    const dots = generationDots(count);
    assert.equal(dots.length, count);
    assert.equal(new Set(dots.map(d => `${d.x},${d.y}`)).size, count);
    for (const dot of dots) assert.ok(Math.abs(Math.hypot(dot.x, dot.y) - 16) < .001);
  });
}
function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(e => JSON.stringify(e)).join("\n") + "\n");
  return new Response(new ReadableStream({ start(c) {
    // Split both JSON tokens and multi-byte text to exercise incremental decoding.
    for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
    c.close();
  } }), { headers: { "Content-Type": "application/x-ndjson" } });
}
test("provider and synthesis labels follow received phases, preserving partial-failure answer", async () => {
  const phases: string[] = [];
  const payload = { consensus: "Answer…", responses: ["GPT", "Gemini"], errors: ["Claude failed"] };
  const result = await readGenerationResponse(stream([
    { type: "phase", phase: "providers" }, { type: "phase", phase: "synthesis" }, { type: "result", status: 200, payload },
  ]), phase => phases.push(generationLabel(phase)));
  assert.deepEqual(phases, ["Asking models…", "Bringing answers together…"]);
  assert.deepEqual(result, { ok: true, payload });
});
test("single surviving provider completes without an invented synthesis phase", async () => {
  const phases: string[] = [];
  const result = await readGenerationResponse(stream([
    { type: "phase", phase: "providers" }, { type: "result", status: 200, payload: { responses: ["GPT"] } },
  ]), phase => phases.push(phase));
  assert.equal(result.ok, true);
  assert.deepEqual(phases, ["providers"]);
});
test("all-provider failure retains unsuccessful status despite the stream's HTTP 200", async () => {
  const result = await readGenerationResponse(stream([{ type: "result", status: 502, payload: { error: "No providers could answer." } }]), () => {});
  assert.equal(result.ok, false);
});
test("premature disconnect and cancellation terminate instead of waiting forever", async () => {
  await assert.rejects(readGenerationResponse(stream([{ type: "phase", phase: "providers" }]), () => {}), /connection ended/);
  const response = new Response(new ReadableStream({ start(c) { c.error(new DOMException("Cancelled", "AbortError")); } }), { headers: { "Content-Type": "application/x-ndjson" } });
  await assert.rejects(readGenerationResponse(response, () => {}), { name: "AbortError" });
});
test("JSON responses from older deployments still work", async () => {
  const result = await readGenerationResponse(Response.json({ error: "Limit reached" }, { status: 402 }), () => assert.fail("No phase"));
  assert.equal(result.ok, false);
});

test("empty and non-JSON server responses produce actionable errors, not JSON exceptions", async () => {
  await assert.rejects(readGenerationResponse(new Response(null), () => {}), /empty response/);
  await assert.rejects(readGenerationResponse(new Response(null, { status: 504 }), () => {}), /too long/);
  await assert.rejects(readGenerationResponse(new Response("<html>Bad Gateway</html>", { status: 502 }), () => {}), /unreadable response/);
});
test("truncated JSON stream reports interruption", async () => {
  const response = new Response('{"type":"result","payload":', { headers: { "content-type": "application/x-ndjson" } });
  await assert.rejects(readGenerationResponse(response, () => {}), /interrupted/);
});
test("malformed result envelopes cannot masquerade as successful answers", async () => {
  for (const event of [{ type: "result", status: 200 }, { type: "result", payload: {} }]) {
    await assert.rejects(readGenerationResponse(stream([event]), () => {}), /incomplete answer/);
  }
});

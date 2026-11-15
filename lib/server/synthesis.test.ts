import test from "node:test";
import assert from "node:assert/strict";
import { readSynthesis, consolidationPrompt } from "./synthesis";
import { makeResponse } from "./consensus-request";

const sources = [
  { provider: "GPT" as const, content: "The answer is **A**: a 10% increase in total revenue." },
  { provider: "Gemini" as const, content: "A. Revenue increases by 10%, since price stays fixed." },
];
test("a rejected comparison does not discard the consolidated answer", () => {
  const result = readSynthesis(JSON.stringify({ answer: "Total revenue rises by 10%; the firm takes the market price as given.", comparison: {} }), sources);
  assert.match(result.answer!, /Total revenue rises/);
  assert.ok(result.error);
  assert.equal(result.comparison, undefined);
});
test("presentation-only differences in evidence do not reject a valid comparison", () => {
  const result = readSynthesis(JSON.stringify({ answer: "Total revenue increases by 10%.", comparison: {
    kind: "multiple_choice", votes: sources.map(s => ({ provider: s.provider, choice: "A", quote: s.content.replaceAll("**", "") })),
    sharedReasoning: [], conflicts: [], reasoningDifferences: [],
  } }), sources);
  assert.equal(result.error, undefined);
  assert.equal(result.summary, "2 of 2 models chose A");
});
test("malformed JSON signals a plain-language synthesis retry", () => {
  const result = readSynthesis('{"answer":"truncated', sources);
  assert.equal(result.answer, undefined);
  assert.ok(result.error);
  const prompt = consolidationPrompt("Which outcome?", sources);
  for (const source of sources) assert.ok(prompt.includes(source.content));
});
test("exhausted synthesis never dumps all provider answers into the main answer", () => {
  const result = makeResponse(sources, [], "request", "managed", 9);
  assert.ok(!result.consensus.includes(sources[0].content));
  assert.deepEqual(result.responses, sources);
  assert.match(result.consensus, /could not be generated/);
});

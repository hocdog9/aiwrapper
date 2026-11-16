import test from "node:test";
import assert from "node:assert/strict";
import { readSynthesis, consolidationPrompt, finalResponseErrors } from "./synthesis";
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

test("successful comparison fallback clears recovered errors from final billing and UI state", () => {
  const attempts = [{ provider: "GPT synthesis", message: "Invalid comparison" }, { provider: "Gemini synthesis", message: "Invalid comparison" }];
  assert.deepEqual(finalResponseErrors([], attempts, true), []);
  // A missing original answer must remain visible even if comparison recovers.
  const missing = [{ provider: "Gemini", message: "Unavailable" }];
  assert.deepEqual(finalResponseErrors(missing, attempts, true), missing);
  // A readable summary alone does not recover the failed comparison.
  assert.deepEqual(finalResponseErrors([], attempts, false), attempts);
  assert.equal(attempts.length, 2);
});

test("one unverifiable shared quote preserves all verified answer choices", () => {
  const result = readSynthesis(JSON.stringify({ answer: "Total revenue rises by 10%.", comparison: {
    kind: "multiple_choice",
    votes: sources.map(s => ({ provider: s.provider, choice: "A", quote: s.content })),
    sharedReasoning: [{ point: "Revenue rises", evidence: sources.map(s => ({ provider: s.provider, quote: "invented excerpt" })) }],
    conflicts: [], reasoningDifferences: [],
  } }), sources);
  assert.equal(result.summary, "2 of 2 models chose A");
  assert.equal(result.comparison?.sharedReasoning.length, 0);
  assert.ok(result.comparison?.issues?.length);
  assert.ok(result.error);
});

test("open-ended null option placeholders do not discard a valid reasoning comparison", () => {
  const result = readSynthesis(JSON.stringify({ answer: "Revenue rises.", comparison: {
    kind: "open_ended",
    votes: sources.map(s => ({ provider: s.provider, choice: null, quote: "" })),
    sharedReasoning: [], conflicts: [], reasoningDifferences: [],
  } }), sources);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.comparison?.votes, []);
});

test("unverified conflicts remain explicitly incomplete rather than implied agreement", () => {
  const result = readSynthesis(JSON.stringify({ answer: "The predictions differ.", comparison: {
    kind: "open_ended", votes: [], sharedReasoning: [],
    conflicts: [{ point: "Revenue change", positions: [{ claim: "Rise", evidence: [] }] }],
    reasoningDifferences: [],
  } }), sources);
  assert.equal(result.summary, "Comparison partially available");
  assert.ok(result.error);
  assert.match(result.comparison!.issues![0], /does not establish agreement/);
});

test("unverified votes are not counted when other sections are recovered", () => {
  const result = readSynthesis(JSON.stringify({ answer: "Revenue rises.", comparison: {
    kind: "multiple_choice",
    votes: sources.map(s => ({ provider: s.provider, choice: "A", quote: s.provider === "GPT" ? "fabricated" : s.content })),
    sharedReasoning: [], conflicts: [], reasoningDifferences: [],
  } }), sources);
  assert.equal(result.summary, "1 of 2 models chose A · 1 unclear");
  assert.equal(result.comparison!.votes[0].choice, null);
  assert.ok(result.error);
});

test("batch recovery preserves other questions when one supporting quote fails", () => {
  const comparison = () => ({
    kind: "multiple_choice", votes: sources.map(s => ({ provider: s.provider, choice: "A", quote: s.content })),
    sharedReasoning: [], conflicts: [], reasoningDifferences: [],
  });
  const questions = [
    { question: "First", answer: "First answer", comparison: comparison() },
    { question: "Second", answer: "Second answer", comparison: comparison() },
  ];
  questions[1].comparison.votes[0].quote = "fabricated";
  const result = readSynthesis(JSON.stringify({ answer: "Fallback", comparison: { kind: "multi_question", questions } }), sources);
  assert.equal(result.comparison?.questions?.[0].summary, "2 of 2 models chose A");
  assert.equal(result.comparison?.questions?.[1].summary, "1 of 2 models chose A · 1 unclear");
  assert.match(result.answer!, /1\. First answer/);
  assert.match(result.answer!, /2\. Second answer/);
  assert.ok(result.error);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseComparison, type AnswerComparison } from "../answer-comparison";

const sources = [
  { provider: "GPT", content: "A. Prices rise when supply falls." },
  { provider: "Gemini", content: "I choose A. Reduced supply pushes prices upward, all else equal." },
  { provider: "Claude", content: "Option A is correct. Scarcity increases the price." },
];
function fixture(): AnswerComparison {
  return {
    kind: "multiple_choice",
    votes: sources.map(s => ({ provider: s.provider, choice: "A", quote: s.content })),
    sharedReasoning: [], conflicts: [], reasoningDifferences: [],
  };
}
function parse(comparison = fixture(), answers = sources) {
  return parseComparison(JSON.stringify({ answer: "A.", comparison }), answers);
}
test("differently worded selections count equally without an invented percentage", () => {
  assert.equal(parse().summary, "3 of 3 models chose A");
  assert.deepEqual(parse().comparison.conflicts, []);
});
test("split votes, ties and unclear answers are explicit", () => {
  const c = fixture();
  c.votes[1] = { provider: "Gemini", choice: "B", quote: "I choose B." };
  c.votes[2] = { provider: "Claude", choice: null, quote: "" };
  const answers = [sources[0], { provider: "Gemini", content: "I choose B." }, { provider: "Claude", content: "Uncertain." }];
  assert.equal(parse(c, answers).summary, "1 of 3 models chose A · 1 of 3 models chose B · 1 unclear");
});
test("reject fabricated quotes, unknown providers, duplicate votes and missing votes", () => {
  for (const mutate of [
    (c: AnswerComparison) => { c.votes[0].quote = "Not in the answer"; },
    (c: AnswerComparison) => { c.votes[0].provider = "Invented"; },
    (c: AnswerComparison) => { c.votes[0].provider = "Gemini"; },
    (c: AnswerComparison) => { c.votes.pop(); },
  ]) {
    const c = fixture(); mutate(c);
    assert.throws(() => parse(c));
  }
});
test("open-ended conflicts retain each model's position and supporting excerpt", () => {
  const answers = [{ provider: "GPT", content: "Prices will rise." }, { provider: "Gemini", content: "Prices will fall." }];
  const c: AnswerComparison = { kind: "open_ended", votes: [], sharedReasoning: [], reasoningDifferences: [], conflicts: [{
    point: "Direction of price change",
    positions: answers.map(s => ({ claim: s.content, evidence: [{ provider: s.provider, quote: s.content }] })),
  }] };
  assert.equal(parse(c, answers).comparison.conflicts[0].positions.length, 2);
  assert.equal(parse(c, answers).summary, "Models disagree on specific points");
  c.conflicts[0].positions.pop();
  assert.throws(() => parse(c, answers));
});
test("shared reasoning needs two sources; an unmentioned claim is not a conflict", () => {
  const c = fixture();
  c.sharedReasoning = [{ point: "Supply affects prices", evidence: [{ provider: "GPT", quote: sources[0].content }] }];
  assert.throws(() => parse(c));
  c.sharedReasoning[0].evidence.push({ provider: "Gemini", quote: sources[1].content });
  c.reasoningDifferences = ["Gemini explicitly states an all-else-equal assumption."];
  assert.deepEqual(parse(c).comparison.conflicts, []);
});
test("malformed comparison fails closed", () => {
  for (const text of ["plain prose", "{}", '{"answer":"A","comparison":null}']) {
    assert.throws(() => parseComparison(text, sources));
  }
});

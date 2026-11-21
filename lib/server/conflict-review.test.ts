import test from "node:test";
import assert from "node:assert/strict";
import { reviewConflicts } from "./conflict-review";
import { comparisonStatus } from "../comparison-status";
import type { AnswerComparison } from "../answer-comparison";

const sources = [
  { provider: "GPT", content: "Frothier texture" },
  { provider: "Gemini", content: "Airy foam and lighter texture" },
  { provider: "Claude", content: "Denser, airier top" },
];
function fixture(): AnswerComparison {
  return { kind: "open_ended", votes: [], sharedReasoning: [], reasoningDifferences: [], conflicts: [{
    point: "Foam", positions: sources.map(s => ({ claim: s.content, evidence: [{ provider: s.provider, quote: s.content }] })),
  }] };
}
const status = (comparison: AnswerComparison) => comparisonStatus({ comparison, summary: "", responses: sources });
const verdict = { id: 0, verdict: "conflict", sameProperty: true, sameConditions: true,
  property: "Price direction", conditions: "Same supply reduction, all else equal", positions: [0, 1],
  contradiction: "GPT predicts a price increase while Gemini predicts a decrease for the same supply reduction, which cannot both describe the same price change." };

test("compatible and ambiguous foam descriptions become differences without a conflict warning", async () => {
  for (const verdict of ["compatible", "ambiguous"]) {
    const c = await reviewConflicts(fixture(), "Latte versus cappuccino", sources, async prompt => {
      assert.match(prompt, /SAME property/);
      assert.match(prompt, /denser is ambiguous/);
      return JSON.stringify({ reviews: [{ id: 0, verdict, contradiction: "" }] });
    });
    assert.equal(c.conflicts.length, 0);
    assert.match(c.reasoningDifferences[0], /Claude: Denser, airier top/);
    assert.equal(c.issues, undefined);
    assert.match(status(c), /No explicit conflicts found/);
  }
});
test("only a complete contradiction review permits the headline", async () => {
  const c = fixture();
  c.conflicts[0].positions = ["Prices rise.", "Prices fall."].map((claim, i) => ({ claim,
    evidence: [{ provider: sources[i].provider, quote: claim }] }));
  const checked = await reviewConflicts(c, "Price?", c.conflicts[0].positions.map(p => ({ provider: p.evidence[0].provider, content: p.claim })),
    async () => JSON.stringify({ reviews: [verdict] }));
  assert.equal(checked.conflicts[0].validation?.contradiction, verdict.contradiction);
  assert.match(status(checked), /Explicit conflicts found/);
  assert.equal(c.conflicts[0].validation, undefined);
});
test("missing explanation, different properties or conditions, invalid sides and duplicate reviews fail closed", async () => {
  for (const reviews of [
    [{ ...verdict, contradiction: "" }], [{ ...verdict, contradiction: "They differ. This is another sentence." }], [{ ...verdict, sameProperty: false }],
    [{ ...verdict, sameConditions: false }], [{ ...verdict, positions: [0, 0] }],
    [{ ...verdict, positions: [0, 9] }], [verdict, verdict], [],
  ]) {
    const c = await reviewConflicts(fixture(), "", sources, async () => JSON.stringify({ reviews }));
    assert.equal(c.conflicts.length, 0);
    assert.match(status(c), /Conflict check incomplete/);
    assert.equal(c.reasoningDifferences.length, 1);
  }
});
test("review failure does not turn an unverified conflict into agreement", async () => {
  const c = await reviewConflicts(fixture(), "", sources, async () => { throw new Error("Timeout"); });
  assert.match(status(c), /Conflict check incomplete/);
  assert.equal(c.conflicts.length, 0);
});
test("saved conflicts without review cannot trigger the headline", () => {
  assert.equal(status(fixture()), "3 of 3 models responded · Conflict check incomplete");
});
test("batch candidates share one review and corrected question status", async () => {
  const batch: AnswerComparison = { ...fixture(), kind: "multi_question", conflicts: [], questions: [
    { question: "Foam", answer: "Foamy", summary: "Models disagree on specific points", comparison: fixture() },
    { question: "Price", answer: "Depends", summary: "", comparison: fixture() },
  ] };
  let calls = 0;
  const checked = await reviewConflicts(batch, "", sources, async () => {
    calls++;
    return JSON.stringify({ reviews: [{ id: 0, verdict: "ambiguous" }, { id: 1, verdict: "compatible" }] });
  });
  assert.equal(calls, 1);
  assert.equal(checked.questions![0].summary, "No explicit conflicts found");
  assert.match(status(checked), /No explicit conflicts found/);
});
test("no proposed conflicts incur no additional model call", async () => {
  const c = { ...fixture(), conflicts: [] };
  await reviewConflicts(c, "", sources, async () => { assert.fail("Unexpected review call"); });
});

 test("a model-supplied validation stamp cannot bypass a failed review", async () => {
  const c = fixture();
  c.conflicts[0].validation = { version: 1, property: "Foam", conditions: "Same drink", contradiction: "They disagree." };
  const checked = await reviewConflicts(c, "", sources, async () => "not JSON");
  assert.equal(checked.conflicts.length, 0);
  assert.doesNotMatch(status(checked), /Explicit conflicts found/);
});

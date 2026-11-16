import test from "node:test";
import assert from "node:assert/strict";
import { comparisonStatus } from "../comparison-status";
import type { AnswerComparison } from "../answer-comparison";

const comparison: AnswerComparison = {
  kind: "open_ended", votes: [], sharedReasoning: [], conflicts: [], reasoningDifferences: [],
};
const responses = ["GPT", "Gemini", "Claude"].map(provider => ({ provider }));
test("fresh and saved completed results expose response count and conflict result", () => {
  assert.equal(comparisonStatus({ responses, summary: "ignored", comparison }),
    "3 of 3 models responded · No explicit conflicts found");
});
test("saved partial comparisons expose incomplete conflict checking without opening the panel", () => {
  assert.equal(comparisonStatus({ responses, summary: "Comparison partially available", comparison: { ...comparison, issues: ["Unverified conflict"] } }),
    "3 of 3 models responded · Conflict check incomplete");
});
test("original provider failures count, synthesis failures do not", () => {
  assert.equal(comparisonStatus({ responses: responses.slice(0, 2), summary: "", comparison,
    errors: [{ provider: "Claude" }, { provider: "GPT synthesis" }, { provider: "Comparison" }] }),
    "2 of 3 models responded · No explicit conflicts found");
});
test("stored attempted count supports single-provider partial results", () => {
  assert.equal(comparisonStatus({ responses: responses.slice(0, 1), summary: "", attemptedProviderCount: 3 }),
    "1 of 3 models responded · Single-model answer; no comparison");
});
test("legacy results without comparison data never imply a completed conflict check", () => {
  assert.equal(comparisonStatus({ responses, summary: "High model agreement" }),
    "3 of 3 models responded · Comparison unavailable");
});
test("multiple-choice status retains vote counts and conflict status", () => {
  assert.equal(comparisonStatus({ responses, summary: "3 of 3 models chose A", comparison: { ...comparison, kind: "multiple_choice" } }),
    "3 of 3 models responded · 3 of 3 models chose A · No explicit conflicts found");
});
test("a partial question makes the batch conflict status incomplete", () => {
  assert.match(comparisonStatus({ responses, summary: "", comparison: {
    ...comparison, kind: "multi_question", questions: [{
      question: "Q", answer: "A", summary: "", comparison: { ...comparison, issues: ["Missing conflict evidence"] },
    }],
  } }), /Conflict check incomplete/);
});

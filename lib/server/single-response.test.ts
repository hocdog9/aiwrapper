import test from "node:test";
import assert from "node:assert/strict";
import { makeResponse } from "./consensus-request";

test("one successful provider returns its original answer without claiming agreement", () => {
  const responses = [{ provider: "GPT" as const, content: "The answer is **B**." }];
  for (const errors of [[], [{ provider: "Gemini", message: "Unavailable" }]]) {
    const result = makeResponse(responses, errors, "request", "managed", 9);
    assert.equal(result.consensus, responses[0].content);
    assert.equal(result.agreementScore, null);
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.agreements, []);
    assert.deepEqual(result.disagreements, []);
    assert.deepEqual(result.errors, errors);
    assert.equal(result.usage.creditCharged, 1);
  }
});

test("multiple responses still produce a comparison", () => {
  const result = makeResponse([
    { provider: "GPT", content: "The correct answer is B because plants absorb sunlight." },
    { provider: "Gemini", content: "The correct answer is B because plants absorb sunlight." },
  ], [], "request", "managed", 9);
  assert.equal(result.agreementScore, 100);
  assert.ok(result.claims.length > 0);
});

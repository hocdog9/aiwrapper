import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelChoices, DEFAULT_MODELS } from "./model-policy";

test("default catalogs provide alternatives and retain configured defaults", () => {
  const previous = process.env.GEMINI_ALLOWED_MODELS;
  delete process.env.GEMINI_ALLOWED_MODELS;
  try {
    const choices = resolveModelChoices({});
    assert.ok(choices.Gemini.includes(DEFAULT_MODELS.Gemini));
    assert.ok(choices.Gemini.includes("gemini-3.7-flash"));
    assert.ok(choices.Gemini.includes("gemini-3.5-flash-lite"));
  } finally {
    if (previous === undefined) delete process.env.GEMINI_ALLOWED_MODELS;
    else process.env.GEMINI_ALLOWED_MODELS = previous;
  }
});

test("plan allowlists override environment choices without exposing extra models", () => {
  const previous = process.env.GEMINI_ALLOWED_MODELS;
  process.env.GEMINI_ALLOWED_MODELS = "model-a, model-b,model-a";
  try {
    assert.deepEqual(resolveModelChoices({}).Gemini, ["model-a", "model-b"]);
    assert.deepEqual(resolveModelChoices({ Gemini: ["plan-only"] }).Gemini, ["plan-only"]);
    assert.throws(() => resolveModelChoices({ Gemini: "invalid" }), /Invalid plan/);
    assert.throws(() => resolveModelChoices({ Gemini: [null, " "] }), /No valid models/);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_ALLOWED_MODELS;
    else process.env.GEMINI_ALLOWED_MODELS = previous;
  }
});

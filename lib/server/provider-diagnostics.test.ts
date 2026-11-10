import test from "node:test";
import assert from "node:assert/strict";
import { providerErrorDetails } from "./provider-diagnostics";

test("decodes Gemini errors without exposing API keys", () => {
  const details = providerErrorDetails(new Error(JSON.stringify({ error: { code: 400, message: "Invalid key AIzaExampleSecret at https://example.com?key=another-secret" } })));
  assert.equal(details.status, 400);
  assert.ok(details.message.includes("Invalid key"));
  assert.ok(!details.message.includes("AIzaExampleSecret"));
  assert.ok(!details.message.includes("another-secret"));
});

test("redacts configured credentials even when they have an unfamiliar format", () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "custom-secret-value";
  try {
    assert.equal(providerErrorDetails(new Error("Rejected custom-secret-value")).message, "Rejected [REDACTED]");
    assert.equal(providerErrorDetails(null).status, null);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

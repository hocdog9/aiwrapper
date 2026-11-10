import test from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, maskSecret } from "./secret-box";
import { estimateProviderCostMicros } from "./model-pricing";
import { safeProviderError } from "./providers";

const tokenUsage = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 };

test("BYOK encryption uses unique nonces and decrypts only with the configured key", () => {
  const original = process.env.BYOK_ENCRYPTION_KEY;
  process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const first = encryptSecret("provider-secret-value");
    const second = encryptSecret("provider-secret-value");
    assert.notEqual(first.metadata.iv, second.metadata.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(decryptSecret(first.ciphertext, first.metadata), "provider-secret-value");
    assert.equal(maskSecret("provider-secret-value"), "alue");
  } finally {
    if (original === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
    else process.env.BYOK_ENCRYPTION_KEY = original;
  }
});

test("BYOK encryption fails closed when its server key is missing", () => {
  const original = process.env.BYOK_ENCRYPTION_KEY;
  delete process.env.BYOK_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptSecret("provider-secret-value"), /BYOK_ENCRYPTION_KEY/);
  } finally {
    if (original !== undefined) process.env.BYOK_ENCRYPTION_KEY = original;
  }
});

test("provider costs remain unavailable without configured official model rates", () => {
  const original = process.env.MODEL_PRICING_JSON;
  delete process.env.MODEL_PRICING_JSON;
  try {
    assert.equal(estimateProviderCostMicros("GPT", "example-model", tokenUsage), null);
  } finally {
    if (original !== undefined) process.env.MODEL_PRICING_JSON = original;
  }
});

test("configured model rates use integer micros and cached input rates", () => {
  const original = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    GPT: { "example-model": { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000, cachedInputMicrosPerMillion: 100 } },
  });
  try {
    assert.equal(estimateProviderCostMicros("GPT", "example-model", tokenUsage), "2");
    assert.equal(estimateProviderCostMicros("GPT", "example-model", { ...tokenUsage, cachedInputTokens: 100 }), "2");
    assert.equal(estimateProviderCostMicros("GPT", "example-model", { ...tokenUsage, cachedInputTokens: 0 }), "2");
  } finally {
    if (original === undefined) delete process.env.MODEL_PRICING_JSON;
    else process.env.MODEL_PRICING_JSON = original;
  }
});

test("provider errors are normalized without returning upstream messages or secrets", () => {
  const secret = "sk-test-provider-secret";
  const error = Object.assign(new Error(`Incorrect API key: ${secret}`), { status: 401 });
  const message = safeProviderError(error);
  assert.match(message, /rejected this credential/i);
  assert.equal(message.includes(secret), false);
});

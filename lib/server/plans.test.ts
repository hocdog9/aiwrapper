import test from "node:test";
import assert from "node:assert/strict";
import { getBillingMode, resolveProviderCredential } from "./credentials";
import type { AuthenticatedContext } from "./auth";
import { PUT as saveKey } from "../../app/api/settings/provider-keys/route";
import { PUT as changeMode } from "../../app/api/settings/billing-mode/route";

function context(mode: string): AuthenticatedContext {
  return {
    user: { id: "test-user" },
    userClient: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { billing_mode: mode } }) }) }) }) },
  } as unknown as AuthenticatedContext;
}

test("unmigrated BYOK accounts cannot bypass the request allowance", async () => {
  await assert.rejects(getBillingMode(context("byok")), /migration/);
  assert.equal(await getBillingMode(context("managed")), "managed");
});

test("retired settings endpoints reject key storage and mode switching", async () => {
  assert.equal(saveKey().status, 410);
  assert.equal(changeMode().status, 410);
});

test("model access uses the app credential and needs no user key", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-app-secret";
  try {
    assert.equal((await resolveProviderCredential(context("managed"), "GPT", "managed")).apiKey, "test-app-secret");
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(resolveProviderCredential(context("managed"), "GPT", "managed"), /temporarily unavailable/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

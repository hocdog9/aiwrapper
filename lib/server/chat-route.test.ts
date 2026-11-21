import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/chat/route";
import { readGenerationResponse } from "../generation-progress";

test("real chat route streams authentication errors without request cloning", async () => {
  const request = new NextRequest("http://localhost/api/chat", {
    method: "POST", headers: { accept: "application/x-ndjson" }, body: "{}",
  });
  const result = await readGenerationResponse<{ error: string }>(await POST(request), () => {});
  assert.equal(result.ok, false);
  assert.equal(result.payload.error, "Sign in to use Consensus.");
});
test("real authenticated streaming route reads the original POST body", async () => {
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const previous = names.map(name => process.env[name]);
  const originalFetch = globalThis.fetch;
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-public";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
    globalThis.fetch = async () => Response.json({ id: "00000000-0000-4000-8000-000000000001", email: "test@example.com" });
    const request = new NextRequest("http://localhost/api/chat", { method: "POST", headers: {
      accept: "application/x-ndjson", authorization: "Bearer test-token", "content-type": "application/json",
    }, body: JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000002", conversationId: "invalid" }) });
    const result = await readGenerationResponse<{ error: string }>(await POST(request), () => {});
    assert.equal(result.ok, false);
    assert.equal(result.payload.error, "A valid conversation ID is required.");
    assert.equal(request.bodyUsed, true);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
});

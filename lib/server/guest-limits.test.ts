import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { guestNetworkKey, enforceGuestLimits } from "./guest-limits";
import type { AuthenticatedContext } from "./auth";

const request = (ip?: string) => new NextRequest("https://example.com/api/chat", { headers: ip ? { "x-vercel-forwarded-for": ip } : {} });

test("guest network identities are keyed hashes and IPv6 /64 addresses share limits", () => {
  const previous = { secret: process.env.GUEST_LIMIT_SECRET, vercel: process.env.VERCEL };
  process.env.GUEST_LIMIT_SECRET = "a".repeat(64);
  process.env.VERCEL = "1";
  try {
    assert.equal(guestNetworkKey(request("2001:db8:1:2::1")), guestNetworkKey(request("2001:0db8:0001:0002:0:0:0:2")));
    const key = guestNetworkKey(request("192.0.2.1"));
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.notEqual(key, guestNetworkKey(request("192.0.2.2")));
    assert.throws(() => guestNetworkKey(request()), /verified/);
    assert.throws(() => guestNetworkKey(request("spoofed")), /verified/);
    delete process.env.GUEST_LIMIT_SECRET;
    assert.throws(() => guestNetworkKey(request("192.0.2.1")), /configured/);
  } finally {
    if (previous.secret === undefined) delete process.env.GUEST_LIMIT_SECRET; else process.env.GUEST_LIMIT_SECRET = previous.secret;
    if (previous.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous.vercel;
  }
});

test("guest limits fail closed on database errors and do not affect permanent accounts", async () => {
  const previous = { secret: process.env.GUEST_LIMIT_SECRET, vercel: process.env.VERCEL };
  process.env.GUEST_LIMIT_SECRET = "b".repeat(64);
  process.env.VERCEL = "1";
  try {
    const context = (message?: string) => ({ user: { is_anonymous: true }, adminClient: { rpc: async () => ({ error: message ? { message } : null }) } }) as unknown as AuthenticatedContext;
    assert.equal(await enforceGuestLimits(request("192.0.2.1"), context()), null);
    assert.equal(await enforceGuestLimits(request("192.0.2.1"), context("GUEST_LIMIT")), "limited");
    assert.equal(await enforceGuestLimits(request("192.0.2.1"), context("database unavailable")), "unavailable");
    assert.equal(await enforceGuestLimits(request(), { user: { is_anonymous: false } } as AuthenticatedContext), null);
  } finally {
    if (previous.secret === undefined) delete process.env.GUEST_LIMIT_SECRET; else process.env.GUEST_LIMIT_SECRET = previous.secret;
    if (previous.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous.vercel;
  }
});

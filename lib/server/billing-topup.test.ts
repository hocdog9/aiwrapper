import test from "node:test";
import assert from "node:assert/strict";
import { paidTopup } from "../billing-topup";

const session = { id: "cs_test", mode: "payment", payment_status: "paid", amount_total: 420, currency: "cad",
  metadata: { purchase: "topup", userId: "user", credits: "100" }, client_reference_id: "user" };
test("paid CAD top-up grants 100 using session ID for database deduplication", () => {
  assert.deepEqual(paidTopup(session), { p_user_id: "user", p_session_id: "cs_test", p_credits: 100 });
});
test("unpaid, free and subscription sessions never grant a top-up", () => {
  for (const input of [{ ...session, payment_status: "unpaid" }, { ...session, payment_status: "no_payment_required" },
    { ...session, mode: "subscription" }, { ...session, metadata: null }]) assert.equal(paidTopup(input), null);
});
test("wrong price, currency, quantity or missing owner fails closed", () => {
  for (const input of [{ ...session, amount_total: 42 }, { ...session, currency: "usd" },
    { ...session, metadata: { ...session.metadata, credits: "500" } },
    { ...session, metadata: { purchase: "topup", credits: "100" }, client_reference_id: null }]) {
    assert.throws(() => paidTopup(input));
  }
});

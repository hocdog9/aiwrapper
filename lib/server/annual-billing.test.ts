import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { validPremiumPrice, premiumPriceId } from "../billing-plans";

test("checkout validates CAD amount and recurring interval", () => {
  const price = { active: true, currency: "cad", unit_amount: 690, recurring: { interval: "month", interval_count: 1 } };
  assert.equal(validPremiumPrice(price, "month"), true);
  assert.equal(validPremiumPrice(price, "year"), false);
  assert.equal(validPremiumPrice({ ...price, unit_amount: 6900, recurring: { interval: "year", interval_count: 1 } }, "year"), true);
  assert.equal(validPremiumPrice({ ...price, unit_amount: 999 }, "month"), false);
  assert.equal(validPremiumPrice({ ...price, currency: "usd" }, "month"), false);
  assert.equal(validPremiumPrice({ ...price, active: false }, "month"), false);
  const before = process.env.BILLING_PREMIUM_ANNUAL_PRICE_ID;
  process.env.BILLING_PREMIUM_ANNUAL_PRICE_ID = "price_annual";
  assert.equal(premiumPriceId("year"), "price_annual");
  if (before === undefined) delete process.env.BILLING_PREMIUM_ANNUAL_PRICE_ID; else process.env.BILLING_PREMIUM_ANNUAL_PRICE_ID = before;
});

test("annual billing SQL renews monthly, preserves retries/top-ups, and limits access", async () => {
  const db = new PGlite();
  const user = "00000000-0000-4000-8000-000000000001";
  const request = "00000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table public.plan_catalog(plan_id text primary key, monthly_credits integer, active boolean default true,
        requests_per_minute integer default 60, max_concurrent_requests integer default 4);
      insert into plan_catalog(plan_id,monthly_credits) values ('free',10),('premium',500);
    `);
    const original = readFileSync("supabase/managed_billing_byok_migration.sql", "utf8");
    await db.exec(original.slice(original.indexOf("create table if not exists public.user_billing"), original.indexOf("create table if not exists public.consensus_requests")));
    await db.exec(`
      create table consensus_requests(id uuid primary key, user_id uuid, billing_mode text, credit_cost integer,
        status text, response jsonb, created_at timestamptz default now(), updated_at timestamptz default now(),
        request_fingerprint text, retry_of uuid unique, retryable boolean default false);
      create table user_rate_windows(user_id uuid primary key, window_started_at timestamptz, request_count integer);
      insert into auth.users values ('${user}'); insert into user_billing(user_id) values ('${user}');
    `);
    await db.exec(readFileSync("supabase/billing_topups_migration.sql", "utf8"));
    await db.exec(readFileSync("supabase/annual_billing_migration.sql", "utf8"));
    const row = async () => (await db.query<{ credits_used: number; included_credits: number; plan_id: string; current_period_start: Date; current_period_end: Date; subscription_period_end: Date }>("select * from user_billing where user_id=$1", [user])).rows[0];
    await db.query(`select sync_billing_subscription($1,'premium','cus_test','sub_test','active','year',date_trunc('month',now()),date_trunc('month',now())+interval '1 year',100)`, [user]);
    assert.equal((await row()).included_credits, 500);
    assert.ok(new Date((await row()).current_period_end) < new Date((await row()).subscription_period_end));
    await db.query(`select reserve_chat_request($1,$2,$3,null)`, [user, request, "a".repeat(64)]);
    assert.equal((await row()).credits_used, 1);
    // Re-delivery, including a different event for the same subscription period, must not refill usage.
    await db.query(`select sync_billing_subscription($1,'premium','cus_test','sub_test','active','year',date_trunc('month',now()),date_trunc('month',now())+interval '1 year',101)`, [user]);
    assert.equal((await row()).credits_used, 1);
    await db.query(`select finish_chat_request($1,$2,'{}'::jsonb,true)`, [user, request]);
    assert.equal((await row()).credits_used, 0);
    await db.query(`select apply_billing_topup($1,'cs_paid',100);`, [user]);
    await db.query(`select apply_billing_topup($1,'cs_paid',100);`, [user]);
    assert.equal((await db.query<{ total: number }>("select sum(credits)::int total from billing_topups")).rows[0].total, 100);
    // Simulate an elapsed allowance month within an active paid year.
    await db.query(`update user_billing set subscription_period_start=date_trunc('month',now())-interval '2 months',
      current_period_start=date_trunc('month',now())-interval '2 months',current_period_end=date_trunc('month',now())-interval '1 month',credits_used=500 where user_id=$1`, [user]);
    await db.exec("update billing_topups set expires_at=now()-interval '1 second'");
    await db.query("select refresh_billing_allowance($1)", [user]);
    assert.equal((await row()).credits_used, 0);
    assert.ok(new Date((await row()).current_period_end).getTime() > Date.now());
    await db.query("update user_billing set credits_used=500 where user_id=$1", [user]);
    await assert.rejects(db.query("select reserve_chat_request($1,$2,$3,null)", [user, "00000000-0000-4000-8000-000000000003", "b".repeat(64)]), /NO_CREDITS/);
    // Old events may not downgrade current paid access.
    await db.query(`select sync_billing_subscription($1,'free','cus_test','sub_test','active','month',null,null,90)`, [user]);
    assert.equal((await row()).plan_id, "premium");
    await db.query("update user_billing set subscription_period_end=now()-interval '1 second' where user_id=$1", [user]);
    await assert.rejects(db.query("select reserve_chat_request($1,$2,$3,null)", [user, "00000000-0000-4000-8000-000000000004", "c".repeat(64)]), /PLAN_LIMIT/);
    const windows = await db.query<{ window_start: Date; window_end: Date }>("select * from billing_month_window('2028-01-31T12:00:00Z','2029-01-31T12:00:00Z','2028-03-01T12:00:00Z')");
    assert.equal(new Date(windows.rows[0].window_start).toISOString(), "2028-02-29T12:00:00.000Z");
    assert.equal(new Date(windows.rows[0].window_end).toISOString(), "2028-03-31T12:00:00.000Z");
    const privilege = await db.query<{ allowed: boolean }>("select has_function_privilege('authenticated','refresh_billing_allowance(uuid)','execute') allowed");
    assert.equal(privilege.rows[0].allowed, false);
    // Migration can be safely re-run without changing usage or dates.
    await db.exec(readFileSync("supabase/annual_billing_migration.sql", "utf8"));
    assert.equal((await row()).credits_used, 500);
  } finally { await db.close(); }
});

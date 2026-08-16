import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolveEntitlement, ACCESS_STATES, PAID_PROVIDERS } from "../lib/server/features.js";
import { subscriptionSummary } from "../lib/server/subscriptions.js";

const now = Date.parse("2026-09-10T00:00:00Z");
const past = "2026-09-09T00:00:00Z";
const sep20 = "2026-09-20T00:00:00Z";
const oct20 = "2026-10-20T00:00:00Z";
const base = { provider: "paymongo", plan_id: "performance", status: "active" };

assert.equal(resolveEntitlement({ ...base, paid_until: oct20 }, now).accessState, ACCESS_STATES.PAID_ACTIVE);
assert.equal(resolveEntitlement({ ...base, paid_until: past }, now).accessState, ACCESS_STATES.PAID_INACTIVE);
assert.equal(resolveEntitlement({ ...base, current_period_end: sep20 }, now).accessState, ACCESS_STATES.PAID_ACTIVE);
assert.equal(resolveEntitlement({ ...base, current_period_end: sep20, paid_until: oct20 }, now).effectivePaidEnd, Date.parse(oct20));
assert.equal(resolveEntitlement({ ...base, current_period_end: past, paid_until: past }, now).tier, 0);
assert.equal(resolveEntitlement({ ...base, plan_id: "essentials", paid_until: oct20 }, now).planId, "essentials");
assert.equal(resolveEntitlement({ ...base, provider: "unknown", paid_until: oct20 }, now).accessState, ACCESS_STATES.FREE);
assert.ok(PAID_PROVIDERS.has("whop") && PAID_PROVIDERS.has("gcash_manual") && PAID_PROVIDERS.has("paymongo"));

// Whop cancellation/refund status cannot erase a future PayMongo lane.
assert.equal(resolveEntitlement({
  provider: "whop", plan_id: "performance", status: "expired",
  current_period_end: past, paid_until: oct20
}, now).accessState, ACCESS_STATES.PAID_ACTIVE);
// A PayMongo refund/expiry cannot erase a valid Whop period.
assert.equal(resolveEntitlement({
  provider: "whop", plan_id: "performance", status: "active",
  current_period_end: sep20, paid_until: past
}, now).accessState, ACCESS_STATES.PAID_ACTIVE);
// Manual GCash remains unchanged.
assert.equal(resolveEntitlement({
  provider: "gcash_manual", plan_id: "performance", status: "active",
  current_period_end: sep20, paid_until: null
}, now).accessState, ACCESS_STATES.PAID_ACTIVE);

assert.equal(subscriptionSummary({ ...base, current_period_end: sep20, paid_until: oct20 }, now).expiresAt, oct20);

const clientSource = readFileSync("./js/features.js", "utf8");
const sandbox = {
  window: {}, console,
  supabaseClient: { auth: { getUser: async () => ({ data: { user: null } }) } }
};
vm.runInNewContext(clientSource, sandbox);
const cases = [
  { ...base, paid_until: oct20 },
  { ...base, paid_until: past },
  { ...base, current_period_end: sep20, paid_until: oct20 },
  { provider: "whop", plan_id: "performance", status: "expired", paid_until: oct20 },
  { provider: "gcash_manual", plan_id: "performance", status: "active", current_period_end: sep20 },
  { ...base, provider: "unknown", paid_until: oct20 }
];
for (const row of cases) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.window.AthlevoPlan._resolveEntitlement(row, now))),
    JSON.parse(JSON.stringify(resolveEntitlement(row, now)))
  );
}

const migration = readFileSync("./migrations/2026-08-16_paymongo_entitlements.sql", "utf8");
assert.match(migration, /add column if not exists paid_until timestamptz/i);
assert.match(migration, /create table if not exists public\.payment_transactions/i);
assert.match(migration, /monthly_price_cents = 59700/i);
assert.match(migration, /revoke all on function public\.apply_paymongo_payment[\s\S]*from public, anon, authenticated/i);
assert.match(migration, /current_period_end[\s\S]*paid_until/i);

console.log("PayMongo entitlement: 18 assertions passed");

/*
 * Entitlement provider tests — gcash_manual, Whop, trial, and unsupported.
 *
 * Validates that resolveEntitlement and canUse correctly handle:
 *   1. active gcash_manual → paid_active
 *   2. expired gcash_manual → no paid access
 *   3. active Whop → paid_active
 *   4. Athlevo trial (free plan) behaviour unchanged
 *   5. unsupported provider remains blocked
 *
 * Run: node tests/entitlement-providers.test.mjs
 */

import {
  ACCESS_STATES,
  PAID_PROVIDERS,
  resolveEntitlement,
  canUse
} from "../lib/server/features.js";

let passed = 0, failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name); }
};
const section = s => console.log(`\n──── ${s} ────`);

const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
const pastDate = new Date(Date.now() - 1 * 86400000).toISOString();

/* ──── 1. Active gcash_manual → paid_active ──── */
section("Active gcash_manual");

const gcashActive = {
  plan_id: "performance",
  provider: "gcash_manual",
  status: "active",
  current_period_end: futureDate
};
const gcashEnt = resolveEntitlement(gcashActive);

test("gcash_manual active resolves to paid_active",
  gcashEnt.accessState === ACCESS_STATES.PAID_ACTIVE);
test("gcash_manual active tier is 2 (performance)",
  gcashEnt.tier === 2);
test("gcash_manual active planId is performance",
  gcashEnt.planId === "performance");
test("gcash_manual active unlocks adaptive_ai",
  canUse("adaptive_ai", gcashActive));
test("gcash_manual active unlocks daily_brief",
  canUse("daily_brief", gcashActive));
test("gcash_manual active unlocks workout_modifications",
  canUse("workout_modifications", gcashActive));
test("gcash_manual active unlocks free coach_chat",
  canUse("coach_chat", gcashActive));

/* ──── 2. Expired gcash_manual → no paid access ──── */
section("Expired gcash_manual");

const gcashExpired = {
  plan_id: "performance",
  provider: "gcash_manual",
  status: "active",
  current_period_end: pastDate
};
const gcashExpEnt = resolveEntitlement(gcashExpired);

test("gcash_manual expired resolves to paid_inactive",
  gcashExpEnt.accessState === ACCESS_STATES.PAID_INACTIVE);
test("gcash_manual expired tier drops to 0",
  gcashExpEnt.tier === 0);
test("gcash_manual expired cannot use adaptive_ai",
  !canUse("adaptive_ai", gcashExpired));
test("gcash_manual expired cannot use daily_brief",
  !canUse("daily_brief", gcashExpired));
test("gcash_manual expired keeps free coach_chat",
  canUse("coach_chat", gcashExpired));

const gcashStatusExpired = {
  plan_id: "performance",
  provider: "gcash_manual",
  status: "expired",
  current_period_end: futureDate
};
const gcashStatusExpEnt = resolveEntitlement(gcashStatusExpired);
test("gcash_manual status=expired resolves to paid_inactive",
  gcashStatusExpEnt.accessState === ACCESS_STATES.PAID_INACTIVE);

/* ──── 3. Active Whop → paid_active ──── */
section("Active Whop");

const whopActive = {
  plan_id: "performance",
  provider: "whop",
  status: "active",
  current_period_end: futureDate
};
const whopEnt = resolveEntitlement(whopActive);

test("Whop active resolves to paid_active",
  whopEnt.accessState === ACCESS_STATES.PAID_ACTIVE);
test("Whop active tier is 2",
  whopEnt.tier === 2);
test("Whop active planId is performance",
  whopEnt.planId === "performance");
test("Whop active unlocks adaptive_ai",
  canUse("adaptive_ai", whopActive));
test("Whop active unlocks daily_brief",
  canUse("daily_brief", whopActive));

// Whop with any non-free plan_id still maps to performance
const whopAnyPlan = {
  plan_id: "some_whop_plan",
  provider: "whop",
  status: "active",
  current_period_end: futureDate
};
test("Whop with arbitrary plan_id still maps to performance",
  resolveEntitlement(whopAnyPlan).planId === "performance");

/* ──── 4. Athlevo trial / free behaviour unchanged ──── */
section("Trial / Free behaviour");

const noSub = null;
test("null subscription resolves to free",
  resolveEntitlement(noSub).accessState === ACCESS_STATES.FREE);
test("null subscription tier is 0",
  resolveEntitlement(noSub).tier === 0);
test("null subscription allows coach_chat",
  canUse("coach_chat", noSub));
test("null subscription blocks adaptive_ai",
  !canUse("adaptive_ai", noSub));

const freeSub = {
  plan_id: "free",
  provider: "whop",
  status: "active"
};
test("explicit free plan resolves to free",
  resolveEntitlement(freeSub).accessState === ACCESS_STATES.FREE);

const freeGcash = {
  plan_id: "free",
  provider: "gcash_manual",
  status: "active"
};
test("gcash_manual with plan_id=free resolves to free",
  resolveEntitlement(freeGcash).accessState === ACCESS_STATES.FREE);

/* ──── 5. Unsupported provider remains blocked ──── */
section("Unsupported provider");

const unknownProvider = {
  plan_id: "performance",
  provider: "stripe",
  status: "active",
  current_period_end: futureDate
};
const unknownEnt = resolveEntitlement(unknownProvider);

test("unsupported provider resolves to free",
  unknownEnt.accessState === ACCESS_STATES.FREE);
test("unsupported provider tier is 0",
  unknownEnt.tier === 0);
test("unsupported provider cannot use adaptive_ai",
  !canUse("adaptive_ai", unknownProvider));

const emptyProvider = {
  plan_id: "performance",
  provider: "",
  status: "active",
  current_period_end: futureDate
};
test("empty provider resolves to free",
  resolveEntitlement(emptyProvider).accessState === ACCESS_STATES.FREE);

const noProvider = {
  plan_id: "performance",
  status: "active",
  current_period_end: futureDate
};
test("missing provider resolves to free",
  resolveEntitlement(noProvider).accessState === ACCESS_STATES.FREE);

/* ──── PAID_PROVIDERS allowlist ──── */
section("PAID_PROVIDERS allowlist");

test("PAID_PROVIDERS contains whop", PAID_PROVIDERS.has("whop"));
test("PAID_PROVIDERS contains gcash_manual", PAID_PROVIDERS.has("gcash_manual"));
test("PAID_PROVIDERS does not contain stripe", !PAID_PROVIDERS.has("stripe"));
test("PAID_PROVIDERS does not contain founding_beta", !PAID_PROVIDERS.has("founding_beta"));

/* ──── cancelled but within period ──── */
section("Cancelled within period");

const gcashCancelled = {
  plan_id: "performance",
  provider: "gcash_manual",
  status: "cancelled",
  current_period_end: futureDate
};
test("gcash_manual cancelled with future period_end is still paid_active",
  resolveEntitlement(gcashCancelled).accessState === ACCESS_STATES.PAID_ACTIVE);

const gcashCancelledPast = {
  plan_id: "performance",
  provider: "gcash_manual",
  status: "cancelled",
  current_period_end: pastDate
};
test("gcash_manual cancelled with past period_end is paid_inactive",
  resolveEntitlement(gcashCancelledPast).accessState === ACCESS_STATES.PAID_INACTIVE);

/* ──── summary ──── */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

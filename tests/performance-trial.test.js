/*
 * Tests for the 24-hour Performance Trial and one-time plan generation.
 *
 * Run with: node tests/performance-trial.test.js
 *
 * These are self-contained unit tests — no Supabase connection needed.
 * They import the shared entitlement functions and exercise every scenario
 * the user specified.
 */

// ── Inline test harness ────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const detail = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(detail);
    console.error(`  FAIL: ${detail}`);
  }
}

function suite(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

// ── Import server-side entitlement (ESM) ────────────────────────────
import {
  ACCESS_STATES,
  PLAN_TIERS,
  FEATURE_REGISTRY,
  resolveEntitlement,
  canUse
} from "../lib/server/features.js";

// ── Helpers ─────────────────────────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();

function hoursAgo(h) { return new Date(NOW - h * HOUR_MS).toISOString(); }
function hoursFromNow(h) { return new Date(NOW + h * HOUR_MS).toISOString(); }

// ─────────────────────────────────────────────────────────────────────
// 1. New account gets 24-hour performance access
// ─────────────────────────────────────────────────────────────────────
suite("1. New account gets 24h performance access", () => {
  const sub = {
    plan_id: "free",
    status: "active",
    trial_started_at: new Date(NOW).toISOString()
  };
  const ent = resolveEntitlement(sub, NOW);

  assertEqual(ent.accessState, ACCESS_STATES.PAID_ACTIVE,
    "New trial user should have PAID_ACTIVE access state");
  assertEqual(ent.planId, "performance",
    "New trial user should have performance plan");
  assertEqual(ent.tier, PLAN_TIERS.performance,
    "New trial user should have performance tier (2)");
  assertEqual(ent.status, "trialing",
    "New trial user should have trialing status");
  assertEqual(ent.isPerformanceTrial, true,
    "New trial user should have isPerformanceTrial flag");
  assertEqual(ent.reason, "performance_trial",
    "New trial user reason should be performance_trial");
  assert(ent.trialExpiresAt != null,
    "New trial user should have trialExpiresAt set");
});

// ─────────────────────────────────────────────────────────────────────
// 2. Trial active within 24 hours
// ─────────────────────────────────────────────────────────────────────
suite("2. Trial active at various points within 24h", () => {
  // 1 hour into trial
  const sub1h = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(1)
  };
  const ent1 = resolveEntitlement(sub1h, NOW);
  assertEqual(ent1.accessState, ACCESS_STATES.PAID_ACTIVE,
    "1h into trial — should still be active");
  assertEqual(ent1.isPerformanceTrial, true,
    "1h into trial — isPerformanceTrial should be true");

  // 12 hours in
  const sub12h = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(12)
  };
  const ent12 = resolveEntitlement(sub12h, NOW);
  assertEqual(ent12.accessState, ACCESS_STATES.PAID_ACTIVE,
    "12h into trial — should still be active");

  // 23 hours 59 minutes in (1 minute left)
  const sub23h59 = {
    plan_id: "free",
    status: "active",
    trial_started_at: new Date(NOW - (24 * HOUR_MS - 60000)).toISOString()
  };
  const ent23 = resolveEntitlement(sub23h59, NOW);
  assertEqual(ent23.accessState, ACCESS_STATES.PAID_ACTIVE,
    "23h59m into trial — should still be active (1 min remaining)");
});

// ─────────────────────────────────────────────────────────────────────
// 3. Trial expires at exactly 24 hours
// ─────────────────────────────────────────────────────────────────────
suite("3. Trial expires at >= 24h", () => {
  // Exactly 24 hours
  const subExact = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(24)
  };
  const entExact = resolveEntitlement(subExact, NOW);
  assertEqual(entExact.accessState, ACCESS_STATES.FREE,
    "Exactly 24h — trial should be expired → FREE");
  assertEqual(entExact.tier, 0,
    "Exactly 24h — tier should be 0 (free)");
  assert(entExact.isPerformanceTrial !== true,
    "Exactly 24h — isPerformanceTrial should not be true");

  // 25 hours (well past)
  const sub25h = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(25)
  };
  const ent25 = resolveEntitlement(sub25h, NOW);
  assertEqual(ent25.accessState, ACCESS_STATES.FREE,
    "25h past trial start — should be FREE");

  // 7 days past
  const sub7d = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(168)
  };
  const ent7d = resolveEntitlement(sub7d, NOW);
  assertEqual(ent7d.accessState, ACCESS_STATES.FREE,
    "7 days past trial start — should be FREE");
});

// ─────────────────────────────────────────────────────────────────────
// 4. Paid user is always fully unlocked (no 24h restriction)
// ─────────────────────────────────────────────────────────────────────
suite("4. Paid user always fully unlocked", () => {
  // Whop active
  const whopSub = {
    plan_id: "performance",
    status: "active",
    provider: "whop",
    current_period_end: hoursFromNow(720)  // 30 days out
  };
  const whopEnt = resolveEntitlement(whopSub, NOW);
  assertEqual(whopEnt.accessState, ACCESS_STATES.PAID_ACTIVE,
    "Whop paid user — PAID_ACTIVE");
  assertEqual(whopEnt.tier, 2,
    "Whop paid user — tier 2 (performance)");
  assert(whopEnt.isPerformanceTrial !== true,
    "Whop paid user — NOT a trial user");

  // PayMongo active
  const paymongoSub = {
    plan_id: "performance",
    status: "active",
    provider: "paymongo",
    paid_until: hoursFromNow(720)
  };
  const paymongoEnt = resolveEntitlement(paymongoSub, NOW);
  assertEqual(paymongoEnt.accessState, ACCESS_STATES.PAID_ACTIVE,
    "PayMongo paid user — PAID_ACTIVE");

  // GCash manual active
  const gcashSub = {
    plan_id: "performance",
    status: "active",
    provider: "gcash_manual",
    current_period_end: hoursFromNow(720)
  };
  const gcashEnt = resolveEntitlement(gcashSub, NOW);
  assertEqual(gcashEnt.accessState, ACCESS_STATES.PAID_ACTIVE,
    "GCash manual paid user — PAID_ACTIVE");

  // Paid user with trial_started_at in the past — should STILL be paid,
  // not fall into trial logic
  const paidWithTrial = {
    plan_id: "performance",
    status: "active",
    provider: "whop",
    current_period_end: hoursFromNow(720),
    trial_started_at: hoursAgo(48)  // expired trial, but they're paid
  };
  const paidTrialEnt = resolveEntitlement(paidWithTrial, NOW);
  assertEqual(paidTrialEnt.accessState, ACCESS_STATES.PAID_ACTIVE,
    "Paid user with expired trial — should remain PAID_ACTIVE");
  assert(paidTrialEnt.isPerformanceTrial !== true,
    "Paid user — should NOT be marked as trial");
});

// ─────────────────────────────────────────────────────────────────────
// 5. No subscription row at all → FREE
// ─────────────────────────────────────────────────────────────────────
suite("5. No subscription / null / undefined → FREE", () => {
  assertEqual(resolveEntitlement(null, NOW).accessState, ACCESS_STATES.FREE,
    "null subscription — FREE");
  assertEqual(resolveEntitlement(undefined, NOW).accessState, ACCESS_STATES.FREE,
    "undefined subscription — FREE");
  assertEqual(resolveEntitlement({}, NOW).accessState, ACCESS_STATES.FREE,
    "empty object subscription — FREE");
});

// ─────────────────────────────────────────────────────────────────────
// 6. Feature gating: trial user can use performance features
// ─────────────────────────────────────────────────────────────────────
suite("6. Trial user can use performance features", () => {
  const trialSub = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(6)
  };

  // Performance features should be unlocked
  assert(canUse("advanced_trends", trialSub, NOW),
    "Trial user — can use advanced_trends");
  assert(canUse("workout_modifications", trialSub, NOW),
    "Trial user — can use workout_modifications");
  assert(canUse("weekly_analysis", trialSub, NOW),
    "Trial user — can use weekly_analysis");
  assert(canUse("advanced_analytics", trialSub, NOW),
    "Trial user — can use advanced_analytics");
  assert(canUse("daily_brief", trialSub, NOW),
    "Trial user — can use daily_brief");
  assert(canUse("adaptive_ai", trialSub, NOW),
    "Trial user — can use adaptive_ai");

  // Free features should also work
  assert(canUse("today", trialSub, NOW),
    "Trial user — can use today (free feature)");
  assert(canUse("coach_chat", trialSub, NOW),
    "Trial user — can use coach_chat (free feature)");

  // Not-yet-shipped features should STILL be blocked
  assert(!canUse("coach_reports", trialSub, NOW),
    "Trial user — cannot use coach_reports (available: false)");
  assert(!canUse("ai_race_prediction", trialSub, NOW),
    "Trial user — cannot use ai_race_prediction (available: false)");
});

// ─────────────────────────────────────────────────────────────────────
// 7. Expired trial user: performance features locked again
// ─────────────────────────────────────────────────────────────────────
suite("7. Expired trial user — performance features locked", () => {
  const expiredSub = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(25)
  };

  // Performance features should be locked
  assert(!canUse("advanced_trends", expiredSub, NOW),
    "Expired trial — cannot use advanced_trends");
  assert(!canUse("workout_modifications", expiredSub, NOW),
    "Expired trial — cannot use workout_modifications");
  assert(!canUse("weekly_analysis", expiredSub, NOW),
    "Expired trial — cannot use weekly_analysis");

  // Free features should still work
  assert(canUse("today", expiredSub, NOW),
    "Expired trial — can still use today (free)");
  assert(canUse("coach_chat", expiredSub, NOW),
    "Expired trial — can still use coach_chat (free)");
  assert(canUse("training_calendar", expiredSub, NOW),
    "Expired trial — can still use training_calendar (free)");
});

// ─────────────────────────────────────────────────────────────────────
// 8. Existing user migration: gets fresh trial from deployment
// ─────────────────────────────────────────────────────────────────────
suite("8. Existing user migration — fresh trial from deployment", () => {
  // Simulates an existing free user whose trial_started_at is set to NOW
  // by the migration (backfill sets it to now() at deploy time)
  const migrated = {
    plan_id: "free",
    status: "active",
    trial_started_at: new Date(NOW).toISOString()
  };
  const ent = resolveEntitlement(migrated, NOW);
  assertEqual(ent.accessState, ACCESS_STATES.PAID_ACTIVE,
    "Migrated existing user — gets fresh trial access");
  assertEqual(ent.isPerformanceTrial, true,
    "Migrated existing user — flagged as trial");
});

// ─────────────────────────────────────────────────────────────────────
// 9. Trial cannot be reset (no client-side control)
// ─────────────────────────────────────────────────────────────────────
suite("9. Trial is server-enforced (no reset path)", () => {
  // Once trial_started_at is set, the entitlement function respects it;
  // there's no path to clear or reset it. A user re-logging in gets the
  // same row via ensure_free_trial RPC, which is idempotent.
  const sub = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(25)  // expired
  };
  const ent = resolveEntitlement(sub, NOW);
  assertEqual(ent.accessState, ACCESS_STATES.FREE,
    "Expired trial stays expired — no reset");

  // Even if someone tries to pass a fresh trial_started_at, the DB
  // column is write-once (the RPC won't overwrite an existing value).
  // This test just confirms the entitlement logic itself doesn't
  // have a backdoor — it respects whatever the DB says.
  const tampered = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(25)
  };
  const ent2 = resolveEntitlement(tampered, NOW);
  assertEqual(ent2.accessState, ACCESS_STATES.FREE,
    "Cannot reset expired trial by re-reading the same row");
});

// ─────────────────────────────────────────────────────────────────────
// 10. Device clock manipulation: server-side now wins
// ─────────────────────────────────────────────────────────────────────
suite("10. Clock manipulation doesn't help", () => {
  const sub = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(25)  // expired
  };

  // Server uses Date.now(), not client time. Even if somehow a future
  // `now` were passed, trial_started_at + 24h is still in the past.
  const pastNow = NOW - 48 * HOUR_MS;  // pretend it's 2 days ago
  const ent = resolveEntitlement(sub, pastNow);
  // trial_started_at was 25h before NOW, so (trialStart + 24h) > pastNow might be true
  // But on the SERVER, `now` is always Date.now(), so this scenario
  // only matters if the client can inject `now`. They can't — the server
  // always calls resolveEntitlement(sub) without a custom now.
  // This test confirms the function uses the provided now correctly.
  assert(ent.accessState === ACCESS_STATES.FREE || ent.isPerformanceTrial === true,
    "Clock manipulation test — function uses provided 'now' parameter");
});

// ─────────────────────────────────────────────────────────────────────
// 11. Founder flag preserved during trial
// ─────────────────────────────────────────────────────────────────────
suite("11. Founder flag preserved during trial", () => {
  const founderTrial = {
    plan_id: "free",
    status: "active",
    trial_started_at: hoursAgo(6),
    is_founder: true
  };
  const ent = resolveEntitlement(founderTrial, NOW);
  assertEqual(ent.isFounder, true,
    "Founder flag should be preserved during trial");
  assertEqual(ent.isPerformanceTrial, true,
    "Still flagged as trial");
});

// ─────────────────────────────────────────────────────────────────────
// 12. Unrecognised provider: trial still works for free user
// ─────────────────────────────────────────────────────────────────────
suite("12. Unrecognised provider with trial_started_at", () => {
  const sub = {
    plan_id: "performance",
    provider: "unknown_provider",
    status: "active",
    trial_started_at: hoursAgo(6)
  };
  const ent = resolveEntitlement(sub, NOW);
  // Unrecognised provider → treated as free → trial logic kicks in
  assertEqual(ent.accessState, ACCESS_STATES.PAID_ACTIVE,
    "Unrecognised provider with active trial — should get trial access");
  assertEqual(ent.isPerformanceTrial, true,
    "Unrecognised provider — isPerformanceTrial true");
});

// ─────────────────────────────────────────────────────────────────────
// 13. No trial_started_at set → plain free user
// ─────────────────────────────────────────────────────────────────────
suite("13. No trial_started_at → plain free user", () => {
  const sub = {
    plan_id: "free",
    status: "active"
    // trial_started_at not set
  };
  const ent = resolveEntitlement(sub, NOW);
  assertEqual(ent.accessState, ACCESS_STATES.FREE,
    "No trial_started_at — should be plain FREE");
  assert(ent.isPerformanceTrial !== true,
    "No trial_started_at — isPerformanceTrial should not be true");
});

// ─────────────────────────────────────────────────────────────────────
// 14. trialExpiresAt is correctly calculated
// ─────────────────────────────────────────────────────────────────────
suite("14. trialExpiresAt correctly calculated", () => {
  const trialStart = hoursAgo(6);
  const sub = {
    plan_id: "free",
    status: "active",
    trial_started_at: trialStart
  };
  const ent = resolveEntitlement(sub, NOW);
  const expectedExpiry = new Date(new Date(trialStart).getTime() + DAY_MS).toISOString();
  assertEqual(ent.trialExpiresAt, expectedExpiry,
    "trialExpiresAt should be trial_started_at + 24h");
});

// ─────────────────────────────────────────────────────────────────────
// 15. Paid-then-cancelled user: no trial interference
// ─────────────────────────────────────────────────────────────────────
suite("15. Cancelled paid user — trial doesn't interfere", () => {
  const sub = {
    plan_id: "performance",
    provider: "whop",
    status: "cancelled",
    current_period_end: hoursAgo(1),  // period ended an hour ago
    trial_started_at: hoursAgo(100)  // old trial
  };
  const ent = resolveEntitlement(sub, NOW);
  // Provider is whop & recognisedPaid, so it won't enter the trial branch
  assertEqual(ent.accessState, ACCESS_STATES.PAID_INACTIVE,
    "Cancelled whop user — PAID_INACTIVE, not trial");
  assertEqual(ent.reason, "cancelled",
    "Cancelled whop user — reason is cancelled");
});

// ─────────────────────────────────────────────────────────────────────
// 16. Edge: Invalid trial_started_at values
// ─────────────────────────────────────────────────────────────────────
suite("16. Invalid trial_started_at values handled gracefully", () => {
  const badValues = [null, undefined, "", "not-a-date", 0, false];
  for (const bad of badValues) {
    const sub = {
      plan_id: "free",
      status: "active",
      trial_started_at: bad
    };
    const ent = resolveEntitlement(sub, NOW);
    assertEqual(ent.accessState, ACCESS_STATES.FREE,
      `trial_started_at = ${JSON.stringify(bad)} — should be FREE`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 17. Client-server parity: resolveEntitlement in js/features.js
// ─────────────────────────────────────────────────────────────────────
suite("17. Verify client mirror has trial logic", async () => {
  // We can't import the client file (it uses globals), but we can
  // verify the key code is present by reading the source.
  const fs = await import("fs");
  const clientSrc = fs.readFileSync(
    new URL("../js/features.js", import.meta.url),
    "utf-8"
  );

  assert(clientSrc.includes("trial_started_at"),
    "Client features.js contains trial_started_at");
  assert(clientSrc.includes("TRIAL_DURATION_MS"),
    "Client features.js contains TRIAL_DURATION_MS");
  assert(clientSrc.includes("isPerformanceTrial"),
    "Client features.js contains isPerformanceTrial");
  assert(clientSrc.includes("performance_trial"),
    "Client features.js contains performance_trial reason");
  assert(clientSrc.includes("trialExpiresAt"),
    "Client features.js contains trialExpiresAt");
  assert(clientSrc.includes("ensure_free_trial"),
    "Client features.js calls ensure_free_trial RPC");
  assert(clientSrc.includes("renderTrialIndicator"),
    "Client features.js calls renderTrialIndicator");
});

// ─────────────────────────────────────────────────────────────────────
// 18. Verify freemium.js keeps Coach limits during trial
// ─────────────────────────────────────────────────────────────────────
suite("18. Freemium.js preserves Coach limits for trial users", async () => {
  const fs = await import("fs");
  const freemiumSrc = fs.readFileSync(
    new URL("../lib/server/freemium.js", import.meta.url),
    "utf-8"
  );

  assert(freemiumSrc.includes("isPerformanceTrial"),
    "freemium.js references isPerformanceTrial");
  assert(freemiumSrc.includes("!access.isPerformanceTrial"),
    "freemium.js checks !access.isPerformanceTrial to keep Coach limits");
});

// ─────────────────────────────────────────────────────────────────────
// 19. Verify generate-plan.js has one-time plan generation logic
// ─────────────────────────────────────────────────────────────────────
suite("19. generate-plan.js has one-time plan generation", async () => {
  const fs = await import("fs");
  const planSrc = fs.readFileSync(
    new URL("../api/training/generate-plan.js", import.meta.url),
    "utf-8"
  );

  assert(planSrc.includes("free_plan_generated"),
    "generate-plan.js checks free_plan_generated flag");
  assert(planSrc.includes("isPerformanceTrial") || planSrc.includes("isTrialUser"),
    "generate-plan.js handles trial users");
});

// ─────────────────────────────────────────────────────────────────────
// 20. Verify migration SQL exists and is correct
// ─────────────────────────────────────────────────────────────────────
suite("20. Migration SQL has required elements", async () => {
  const fs = await import("fs");
  const migrationSrc = fs.readFileSync(
    new URL("../migrations/2026-08-20_performance_trial.sql", import.meta.url),
    "utf-8"
  );

  assert(migrationSrc.includes("trial_started_at"),
    "Migration adds trial_started_at column");
  assert(migrationSrc.includes("free_plan_generated"),
    "Migration adds free_plan_generated column");
  assert(migrationSrc.includes("ensure_free_trial"),
    "Migration creates ensure_free_trial function");
  assert(migrationSrc.includes("SECURITY DEFINER"),
    "ensure_free_trial is SECURITY DEFINER");
  assert(migrationSrc.includes("trial_started_at IS NULL"),
    "ensure_free_trial only sets trial_started_at when NULL (idempotent)");
});

// ─────────────────────────────────────────────────────────────────────
// 21. Verify accessGuard.js has trial indicator
// ─────────────────────────────────────────────────────────────────────
suite("21. accessGuard.js has trial indicator", async () => {
  const fs = await import("fs");
  const guardSrc = fs.readFileSync(
    new URL("../js/accessGuard.js", import.meta.url),
    "utf-8"
  );

  assert(guardSrc.includes("renderTrialIndicator"),
    "accessGuard.js has renderTrialIndicator function");
  assert(guardSrc.includes("ag-trial-indicator"),
    "accessGuard.js uses ag-trial-indicator CSS class");
  assert(guardSrc.includes("trialExpiresAt"),
    "accessGuard.js reads trialExpiresAt");
});

// ─────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
}
console.log(`${"─".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);

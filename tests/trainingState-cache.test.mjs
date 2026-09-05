/**
 * trainingState cache safety tests
 *
 * Focused tests for:
 *   1. Same user, cache hit within TTL
 *   2. Two concurrent requests same user → one underlying fetch
 *   3. invalidateCache() forces next request fresh
 *   4. Inflight stale write race (generation safety)
 *   5. User switch — B cannot receive A's cached state
 *   6. Inflight user switch — A's result must not populate B's cache
 *   7–9. Activity sync / reanalysis / wellness refresh trigger invalidation
 *   10. Readiness does NOT unnecessarily invalidate trainingState
 *   11. Failed mutation does NOT invalidate
 *
 * Run: node tests/trainingState-cache.test.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── Helpers ──────────────────────────────────────────────────────────── */

let fetchCount = 0;
let currentUserId = "user-A";

/**
 * Build a fresh window-like global, load the IIFE, and return
 * the AthlevoTrainingState API plus test hooks.
 */
function createTestEnv(opts = {}) {
  fetchCount = 0;

  const fakeWindow = {
    supabaseClient: {
      auth: {
        getUser: async () => ({
          data: { user: { id: currentUserId } }
        })
      }
    },
    AthlevoBrain: {
      loadProviderTrends: async () => ({
        days: [
          { date: "2026-08-28", fitness: 40, fatigue: 30, form: 10 },
          { date: "2026-09-04", fitness: 42, fatigue: 32, form: 10 }
        ]
      })
    },
    AthleteEngine: {
      computeAthleteMetrics: (input) => {
        fetchCount++;
        return {
          detail: {
            acwr: 1.1 + fetchCount * 0.01,
            trainingBalance: "balanced",
            recoveryTrendPct: -5
          },
          snapshot: {
            weekly_training_load: 200 + fetchCount
          }
        };
      }
    },
    AthlevoTrendsAnalytics: {
      classifyForm: (form) => ({ key: form >= 5 ? "fresh" : "tired" })
    }
  };

  // Override with test-specific mocks
  if (opts.supabaseClient !== undefined) {
    fakeWindow.supabaseClient = opts.supabaseClient;
  }
  if (opts.AthlevoBrain !== undefined) {
    fakeWindow.AthlevoBrain = opts.AthlevoBrain;
  }
  if (opts.AthleteEngine !== undefined) {
    fakeWindow.AthleteEngine = opts.AthleteEngine;
  }

  // Load the IIFE source and execute it against our fake window
  const src = readFileSync(
    resolve(__dirname, "..", "js", "trainingState.js"),
    "utf8"
  );

  // The IIFE expects `window` as its argument. We replace the last
  // `})(window);` with `})(fakeWindow);` and eval in a closure.
  const modifiedSrc = src.replace(/\}\)\(window\);[\s]*$/, "})(fakeWindow);");
  const fn = new Function("fakeWindow", modifiedSrc);
  fn(fakeWindow);

  return {
    api: fakeWindow.AthlevoTrainingState,
    window: fakeWindow
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ── Tests ────────────────────────────────────────────────────────────── */

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.message });
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\ntrainingState cache safety tests\n");

// ─── Test 1: Same user, cache hit within TTL ────────────────────────
await test("1. Same user cache hit within TTL", async () => {
  currentUserId = "user-A";
  fetchCount = 0;
  const { api } = createTestEnv();

  const first = await api.getTrainingState({ activities: [] });
  assert.ok(first, "first call should return state");
  assert.equal(fetchCount, 1, "first call should fetch");

  const second = await api.getTrainingState({ activities: [] });
  assert.ok(second, "second call should return state");
  assert.equal(fetchCount, 1, "second call should use cache, not fetch again");
  assert.deepEqual(first, second, "cached value matches original");
});

// ─── Test 2: Two concurrent requests → one fetch ────────────────────
await test("2. Concurrent requests share one fetch", async () => {
  currentUserId = "user-A";

  // Use a delayed loadProviderTrends so the inflight Promise stays pending
  // long enough for the second call to see it and piggyback.
  let providerCallCount = 0;
  let resolveProvider;
  const { api } = createTestEnv({
    AthlevoBrain: {
      loadProviderTrends: () => {
        providerCallCount++;
        return new Promise(r => {
          resolveProvider = () => r({
            days: [{ date: "2026-09-04", fitness: 42, fatigue: 32, form: 10 }]
          });
        });
      }
    }
  });

  const p1 = api.getTrainingState({ activities: [] });
  // Wait for p1's _resolveUserId() microtask to complete and set _cache.inflight
  await sleep(50);
  const p2 = api.getTrainingState({ activities: [] });

  // Resolve the provider fetch
  await sleep(10);
  resolveProvider();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1, "first concurrent call returns state");
  assert.ok(r2, "second concurrent call returns state");
  assert.equal(providerCallCount, 1, "only one provider fetch for two concurrent requests");
  assert.deepEqual(r1, r2, "both callers get the same object");
});

// ─── Test 3: invalidateCache() forces next request fresh ────────────
await test("3. invalidateCache() forces fresh fetch", async () => {
  currentUserId = "user-A";
  fetchCount = 0;
  const { api } = createTestEnv();

  const first = await api.getTrainingState({ activities: [] });
  assert.equal(fetchCount, 1);

  api.invalidateCache();

  const second = await api.getTrainingState({ activities: [] });
  assert.equal(fetchCount, 2, "should fetch again after invalidation");
  // The acwr changes with fetchCount, so values differ
  assert.notEqual(first.acwr, second.acwr, "new fetch should produce different metrics");
});

// ─── Test 4: Inflight stale write race ──────────────────────────────
await test("4. Inflight stale write race — stale result does NOT repopulate cache", async () => {
  currentUserId = "user-A";
  fetchCount = 0;

  let resolveStaleProvider;
  let providerCallCount = 0;

  const { api } = createTestEnv({
    AthlevoBrain: {
      loadProviderTrends: () => {
        providerCallCount++;
        const callNum = providerCallCount;
        if (callNum === 1) {
          // First call: slow — will be stale by the time it resolves
          return new Promise(r => {
            resolveStaleProvider = () => r({
              days: [{ date: "2026-09-04", fitness: 40, fatigue: 30, form: 10 }]
            });
          });
        }
        // Second call: resolves immediately with newer data
        return Promise.resolve({
          days: [{ date: "2026-09-04", fitness: 99, fatigue: 50, form: 49 }]
        });
      }
    }
  });

  // Start fetch A (slow)
  const promiseA = api.getTrainingState({ activities: [] });
  await sleep(5);

  // Invalidate while fetch A is in flight
  api.invalidateCache();

  // Start fetch B (fast — resolves immediately)
  const promiseB = api.getTrainingState({ activities: [] });
  const resultB = await promiseB;
  assert.equal(resultB.fitness, 99, "fetch B should have new fitness=99");

  // Now resolve stale fetch A
  resolveStaleProvider();
  const resultA = await promiseA;
  // resultA should still return its data to the original caller
  assert.equal(resultA.fitness, 40, "fetch A caller gets its own result");

  // But the cache should NOT have been repopulated with stale data
  const resultC = await api.getTrainingState({ activities: [] });
  assert.equal(resultC.fitness, 99, "cache still holds fetch B's data, not stale A");
});

// ─── Test 5: User switch — B cannot get A's cached state ────────────
await test("5. User switch — Athlete B cannot receive Athlete A's cached state", async () => {
  currentUserId = "user-A";
  fetchCount = 0;
  const { api } = createTestEnv();

  const stateA = await api.getTrainingState({ activities: [] });
  assert.ok(stateA, "user A gets state");
  const fetchAfterA = fetchCount;

  // Switch to user B
  currentUserId = "user-B";

  const stateB = await api.getTrainingState({ activities: [] });
  assert.ok(stateB, "user B gets state");
  assert.ok(fetchCount > fetchAfterA, "user B triggered a new fetch");
  // The acwr includes fetchCount, so if B got A's cached state they'd be equal
  assert.notEqual(stateA.acwr, stateB.acwr, "B's state differs from A's");
});

// ─── Test 6: Inflight user switch — A's result must not populate B ──
await test("6. Inflight user switch — A's inflight must not populate B's cache", async () => {
  currentUserId = "user-A";
  fetchCount = 0;

  let resolveSlowProvider;
  let providerCallCount = 0;

  const { api } = createTestEnv({
    AthlevoBrain: {
      loadProviderTrends: () => {
        providerCallCount++;
        const callNum = providerCallCount;
        if (callNum === 1) {
          // User A's fetch: slow
          return new Promise(r => {
            resolveSlowProvider = () => r({
              days: [{ date: "2026-09-04", fitness: 40, fatigue: 30, form: 10 }]
            });
          });
        }
        // User B's fetch: immediate
        return Promise.resolve({
          days: [{ date: "2026-09-04", fitness: 88, fatigue: 44, form: 44 }]
        });
      }
    }
  });

  // Start fetch for user A (slow)
  const promiseA = api.getTrainingState({ activities: [] });
  await sleep(5);

  // Switch to user B
  currentUserId = "user-B";

  // B triggers a fresh fetch (different user)
  const stateB = await api.getTrainingState({ activities: [] });
  assert.equal(stateB.fitness, 88, "B gets its own fresh data");

  // Now resolve A's slow fetch
  resolveSlowProvider();
  const stateA = await promiseA;
  assert.equal(stateA.fitness, 40, "A's caller still gets A's result");

  // Verify cache still holds B's data
  const stateCheck = await api.getTrainingState({ activities: [] });
  assert.equal(stateCheck.fitness, 88, "cache still holds B's data after A resolved");
});

// ─── Test 7: Activity sync triggers invalidation ────────────────────
await test("7. syncIntervals invalidates trainingState cache", async () => {
  // This test verifies the wiring in brain.js by checking that
  // invalidateCache is called. Since we can't run the full brain.js
  // (it has many dependencies), we verify the source code contains
  // the invalidation call at the right point.
  const brainSrc = readFileSync(
    resolve(__dirname, "..", "js", "brain.js"),
    "utf8"
  );

  // Find the syncIntervals function
  const syncIdx = brainSrc.indexOf("async function syncIntervals()");
  assert.ok(syncIdx > -1, "syncIntervals function exists");

  // Find invalidateActivityCache() call within syncIntervals
  const afterSync = brainSrc.indexOf("invalidateActivityCache()", syncIdx);
  assert.ok(afterSync > -1, "invalidateActivityCache called in syncIntervals");

  // Find AthlevoTrainingState.invalidateCache() call after it
  const tsInvalidate = brainSrc.indexOf("AthlevoTrainingState.invalidateCache()", afterSync);
  assert.ok(tsInvalidate > -1, "AthlevoTrainingState.invalidateCache() called after sync");

  // Verify it's within the syncIntervals function body (before the next
  // top-level function). The catch block follows.
  const nextFuncAfterSync = brainSrc.indexOf("async function ", syncIdx + 30);
  if (nextFuncAfterSync > -1) {
    assert.ok(tsInvalidate < nextFuncAfterSync,
      "trainingState invalidation is inside syncIntervals, not a later function");
  }
});

// ─── Test 8: Activity reanalysis triggers invalidation ──────────────
await test("8. reanalyzeActivities invalidates trainingState cache", async () => {
  const brainSrc = readFileSync(
    resolve(__dirname, "..", "js", "brain.js"),
    "utf8"
  );

  const reanalyzeIdx = brainSrc.indexOf("async function reanalyzeActivities(");
  assert.ok(reanalyzeIdx > -1, "reanalyzeActivities function exists");

  // The invalidation should be inside the `if (r && r.analyzed > 0)` block
  const analyzedCheck = brainSrc.indexOf("r.analyzed > 0", reanalyzeIdx);
  assert.ok(analyzedCheck > -1, "analyzed > 0 check exists");

  const tsInvalidate = brainSrc.indexOf("AthlevoTrainingState.invalidateCache()", analyzedCheck);
  assert.ok(tsInvalidate > -1, "AthlevoTrainingState.invalidateCache() called after reanalysis");

  // Verify it's within the reanalyzeActivities function
  const nextFunc = brainSrc.indexOf("async function ", reanalyzeIdx + 30);
  if (nextFunc > -1) {
    assert.ok(tsInvalidate < nextFunc,
      "trainingState invalidation is inside reanalyzeActivities");
  }
});

// ─── Test 9: Lap backfill triggers invalidation ─────────────────────
await test("9. Lap backfill invalidates trainingState cache", async () => {
  const brainSrc = readFileSync(
    resolve(__dirname, "..", "js", "brain.js"),
    "utf8"
  );

  // Find the lap backfill completion area (near "lap backfill] finished")
  const backfillFinished = brainSrc.indexOf("[lap backfill] finished");
  assert.ok(backfillFinished > -1, "lap backfill finished log exists");

  // The invalidation should be before the log (after invalidateActivityCache)
  const backfillInvalidateAC = brainSrc.lastIndexOf("invalidateActivityCache()", backfillFinished);
  assert.ok(backfillInvalidateAC > -1, "invalidateActivityCache called before backfill finished");

  const tsInvalidate = brainSrc.indexOf("AthlevoTrainingState.invalidateCache()", backfillInvalidateAC);
  assert.ok(tsInvalidate > -1 && tsInvalidate < backfillFinished,
    "AthlevoTrainingState.invalidateCache() called in lap backfill completion");
});

// ─── Test 10: Readiness does NOT invalidate trainingState ───────────
await test("10. Readiness is independent — no unnecessary trainingState invalidation", async () => {
  // Readiness (getReadinessForCoach / loadTodayReadinessForCoach) is a
  // separate system that queries Supabase fresh every Coach message.
  // Verify brain.js does not call AthlevoTrainingState.invalidateCache()
  // from any readiness-related function.
  const brainSrc = readFileSync(
    resolve(__dirname, "..", "js", "brain.js"),
    "utf8"
  );

  // Count total invalidation sites
  const invalidationSites = [];
  let searchFrom = 0;
  while (true) {
    const idx = brainSrc.indexOf("AthlevoTrainingState.invalidateCache()", searchFrom);
    if (idx === -1) break;
    invalidationSites.push(idx);
    searchFrom = idx + 1;
  }

  // Each site should be near a known mutation point, not readiness
  for (const site of invalidationSites) {
    // Check ~500 chars before the site for context
    const context = brainSrc.slice(Math.max(0, site - 500), site + 50);
    const nearReadiness = context.includes("readiness") || context.includes("Readiness");
    assert.ok(!nearReadiness,
      "AthlevoTrainingState.invalidateCache() should not appear near readiness code");
  }

  // Verify exactly 3 invalidation sites (sync, reanalyze, backfill)
  assert.equal(invalidationSites.length, 3,
    `Expected 3 invalidation sites, found ${invalidationSites.length}`);
});

// ─── Test 11: Failed mutation does NOT invalidate ───────────────────
await test("11. Failed sync does NOT invalidate trainingState cache", async () => {
  // The syncIntervals invalidation is BEFORE the catch block — it runs
  // only when providerRequest("sync") succeeds. Verify this by checking
  // that invalidateCache is called BEFORE the catch, not inside it.
  const brainSrc = readFileSync(
    resolve(__dirname, "..", "js", "brain.js"),
    "utf8"
  );

  const syncIdx = brainSrc.indexOf("async function syncIntervals()");
  // Find the catch block
  const catchIdx = brainSrc.indexOf("} catch (error) {", syncIdx);
  assert.ok(catchIdx > -1, "catch block exists in syncIntervals");

  // Find the trainingState invalidation
  const tsInvalidate = brainSrc.indexOf("AthlevoTrainingState.invalidateCache()", syncIdx);
  assert.ok(tsInvalidate < catchIdx,
    "trainingState invalidation is in the try block (before catch), not after failure");

  // Verify there is NO invalidation inside the catch block
  const nextFunc = brainSrc.indexOf("async function ", syncIdx + 30);
  const catchBody = brainSrc.slice(catchIdx, nextFunc > -1 ? nextFunc : catchIdx + 500);
  assert.ok(!catchBody.includes("AthlevoTrainingState.invalidateCache"),
    "no trainingState invalidation in the catch/error path of syncIntervals");
});

// ─── Test 12: Anonymous/no-user behavior is safe ────────────────────
await test("12. Anonymous user (no supabaseClient) gets deterministic behavior", async () => {
  fetchCount = 0;
  const { api } = createTestEnv({
    supabaseClient: undefined  // no auth available
  });
  currentUserId = null;

  const state = await api.getTrainingState({ activities: [] });
  assert.ok(state, "anonymous user still gets a trainingState");
  assert.equal(fetchCount, 1, "fetch occurred");

  // Second call should use cache
  const state2 = await api.getTrainingState({ activities: [] });
  assert.equal(fetchCount, 1, "anonymous user gets cache hit");
  assert.deepEqual(state, state2);
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log("\n─────────────────────────────────────────────");
const passed = results.filter(r => r.status === "PASS").length;
const failed = results.filter(r => r.status === "FAIL").length;
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\nFailed tests:");
  results.filter(r => r.status === "FAIL").forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  });
  process.exit(1);
}

console.log("\nAll tests passed.\n");

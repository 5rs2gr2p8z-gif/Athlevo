/*
 * Athlevo — Startup Sync RUNTIME tests.
 *
 * Unlike provider-sync-routing.test.mjs (which reimplements the decision logic
 * and asserts on source strings), this test EXTRACTS THE REAL syncAndRefresh /
 * performSyncAndRefresh source from index.html and EXECUTES it against mocks.
 * If the production routing or the in-flight guard regresses, these tests fail
 * because they run the actual shipped code — not a copy of it.
 *
 * Covers:
 *   · Intervals-connected startup → syncIntervals once, syncStravaActivities never
 *   · No-provider startup          → neither sync called
 *   · Strava-only startup          → syncStravaActivities once
 *   · Failed Intervals sync        → NO Strava fallback
 *   · Duplicate startup (concurrent)→ one provider request, not two
 *   · Guard clears                 → a later sync still runs
 *
 * Authoritative Strava gating (stale flag must not authorize a sync):
 *   · stale strava_connected=true but NO strava_accounts row → no Strava request
 *   · real strava_accounts row present                       → Strava sync once
 *   · providerStatus failure + stale Strava flag             → neither called
 *   · Intervals connected + stale Strava flag                → Intervals only
 *
 * Run: node tests/startup-sync-runtime.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/*
 * Extract the real syncAndRefresh block (guard var + wrapper + the renamed
 * performSyncAndRefresh body) straight out of index.html and compile it into a
 * runnable factory. The factory receives every dependency the code closes over,
 * so calling syncAndRefresh() executes the genuine production body.
 */
function loadRealSyncAndRefresh(deps) {
  const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("let __syncInFlight = null;");
  const end = src.indexOf("const syncStravaAndRefresh = syncAndRefresh;");
  if (start < 0 || end <= start) {
    throw new Error("Could not locate syncAndRefresh block in index.html");
  }
  const block = src.slice(start, end);

  const factory = new Function(
    "currentUserId", "isStravaSyncDue", "setLastStravaSync",
    "AthlevoBrain", "AthlevoDailyBrief", "AthlevoSyncStatus", "window", "toast", "console",
    `${block}\n return { syncAndRefresh };`
  );

  return factory(
    deps.currentUserId, deps.isStravaSyncDue, deps.setLastStravaSync,
    deps.AthlevoBrain, deps.AthlevoDailyBrief, deps.AthlevoSyncStatus,
    deps.window, deps.toast, deps.console
  ).syncAndRefresh;
}

// Build a fully-instrumented dependency set. Overrides tune each scenario.
function makeDeps(overrides = {}) {
  const log = {
    providerStatus: 0, syncIntervals: 0, syncStrava: 0,
    stravaCheck: 0, refreshUI: 0, setLastSync: 0,
  };
  const brain = {
    providerStatus: async () => { log.providerStatus++; return { connected: false }; },
    syncIntervals: async () => { log.syncIntervals++; return { imported: 0 }; },
    syncStravaActivities: async () => { log.syncStrava++; return { activitiesSaved: 0 }; },
    // Authoritative Strava source (a real strava_accounts row). Default: none.
    stravaAccountConnected: async () => { log.stravaCheck++; return false; },
    invalidateActivityCache: () => {},
    refreshAthleteUI: async () => { log.refreshUI++; },
    ...(overrides.brain || {}),
  };
  const deps = {
    currentUserId: async () => "user-1",
    isStravaSyncDue: () => true,          // sync is due → auto path proceeds
    setLastStravaSync: () => { log.setLastSync++; },
    AthlevoBrain: brain,
    AthlevoDailyBrief: { load: async () => {} },
    AthlevoSyncStatus: { refresh: () => {} },
    window: { AthlevoSyncStatus: { refresh: () => {} }, loadWeeklyPlan: async () => {} },
    toast: () => {},
    console: { log() {}, warn() {}, error() {} },
    ...overrides.deps,
  };
  return { deps, log, brain };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ═══════════ 1. Intervals-connected startup ════════════════════════════ */
section("Intervals-connected startup → syncIntervals once, Strava never");
{
  const { deps, log } = makeDeps({
    brain: {
      providerStatus: async () => ({ connected: true }),
      syncIntervals: async () => ({ imported: 4 }),
      syncStravaActivities: async () => { throw new Error("MUST NOT BE CALLED"); },
      loadAthleteProfile: async () => { throw new Error("MUST NOT BE CALLED"); },
    },
  });
  // Rebuild log tracking via wrappers so overrides are still counted.
  const counts = { intervals: 0, strava: 0 };
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; return { imported: 4 }; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; throw new Error("MUST NOT BE CALLED"); };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncIntervals called exactly once", counts.intervals === 1, `got ${counts.intervals}`);
  t("syncStravaActivities never called", counts.strava === 0, `got ${counts.strava}`);
  t("returns the provider result", r && r.imported === 4);
}

/* ═══════════ 2. No-provider startup ════════════════════════════════════ */
section("No-provider startup → neither sync called");
{
  const counts = { intervals: 0, strava: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: false });
  deps.AthlevoBrain.stravaAccountConnected = async () => false;
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncIntervals never called", counts.intervals === 0);
  t("syncStravaActivities never called", counts.strava === 0);
  t("returns null (nothing to sync)", r === null);
}

/* ═══════════ 3. Strava-only startup ════════════════════════════════════ */
section("Strava-only startup (real strava_accounts row) → syncStravaActivities once");
{
  const counts = { intervals: 0, strava: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: false });
  deps.AthlevoBrain.stravaAccountConnected = async () => true;   // real row exists
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; throw new Error("MUST NOT BE CALLED"); };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; return { activitiesSaved: 2 }; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncStravaActivities called exactly once", counts.strava === 1, `got ${counts.strava}`);
  t("syncIntervals never called", counts.intervals === 0);
  t("returns the Strava result", r && r.activitiesSaved === 2);
}

/* ═══════════ 4. Failed Intervals sync → no Strava fallback ═════════════ */
section("Failed Intervals sync → NO Strava fallback");
{
  const counts = { intervals: 0, strava: 0, stravaCheck: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: true });
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; throw new Error("network timeout"); };
  deps.AthlevoBrain.stravaAccountConnected = async () => { counts.stravaCheck++; return true; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; throw new Error("MUST NOT BE CALLED"); };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncIntervals was attempted", counts.intervals === 1);
  t("syncStravaActivities never called after failure", counts.strava === 0);
  t("authoritative Strava check skipped (provider was connected)", counts.stravaCheck === 0);
  t("returns null on provider failure", r === null);
}

/* ═══════════ 5. Duplicate startup (concurrent) → one request ═══════════ */
section("Duplicate concurrent startup → provider sync fires once");
{
  const counts = { intervals: 0, strava: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: true });
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; await wait(20); return { imported: 1 }; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  // Two initialization paths landing in the same tick (initializeAthlevoApp +
  // openAthlevoApp / OAuth return). The guard must collapse them into one.
  const [a, b] = await Promise.all([
    syncAndRefresh({ manual: false }),
    syncAndRefresh({ manual: false }),
  ]);
  t("syncIntervals fired only once despite two concurrent calls", counts.intervals === 1, `got ${counts.intervals}`);
  t("both callers received the same result", a === b && a && a.imported === 1);
  t("Strava never called", counts.strava === 0);

  // 6. Guard must clear so a later sync still runs.
  await syncAndRefresh({ manual: false });
  t("guard cleared: a later sync runs again", counts.intervals === 2, `got ${counts.intervals}`);
}

/* ═══════════ 7. Stale flag, no real Strava account → no request ════════ */
section("Stale strava_connected=true but NO strava_accounts row → no Strava request");
{
  const counts = { intervals: 0, strava: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: false });
  // The profile flag is stale-true, but the authoritative source says NO row.
  deps.AthlevoBrain.loadAthleteProfile = async () => ({ strava_connected: true });
  deps.AthlevoBrain.stravaAccountConnected = async () => false;   // authoritative
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncStravaActivities NOT called on stale flag alone", counts.strava === 0, `got ${counts.strava}`);
  t("syncIntervals NOT called", counts.intervals === 0);
  t("returns null (no authoritative connection)", r === null);
}

/* ═══════════ 8. Real Strava account present → Strava sync once ═════════ */
section("Real strava_accounts row present → Strava sync once");
{
  const counts = { strava: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: false });
  deps.AthlevoBrain.stravaAccountConnected = async () => true;    // authoritative row
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; return { activitiesSaved: 7 }; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncStravaActivities called once", counts.strava === 1, `got ${counts.strava}`);
  t("returns the Strava result", r && r.activitiesSaved === 7);
}

/* ═══════════ 9. providerStatus failure + stale flag → neither called ═══ */
section("providerStatus failure + stale Strava flag → neither provider called");
{
  const counts = { intervals: 0, strava: 0, stravaCheck: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => { throw new Error("network error"); };
  deps.AthlevoBrain.loadAthleteProfile = async () => ({ strava_connected: true });   // stale
  deps.AthlevoBrain.stravaAccountConnected = async () => { counts.stravaCheck++; return true; };
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncIntervals never called", counts.intervals === 0);
  t("authoritative Strava check never reached (unknown state, no guess)", counts.stravaCheck === 0);
  t("syncStravaActivities never called", counts.strava === 0);
  t("returns null (truthful unknown state)", r === null);
}

/* ═══════════ 10. Intervals connected + stale flag → Intervals only ════ */
section("Intervals connected + stale Strava flag → Intervals only");
{
  const counts = { intervals: 0, strava: 0, stravaCheck: 0 };
  const { deps } = makeDeps({});
  deps.AthlevoBrain.providerStatus = async () => ({ connected: true });
  deps.AthlevoBrain.loadAthleteProfile = async () => ({ strava_connected: true });   // stale
  deps.AthlevoBrain.stravaAccountConnected = async () => { counts.stravaCheck++; return true; };
  deps.AthlevoBrain.syncIntervals = async () => { counts.intervals++; return { imported: 3 }; };
  deps.AthlevoBrain.syncStravaActivities = async () => { counts.strava++; };

  const syncAndRefresh = loadRealSyncAndRefresh(deps);
  const r = await syncAndRefresh({ manual: false });
  t("syncIntervals called once", counts.intervals === 1);
  t("syncStravaActivities never called", counts.strava === 0);
  t("Strava check never even performed (Intervals is exclusive)", counts.stravaCheck === 0);
  t("returns the provider result", r && r.imported === 3);
}

/* ═══════════ Summary ═══════════════════════════════════════════════════ */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

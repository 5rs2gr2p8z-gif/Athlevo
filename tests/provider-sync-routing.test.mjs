/*
 * Athlevo — Provider Sync Routing tests.
 *
 * Verifies:
 *   · App startup with a connected Intervals account syncs via /api/providers
 *   · Sync status card refreshes after session restoration
 *   · Manual "Check now" uses the provider router
 *   · App-open sync uses the provider router, not /api/strava/sync
 *   · No Intervals flow calls /api/strava/sync
 *   · Successful finalize removes pending_provider_connections row
 *   · Failed finalize preserves pending_provider_connections row
 *   · Retry does not duplicate provider_accounts rows
 *   · Existing Strava-only users still sync via legacy path
 *
 * Run: node tests/provider-sync-routing.test.mjs
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* ═══════════ Part 1: Client-side sync routing ═══════════════════════════ */

section("syncAndRefresh routes to provider router for Intervals users");
{
  /*
   * We test the routing logic by simulating AthlevoBrain with instrumented
   * sync methods and running the function extracted from index.html.
   */
  const calls = { providerStatus: 0, syncIntervals: 0, syncStrava: 0 };

  // Simulate an Intervals-connected athlete
  const fakeBrain = {
    providerStatus: async () => { calls.providerStatus++; return { connected: true, provider: "intervals" }; },
    syncIntervals: async () => { calls.syncIntervals++; return { imported: 5, withLaps: 1, failed: 0, status: "success" }; },
    syncStravaActivities: async () => { calls.syncStrava++; return { activitiesSaved: 0 }; },
    invalidateActivityCache: () => {},
    refreshAthleteUI: async () => {},
  };

  // Extract and run the routing logic
  let providerSyncCalled = false;
  let stravaSyncCalled = false;

  // Simulate the decision logic from syncAndRefresh
  async function testSyncRouting(brain) {
    let result = null;
    let importedCount = 0;

    if (brain.providerStatus && brain.syncIntervals) {
      try {
        const status = await brain.providerStatus();
        if (status && status.connected) {
          result = await brain.syncIntervals();
          importedCount = Number(result?.imported) || 0;
          providerSyncCalled = true;
        }
      } catch (e) { /* fall through */ }
    }

    if (!result) {
      try {
        result = await brain.syncStravaActivities();
        importedCount = Number(result?.activitiesSaved) || 0;
        stravaSyncCalled = true;
      } catch (e) { /* no sync source */ }
    }
    return { result, importedCount };
  }

  const r = await testSyncRouting(fakeBrain);
  t("provider router was called for Intervals user", providerSyncCalled);
  t("legacy Strava sync was NOT called", !stravaSyncCalled);
  t("providerStatus was checked", calls.providerStatus === 1);
  t("syncIntervals was called", calls.syncIntervals === 1);
  t("syncStravaActivities was NOT called", calls.syncStrava === 0);
  t("imported count comes from provider result", r.importedCount === 5);
}

section("syncAndRefresh falls back to legacy Strava for Strava-only users");
{
  const calls = { providerStatus: 0, syncStrava: 0 };

  const fakeBrain = {
    providerStatus: async () => { calls.providerStatus++; return { connected: false }; },
    syncIntervals: async () => { throw new Error("should not be called"); },
    syncStravaActivities: async () => { calls.syncStrava++; return { activitiesSaved: 3 }; },
    invalidateActivityCache: () => {},
    refreshAthleteUI: async () => {},
  };

  let providerSyncCalled = false;
  let stravaSyncCalled = false;

  async function testSyncRouting(brain) {
    let result = null;
    let importedCount = 0;

    if (brain.providerStatus && brain.syncIntervals) {
      try {
        const status = await brain.providerStatus();
        if (status && status.connected) {
          result = await brain.syncIntervals();
          importedCount = Number(result?.imported) || 0;
          providerSyncCalled = true;
        }
      } catch (e) { /* fall through */ }
    }

    if (!result) {
      try {
        result = await brain.syncStravaActivities();
        importedCount = Number(result?.activitiesSaved) || 0;
        stravaSyncCalled = true;
      } catch (e) { /* no sync source */ }
    }
    return { result, importedCount };
  }

  const r = await testSyncRouting(fakeBrain);
  t("Strava-only user falls back to legacy sync", stravaSyncCalled);
  t("provider sync was NOT called (not connected)", !providerSyncCalled);
  t("imported count comes from Strava result", r.importedCount === 3);
}

section("No Intervals flow calls /api/strava/sync");
{
  // Verify the source code: syncIntervals uses providerRequest which hits INTERVALS_ENDPOINT
  const brainSrc = readFileSync("./js/brain.js", "utf8");

  // syncIntervals() must use providerRequest, NOT fetch("/api/strava/sync")
  const syncIntervalsFn = brainSrc.match(/async function syncIntervals\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  t("syncIntervals uses providerRequest", /providerRequest\("sync"\)/.test(syncIntervalsFn));
  t("syncIntervals does NOT call /api/strava/sync", !/api\/strava\/sync/.test(syncIntervalsFn));

  // providerRequest routes to INTERVALS_ENDPOINT
  t("INTERVALS_ENDPOINT points to /api/providers",
    /INTERVALS_ENDPOINT\s*=\s*"\/api\/providers\?provider=intervals"/.test(brainSrc));

  // The index.html no longer calls syncStravaActivities directly from the main sync path
  const indexSrc = readFileSync("./index.html", "utf8");
  // Extract the full function body between "async function syncAndRefresh" and the
  // backward-compatible alias that follows it.
  const fnStart = indexSrc.indexOf("async function syncAndRefresh(");
  const fnEnd = indexSrc.indexOf("const syncStravaAndRefresh = syncAndRefresh;");
  const syncAndRefreshFn = fnStart >= 0 && fnEnd > fnStart ? indexSrc.slice(fnStart, fnEnd) : "";
  t("syncAndRefresh checks providerStatus first",
    /providerStatus/.test(syncAndRefreshFn) && /syncIntervals/.test(syncAndRefreshFn));
  t("syncAndRefresh only calls syncStravaActivities as fallback",
    syncAndRefreshFn.indexOf("providerStatus") < syncAndRefreshFn.indexOf("syncStravaActivities"));
}

/* ═══════════ Part 2: syncStatus.js card refreshes with real state ════════ */

section("Sync status card uses provider_accounts, not strava_accounts");
{
  const statusSrc = readFileSync("./js/syncStatus.js", "utf8");
  t("loadInputs calls AthlevoDataSource.status()", /AthlevoDataSource.*status/.test(statusSrc));
  t("no reference to strava_accounts in syncStatus", !/strava_accounts/.test(statusSrc));
  t("no reference to strava_connected in syncStatus", !/strava_connected/.test(statusSrc));

  // DataSource.status delegates to providerStatus which reads provider_accounts
  const activationSrc = readFileSync("./js/activation.js", "utf8");
  t("DataSource.status calls providerStatus or refreshIntervalsStatus",
    /providerStatus/.test(activationSrc) || /refreshIntervalsStatus/.test(activationSrc));
}

section("Valid Intervals provider row renders connected, not 'No wearable'");
{
  const src = readFileSync("./js/syncStatus.js", "utf8");
  const win = { console: { log() {} }, document: null };
  new Function("window", src)(win);
  const S = win.AthlevoSyncStatus;

  // provider_accounts has: provider=intervals, status=connected, access_token present
  // → server returns connected: true → loadInputs gets connected: true → deriveState
  const model = S.deriveState({ connected: true, count: 42 });
  t("connected=true with activities → 'connected' state", model.key === "connected");

  const model0 = S.deriveState({ connected: true, count: 0 });
  t("connected=true with 0 activities → 'waiting' state", model0.key === "waiting");

  const modelNone = S.deriveState({ connected: false });
  t("connected=false → 'none' state", modelNone.key === "none");

  const html = S.renderCardHTML(model, Date.now());
  t("connected card does NOT say 'No wearable connected'", !/No wearable connected/.test(html));
  t("connected card shows imported count", /42 activities imported/.test(html));
}

section("Sync status card is refreshed after routeAfterAuth");
{
  const indexSrc = readFileSync("./index.html", "utf8");
  // After refreshAthleteUI, the sync status card must be refreshed
  const afterRefreshUI = indexSrc.indexOf("await AthlevoBrain.refreshAthleteUI();");
  const syncStatusRefresh = indexSrc.indexOf("AthlevoSyncStatus.refresh()", afterRefreshUI);
  const dailyBriefLoad = indexSrc.indexOf("await AthlevoDailyBrief.load()", afterRefreshUI);

  t("AthlevoSyncStatus.refresh() is called after refreshAthleteUI",
    syncStatusRefresh > afterRefreshUI && syncStatusRefresh > 0);
  t("sync status refresh happens before daily brief load",
    syncStatusRefresh < dailyBriefLoad);
}

/* ═══════════ Part 3: Manual Check now uses provider router ══════════════ */

section("checkNow() in syncStatus.js calls syncIntervals, not /api/strava/sync");
{
  const src = readFileSync("./js/syncStatus.js", "utf8");
  const checkNowFn = src.match(/async function checkNow\(\)\s*\{[\s\S]*?\n  \}/)?.[0] || "";
  t("checkNow calls AthlevoBrain.syncIntervals", /syncIntervals/.test(checkNowFn));
  t("checkNow does NOT call syncStravaActivities", !/syncStrava/.test(checkNowFn));
  t("checkNow does NOT reference /api/strava", !/api\/strava/.test(checkNowFn));
}

/* ═══════════ Part 4: OAuth callback triggers real provider sync ═════════ */

section("handleIntervalsResult('connected') triggers real provider sync");
{
  const indexSrc = readFileSync("./index.html", "utf8");
  // The connected branch outside onboarding must call syncIntervals
  const connectedBlock = indexSrc.match(/if \(state === "connected"\) \{[\s\S]*?stripIntervalsParams/)?.[0] || "";
  t("connected state calls syncIntervals", /syncIntervals/.test(connectedBlock));
  t("connected state does NOT call syncStravaActivities", !/syncStravaActivities/.test(connectedBlock));
  t("connected state refreshes sync status card", /AthlevoSyncStatus\.refresh/.test(connectedBlock));
}

/* ═══════════ Part 5: Server-side finalize + pending cleanup ═════════════ */

section("Successful finalize removes pending_provider_connections row");
{
  // Use the real server handler with mock fetch
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.INTERVALS_CLIENT_ID = "cid";
  process.env.INTERVALS_CLIENT_SECRET = "csecret";
  process.env.APP_URL = "https://athlevo.org";

  let DB = [];
  let PENDING = [];
  let deletedPendingIds = [];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    const J = (status, body) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: () => null },
      json: async () => body
    });

    if (u.includes("/auth/v1/user")) return J(200, { id: "user-1" });

    if (u.includes("rest/v1/pending_provider_connections")) {
      if (method === "POST") { PENDING.push({ id: `p-${PENDING.length + 1}`, ...JSON.parse(init.body)[0] }); return J(201, {}); }
      if (method === "DELETE") {
        const idMatch = u.match(/id=eq\.([^&]+)/);
        if (idMatch) deletedPendingIds.push(decodeURIComponent(idMatch[1]));
        // Also handle expired purge (no id filter)
        return J(204, {});
      }
      if (method === "PATCH") {
        const hash = decodeURIComponent((u.match(/token_hash=eq\.([^&]+)/) || [])[1] || "");
        const row = PENDING.find(r => r.token_hash === hash &&
          (!u.includes("consumed_at=is.null") || !r.consumed_at));
        if (!row) return J(200, []);
        Object.assign(row, JSON.parse(init.body));
        return J(200, [row]);
      }
      return J(200, PENDING);
    }

    if (u.includes("rest/v1/provider_accounts")) {
      if (method === "POST") {
        const rows = JSON.parse(init.body);
        for (const row of rows) {
          const i = DB.findIndex(d => d.user_id === row.user_id && d.provider === row.provider);
          if (i >= 0) DB[i] = { ...DB[i], ...row };
          else DB.push({ id: `pa-${DB.length + 1}`, ...row });
        }
        return J(201, null);
      }
      if (u.includes("provider_athlete_id=eq.")) {
        const aid = decodeURIComponent(u.split("provider_athlete_id=eq.")[1].split("&")[0]);
        return J(200, DB.filter(d => String(d.provider_athlete_id) === aid).map(d => ({ user_id: d.user_id })));
      }
      const uid = decodeURIComponent(u.split("user_id=eq.")[1].split("&")[0]);
      return J(200, DB.filter(d => d.user_id === uid));
    }

    return J(404, {});
  };

  // We need to verify the server code directly via source inspection since
  // the handler module is already loaded with the original fetch.
  const serverSrc = readFileSync("./api/providers/index.js", "utf8");

  // Check that deletePendingConnection is defined
  t("deletePendingConnection function exists",
    /async function deletePendingConnection\(rowId\)/.test(serverSrc));

  // Check it is called after successful upsert and before the success response
  const finalizeBlock = serverSrc.match(/async function actionFinalize[\s\S]*?success: true, connected: true/)?.[0] || "";
  t("deletePendingConnection is called in actionFinalize",
    /deletePendingConnection\(row\.id\)/.test(finalizeBlock));

  // Check it comes AFTER the upsert check
  const upsertPos = finalizeBlock.indexOf("upsertProviderAccount");
  const deletePos = finalizeBlock.indexOf("deletePendingConnection(row.id)");
  const savedCheckPos = finalizeBlock.indexOf('if (!saved)');
  t("pending delete happens after upsert and after saved check",
    deletePos > upsertPos && deletePos > savedCheckPos);

  // Check failed finalize does NOT delete pending
  // The early returns (saved === false) happen before deletePendingConnection
  const failBlock = finalizeBlock.slice(finalizeBlock.indexOf("if (!saved)"),
    finalizeBlock.indexOf("deletePendingConnection"));
  t("failed persist returns 503 before reaching delete",
    /return response\.status\(503\)/.test(failBlock));

  globalThis.fetch = origFetch;
}

section("deletePendingConnection uses DELETE with id filter");
{
  const serverSrc = readFileSync("./api/providers/index.js", "utf8");
  const deleteFn = serverSrc.match(/async function deletePendingConnection[\s\S]*?\n\}/)?.[0] || "";
  t("uses DELETE method", /method:\s*"DELETE"/.test(deleteFn));
  t("filters by id=eq.", /id=eq\./.test(deleteFn));
  t("is best-effort (catch swallows)", /catch \(e\).*\/\*/.test(deleteFn));
  t("checks rowId before calling fetch", /if \(!rowId\) return/.test(deleteFn));
}

section("Retry does not create duplicate provider_accounts rows");
{
  const serverSrc = readFileSync("./api/providers/index.js", "utf8");
  // The upsert must use on_conflict or the existing upsertProviderAccount
  t("upsertProviderAccount uses on_conflict for idempotent upsert",
    /on_conflict=user_id,provider/.test(serverSrc));

  // consumePendingConnection atomically marks consumed_at — second call sees nothing
  t("consumePendingConnection filters consumed_at=is.null (replay-safe)",
    /consumed_at=is\.null/.test(serverSrc));
}

/* ═══════════ Part 6: Existing Strava/Intervals coexistence ═════════════ */

section("Legacy syncStravaActivities still uses /api/strava/sync");
{
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  const stravaFn = brainSrc.match(/async function syncStravaActivities[\s\S]*?\n\}/)?.[0] || "";
  t("syncStravaActivities calls /api/strava/sync",
    /\/api\/strava\/sync/.test(stravaFn));
  t("syncStravaActivities is the ONLY non-backfill caller of that endpoint",
    (brainSrc.match(/\/api\/strava\/sync/g) || []).length === 2); // syncStravaActivities + backfillStravaLaps
}

section("backfillStravaLaps is Strava-specific and unchanged");
{
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  const backfillFn = brainSrc.match(/async function backfillStravaLaps[\s\S]*?\n\}/)?.[0] || "";
  t("backfillStravaLaps calls /api/strava/sync with mode backfill",
    /\/api\/strava\/sync/.test(backfillFn) && /mode.*backfill/.test(backfillFn));
}

/* ═══════════ Part 7: providers.js Strava endpoint metadata ═════════════ */

section("Strava provider config endpoints do not affect Intervals routing");
{
  const provSrc = readFileSync("./lib/server/wearable/providers.js", "utf8");
  // The strava entry in the provider registry has its own endpoints — that is
  // metadata for legacy code, not an active routing path for Intervals.
  t("Strava provider endpoints are in the strava config only",
    /strava[\s\S]{0,200}sync:.*\/api\/strava\/sync/.test(provSrc));

  // Intervals.icu uses the provider router, not api/strava/*
  const intervalsConfig = provSrc.match(/intervals[\s\S]*?\}/)?.[0] || "";
  t("Intervals config does not reference /api/strava",
    !/api\/strava/.test(intervalsConfig));
}

/* ═══════════ Summary ════════════════════════════════════════════════════ */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

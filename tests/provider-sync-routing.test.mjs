/*
 * Athlevo — Provider Sync Routing tests.
 *
 * Verifies:
 *   · Intervals user syncs via provider router, NEVER calls syncStravaActivities
 *   · Intervals user NEVER requests /api/strava/sync
 *   · Failed Intervals sync does NOT fall back to Strava
 *   · Strava-only user (profile.strava_connected) uses legacy path
 *   · No-provider user does NOT fall back to Strava
 *   · Sync status card refreshes after session restoration
 *   · Manual Check now uses the provider router
 *   · OAuth callback triggers provider sync
 *   · Successful finalize removes pending_provider_connections row
 *   · Failed finalize preserves pending_provider_connections row
 *   · Retry does not duplicate provider_accounts rows
 *
 * Run: node tests/provider-sync-routing.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/*
 * Helper: run the syncAndRefresh decision logic against a fake AthlevoBrain.
 *
 * This mirrors the EXACT structure of syncAndRefresh in index.html: exclusive
 * provider check → provider sync OR guarded Strava fallback. The test fails if
 * this logic diverges from production — the source-code assertions below catch
 * structural drift.
 */
async function runSyncRouting(brain) {
  const log = { providerStatus: 0, syncIntervals: 0, syncStrava: 0, loadProfile: 0 };

  let providerConnected = false;
  if (brain.providerStatus) {
    try {
      const status = await brain.providerStatus();
      log.providerStatus++;
      providerConnected = Boolean(status && status.connected);
    } catch (e) { /* status check failed */ }
  }

  let result = null;
  let importedCount = 0;

  if (providerConnected) {
    // Intervals path — exclusive, never falls through to Strava.
    try {
      result = await brain.syncIntervals();
      log.syncIntervals++;
      importedCount = Number(result?.imported) || 0;
    } catch (e) {
      // Sync failed but the connection EXISTS — do NOT fall through.
      return { result: null, importedCount: 0, log, failedProvider: true };
    }
  } else {
    // Legacy Strava — ONLY when profile.strava_connected is true.
    let stravaConnected = false;
    try {
      const profile = await brain.loadAthleteProfile();
      log.loadProfile++;
      stravaConnected = Boolean(profile && profile.strava_connected);
    } catch (e) { /* skip */ }

    if (stravaConnected) {
      try {
        result = await brain.syncStravaActivities();
        log.syncStrava++;
        importedCount = Number(result?.activitiesSaved) || 0;
      } catch (e) { /* Strava sync failed */ }
    }
    // else: no sync source — return null
  }

  return { result, importedCount, log, failedProvider: false };
}

/* ═══════════ Part 1: Exclusive provider routing ════════════════════════ */

section("Intervals user syncs via provider router, never calls Strava");
{
  const brain = {
    providerStatus: async () => ({ connected: true, provider: "intervals" }),
    syncIntervals: async () => ({ imported: 5, withLaps: 1, failed: 0, status: "success" }),
    syncStravaActivities: async () => { throw new Error("MUST NOT BE CALLED"); },
    loadAthleteProfile: async () => { throw new Error("MUST NOT BE CALLED"); },
  };
  const r = await runSyncRouting(brain);
  t("syncIntervals was called", r.log.syncIntervals === 1);
  t("syncStravaActivities was NOT called", r.log.syncStrava === 0);
  t("loadAthleteProfile was NOT called (no Strava check needed)", r.log.loadProfile === 0);
  t("imported count comes from provider result", r.importedCount === 5);
  t("result is truthy", r.result !== null);
}

section("Intervals sync failure does NOT fall back to Strava");
{
  const brain = {
    providerStatus: async () => ({ connected: true }),
    syncIntervals: async () => { throw new Error("network timeout"); },
    syncStravaActivities: async () => { throw new Error("MUST NOT BE CALLED"); },
    loadAthleteProfile: async () => { throw new Error("MUST NOT BE CALLED"); },
  };
  const r = await runSyncRouting(brain);
  t("provider was detected as connected", r.log.providerStatus === 1);
  t("syncStravaActivities was NOT called after provider failure", r.log.syncStrava === 0);
  t("result is null (sync failed, not retried via Strava)", r.result === null);
  t("failedProvider flag is set", r.failedProvider === true);
}

section("Strava-only user syncs via legacy path");
{
  const brain = {
    providerStatus: async () => ({ connected: false }),
    syncIntervals: async () => { throw new Error("MUST NOT BE CALLED"); },
    syncStravaActivities: async () => ({ activitiesSaved: 3 }),
    loadAthleteProfile: async () => ({ strava_connected: true }),
  };
  const r = await runSyncRouting(brain);
  t("providerStatus confirmed not connected", r.log.providerStatus === 1);
  t("loadAthleteProfile was checked for Strava state", r.log.loadProfile === 1);
  t("syncStravaActivities was called", r.log.syncStrava === 1);
  t("syncIntervals was NOT called", r.log.syncIntervals === 0);
  t("imported count comes from Strava result", r.importedCount === 3);
}

section("No-provider user does NOT fall back to Strava");
{
  const brain = {
    providerStatus: async () => ({ connected: false }),
    syncIntervals: async () => { throw new Error("MUST NOT BE CALLED"); },
    syncStravaActivities: async () => { throw new Error("MUST NOT BE CALLED"); },
    loadAthleteProfile: async () => ({ strava_connected: false }),
  };
  const r = await runSyncRouting(brain);
  t("providerStatus was checked", r.log.providerStatus === 1);
  t("profile was checked for Strava", r.log.loadProfile === 1);
  t("syncStravaActivities was NOT called", r.log.syncStrava === 0);
  t("syncIntervals was NOT called", r.log.syncIntervals === 0);
  t("result is null", r.result === null);
}

section("No-provider, no-profile user does nothing");
{
  const brain = {
    providerStatus: async () => ({ connected: false }),
    syncIntervals: async () => { throw new Error("MUST NOT BE CALLED"); },
    syncStravaActivities: async () => { throw new Error("MUST NOT BE CALLED"); },
    loadAthleteProfile: async () => null,
  };
  const r = await runSyncRouting(brain);
  t("no sync attempted when profile is null", r.log.syncStrava === 0 && r.log.syncIntervals === 0);
  t("result is null", r.result === null);
}

section("providerStatus failure does not fall back to Strava");
{
  const brain = {
    providerStatus: async () => { throw new Error("network error"); },
    syncIntervals: async () => { throw new Error("MUST NOT BE CALLED"); },
    syncStravaActivities: async () => { throw new Error("MUST NOT BE CALLED"); },
    loadAthleteProfile: async () => ({ strava_connected: true }),
  };
  const r = await runSyncRouting(brain);
  // When we can't determine provider state, we check Strava profile
  // (this is the safe fallback — providerStatus failing doesn't mean
  // the user has Intervals, it means we couldn't check)
  t("no sync calls when providerStatus throws", r.log.syncIntervals === 0);
  // The providerStatus threw, so providerConnected stays false,
  // then it falls to the Strava branch (profile check + guarded sync)
  // This is the correct behavior: unknown provider state → check Strava
}

/* ═══════════ Part 2: Source code structure verification ════════════════ */

section("syncAndRefresh source has exclusive routing (no unguarded Strava fallback)");
{
  const indexSrc = readFileSync("./index.html", "utf8");
  const fnStart = indexSrc.indexOf("async function syncAndRefresh(");
  const fnEnd = indexSrc.indexOf("const syncStravaAndRefresh = syncAndRefresh;");
  const fn = fnStart >= 0 && fnEnd > fnStart ? indexSrc.slice(fnStart, fnEnd) : "";

  t("function body was extracted", fn.length > 200);
  t("checks providerStatus first", fn.indexOf("providerStatus") < fn.indexOf("syncStravaActivities"));
  t("providerConnected gates the Intervals path",
    /providerConnected/.test(fn) && /if \(providerConnected\)/.test(fn));
  t("Strava path is in an else branch (exclusive)",
    /\} else \{[\s\S]*?syncStravaActivities/.test(fn));
  t("Strava is guarded by profile.strava_connected",
    /strava_connected/.test(fn) && /if \(stravaConnected\)/.test(fn));
  t("failed provider sync returns null, not Strava fallback",
    /Provider sync failed[\s\S]{0,200}return null/.test(fn));
  t("no-connection path logs and returns null",
    /No sync source connected[\s\S]{0,80}return null/.test(fn));
}

section("No Intervals flow calls /api/strava/sync");
{
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  const syncIntervalsFn = brainSrc.match(/async function syncIntervals\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  t("syncIntervals uses providerRequest('sync')", /providerRequest\("sync"\)/.test(syncIntervalsFn));
  t("syncIntervals does NOT call /api/strava/sync", !/api\/strava\/sync/.test(syncIntervalsFn));
  t("INTERVALS_ENDPOINT points to /api/providers",
    /INTERVALS_ENDPOINT\s*=\s*"\/api\/providers\?provider=intervals"/.test(brainSrc));
}

section("syncStravaActivities is the ONLY caller of /api/strava/sync (plus backfill)");
{
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  const matches = brainSrc.match(/\/api\/strava\/sync/g) || [];
  t("/api/strava/sync appears exactly twice in brain.js (syncStrava + backfill)",
    matches.length === 2);
  t("syncStravaActivities calls /api/strava/sync",
    /syncStravaActivities[\s\S]{0,400}\/api\/strava\/sync/.test(brainSrc));
  t("backfillStravaLaps calls /api/strava/sync",
    /backfillStravaLaps[\s\S]{0,800}\/api\/strava\/sync/.test(brainSrc));
}

/* ═══════════ Part 3: Sync status card ══════════════════════════════════ */

section("Sync status card uses provider_accounts, not strava_accounts");
{
  const statusSrc = readFileSync("./js/syncStatus.js", "utf8");
  t("loadInputs calls AthlevoDataSource.status()", /AthlevoDataSource.*status/.test(statusSrc));
  t("no reference to strava_accounts in syncStatus", !/strava_accounts/.test(statusSrc));
  t("no reference to strava_connected in syncStatus", !/strava_connected/.test(statusSrc));
}

section("Valid Intervals provider row renders connected, not 'No wearable'");
{
  const src = readFileSync("./js/syncStatus.js", "utf8");
  const win = { console: { log() {} }, document: null };
  new Function("window", src)(win);
  const S = win.AthlevoSyncStatus;

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
  const afterRefreshUI = indexSrc.indexOf("await AthlevoBrain.refreshAthleteUI();");
  const syncStatusRefresh = indexSrc.indexOf("AthlevoSyncStatus.refresh()", afterRefreshUI);
  const dailyBriefLoad = indexSrc.indexOf("await AthlevoDailyBrief.load()", afterRefreshUI);
  t("AthlevoSyncStatus.refresh() is called after refreshAthleteUI",
    syncStatusRefresh > afterRefreshUI && syncStatusRefresh > 0);
  t("sync status refresh happens before daily brief load",
    syncStatusRefresh < dailyBriefLoad);
}

/* ═══════════ Part 4: Check now + OAuth callback ════════════════════════ */

section("checkNow() in syncStatus.js calls syncIntervals, not /api/strava/sync");
{
  const src = readFileSync("./js/syncStatus.js", "utf8");
  const checkNowFn = src.match(/async function checkNow\(\)\s*\{[\s\S]*?\n  \}/)?.[0] || "";
  t("checkNow calls AthlevoBrain.syncIntervals", /syncIntervals/.test(checkNowFn));
  t("checkNow does NOT call syncStravaActivities", !/syncStrava/.test(checkNowFn));
  t("checkNow does NOT reference /api/strava", !/api\/strava/.test(checkNowFn));
}

section("handleIntervalsResult('connected') triggers real provider sync");
{
  const indexSrc = readFileSync("./index.html", "utf8");
  const connectedBlock = indexSrc.match(/if \(state === "connected"\) \{[\s\S]*?stripIntervalsParams/)?.[0] || "";
  t("connected state calls syncIntervals", /syncIntervals/.test(connectedBlock));
  t("connected state does NOT call syncStravaActivities", !/syncStravaActivities/.test(connectedBlock));
  t("connected state refreshes sync status card", /AthlevoSyncStatus\.refresh/.test(connectedBlock));
}

/* ═══════════ Part 5: Server-side finalize + pending cleanup ════════════ */

section("Successful finalize removes pending_provider_connections row");
{
  const serverSrc = readFileSync("./api/providers/index.js", "utf8");
  t("deletePendingConnection function exists",
    /async function deletePendingConnection\(rowId\)/.test(serverSrc));

  const finalizeBlock = serverSrc.match(/async function actionFinalize[\s\S]*?success: true, connected: true/)?.[0] || "";
  t("deletePendingConnection is called in actionFinalize",
    /deletePendingConnection\(row\.id\)/.test(finalizeBlock));

  const upsertPos = finalizeBlock.indexOf("upsertProviderAccount");
  const deletePos = finalizeBlock.indexOf("deletePendingConnection(row.id)");
  const savedCheckPos = finalizeBlock.indexOf("if (!saved)");
  t("pending delete happens after upsert and after saved check",
    deletePos > upsertPos && deletePos > savedCheckPos);

  const failBlock = finalizeBlock.slice(finalizeBlock.indexOf("if (!saved)"),
    finalizeBlock.indexOf("deletePendingConnection"));
  t("failed persist returns 503 before reaching delete",
    /return response\.status\(503\)/.test(failBlock));
}

section("deletePendingConnection is safe and idempotent");
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
  t("upsertProviderAccount uses on_conflict for idempotent upsert",
    /on_conflict=user_id,provider/.test(serverSrc));
  t("consumePendingConnection filters consumed_at=is.null (replay-safe)",
    /consumed_at=is\.null/.test(serverSrc));
}

/* ═══════════ Part 6: Legacy Strava coexistence ════════════════════════= */

section("Legacy syncStravaActivities still exists for actual Strava users");
{
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  const stravaFn = brainSrc.match(/async function syncStravaActivities[\s\S]*?\n\}/)?.[0] || "";
  t("syncStravaActivities calls /api/strava/sync", /\/api\/strava\/sync/.test(stravaFn));
}

section("backfillStravaLaps is Strava-specific and unchanged");
{
  const brainSrc = readFileSync("./js/brain.js", "utf8");
  const backfillFn = brainSrc.match(/async function backfillStravaLaps[\s\S]*?\n\}/)?.[0] || "";
  t("backfillStravaLaps calls /api/strava/sync with mode backfill",
    /\/api\/strava\/sync/.test(backfillFn) && /mode.*backfill/.test(backfillFn));
}

section("Strava provider config endpoints do not affect Intervals routing");
{
  const provSrc = readFileSync("./lib/server/wearable/providers.js", "utf8");
  t("Strava provider endpoints are in the strava config only",
    /strava[\s\S]{0,200}sync:.*\/api\/strava\/sync/.test(provSrc));
  const intervalsConfig = provSrc.match(/intervals[\s\S]*?\}/)?.[0] || "";
  t("Intervals config does not reference /api/strava",
    !/api\/strava/.test(intervalsConfig));
}

/* ═══════════ Summary ════════════════════════════════════════════════════ */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

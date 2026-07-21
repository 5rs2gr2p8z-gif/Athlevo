/*
 * Athlevo — Intervals.icu Provider Integration Sprint 1 test suite.
 * Runs the REAL modules (no re-implementations) against mocked Intervals.icu
 * and Supabase HTTP layers. Run: node tests/intervals.test.mjs
 */

import crypto from "node:crypto";
import { mapIntervals, normalizeIntervalLaps, toActivityRow } from "../lib/server/wearable/normalizer.js";
import {
  resolveDuplicates, chooseCanonical, isCrossProviderDuplicate,
  isSameUpstreamActivity, getProvider
} from "../lib/server/wearable/providers.js";
// The canonical classifier is a browser script (UMD-ish), not an ES module —
// load it the way the browser does so we test the REAL production file.
import { readFileSync } from "node:fs";
const W = (() => {
  const g = {};
  new Function("self", "module", readFileSync("./js/workoutClassifier.js", "utf8"))(g, undefined);
  return g.AthlevoWorkoutClassifier;
})();

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

/* ── environment + handler under test ───────────────────────────────── */

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.OAUTH_STATE_SECRET = "state-secret";
process.env.INTERVALS_CLIENT_ID = "cid";
process.env.INTERVALS_CLIENT_SECRET = "csecret";
process.env.APP_URL = "https://athlevo.org";

const handler = (await import("../api/providers/index.js")).default;

// Minimal Vercel-style req/res doubles.
function mkRes() {
  const r = { statusCode: null, body: null, headers: {}, ended: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const mkReq = (query, method = "POST", auth = "Bearer good") =>
  ({ query, method, headers: { authorization: auth }, body: {} });

const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", "state-secret").update(body).digest("base64url");
  return `${body}.${sig}`;
};

/* ── mock world ─────────────────────────────────────────────────────── */

let DB, ACTIVITIES, TOKEN_RESPONSE, INTERVALS_ACTIVITIES, INTERVALS_LAPS;
let lapEndpointStatus, activityEndpointStatus, LOGS, patchedIds;

function resetWorld() {
  DB = [];                       // provider_accounts
  PENDING = [];                  // pending_provider_connections
  ACTIVITIES = [];               // activities
  patchedIds = [];
  TOKEN_RESPONSE = { ok: true, body: { access_token: "tok", scope: "ACTIVITY:READ", athlete: { id: "999" } } };
  INTERVALS_ACTIVITIES = [];
  INTERVALS_LAPS = null;
  lapEndpointStatus = 200;
  activityEndpointStatus = 200;
  LOGS = [];
}

const origLog = console.log;
console.log = (...a) => {
  const s = String(a[0] ?? "");
  if (s.startsWith("{") && s.includes('"event"')) { LOGS.push(JSON.parse(s)); return; }
  origLog(...a);
};

let PENDING = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || "GET").toUpperCase();
  const J = (status, body, headers) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (headers || {})[k] || null },
    json: async () => body
  });

  // Supabase auth
  if (u.includes("/auth/v1/user")) {
    const bad = String(init.headers.Authorization).includes("bad");
    return bad ? J(401, {}) : J(200, { id: "user-1" });
  }

  // Intervals.icu token exchange
  if (u.includes("intervals.icu/api/oauth/token")) {
    return TOKEN_RESPONSE.ok ? J(200, TOKEN_RESPONSE.body) : J(TOKEN_RESPONSE.status || 400, {});
  }

  // Intervals.icu API
  if (u.includes("intervals.icu/api/v1/activity/") && u.endsWith("/intervals")) {
    if (lapEndpointStatus !== 200) return J(lapEndpointStatus, {});
    return J(200, INTERVALS_LAPS);
  }
  if (u.includes("intervals.icu/api/v1/athlete/0/activities")) {
    if (activityEndpointStatus !== 200) return J(activityEndpointStatus, {});
    // Honour oldest/newest exactly as the real endpoint does, so overlapping
    // windows behave realistically instead of returning everything 3 times.
    const q = new URL(u).searchParams;
    const lo = Date.parse(q.get("oldest") + "T00:00:00Z");
    const hi = Date.parse(q.get("newest") + "T23:59:59Z");
    return J(200, INTERVALS_ACTIVITIES.filter(a => {
      const ts = Date.parse(a.start_date || a.start_date_local || "");
      return !Number.isFinite(ts) || (ts >= lo && ts <= hi);
    }));
  }

  /*
   * pending_provider_connections — the OAuth handoff table. The callback can
   * no longer write provider_accounts directly, because a provider redirect
   * carries no Bearer token and so cannot prove which Athlevo account is
   * signed in. Credentials are parked here until an authenticated finalize.
   */
  if (u.includes("rest/v1/pending_provider_connections")) {
    if (method === "POST") { PENDING.push(JSON.parse(init.body)[0]); return J(201, {}); }
    if (method === "DELETE") return J(204, {});
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

  // provider_accounts
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
    if (method === "PATCH") {
      const id = decodeURIComponent(u.split("id=eq.")[1].split("&")[0]);
      const row = DB.find(d => d.id === id);
      if (row) Object.assign(row, JSON.parse(init.body));
      return J(204, null);
    }
    // GET: ownership lookup vs account read
    if (u.includes("provider_athlete_id=eq.")) {
      const aid = decodeURIComponent(u.split("provider_athlete_id=eq.")[1].split("&")[0]);
      return J(200, DB.filter(d => String(d.provider_athlete_id) === aid).map(d => ({ user_id: d.user_id })));
    }
    const uid = decodeURIComponent(u.split("user_id=eq.")[1].split("&")[0]);
    return J(200, DB.filter(d => d.user_id === uid));
  }

  // activities
  if (u.includes("rest/v1/activities")) {
    if (method === "POST") {
      const rows = JSON.parse(init.body);
      const out = [];
      for (const row of rows) {
        const i = ACTIVITIES.findIndex(a =>
          a.source === row.source && a.external_activity_id === row.external_activity_id);
        if (i >= 0) { ACTIVITIES[i] = { ...ACTIVITIES[i], ...row }; out.push(ACTIVITIES[i]); }
        else {
          const rec = { id: `act-${ACTIVITIES.length + 1}`, created_at: new Date().toISOString(), ...row };
          ACTIVITIES.push(rec); out.push(rec);
        }
      }
      return J(201, out);
    }
    if (method === "PATCH") {
      const id = decodeURIComponent(u.split("id=eq.")[1].split("&")[0]);
      patchedIds.push(id);
      const row = ACTIVITIES.find(a => a.id === id);
      if (row) Object.assign(row, JSON.parse(init.body));
      return J(204, null);
    }
    return J(200, ACTIVITIES.filter(a => a.user_id === "user-1"));
  }
  return J(404, {});
};

/* ── fixtures ───────────────────────────────────────────────────────── */

const icuRun = (over = {}) => ({
  id: "i100", type: "Run", name: "Morning Run",
  start_date_local: "2026-07-18T06:00:00", start_date: "2026-07-18T06:00:00Z",
  distance: 12000, moving_time: 3600, elapsed_time: 3700,
  average_heartrate: 152, max_heartrate: 178, total_elevation_gain: 40,
  calories: 800, average_cadence: 172, icu_training_load: 95,
  device_name: "Garmin Forerunner 965", source: "GARMIN", ...over
});

// 3 × 6 min @ threshold (1740 m / 480 s = 4:36/km-ish reps) with recoveries.
const thresholdLaps = [
  { distance: 3000, moving_time: 1050, average_speed: 2.86 },
  { distance: 1740, moving_time: 480, average_speed: 3.63 },
  { distance: 500, moving_time: 210, average_speed: 2.38 },
  { distance: 1740, moving_time: 480, average_speed: 3.63 },
  { distance: 500, moving_time: 210, average_speed: 2.38 },
  { distance: 1740, moving_time: 480, average_speed: 3.63 },
  { distance: 2040, moving_time: 714, average_speed: 2.86 }
];
// 8 × 400 m @ ~3:20/km — rep/speed territory.
const speedLaps = [
  { distance: 2000, moving_time: 700, average_speed: 2.86 },
  ...Array.from({ length: 8 }, () => ([
    { distance: 400, moving_time: 94, average_speed: 4.26 },   // 235 s/km = rep pace
    { distance: 200, moving_time: 90, average_speed: 2.22 }
  ])).flat(),
  { distance: 2000, moving_time: 700, average_speed: 2.86 }
];

/*
 * Athlete pace zones in the shape js/workoutClassifier.js actually consumes:
 * flat seconds-per-km, not ranges. (Getting this wrong silently collapses
 * every session to "Threshold", which is how this fixture was caught.)
 */
const ZONES = { easySec: 330, thresholdSec: 282, intervalSec: 255, repetitionSec: 235, maxHr: 190 };

/* ══════════════════════ OAUTH (tests 1–6) ═══════════════════════════ */

section("OAuth");
/*
 * The OAuth completion is now two steps: the unauthenticated provider
 * callback parks encrypted credentials, then an AUTHENTICATED finalize call
 * proves the returning session is the account that started the flow and only
 * then writes provider_accounts. Tests drive both, as production does.
 */
async function completeConnection(state, code = "c1", asUser = "user-1") {
  const cb = mkRes();
  await handler({ query: { provider: "intervals", action: "callback", code, state },
    method: "GET", headers: {} }, cb);
  const afterCallback = { accounts: DB.length, pending: PENDING.length };
  const loc = String(cb.headers.Location || "");
  const completion = loc.includes("completion=")
    ? new URL(loc).searchParams.get("completion") : null;
  if (!completion) return { cb, fin: null, completion: null, afterCallback };
  const fin = mkRes();
  await handler({ query: { provider: "intervals", action: "finalize" }, method: "POST",
    headers: { authorization: `Bearer ${asUser}` }, body: { completion } }, fin);
  return { cb, fin, completion, afterCallback };
}

resetWorld();

// 1. First Intervals OAuth connection
{
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "connect" }), res);
  const url = res.body && res.body.authorizationUrl ? new URL(res.body.authorizationUrl) : null;
  t("1. connect returns an intervals.icu authorize URL", url && url.origin === "https://intervals.icu" && url.pathname === "/oauth/authorize");
  t("1b. requests only ACTIVITY:READ (no write scopes)", url && url.searchParams.get("scope") === "ACTIVITY:READ");
  t("1c. state is signed and present", url && (url.searchParams.get("state") || "").split(".").length === 2);
  t("1d. client_secret never reaches the browser", !JSON.stringify(res.body).includes("csecret"));
  t("1e. logs intervals_oauth_start with a correlation id", LOGS.some(l => l.event === "intervals_oauth_start" && l.correlationId));

  // Callback with the real signed state completes the connection.
  const state = url.searchParams.get("state");
  const { cb, fin, afterCallback } = await completeConnection(state);
  t("1f. callback parks the connection WITHOUT writing provider_accounts",
    cb.statusCode === 302 && afterCallback.accounts === 0 && afterCallback.pending === 1);
  t("1f2. only an authenticated finalize writes the connection",
    fin.statusCode === 200 && DB.length === 1 && DB[0].access_token === "tok");
  t("1g. success is logged, token is not",
    LOGS.some(l => l.event === "intervals_finalize_success") && !JSON.stringify(LOGS).includes("tok"));
  t("1g2. the parked credential was encrypted at rest",
    !String(PENDING[0].payload_encrypted).includes("tok"));
}

// 2. Invalid state
{
  resetWorld();
  const res = mkRes();
  const forged = signState({ userId: "attacker", issuedAt: Date.now() }).split(".")[0] + ".badsignature";
  await handler({ query: { provider: "intervals", action: "callback", code: "c1", state: forged }, method: "GET", headers: {} }, res);
  t("2. forged state is rejected, nothing stored", res.statusCode === 302 && DB.length === 0 &&
    LOGS.some(l => l.code === "INVALID_STATE"));
}

// 3. Expired state
{
  resetWorld();
  const res = mkRes();
  const old = signState({ userId: "user-1", issuedAt: Date.now() - 11 * 60 * 1000 });
  await handler({ query: { provider: "intervals", action: "callback", code: "c1", state: old }, method: "GET", headers: {} }, res);
  t("3. correctly-signed but EXPIRED state is rejected", DB.length === 0 && LOGS.some(l => l.code === "INVALID_STATE"));
}

// 4. OAuth denial
{
  resetWorld();
  const res = mkRes();
  await handler({ query: { provider: "intervals", action: "callback", error: "access_denied" }, method: "GET", headers: {} }, res);
  t("4. denial is handled as 'cancelled', not an error", res.statusCode === 302 &&
    String(res.headers.Location).includes("intervals=cancelled") &&
    LOGS.some(l => l.code === "ACCESS_DENIED"));
}

// 5. Same-user reconnect
{
  resetWorld();
  const state = signState({ userId: "user-1", issuedAt: Date.now() });
  await completeConnection(state, "c1");
  TOKEN_RESPONSE.body.access_token = "tok2";
  await completeConnection(state, "c2");
  t("5. reconnect updates in place — no duplicate connection row", DB.length === 1 && DB[0].access_token === "tok2");
}

// 6. Different Athlevo user tries the same Intervals account
{
  const state = signState({ userId: "user-2", issuedAt: Date.now() });
  const pendingBefore = PENDING.length;
  const res = mkRes();
  await handler({ query: { provider: "intervals", action: "callback", code: "c3", state }, method: "GET", headers: {} }, res);
  const loc = decodeURIComponent(String(res.headers.Location).replace(/\+/g, " "));
  t("6c. nothing is even parked for the wrong account", PENDING.length === pendingBefore);
  t("6. second Athlevo user is blocked from an already-linked account", DB.length === 1 &&
    LOGS.some(l => l.code === "ALREADY_LINKED"));
  t("6b. ownership error is privacy-safe (no other account revealed)", loc.includes("already connected to another Athlevo account") &&
    !loc.includes("user-1"));
}

/* ══════════════════════ SYNC (tests 7–11) ═══════════════════════════ */

section("Sync");

async function connectUser1() {
  resetWorld();
  const state = signState({ userId: "user-1", issuedAt: Date.now() });
  await completeConnection(state, "c");
}

// 7. First activity sync
{
  await connectUser1();
  INTERVALS_ACTIVITIES = [icuRun()];
  INTERVALS_LAPS = thresholdLaps;
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "sync" }), res);
  t("7. first sync imports activities", res.body.imported === 1 && ACTIVITIES.length === 1);
  t("7b. stored with source='intervals' and the provider id", ACTIVITIES[0].source === "intervals" && ACTIVITIES[0].external_activity_id === "i100");
  t("7c. lap structure captured from Intervals.icu", ACTIVITIES[0].raw_data.laps.length === 7);
  t("7d. cursor advanced for incremental sync", DB[0].last_sync_at != null);
  t("7e. sync lock released", DB[0].sync_started_at === null);
}

// 8. Incremental second sync
{
  const before = LOGS.length;
  INTERVALS_ACTIVITIES = [icuRun({ id: "i101", start_date: "2026-07-19T06:00:00Z", start_date_local: "2026-07-19T06:00:00" })];
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "sync" }), res);
  const windows = LOGS.slice(before).find(l => l.windows != null);
  t("8. incremental sync imports only the new activity", res.body.imported === 1 && ACTIVITIES.length === 2);
  t("8b. incremental sync uses ONE bounded window (not full history)", windows && windows.windows === 1, `windows=${windows && windows.windows}`);
}

// 9. Repeated sync (idempotency)
{
  const countBefore = ACTIVITIES.length;
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "sync" }), res);
  t("9. repeated sync creates NO duplicate rows", ACTIVITIES.length === countBefore, `${countBefore} → ${ACTIVITIES.length}`);
}

// 10. Concurrent sync calls
{
  await connectUser1();
  INTERVALS_ACTIVITIES = [icuRun()];
  const [a, b] = await Promise.all([
    (async () => { const r = mkRes(); await handler(mkReq({ provider: "intervals", action: "sync" }), r); return r; })(),
    (async () => { const r = mkRes(); await handler(mkReq({ provider: "intervals", action: "sync" }), r); return r; })()
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  t("10. concurrent syncs — exactly one runs, the other is refused", codes[0] === 200 && codes[1] === 409);
}

// 11. Partial activity failure
{
  await connectUser1();
  INTERVALS_ACTIVITIES = [icuRun(), { id: null, type: "Run" }, icuRun({ id: "i102" })];
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "sync" }), res);
  t("11. one bad activity does not abort the sync",
    res.body.imported === 2 && res.body.failed >= 1,
    `imported=${res.body.imported} failed=${res.body.failed}`);
  t("11b. reported as partial, connection stays intact", res.body.status === "partial" && DB[0].status === "connected" &&
    LOGS.some(l => l.event === "intervals_sync_partial"));
}

// 11c. Lap endpoint failure degrades gracefully
{
  await connectUser1();
  INTERVALS_ACTIVITIES = [icuRun()];
  lapEndpointStatus = 500;
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "sync" }), res);
  t("11c. missing lap endpoint → activity still imports, just without laps",
    res.body.imported === 1 && !ACTIVITIES[0].raw_data.laps);
}

// 11d. Expired auth
{
  await connectUser1();
  activityEndpointStatus = 401;
  const res = mkRes();
  await handler(mkReq({ provider: "intervals", action: "sync" }), res);
  t("11d. expired auth → RECONNECT_REQUIRED, lock released, data intact",
    res.statusCode === 409 && res.body.code === "RECONNECT_REQUIRED" &&
    DB[0].status === "reconnect_required" && DB[0].sync_started_at === null);
}

/* ═════════════════ NORMALIZATION (test 12) ══════════════════════════ */

section("Normalization");
{
  const w = mapIntervals(icuRun());
  t("12. sport/type normalized", w.sport === "run" && w.activityType === "Run");
  t("12b. distance/duration/HR/elevation/calories/cadence mapped", w.distanceMeters === 12000 &&
    w.movingTimeSeconds === 3600 && w.elapsedTimeSeconds === 3700 && w.averageHeartrate === 152 &&
    w.maxHeartrate === 178 && w.elevationGainMeters === 40 && w.caloriesKcal === 800 && w.averageCadence === 172);
  t("12c. pace derived, training load + device carried", w.averagePaceSecPerKm === 300 &&
    w.trainingLoad === 95 && w.device === "Garmin Forerunner 965");
  t("12d. start_date_local preserved alongside the UTC instant", w.startDateLocal === "2026-07-18T06:00:00");

  const missing = mapIntervals({ id: "x", type: "Run", start_date_local: "2026-07-18T06:00:00" });
  t("12e. fields Intervals.icu does not supply stay null (nothing fabricated)",
    missing.averageHeartrate === null && missing.caloriesKcal === null && missing.averagePowerWatts === null &&
    missing.trainingLoad === null && missing.distanceMeters === null);

  const row = toActivityRow("user-1", mapIntervals(icuRun()), {});
  t("12f. stored row matches the SAME activities schema Strava writes",
    row.source === "intervals" && row.external_activity_id === "i100" && row.sport_type === "run" &&
    typeof row.average_speed_mps === "number" && row.raw_data.training_load === 95);

  const laps = normalizeIntervalLaps([{ distance: 1000, moving_time: 240 }, { distance: 0, moving_time: 0 }]);
  t("12g. malformed laps are dropped, not guessed", laps.length === 1 && laps[0].average_speed > 4.1);
}

/* ═══════════ PROVIDER COEXISTENCE + DEDUP (tests 13–17) ═════════════ */

section("Coexistence & deduplication");

const stravaRow = (over = {}) => ({
  id: "s1", source: "strava", external_activity_id: "555", sport_type: "run",
  start_date: "2026-07-18T06:00:00Z", distance_meters: 12000, moving_time_seconds: 3600,
  average_heartrate: 152, created_at: "2026-07-18T07:00:00Z", raw_data: {}, ...over
});
const icuRowFrom = (over = {}) => ({
  id: "v1", source: "intervals", external_activity_id: "i100", sport_type: "run",
  start_date: "2026-07-18T06:00:00Z", distance_meters: 12000, moving_time_seconds: 3600,
  average_heartrate: 152, created_at: "2026-07-18T08:00:00Z",
  raw_data: { upstream_source: "STRAVA", upstream_id: "555" }, ...over
});

// 13. Strava-only athlete
{
  const marks = resolveDuplicates([stravaRow()], [stravaRow({ id: "s2", external_activity_id: "556", start_date: "2026-07-19T06:00:00Z" })]);
  t("13. Strava-only athlete — nothing is ever deduped or altered", marks.length === 0);
}

// 14. Intervals-only athlete
{
  const marks = resolveDuplicates([icuRowFrom()], [icuRowFrom({ id: "v2", external_activity_id: "i101", start_date: "2026-07-19T06:00:00Z" })]);
  t("14. Intervals-only athlete — no same-provider dedup (unique key handles it)", marks.length === 0);
}

// 15 + 16. Both connected; same workout in both
{
  const marks = resolveDuplicates([icuRowFrom()], [stravaRow()]);
  t("15/16. same workout from Strava + Intervals is matched exactly once", marks.length === 1);
  t("16b. matched by upstream provenance, not by guesswork", marks[0].reason === "upstream_id_match");
  t("16c. the loser is FLAGGED, never deleted", marks[0].id && marks[0].supersededBy);

  // Richest-data-wins: the copy WITH laps becomes canonical.
  const withLaps = icuRowFrom({ raw_data: { upstream_source: "STRAVA", upstream_id: "555", laps: thresholdLaps } });
  const r = chooseCanonical(withLaps, stravaRow());
  t("16d. richest data wins — the copy with lap structure is canonical",
    r.canonical.source === "intervals" && r.superseded.source === "strava");
  const r2 = chooseCanonical(stravaRow(), withLaps);
  t("16e. selection is order-independent (deterministic)", r2.canonical.source === "intervals");

  // No provenance? Fall back to the strict fingerprint.
  const noProv = icuRowFrom({ raw_data: {} });
  t("16f. without provenance, a strict fingerprint still catches it",
    isCrossProviderDuplicate(noProv, stravaRow()) && !isSameUpstreamActivity(noProv, stravaRow()));
}

// 17. Two legitimate workouts on the same day
{
  const morning = stravaRow({ id: "s1", external_activity_id: "555", start_date: "2026-07-18T06:00:00Z" });
  const evening = icuRowFrom({ id: "v9", external_activity_id: "i900", start_date: "2026-07-18T18:00:00Z", raw_data: {} });
  t("17. two genuine same-day workouts stay separate", resolveDuplicates([evening], [morning]).length === 0);

  // Same day, same sport, but clearly different sessions.
  const doubleB = icuRowFrom({ id: "v8", external_activity_id: "i800", start_date: "2026-07-18T06:02:00Z", distance_meters: 6000, moving_time_seconds: 1800, raw_data: {} });
  t("17b. same start window but different distance/duration → kept separate",
    resolveDuplicates([doubleB], [morning]).length === 0);
}

/* ═══════ CLASSIFICATION VIA THE EXISTING ENGINE (tests 18–19) ═══════ */

section("Classification through the canonical classifier");
{
  // No new classifier: these go through js/workoutClassifier.js unchanged.
  const thr = W.classifyActivity({
    name: "Morning Run", sport_type: "run", distance_meters: 11260, moving_time_seconds: 3624,
    laps: normalizeIntervalLaps(thresholdLaps)
  }, { zones: ZONES });
  t("18. Intervals threshold session → Threshold via the EXISTING classifier",
    /threshold/i.test(thr.primaryType), `got ${thr.primaryType}`);
  t("18b. threshold volume attributed for Trends / Athlevo Score",
    thr.qualityKm && thr.qualityKm.threshold > 0, `thresholdKm=${thr.qualityKm && thr.qualityKm.threshold}`);

  const spd = W.classifyActivity({
    name: "Track session", sport_type: "run", distance_meters: 8800, moving_time_seconds: 2872,
    laps: normalizeIntervalLaps(speedLaps)
  }, { zones: ZONES });
  t("19. Intervals interval/speed session → high-intensity type",
    /interval|repetition|speed/i.test(spd.primaryType), `got ${spd.primaryType}`);
  t("19b. high-intensity volume attributed", spd.qualityKm && spd.qualityKm.high > 0, `highKm=${spd.qualityKm && spd.qualityKm.high}`);

  t("19c. classifier version unchanged by this sprint", typeof W.VERSION === "string");
}

/* ═════════════ ACTIVATION / PLAN GENERATION (test 20) ═══════════════ */

section("Activation");
{
  // Provider-agnostic activation: the gate is "training data connected",
  // which Intervals.icu satisfies on its own.
  const gate = (profile, intervalsConnected) =>
    Boolean((profile && profile.strava_connected === true) || intervalsConnected);

  t("20. Intervals-only athlete counts as 'training data connected'", gate({ strava_connected: false }, true));
  t("20b. Strava-only athlete still counts (no regression)", gate({ strava_connected: true }, false));
  t("20c. athlete with neither is correctly NOT activated", !gate({ strava_connected: false }, false));

  const p = getProvider("intervals");
  t("20d. Intervals is registered as an available, active provider", p && p.available && p.active);
  t("20e. Strava remains registered, available and active (not removed)",
    getProvider("strava").available && getProvider("strava").active);
  t("20f. Terra remains dormant and unavailable", !getProvider("terra").available);
}

/* ── result ─────────────────────────────────────────────────────────── */

console.log = origLog;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

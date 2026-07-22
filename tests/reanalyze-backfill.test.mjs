/*
 * Athlevo — reanalyze backfill, the production path.
 *
 * Drives the REAL api/providers/index.js router with the EXACT URL and method
 * the browser uses, against an in-memory activities store. Nothing about the
 * routing or the endpoint is mocked. Proves a stored recognition-v1 record
 * ("17 × 5:11") becomes recognition-v2 with 4 work reps.
 *
 * Run: node tests/reanalyze-backfill.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.INTERVALS_CLIENT_ID = "cid";
process.env.INTERVALS_CLIENT_SECRET = "sec";
process.env.OAUTH_STATE_SECRET = "state-secret";
process.env.APP_URL = "https://app.test";

const handler = (await import("../api/providers/index.js")).default;
const { RECOGNITION_VERSION } = await import("../lib/server/wearable/normalizer.js");

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* ── an in-memory activities store behind PostgREST ──────────────────── */

const lap = (d, s) => ({ distance: d, moving_time: s });
const thresholdLaps = [lap(3600, 1200), lap(1440, 360), lap(400, 120), lap(1440, 360),
  lap(400, 120), lap(1440, 360), lap(400, 120), lap(1440, 360), lap(1400, 480)];

function world(rows, meUser = "A") {
  const db = { rows: rows.map(r => ({ ...r, raw_data: JSON.parse(JSON.stringify(r.raw_data)) })) };
  globalThis.fetch = async (u, i = {}) => {
    const s = String(u), m = (i.method || "GET").toUpperCase();
    const J = (c, b) => ({ ok: c >= 200 && c < 300, status: c, json: async () => b, text: async () => JSON.stringify(b) });
    if (s.includes("/auth/v1/user")) {
      const who = String((i.headers && i.headers.Authorization) || "").replace("Bearer ", "");
      return who === "none" ? J(401, {}) : J(200, { id: who || meUser });
    }
    if (s.includes("/rest/v1/activities")) {
      if (m === "GET") {
        const uid = decodeURIComponent((s.match(/user_id=eq\.([^&]+)/) || [])[1] || "");
        return J(200, db.rows.filter(r => r.user_id === uid));
      }
      if (m === "PATCH") {
        const id = decodeURIComponent((s.match(/id=eq\.([^&]+)/) || [])[1] || "");
        const uid = decodeURIComponent((s.match(/user_id=eq\.([^&]+)/) || [])[1] || "");
        const row = db.rows.find(r => r.id === id && r.user_id === uid);
        if (!row) return J(200, []);       // scoped-out → nothing patched
        Object.assign(row, JSON.parse(i.body));
        return J(200, [row]);
      }
    }
    return J(200, []);
  };
  return db;
}

const res = () => { const r = { code: null, body: null, hdrs: {} };
  r.status = c => (r.code = c, r); r.json = b => (r.body = b, r);
  r.setHeader = (k, v) => { r.hdrs[k] = v; }; r.end = () => r; return r; };

// The EXACT request the browser makes: POST /api/providers?provider=intervals&action=reanalyze
const callReanalyze = async (as, body = {}) => {
  const r = res();
  await handler({
    method: "POST",
    url: "/api/providers?provider=intervals&action=reanalyze",
    headers: as === null ? {} : { authorization: `Bearer ${as}` },
    query: { provider: "intervals", action: "reanalyze" },
    body
  }, r);
  return r;
};

/* ══════ PART 3 — routing reaches actionReanalyze ══════════════════ */

section("The browser's exact request routes to actionReanalyze");
{
  const api = readFileSync("./api/providers/index.js", "utf8");
  t("actionReanalyze FUNCTION exists (was missing → 500 in prod)",
    /async function actionReanalyze/.test(api));
  t("...and is routed on action=reanalyze",
    /if \(action === "reanalyze"\) return actionReanalyze/.test(api));

  world([]);
  const r = await callReanalyze("A");
  t("the request returns 200, not a 500", r.code === 200, `${r.code} ${JSON.stringify(r.body)}`);
  t("...with the diagnostic shape", r.body && typeof r.body.scanned === "number" &&
    r.body.currentVersion === RECOGNITION_VERSION);
}

/* ══════ PART 6 — stale v1 is regenerated to v2 ════════════════════ */

section("A stored recognition-v1 activity is regenerated to v2");
{
  const db = world([{
    id: "act1", user_id: "A", start_date: "2026-07-22T07:00:00",
    name: "Morning Run", distance_meters: 12630, moving_time_seconds: 4500,
    raw_data: {
      laps: thresholdLaps,
      recognition: { version: "recognition-v1", workoutType: "Threshold",
        segments: [{ kind: "work", reps: 17 }], coachSummary: "17 × 5:11/km", analyzedAt: "old" }
    }
  }]);

  const r = await callReanalyze("A");
  t("one activity analyzed", r.body.analyzed === 1, JSON.stringify(r.body));
  t("it was counted as STALE, not skipped", r.body.staleRecognition === 1 && r.body.skipped === 0);

  const rec = db.rows[0].raw_data.recognition;
  t("stored recognition is now v2", rec.version === RECOGNITION_VERSION, rec.version);
  const works = (rec.segments || []).filter(s => s.kind === "work");
  t("FOUR work segments, not 17", works.length === 4, JSON.stringify(rec.segments));
  t("each work block ≈ 6 min", works.every(w => Math.abs(w.duration - 360) <= 5));
  t("the original laps are preserved", Array.isArray(db.rows[0].raw_data.laps) &&
    db.rows[0].raw_data.laps.length === thresholdLaps.length);
  t("analyzedAt was refreshed", rec.analyzedAt !== "old");
  t("the stale '17 × 5:11' summary is gone", !/17 ×/.test(rec.coachSummary));
}

/* ══════ idempotency — second run skips ════════════════════════════ */

section("Running again does not re-analyze or duplicate");
{
  const db = world([{
    id: "act1", user_id: "A", start_date: "2026-07-22T07:00:00", name: "Run",
    distance_meters: 12630, moving_time_seconds: 4500, raw_data: { laps: thresholdLaps }
  }]);
  const first = await callReanalyze("A");
  const before = JSON.stringify(db.rows[0].raw_data.recognition);
  const second = await callReanalyze("A");
  t("first run analyzes", first.body.analyzed === 1);
  t("second run skips (already current)", second.body.skipped === 1 && second.body.analyzed === 0);
  t("the stored record is unchanged the second time",
    JSON.stringify(db.rows[0].raw_data.recognition) === before);
}

/* ══════ security — scope + auth ═══════════════════════════════════ */

section("User-scoped and authenticated");
{
  const db = world([
    { id: "mine", user_id: "A", start_date: "2026-07-22T07:00:00", raw_data: { laps: thresholdLaps } },
    { id: "theirs", user_id: "B", start_date: "2026-07-22T07:00:00", raw_data: { laps: thresholdLaps } }
  ]);
  const r = await callReanalyze("A");
  t("only my activities are scanned", r.body.scanned === 1, String(r.body.scanned));
  t("another user's activity is untouched", db.rows.find(x => x.id === "theirs").raw_data.recognition === undefined);

  const anon = await callReanalyze(null);
  t("unauthenticated is rejected", anon.code === 401);
}

section("Per-activity failure never aborts the batch");
{
  const db = world([
    { id: "good", user_id: "A", start_date: "2026-07-22T07:00:00", raw_data: { laps: thresholdLaps } },
    { id: "bad", user_id: "A", start_date: "2026-07-21T07:00:00", raw_data: null }
  ]);
  const r = await callReanalyze("A");
  t("the good activity still analyzes", r.body.analyzed >= 1, JSON.stringify(r.body));
  t("counts are returned even with a bad row",
    typeof r.body.failed === "number" && r.body.scanned === 2);
}

/* ══════ PART 7 — diagnostics distinguish data shapes ══════════════ */

section("Diagnostics report the real stored shape (safely)");
{
  const db = world([
    { id: "withLaps", user_id: "A", start_date: "2026-07-22T07:00:00", raw_data: { laps: thresholdLaps } },
    { id: "noLaps", user_id: "A", start_date: "2026-07-21T07:00:00", raw_data: {} }
  ]);
  const r = await callReanalyze("A");
  t("rowsWithIntervals is reported", r.body.rowsWithIntervals === 1, String(r.body.rowsWithIntervals));
  t("rowsWithoutIntervals is reported", r.body.rowsWithoutIntervals === 1);
  t("missingRecognition is reported", r.body.missingRecognition === 2);
  t("no raw activity data leaks into the response",
    !JSON.stringify(r.body).includes("moving_time") && !JSON.stringify(r.body).includes("laps"));
}

/* ══════ PART 1/8 — client button + refresh, no navigation ═════════ */

section("The client button never navigates and refreshes in place");
{
  const coach = readFileSync("./js/coachTimeline.js", "utf8");
  const brain = readFileSync("./js/brain.js", "utf8");

  t("the button is type=button", /class="ct-backfill" type="button"/.test(coach));
  t("...and calls a handler, NOT location.reload()",
    /onclick="return AthlevoCoach\.runBackfill\(event\);"/.test(coach) &&
    !/onclick="[^"]*location\.reload/.test(coach));
  const fn = coach.slice(coach.indexOf("async function runBackfill"), coach.indexOf("var CELEBRATE_KEY"));
  t("runBackfill preventDefaults", /ev\.preventDefault\(\)/.test(fn) && /ev\.stopPropagation\(\)/.test(fn));
  t("shows 'Analyzing workouts…'", /Analyzing workouts…/.test(fn));
  t("shows a truthful result", /workout.* analyzed/.test(fn) &&
    /Everything is already up to date/.test(fn) && /Analysis failed/.test(fn));
  t("refetches + re-renders WITHOUT reload",
    /loadAthleteActivities\(\)/.test(fn) && /renderTimeline\(acts/.test(fn) && !/location\.reload/.test(fn));

  t("the client selects recognition so the timeline can see it",
    /recognition:raw_data->recognition/.test(brain));
  t("the one-time flag is set ONLY on a reached, successful response",
    /const reached = r && !r\.error && typeof r\.scanned === "number"/.test(brain));
  t("the flag key was re-versioned (broken v2 flags get another attempt)",
    /athlevo_recognition_backfilled_v3/.test(brain));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

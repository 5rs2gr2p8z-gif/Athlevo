/*
 * Athlevo — validates js/productionVerify.js against a simulated dataset that
 * mirrors Dean's real production shape (200 Strava + 58 Intervals, some the
 * same real workouts). Proves the verifier reports TRUE numbers, including
 * deliberately planted faults it must catch.
 *
 * Run: node tests/production-verify.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* ── load the REAL modules into a browser-ish global ────────────────── */

const g = {};
new Function("self", "module", readFileSync("./js/workoutClassifier.js", "utf8"))(g, undefined);

const DAY = 86400000;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

/* ── fixtures ───────────────────────────────────────────────────────── */

// 3 × 6 min threshold reps @ 1740 m / 480 s.
const thresholdLaps = [
  { distance: 3000, moving_time: 1050 }, { distance: 1740, moving_time: 480 },
  { distance: 500, moving_time: 210 }, { distance: 1740, moving_time: 480 },
  { distance: 500, moving_time: 210 }, { distance: 1740, moving_time: 480 },
  { distance: 2040, moving_time: 714 }
];
// 8 × 400 m @ 235 s/km (repetition pace).
const speedLaps = [{ distance: 2000, moving_time: 700 }];
for (let i = 0; i < 8; i++) { speedLaps.push({ distance: 400, moving_time: 94 }); speedLaps.push({ distance: 200, moving_time: 90 }); }
speedLaps.push({ distance: 2000, moving_time: 700 });

const ZONES = { easySec: 330, thresholdSec: 282, intervalSec: 255, repetitionSec: 235, maxHr: 190 };

let ID = 0;
const row = (o) => ({
  id: "row-" + (++ID), name: "Run", sport_type: "run", activity_type: "Run",
  distance_meters: 10000, moving_time_seconds: 3000, elapsed_time_seconds: 3100,
  average_heartrate: 150, max_heartrate: 175, trainer: false,
  created_at: iso(now), raw_data: {}, ...o
});

function buildDataset() {
  const rows = [];

  // 150 Strava easy runs spread over 3 years (some outside the 180d window).
  for (let i = 0; i < 150; i++) {
    rows.push(row({
      source: "strava", external_activity_id: "s" + i,
      start_date: iso(now - (i * 7) * DAY), distance_meters: 10000, moving_time_seconds: 3300
    }));
  }

  // 50 Intervals rows inside 180 days, 8 outside → 58 total, mirroring the
  // "imported 58 but the 180-day probe said 53" situation.
  for (let i = 0; i < 50; i++) {
    rows.push(row({
      source: "intervals", external_activity_id: "i" + i,
      start_date: iso(now - (i * 3) * DAY), distance_meters: 9000, moving_time_seconds: 2900,
      raw_data: { upstream_source: "GARMIN" }
    }));
  }
  for (let i = 0; i < 8; i++) {
    rows.push(row({
      source: "intervals", external_activity_id: "old" + i,
      start_date: iso(now - (200 + i * 10) * DAY), distance_meters: 8000, moving_time_seconds: 2600,
      raw_data: { upstream_source: "GARMIN" }
    }));
  }

  // A real THRESHOLD session from Intervals, with lap structure.
  rows.push(row({
    source: "intervals", external_activity_id: "i-thr", name: "Threshold session",
    start_date: iso(now - 4 * DAY), distance_meters: 11260, moving_time_seconds: 3624,
    raw_data: { upstream_source: "GARMIN", laps: thresholdLaps }
  }));
  // A real SPEED session from Intervals, with lap structure.
  rows.push(row({
    source: "intervals", external_activity_id: "i-spd", name: "Track session",
    start_date: iso(now - 6 * DAY), distance_meters: 8800, moving_time_seconds: 2872,
    raw_data: { upstream_source: "GARMIN", laps: speedLaps }
  }));

  // A RESOLVED cross-provider duplicate: same workout, Strava copy superseded.
  const dupTime = iso(now - 10 * DAY);
  rows.push(row({
    source: "strava", external_activity_id: "555", start_date: dupTime,
    distance_meters: 12000, moving_time_seconds: 3600,
    raw_data: { superseded: true, superseded_by: "intervals:i-dup", superseded_reason: "upstream_id_match" }
  }));
  rows.push(row({
    source: "intervals", external_activity_id: "i-dup", start_date: dupTime,
    distance_meters: 12000, moving_time_seconds: 3600,
    raw_data: { upstream_source: "STRAVA", upstream_id: "555", laps: thresholdLaps }
  }));

  // A PLANTED FAULT: an unresolved duplicate pair the verifier must catch.
  const badTime = iso(now - 12 * DAY);
  rows.push(row({ source: "strava", external_activity_id: "777", start_date: badTime,
    distance_meters: 15000, moving_time_seconds: 4500 }));
  rows.push(row({ source: "intervals", external_activity_id: "i-bad", start_date: badTime,
    distance_meters: 15000, moving_time_seconds: 4500, raw_data: { upstream_source: "GARMIN" } }));

  // Two LEGITIMATE same-day workouts — must NOT be flagged.
  rows.push(row({ source: "strava", external_activity_id: "am", start_date: iso(now - 14 * DAY),
    distance_meters: 8000, moving_time_seconds: 2400 }));
  rows.push(row({ source: "intervals", external_activity_id: "i-pm",
    start_date: iso(now - 14 * DAY + 11 * 3600000), distance_meters: 5000, moving_time_seconds: 1500,
    raw_data: { upstream_source: "GARMIN" } }));

  return rows.sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date));
}

const DATA = buildDataset();

/* ── sandbox: Supabase double + globals the module expects ──────────── */

const sandbox = {
  console,
  supabaseClient: {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => {
      const q = { _from: 0, _to: 499 };
      q.select = () => q; q.eq = () => q; q.order = () => q;
      q.range = (a, b) => { q._from = a; q._to = b; return Promise.resolve({ data: DATA.slice(a, b + 1), error: null }); };
      return q;
    }
  },
  AthlevoWorkoutClassifier: g.AthlevoWorkoutClassifier,
  AthlevoPaceService: { getZones: async () => ZONES },
  AthlevoBrain: { syncIntervals: async () => ({ imported: 0 }) }
};

const src = readFileSync("./js/productionVerify.js", "utf8");
new Function(...Object.keys(sandbox), "window", src + "\n;this.__out = window.AthlevoVerify;")
  .call(sandbox, ...Object.values(sandbox), sandbox);
const V = sandbox.AthlevoVerify;

/* ── run it, silencing the pretty printing ──────────────────────────── */

const realLog = console.log, realTable = console.table, realWarn = console.warn;
console.log = () => {}; console.table = () => {}; console.warn = () => {};
const R = await V.run();
console.log = realLog; console.table = realTable; console.warn = realWarn;

/* ── assertions ─────────────────────────────────────────────────────── */

section("Read integrity");
t("pages past the 200-row loader cap and sees every row",
  R.bySource.strava.total + R.bySource.intervals.total === DATA.length,
  `${R.bySource.strava.total + R.bySource.intervals.total} vs ${DATA.length}`);
// 50 recent + 8 old + threshold + speed + dup + planted-bad + same-day-pm
t("counts Intervals rows correctly", R.intervals.total === 63, `got ${R.intervals.total}`);
t("splits inside vs outside the 180-day window",
  R.intervals.olderThan180d === 8 && R.intervals.within180d === R.intervals.total - 8,
  `in=${R.intervals.within180d} out=${R.intervals.olderThan180d}`);
t("no duplicate external ids within one provider", R.intervals.duplicateExternalIds === 0);

section("Duplicate detection");
t("finds the resolved cross-provider pair", R.dedup.resolved >= 1, `${R.dedup.resolved}`);
t("CATCHES the planted unresolved duplicate", R.dedup.unresolved === 1, `${R.dedup.unresolved}`);
t("does NOT flag two legitimate same-day workouts",
  R.dedup.pairs === R.dedup.resolved + R.dedup.unresolved && R.dedup.pairs === 2,
  `pairs=${R.dedup.pairs}`);
t("superseded rows counted, not deleted", R.dedup.supersededRows === 1);
t("canonical = total - superseded",
  R.dedup.canonicalRows === DATA.length - R.dedup.supersededRows);

section("Volume before / after dedup");
t("dedup REDUCES mileage (the superseded copy is excluded)",
  R.volumeKm.all.canonical < R.volumeKm.all.raw, `${R.volumeKm.all.raw} → ${R.volumeKm.all.canonical}`);
t("the reduction equals exactly the superseded activity (12.0 km)",
  Math.abs((R.volumeKm.all.raw - R.volumeKm.all.canonical) - 12.0) < 0.15,
  `${(R.volumeKm.all.raw - R.volumeKm.all.canonical).toFixed(1)}`);

section("Classification through the REAL engine");
t("threshold sessions recognized", R.classification.thresholdSessions >= 1,
  `${R.classification.thresholdSessions}`);
t("...sourced from Intervals", R.classification.thresholdFromIntervals >= 1);
t("high-intensity sessions recognized", R.classification.highSessions >= 1,
  `${R.classification.highSessions}`);
t("...sourced from Intervals", R.classification.highFromIntervals >= 1);
t("threshold km attributed", R.classification.qualityKm.threshold > 0,
  `${R.classification.qualityKm.threshold.toFixed(1)}`);
t("high-intensity km attributed", R.classification.qualityKm.high > 0,
  `${R.classification.qualityKm.high.toFixed(1)}`);

section("End-to-end example integrity");
t("a REAL threshold example is surfaced with lap structure",
  R.examples.threshold && Array.isArray(R.examples.threshold.laps) &&
  R.examples.threshold.laps.length > 1);
t("a REAL high-intensity example is surfaced", R.examples.high != null);
t("examples come from the Intervals import",
  R.examples.threshold.summary.source === "intervals" &&
  R.examples.high.summary.source === "intervals");
t("threshold example shows lap-derived evidence, not estimation",
  R.examples.threshold.summary.evidence === "lap/interval structure",
  R.examples.threshold.summary.evidence);
t("threshold example reports reps + work pace",
  R.examples.threshold.summary.reps > 1 && R.examples.threshold.summary.workPaceSecPerKm > 0,
  `reps=${R.examples.threshold.summary.reps}`);
t("threshold example contributes threshold km",
  R.examples.threshold.summary.qualityKm.threshold > 0);
t("speed example contributes high-intensity km",
  R.examples.high.summary.qualityKm.high > 0);

section("Score gating");
t("reports the real threshold count", R.scoreGate.thresholdCount === R.classification.thresholdSessions);
t("threshold component gate is >=2 sessions",
  R.scoreGate.thresholdComponentValid === (R.classification.thresholdSessions >= 2));
t("speed component gate is >=1 session",
  R.scoreGate.speedComponentValid === (R.classification.highSessions >= 1));
t("gating rule is stated explicitly", /at least|>=2|>=1/.test(R.scoreGate.rule));

section("Loader truncation");
t("detects that the 200-row cap hides canonical activities",
  R.truncation.hiddenByCap > 0, `hidden=${R.truncation.hiddenByCap}`);
t("cap is reported as 200", R.truncation.loaderCap === 200);
t("superseded rows consume cap slots (counted before filtering)",
  R.truncation.canonicalAfterCap <= R.truncation.rowsLoaderSees);

section("Read-only guarantee");
{
  const s = readFileSync("./js/productionVerify.js", "utf8");
  const runBody = s.slice(s.indexOf("async function run()"), s.indexOf("async function checkIdempotency"));
  t("run() performs no insert/update/delete/upsert",
    !/\.(insert|update|delete|upsert)\s*\(/.test(runBody));
  t("run() issues no POST/PATCH/PUT", !/method:\s*["'](POST|PATCH|PUT|DELETE)["']/.test(runBody));
  t("the only write path is the opt-in idempotency check",
    /checkIdempotency[\s\S]*AthlevoBrain\.syncIntervals/.test(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

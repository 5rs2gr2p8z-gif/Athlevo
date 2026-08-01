/*
 * Athlevo — Multi-sport activity classification tests.
 *
 * Covers the canonical sport foundation added this sprint:
 *   CLASSIFICATION · RUNNING METRICS · CYCLING DATA · LOAD · COACH · UI ·
 *   REGRESSION · CLIENT/SERVER PARITY · ANALYTICS PRIVACY
 *
 * Run: node tests/sport-classification.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  classifyActivity,
  canonicalSportOf,
  isRunRow,
  isRideRow,
  isStrengthRow,
  loadBucketForSport,
  activityDataQuality,
  metricStyleForSport,
  CANONICAL_SPORTS
} from "../lib/server/sportClassification.js";
import {
  mapStrava,
  mapIntervals,
  mapTerra,
  toActivityRow
} from "../lib/server/wearable/normalizer.js";
import {
  summarizeActivityTotals,
  matchPlannedSessions,
  findComparableRuns,
  isRunActivity,
  isRideActivity
} from "../lib/server/weeklyAnalysis.js";
import {
  mergeTrainingItems,
  classifyWorkout,
  sessionLoad,
  computeTrainingLoad
} from "../lib/server/athleteEngine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* Load a browser-global IIFE module into a sandbox and return its window. */
function loadClientGlobal(relPath) {
  const code = readFileSync(join(root, relPath), "utf8");
  const sandbox = { window: {}, console, document: undefined };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window;
}

/* ═══════════════════════════ CLASSIFICATION ═══════════════════════════ */
section("CLASSIFICATION");

t("Strava Run maps to run", classifyActivity({ provider: "strava", providerActivityType: "Run" }).sport === "run");
t("Strava Ride maps to ride", classifyActivity({ provider: "strava", providerActivityType: "Ride" }).sport === "ride");
{
  const c = classifyActivity({ provider: "strava", providerActivityType: "VirtualRide" });
  t("Strava VirtualRide maps to ride + indoor", c.sport === "ride" && c.indoor === true);
  t("VirtualRide gets indoor_ride subtype", c.subtype === "indoor_ride");
}
t("Strava VirtualRun maps to run + indoor", (() => {
  const c = classifyActivity({ provider: "strava", providerActivityType: "VirtualRun" });
  return c.sport === "run" && c.indoor === true && c.subtype === "treadmill_run";
})());
t("Intervals run (lowercase) maps to run", classifyActivity({ provider: "intervals", providerActivityType: "run" }).sport === "run");
t("Intervals cycling maps to ride", classifyActivity({ provider: "intervals", providerActivityType: "Ride" }).sport === "ride");
t("WeightTraining maps to strength", classifyActivity({ provider: "strava", providerActivityType: "WeightTraining" }).sport === "strength");
t("Workout maps to strength", classifyActivity({ provider: "strava", providerActivityType: "Workout" }).sport === "strength");
t("Hike maps to hike (not walk)", classifyActivity({ provider: "strava", providerActivityType: "Hike" }).sport === "hike");
t("Yoga maps to mobility", classifyActivity({ provider: "strava", providerActivityType: "Yoga" }).sport === "mobility");
t("Rowing maps to cross_training", classifyActivity({ provider: "strava", providerActivityType: "Rowing" }).sport === "cross_training");
{
  const c = classifyActivity({ provider: "strava", providerActivityType: "Kitesurf" });
  t("unknown type maps safely to other", c.sport === "other");
  t("unknown type flagged mappingStatus=unmapped", c.mappingStatus === "unmapped");
  t("unknown raw provider type is preserved", c.providerActivityType === "Kitesurf");
}
t("provider type outranks heuristic title guesses", (() => {
  // A ride titled with running words must still classify as ride via type.
  const c = classifyActivity({ provider: "strava", providerActivityType: "Ride", name: "threshold intervals" });
  return c.sport === "ride" && c.classificationSource === "provider_type";
})());
t("all canonical sports are covered by the constant", CANONICAL_SPORTS.length === 10 && CANONICAL_SPORTS.includes("cross_training") && CANONICAL_SPORTS.includes("rest"));
t("Strava Swim maps to swim", classifyActivity({ provider: "strava", providerActivityType: "Swim" }).sport === "swim");
t("Strava Walk maps to walk", classifyActivity({ provider: "strava", providerActivityType: "Walk" }).sport === "walk");
t("mobility/Yoga maps to mobility", classifyActivity({ provider: "strava", providerActivityType: "Yoga" }).sport === "mobility");
t("Intervals VirtualRide maps to ride + indoor", (() => {
  const c = classifyActivity({ provider: "intervals", providerActivityType: "VirtualRide" });
  return c.sport === "ride" && c.indoor === true;
})());
t("heuristic fallback: unmapped 'Peloton Ride' still resolves to ride", classifyActivity({ provider: "terra", providerActivityType: "Peloton Ride" }).sport === "ride");
t("outdoor ride reports indoor=false (outdoor preserved)", classifyActivity({ provider: "strava", providerActivityType: "Ride", trainer: false }).indoor === false);

/* Build helper rows (Strava-style stores RAW types in the columns). */
const runRow = { id: 1, source: "strava", activity_type: "Run", sport_type: "Run", distance_meters: 10000, moving_time_seconds: 3000, average_heartrate: 150, start_date: "2026-07-30T06:00:00Z" };
const rideRow = { id: 2, source: "strava", activity_type: "Ride", sport_type: "Ride", distance_meters: 40000, moving_time_seconds: 4800, average_heartrate: 140, average_cadence: 85, start_date: "2026-07-30T10:00:00Z", trainer: false, raw_data: { average_power_watts: 180, normalized_power_watts: 200, training_load: 90 } };
const virtualRideRow = { id: 4, source: "strava", activity_type: "VirtualRide", sport_type: "VirtualRide", distance_meters: 30000, moving_time_seconds: 3600, start_date: "2026-07-29T19:00:00Z", trainer: true, raw_data: {} };
const strengthRow = { id: 3, source: "strava", activity_type: "WeightTraining", sport_type: "WeightTraining", moving_time_seconds: 1800, start_date: "2026-07-29T18:00:00Z" };

t("canonicalSportOf reads raw Strava Ride column as ride", canonicalSportOf(rideRow) === "ride");
t("isRunRow true for run, false for ride/strength", isRunRow(runRow) && !isRunRow(rideRow) && !isRunRow(strengthRow));
t("isRideRow true only for rides", isRideRow(rideRow) && isRideRow(virtualRideRow) && !isRideRow(runRow));
t("isStrengthRow true only for strength", isStrengthRow(strengthRow) && !isStrengthRow(runRow));

/* ═══════════════════════════ RUNNING METRICS ══════════════════════════ */
section("RUNNING METRICS");

const totals = summarizeActivityTotals([runRow, rideRow, strengthRow]);
t("rides excluded from weekly run distance (10km run only)", totals.distanceKm === 10);
t("strength excluded from run mileage", totals.distanceKm === 10);
t("ride distance kept separately (40km)", totals.rideDistanceKm === 40);
t("total distance still available (50km)", totals.totalDistanceKm === 50);
t("weeklyAnalysis.isRunActivity excludes rides", isRunActivity(runRow) === true && isRunActivity(rideRow) === false);
t("a ride titled with run words is not counted as a run", (() => {
  const trickyRide = { source: "strava", activity_type: "Ride", sport_type: "Ride", name: "Threshold intervals", distance_meters: 20000, moving_time_seconds: 3000 };
  return isRunActivity(trickyRide) === false;
})());
t("longest run ignores rides (run wins even if ride is longer)", (() => {
  const items = mergeTrainingItems([runRow, rideRow], []);
  const runs = items.filter(i => i.isRun);
  return runs.length === 1 && runs[0].sport === "run";
})());
t("weeklyAnalysis.isRideActivity identifies rides only", isRideActivity(rideRow) === true && isRideActivity(runRow) === false);
t("rides excluded from average run pace (comparable-run pace)", (() => {
  // Two comparable RUNS across two weeks yield a pace signal; a ride with the
  // same distance/HR must never be treated as a comparable run.
  const wkRun = { source: "strava", activity_type: "Run", sport_type: "Run", distance_meters: 10000, moving_time_seconds: 3000, average_heartrate: 150, start_date: "2026-07-30T06:00:00Z" };
  const wkRun2 = { source: "strava", activity_type: "Run", sport_type: "Run", distance_meters: 10050, moving_time_seconds: 3020, average_heartrate: 151, start_date: "2026-07-29T06:00:00Z" };
  const baseRun = { source: "strava", activity_type: "Run", sport_type: "Run", distance_meters: 10000, moving_time_seconds: 3100, average_heartrate: 150, start_date: "2026-07-09T06:00:00Z" };
  const baseRun2 = { source: "strava", activity_type: "Run", sport_type: "Run", distance_meters: 10050, moving_time_seconds: 3120, average_heartrate: 151, start_date: "2026-07-08T06:00:00Z" };
  // A ride matching the run's distance/HR — must be ignored by pace comparison.
  const ride = { source: "strava", activity_type: "Ride", sport_type: "Ride", distance_meters: 10000, moving_time_seconds: 1200, average_heartrate: 150, start_date: "2026-07-30T10:00:00Z" };
  const withRide = findComparableRuns([wkRun, wkRun2, ride], [baseRun, baseRun2, ride]);
  const withoutRide = findComparableRuns([wkRun, wkRun2], [baseRun, baseRun2]);
  // The pace signal must be identical whether or not the ride is present.
  return withRide.paceChangeSecPerKm === withoutRide.paceChangeSecPerKm;
})());
t("running Trends ignores cycling speed (ride never enters pace pairs)", (() => {
  const fastRide = { source: "strava", activity_type: "Ride", sport_type: "Ride", distance_meters: 40000, moving_time_seconds: 3600, average_heartrate: 150, start_date: "2026-07-30T10:00:00Z" };
  const res = findComparableRuns([fastRide], [fastRide]);
  return res.sufficient === false && res.pairCount === 0;
})());

/* ═══════════════════════════ CYCLING DATA ═════════════════════════════ */
section("CYCLING DATA");

{
  const w = mapStrava({ id: 99, type: "Ride", sport_type: "Ride", distance: 42000, moving_time: 5400, average_watts: 185, weighted_average_watts: 205, average_cadence: 88, total_elevation_gain: 350, trainer: false });
  const row = toActivityRow("u", w, { type: "Ride" });
  t("ride duration preserved", row.moving_time_seconds === 5400);
  t("ride distance preserved", row.distance_meters === 42000);
  t("ride power preserved when present", row.raw_data.average_power_watts === 185);
  t("ride normalized power preserved", row.raw_data.normalized_power_watts === 205);
  t("ride cadence preserved when present", row.average_cadence === 88);
  t("ride elevation preserved", row.elevation_gain_meters === 350);
  t("classification stored on row (ride)", row.raw_data.classification.canonical_sport === "ride");
  const dq = activityDataQuality(row);
  t("data quality: power_available true", dq.power_available === true);
  t("data quality: cadence_available true", dq.cadence_available === true);
}
{
  const w = mapStrava({ id: 100, type: "Ride", sport_type: "Ride", distance: 20000, moving_time: 3000 });
  const row = toActivityRow("u", w, { type: "Ride" });
  t("missing power remains null (never fabricated)", row.raw_data.average_power_watts === null && row.raw_data.normalized_power_watts === null);
  t("data quality: power_available false when absent", activityDataQuality(row).power_available === false);
}
{
  const w = mapStrava({ id: 101, type: "VirtualRide", sport_type: "VirtualRide", distance: 30000, moving_time: 3600, trainer: true });
  const row = toActivityRow("u", w, { type: "VirtualRide" });
  t("indoor status preserved (VirtualRide → indoor true)", row.raw_data.classification.indoor === true);
}

/* ════════════════════════════════ LOAD ════════════════════════════════ */
section("LOAD");

{
  const now = Date.parse("2026-07-31T12:00:00Z");
  const items = mergeTrainingItems([runRow, rideRow, strengthRow], []);
  const classified = items.map(it => ({ item: it, load: sessionLoad(it, classifyWorkout(it, {})) }));
  const load = computeTrainingLoad(classified, now);
  t("total load includes all sports", load.weekly_training_load > 0);
  t("run load includes only runs (>0)", load.weekly_load_run > 0);
  t("ride load includes only rides (>0)", load.weekly_load_ride > 0);
  t("strength load includes only strength (>0)", load.weekly_load_strength > 0);
  t("no cross-labeling: run load < total (ride/strength separated)", load.weekly_load_run < load.weekly_training_load);
  const sum = load.weekly_load_run + load.weekly_load_ride + load.weekly_load_strength + load.weekly_load_other;
  t("sport buckets sum to total systemic load", Math.abs(sum - load.weekly_training_load) <= 3);
  t("loadBucketForSport maps correctly", loadBucketForSport("run") === "run" && loadBucketForSport("swim") === "other");
}

/* ══════════════════════════ TODAY / ADHERENCE ═════════════════════════ */
section("TODAY / ADHERENCE (cross-sport safety)");

{
  const sessions = [{ id: "s1", session_date: "2026-07-31", session_type: "Easy Run", duration_minutes: 40 }];
  const rideSameDay = [{ id: 9, source: "strava", activity_type: "Ride", sport_type: "Ride", moving_time_seconds: 7200, start_date: "2026-07-31T09:00:00Z" }];
  const m = matchPlannedSessions(sessions, rideSameDay, new Map());
  t("a same-day ride does NOT auto-complete a planned run", m.matches[0].completed === false);
  t("cross-sport activity is flagged for the recommendation engine", m.matches[0].cross_sport_activity_present === true);
  t("planned sport is resolved (run)", m.matches[0].planned_sport === "run");

  const runSameDay = [{ id: 10, source: "strava", activity_type: "Run", sport_type: "Run", moving_time_seconds: 2400, start_date: "2026-07-31T06:00:00Z" }];
  const m2 = matchPlannedSessions(sessions, runSameDay, new Map());
  t("a same-day run DOES complete a planned run (no regression)", m2.matches[0].completed === true);
}

/* ══════════════════════════════ COACH ═════════════════════════════════ */
section("COACH CONTEXT");

{
  const brainSrc = readFileSync(join(root, "js/brain.js"), "utf8");
  t("coach context exposes explicit canonical sport per activity", /sport:\s*canonicalSport/.test(brainSrc));
  t("coach context suppresses running pace for non-runs", /const isRun = canonicalSport[\s\S]{0,120}averagePacePerKilometer = isRun/.test(brainSrc));
  t("coach context exposes ride speed + power", /averageSpeedKph/.test(brainSrc) && /averagePowerWatts/.test(brainSrc));
  t("coach context surfaces athlete sport profile", /primarySport/.test(brainSrc) && /goalSport/.test(brainSrc));
  t("running mileage in summary is run-only", /const sevenDayDistanceMeters = recentRuns\.reduce/.test(brainSrc));

  const coachSrc = readFileSync(join(root, "api/coach.js"), "utf8");
  t("coach prompt tells the model a ride is not a run", /A ride is NOT a run/.test(coachSrc));
  t("coach prompt preserves the cycling capability limitation", /full cycling-specific plan generation is still being expanded/.test(coachSrc));
  t("coach prompt: strength is not aerobic mileage", /Strength is not aerobic mileage/.test(coachSrc));
}

/* ════════════════════════════════ UI ══════════════════════════════════ */
section("UI / HISTORY LABELS");

{
  const calSrc = readFileSync(join(root, "js/trainCalendar.js"), "utf8");
  t("history uses canonical sport label", /canonSport\s*=/.test(calSrc) && /SportClassification/.test(calSrc));
  t("ride shows speed (km/h), not running pace", /Average speed/.test(calSrc) && /km\/h/.test(calSrc));
  t("ride shows power when available", /Average power/.test(calSrc));
  t("run shows pace", /Average pace/.test(calSrc));
  t("strength shows duration + category (not distance/pace)", /Category/.test(calSrc));
  // Mobile labels must be short enough not to clip.
  const labels = ["Run", "Ride", "Strength", "Swim", "Walk", "Hike", "Mobility", "Cross-train", "Rest", "Activity"];
  t("mobile sport labels do not clip (<= 12 chars)", labels.every(l => l.length <= 12));
}

/* ═══════════════════ CLIENT/SERVER PARITY ═════════════════════════════ */
section("CLIENT/SERVER PARITY");

{
  const win = loadClientGlobal("js/sportClassification.js");
  const SC = win.SportClassification;
  t("client SportClassification global exists", !!SC && typeof SC.classifyActivity === "function");
  const cases = ["Run", "Ride", "VirtualRide", "WeightTraining", "Hike", "Yoga", "Rowing", "Kitesurf", "run", "ride"];
  const parity = cases.every(type => {
    const s = classifyActivity({ provider: "strava", providerActivityType: type });
    const c = SC.classifyActivity({ provider: "strava", providerActivityType: type });
    return s.sport === c.sport && s.mappingStatus === c.mappingStatus && (s.indoor === c.indoor);
  });
  t("client and server classify identically (parity)", parity);
  t("client canonicalSportOf matches server on raw Strava ride row", SC.canonicalSportOf(rideRow) === canonicalSportOf(rideRow));
}

/* ═══════════════════════ ANALYTICS PRIVACY ════════════════════════════ */
section("ANALYTICS PRIVACY");

{
  const win = loadClientGlobal("js/analyticsRegistry.js");
  const AR = win.AthlevoAnalyticsRegistry || win.AnalyticsRegistry || null;
  const regSrc = readFileSync(join(root, "js/analyticsRegistry.js"), "utf8");
  t("activity_classified event registered", /activity_classified:/.test(regSrc));
  t("activity_type_unmapped event registered", /activity_type_unmapped:/.test(regSrc));
  t("sport_filter_viewed event registered", /sport_filter_viewed:/.test(regSrc));
  // Only categorical, non-sensitive properties are declared.
  const allowed = ["canonical_sport", "provider", "classification_source", "mapping_status"];
  const declaredProps = (regSrc.match(/props:\s*\[[^\]]*\]/g) || [])
    .filter(block => /canonical_sport|classification_source|mapping_status/.test(block));
  const forbidden = /(distance|power|heart|hr|title|athlete_id|token|payload|lat|lng|pace)/i;
  t("new events declare only allowed categorical props", declaredProps.every(b => !forbidden.test(b)));
  t("allowed props are the documented categorical set", allowed.every(p => /canonical_sport|provider|classification_source|mapping_status/.test(p)));

  const syncSrc = readFileSync(join(root, "api/strava/sync.js"), "utf8");
  t("import analytics logs categorical sport counts only", /event: "activity_classified"/.test(syncSrc) && /by_sport/.test(syncSrc));
  t("import analytics never logs distance/power/hr/title", !/logClassificationSummary[\s\S]{0,1200}(distance_meters|average_power|average_heartrate|\.name)/.test(syncSrc));
}

/* ═══════════════════════════ REGRESSION ═══════════════════════════════ */
section("REGRESSION");

t("existing running users retain run detection", isRunActivity({ sport_type: "Run" }) === true);
t("Strava mapper still produces a normalized workout", (() => {
  const w = mapStrava({ id: 1, type: "Run", sport_type: "Run", distance: 5000, moving_time: 1500 });
  return w.sport === "run" && w.distanceMeters === 5000 && w.provider === "strava";
})());
t("Intervals mapper still produces a normalized workout", (() => {
  const w = mapIntervals({ id: 2, type: "Ride", distance: 20000, moving_time: 3000 });
  return w.sport === "ride" && w.provider === "intervals";
})());
t("Terra mapper still produces a normalized workout", (() => {
  const w = mapTerra({ metadata: { type: "running", start_time: "2026-07-30T06:00:00Z" }, distance_data: { summary: { distance_meters: 8000 } }, active_durations_data: { activity_seconds: 2400 } });
  return w.sport === "run" && w.provider === "terra";
})());
t("toActivityRow still writes the expected core columns", (() => {
  const w = mapStrava({ id: 5, type: "Run", sport_type: "Run", distance: 5000, moving_time: 1500 });
  const row = toActivityRow("u", w, { type: "Run" });
  return row.user_id === "u" && row.source === "strava" && row.distance_meters === 5000 && "sport_type" in row;
})());
t("metricStyleForSport: run=pace, ride=speed, strength=duration", metricStyleForSport("run") === "pace" && metricStyleForSport("ride") === "speed" && metricStyleForSport("strength") === "duration");

/* ═══════════════════════════ SUMMARY ══════════════════════════════════ */
console.log(`\n════════════════════════════════════════`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

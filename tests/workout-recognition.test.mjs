/*
 * Athlevo — workout recognition engine.
 *
 * Executes the REAL lib/server/workoutRecognition.js — the classifier is never
 * mocked. Covers the required type list and the deterministic guarantees the
 * downstream features (Score, Recovery, adaptive plans) rely on.
 *
 * Run: node tests/workout-recognition.test.mjs
 */

import { recognizeWorkout, TYPES } from "../lib/server/workoutRecognition.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const ZONES = { easySec: 330, thresholdSec: 258, intervalSec: 240, repetitionSec: 225, maxHr: 190 };

// Helper: build laps from [distanceM, seconds] pairs.
const laps = (...pairs) => pairs.map(([d, s]) => ({ distance_meters: d, moving_time_seconds: s }));

/* ══════════ threshold — the headline example ═══════════════════════ */

section("Threshold: 20' warmup + 4 × 6' threshold + 2' jogs + cooldown");
{
  const r = recognizeWorkout({
    name: "Morning Run", distance_meters: 12000, moving_time_seconds: 3720,
    laps: laps([3600, 1200], [1395, 360], [420, 120], [1395, 360], [420, 120],
               [1395, 360], [420, 120], [1395, 360], [1500, 480])
  }, { zones: ZONES });

  t("recognised as Threshold", r.workoutType === TYPES.THRESHOLD, r.workoutType);
  t("NOT a generic run", !/Run$/.test(r.workoutType) || r.workoutType === TYPES.THRESHOLD);
  t("high confidence from lap structure", r.confidence >= 0.75, String(r.confidence));
  t("finds four work reps (as four work blocks)",
    r.segments.filter(s => s.kind === "work").length === 4, JSON.stringify(r.segments));
  t("each work block ≈ 6 min", r.segments.filter(s => s.kind === "work").every(s => Math.abs(s.duration - 360) <= 5));
  t("has warmup and cooldown segments",
    r.segments.some(s => s.kind === "warmup") && r.segments.some(s => s.kind === "cooldown"));
  t("coach summary names the rep structure", /4 × 6-min threshold/.test(r.coachSummary));
  t("summary is one honest sentence-ish, not empty", r.coachSummary.length > 30);
}

/* ══════════ intervals / VO2 / speed ════════════════════════════════ */

section("VO2 / intervals: 5 × 3 min hard with recoveries");
{
  const r = recognizeWorkout({
    name: "Intervals", distance_meters: 10000, moving_time_seconds: 3000,
    laps: laps([2400, 900], [740, 180], [400, 120], [740, 180], [400, 120],
               [740, 180], [400, 120], [740, 180], [400, 120], [740, 180], [1600, 480])
  }, { zones: ZONES });
  t("a hard rep session is quality, not easy",
    [TYPES.VO2, TYPES.INTERVALS, TYPES.THRESHOLD, TYPES.SPEED].includes(r.workoutType), r.workoutType);
  t("finds five work reps (five work blocks)",
    r.segments.filter(s => s.kind === "work").length === 5, JSON.stringify(r.segments));
  t("confident from structure", r.confidence >= 0.7);
}

section("Speed: 8 × 30 sec very fast");
{
  const reps = [];
  reps.push([2000, 600]);                       // warmup
  for (let i = 0; i < 8; i++) { reps.push([150, 30]); reps.push([200, 90]); }  // 30s fast / 90s jog
  reps.push([1500, 480]);                        // cooldown
  const r = recognizeWorkout({ name: "Strides session", distance_meters: 6000,
    moving_time_seconds: 2400, laps: laps(...reps) }, { zones: ZONES });
  t("short fast reps → Speed", r.workoutType === TYPES.SPEED, r.workoutType);
}

/* ══════════ easy / recovery / long ═════════════════════════════════ */

section("Easy run: steady, easy pace, no structure");
{
  const r = recognizeWorkout({
    name: "Easy", distance_meters: 10000, moving_time_seconds: 3300,   // 5:30/km
    average_heartrate: 138, max_heartrate: 150,
    laps: laps([2000, 662], [2000, 658], [2000, 665], [2000, 655], [2000, 660])
  }, { zones: ZONES });
  t("recognised as Easy", r.workoutType === TYPES.EASY, r.workoutType);
  t("no work reps detected", !r.segments.some(s => s.kind === "work"));
  t("summary talks about aerobic volume", /aerobic|easy/i.test(r.coachSummary));
}

section("Recovery run: short and very easy");
{
  const r = recognizeWorkout({
    name: "Shakeout", distance_meters: 5000, moving_time_seconds: 1800,   // 30 min, 6:00/km
    average_heartrate: 125, max_heartrate: 138
  }, { zones: ZONES });
  t("recognised as Recovery", r.workoutType === TYPES.RECOVERY, r.workoutType);
}

section("Long run: 2 hours");
{
  const r = recognizeWorkout({
    name: "Sunday long", distance_meters: 26000, moving_time_seconds: 7800,   // 130 min
    average_heartrate: 145
  }, { zones: ZONES });
  t("recognised as Long Run", r.workoutType === TYPES.LONG, r.workoutType);
  t("summary mentions durability or time on feet", /durabilit|time on feet|long/i.test(r.coachSummary));
}

/* ══════════ progression / race / hills / fartlek (title-driven) ════ */

section("Progression run (title)");
{
  const r = recognizeWorkout({ name: "Progression run", distance_meters: 14000,
    moving_time_seconds: 4200 }, { zones: ZONES });
  t("recognised as Progression Run", r.workoutType === TYPES.PROGRESSION, r.workoutType);
}

section("Race (title)");
{
  const r = recognizeWorkout({ name: "Parkrun PB!", distance_meters: 5000,
    moving_time_seconds: 1080, average_heartrate: 178, max_heartrate: 189 }, { zones: ZONES });
  t("recognised as Race", r.workoutType === TYPES.RACE, r.workoutType);
  t("summary frames it as a fitness anchor", /anchor|race/i.test(r.coachSummary));
}

section("Hill repeats (title + structure)");
{
  const r = recognizeWorkout({ name: "Hill repeats",
    distance_meters: 8000, moving_time_seconds: 2700,
    laps: laps([2000, 660], [300, 75], [300, 150], [300, 75], [300, 150],
               [300, 75], [300, 150], [1600, 520]) }, { zones: ZONES });
  t("recognised as Hill Repeats", r.workoutType === TYPES.HILLS, r.workoutType);
}

section("Fartlek (title)");
{
  const r = recognizeWorkout({ name: "Fartlek fun", distance_meters: 9000,
    moving_time_seconds: 2700, laps: laps([1000, 300], [500, 120], [1000, 330], [500, 120], [1000, 300]) },
    { zones: ZONES });
  t("recognised as Fartlek", r.workoutType === TYPES.FARTLEK, r.workoutType);
}

/* ══════════ unknown & robustness ═══════════════════════════════════ */

section("Unknown when there is nothing to go on");
{
  const r = recognizeWorkout({ moving_time_seconds: 600 }, {});
  t("degrades to Unknown, not a confident guess", r.workoutType === TYPES.UNKNOWN, r.workoutType);
  t("low confidence", r.confidence < 0.5);
  t("summary admits it can't classify", /Not enough structure/.test(r.coachSummary));
}

section("Robust to junk input");
{
  for (const bad of [null, undefined, {}, { laps: "nope" }, { distance_meters: "x" }]) {
    const r = recognizeWorkout(bad, {});
    t(`no throw on ${JSON.stringify(bad)}`, r && typeof r.workoutType === "string");
  }
}

/* ══════════ deterministic ══════════════════════════════════════════ */

section("Deterministic — same input, same output");
{
  const act = { name: "Threshold", distance_meters: 12000, moving_time_seconds: 3720,
    laps: laps([3600, 1200], [1395, 360], [420, 120], [1395, 360], [420, 120],
               [1395, 360], [420, 120], [1395, 360], [1500, 480]) };
  const a = recognizeWorkout(act, { zones: ZONES });
  const b = recognizeWorkout(act, { zones: ZONES });
  t("identical result twice", JSON.stringify(a) === JSON.stringify(b));
  t("input was not mutated", act.laps.length === 9 && act.name === "Threshold");
}

section("Signals are machine-readable and PII-free");
{
  const r = recognizeWorkout({ name: "Threshold", laps: laps([3600, 1200], [1395, 360],
    [420, 120], [1395, 360], [420, 120], [1395, 360]) }, { zones: ZONES });
  const dump = JSON.stringify(r.signals);
  t("signals describe WHY", /laps|title|avgZone/.test(dump));
  t("no athlete name or free text in signals", !/Morning|athlete|email/i.test(dump));
}

/* ══════════ PART 1 & 2 — coach activation + setup disappears ═══════ */

import { readFileSync } from "node:fs";

section("Part 1 — coach activation milestone");
{
  const ps = readFileSync("./js/planSetup.js", "utf8");
  const fn = ps.slice(ps.indexOf("if (firstEver) {"), ps.indexOf("return;   // an intentional"));
  t("title 'Your AI coach is ready.'", /Your AI coach is ready\./.test(fn));
  t("subtitle names the analysis", /analyzed your athlete profile and recent/.test(fn));
  ["Athlete profile analyzed", "Training history analyzed",
   "Current fitness estimated", "First training week created"].forEach(line =>
    t(`shows '${line}'`, fn.includes(line)));
  t("primary CTA is 'Open My Coach'", /Open My Coach/.test(fn));
  t("it is a ONE-TIME state gated on the first plan",
    /showSuccess\(outcome\.alreadyExists !== true\)/.test(ps));
  t("no auto-dismiss on the milestone", /an intentional, un-timed milestone/.test(ps));
}

section("Part 2 — after a plan exists, the setup card is gone for good");
{
  const ps = readFileSync("./js/planSetup.js", "utf8");
  const cta = ps.slice(ps.indexOf("function renderTodayCta"), ps.indexOf("function connectTrainingData"));
  t("the Today CTA hides itself when a plan exists",
    /if \(has !== false\) \{ el\.style\.display = "none"; el\.innerHTML = ""; return; \}/.test(cta));
  t("...so 'Connect Training Data' cannot reappear once a plan exists",
    /if \(has !== false\)[\s\S]{0,80}return;/.test(cta) &&
    cta.indexOf("Connect Training Data") > cta.indexOf("has !== false"));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

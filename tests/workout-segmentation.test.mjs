/*
 * Athlevo — workout segmentation.
 *
 * Executes the REAL lib/server/workoutSegmentation.js. The one rule that
 * matters: no workout ever explodes into dozens of tiny intervals. The
 * "17 × 5:11/km" production bug must be impossible.
 *
 * Run: node tests/workout-segmentation.test.mjs
 */

import { segmentWorkout } from "../lib/server/workoutSegmentation.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const lap = (d, s, type) => type ? { distance: d, moving_time: s, type } : { distance: d, moving_time: s };
const work = r => r.segments.filter(s => s.type === "work");
const shape = r => r.segments.map(s => s.type + ":" + s.duration).join(" ");

/* ══════ the production bug — must never recur ═════════════════════ */

section("17 near-uniform 1 km auto-splits do NOT become 17 intervals");
{
  const splits = Array.from({ length: 17 }, (_, i) => lap(1000, 310 + (i % 3 === 0 ? -6 : i % 3 === 1 ? 4 : 0)));
  const r = segmentWorkout(splits);
  t("segment count is small, not ~17", r.segments.length <= 3, String(r.segments.length));
  t("zero work reps from a steady run", r.reps === 0, String(r.reps));
  t("no segment is a tiny fragment", r.segments.every(s => s.duration >= 60));
}

/* ══════ Part 5 — the real 4 × 6 min threshold (plain laps) ════════ */

section("4 × 6-min threshold reconstructs to warmup / 4 work / 3 recovery / cooldown");
{
  const F = [lap(3600, 1200), lap(1440, 360), lap(400, 120), lap(1440, 360), lap(400, 120),
             lap(1440, 360), lap(400, 120), lap(1440, 360), lap(1400, 480)];
  const r = segmentWorkout(F);
  t("exactly 4 work reps", r.reps === 4, String(r.reps));
  t("each work rep ≈ 6 min", work(r).every(s => Math.abs(s.duration - 360) <= 5), shape(r));
  t("first segment is warm-up ≈ 20 min",
    r.segments[0].type === "warmup" && Math.abs(r.segments[0].duration - 1200) <= 5);
  t("last segment is cooldown", r.segments[r.segments.length - 1].type === "cooldown");
  t("3 recoveries between the 4 reps", r.segments.filter(s => s.type === "recovery").length === 3);
  t("work is faster than recovery",
    work(r)[0].avgPace < r.segments.filter(s => s.type === "recovery")[0].avgPace);
  t("every boundary records WHY it was chosen", r.segments.every(s => s.reason && s.reason.length > 5));
}

/* ══════ Part 2 — explicit device interval types used directly ═════ */

section("Explicit Intervals.icu types are used, not reconstructed");
{
  const typed = [
    lap(3600, 1200, "WARMUP"),
    lap(1440, 360, "WORK"), lap(400, 120, "RECOVERY"),
    lap(1440, 360, "WORK"), lap(400, 120, "RECOVERY"),
    lap(1440, 360, "WORK"), lap(400, 120, "RECOVERY"),
    lap(1440, 360, "WORK"), lap(1400, 480, "COOLDOWN")
  ];
  const r = segmentWorkout(typed);
  t("uses the explicit types", /explicit interval types/.test(r.source));
  t("4 work reps", r.reps === 4);
  t("contiguous same-type laps merge", r.segments.filter(s => s.type === "work").length === 4);
}

section("Explicit types: consecutive WORK laps merge into ONE rep");
{
  const typed = [
    lap(2000, 600, "WARMUP"),
    lap(1000, 240, "WORK"), lap(1000, 240, "WORK"),   // one 2-km work block
    lap(400, 120, "RECOVERY"),
    lap(1000, 240, "WORK"), lap(1000, 240, "WORK"),
    lap(1500, 450, "COOLDOWN")
  ];
  const r = segmentWorkout(typed);
  t("two work reps, not four", r.reps === 2, String(r.reps));
  t("each merged rep is 8 min", work(r).every(s => s.duration === 480));
}

/* ══════ Part 6 — required fixtures, none explodes ═════════════════ */

section("6 × 800 m intervals");
{
  const s = [lap(2000, 600)];
  for (let i = 0; i < 6; i++) { s.push(lap(800, 168)); s.push(lap(200, 66)); }   // 800 @ 3:30, 200 jog
  s.push(lap(1500, 450));
  const r = segmentWorkout(s);
  t("6 work reps", r.reps === 6, String(r.reps));
  t("no fragment shorter than the min recovery", r.segments.every(x => x.duration >= 30));
  t("not dozens of segments", r.segments.length <= 15);
}

section("10 × 400 m intervals");
{
  const s = [lap(1600, 480)];
  for (let i = 0; i < 10; i++) { s.push(lap(400, 80)); s.push(lap(200, 72)); }   // 400 @ 3:20, 200 jog
  s.push(lap(1200, 360));
  const r = segmentWorkout(s);
  t("10 work reps", r.reps === 10, String(r.reps));
  t("never dozens of tiny intervals", r.segments.length <= 23 && r.segments.every(x => x.duration >= 30));
}

section("20-min tempo (one sustained effort)");
{
  const s = [lap(2000, 600),
    lap(1200, 288), lap(1200, 288), lap(1200, 288), lap(1200, 288),   // 20 min @ 4:00 continuous
    lap(1500, 450)];
  const r = segmentWorkout(s);
  t("ONE continuous work block, not four", r.reps === 1, String(r.reps));
  t("the block is ~20 min", work(r)[0] && Math.abs(work(r)[0].duration - 1152) <= 5);
}

section("Long run (steady)");
{
  const s = Array.from({ length: 13 }, (_, i) => lap(2000, 660 + (i % 2 ? 6 : -6)));   // 26 km, ~5:30
  const r = segmentWorkout(s);
  t("no work reps in a steady long run", r.reps === 0, String(r.reps));
  t("one steady segment", r.segments.length === 1);
}

section("Progression run (gradually faster)");
{
  const s = [];
  for (let i = 0; i < 10; i++) s.push(lap(1000, 360 - i * 8));   // 6:00 → 4:48, smooth
  const r = segmentWorkout(s);
  t("a smooth progression is NOT chopped into many reps", r.reps <= 1, String(r.reps));
  t("stays a small number of segments", r.segments.length <= 3);
}

section("Fartlek (irregular surges)");
{
  const s = [lap(1500, 450),
    lap(600, 150), lap(400, 132), lap(700, 175), lap(500, 165), lap(800, 200), lap(400, 130),
    lap(1500, 450)];
  const r = segmentWorkout(s);
  t("surges are found but not exploded", r.reps >= 2 && r.reps <= 6, String(r.reps));
  t("no fragment below the minimum", r.segments.every(x => x.duration >= 30));
}

section("Easy run (flat)");
{
  const s = Array.from({ length: 6 }, () => lap(1000, 330));
  const r = segmentWorkout(s);
  t("zero reps", r.reps === 0);
  t("one segment", r.segments.length === 1);
}

/* ══════ robustness + configurability ═════════════════════════════ */

section("Configurable + robust");
{
  t("empty laps → empty segmentation", segmentWorkout([]).segments.length === 0);
  t("null → no throw", segmentWorkout(null).reps === 0);
  t("minWorkSec is configurable",
    segmentWorkout([lap(3600, 1200), lap(1440, 360), lap(400, 120), lap(1440, 360),
      lap(400, 120), lap(1440, 360), lap(1400, 480)], { minWorkSec: 999 }).reps === 0);
  const a = segmentWorkout([lap(3600, 1200), lap(1440, 360), lap(400, 120), lap(1440, 360), lap(1400, 480)]);
  const b = segmentWorkout([lap(3600, 1200), lap(1440, 360), lap(400, 120), lap(1440, 360), lap(1400, 480)]);
  t("deterministic", JSON.stringify(a) === JSON.stringify(b));
  t("segment shape matches the Part-4 contract",
    a.segments.every(s => typeof s.type === "string" && typeof s.duration === "number" &&
      (s.avgPace == null || typeof s.avgPace === "number")));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

/*
 * Athlevo — recognition persistence + display pipeline.
 *
 * Drives the REAL normalizer (which now runs the REAL recognition engine at
 * import) and the REAL client coach-timeline module. Nothing is mocked.
 *
 * Run: node tests/recognition-pipeline.test.mjs
 */

import { readFileSync } from "node:fs";
import { mapIntervals, toActivityRow, buildRecognition } from "../lib/server/wearable/normalizer.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

// Load the REAL client module the way the page does.
const coachSrc = readFileSync("./js/coachTimeline.js", "utf8");
const cm = { exports: {} };
new Function("module", "window", coachSrc + "\nmodule.exports = (typeof window!=='undefined'&&window.AthlevoCoach)||module.exports;")(cm, {});
const Coach = cm.exports;

const lap = (d, s) => ({ distance: d, moving_time: s });          // normalized lap shape
const thresholdLaps = [lap(3600, 1200), lap(1395, 360), lap(420, 120), lap(1395, 360),
  lap(420, 120), lap(1395, 360), lap(420, 120), lap(1395, 360), lap(1500, 480)];

function importActivity({ id = "i1", name = "Morning Run", laps = null, date = "2026-07-22T07:00:00",
                          distance = 12000, moving = 3720 } = {}) {
  const raw = { id, name, type: "Run", start_date_local: date, distance, moving_time: moving };
  const w = mapIntervals(raw);
  if (laps) w.laps = laps;
  return toActivityRow("u1", w, raw);
}

/* ══════ PART 1 — recognition persists at import ════════════════════ */

section("1. Every imported activity carries a stored recognition");
{
  const row = importActivity({ laps: thresholdLaps });
  const rec = row.raw_data.recognition;
  t("recognition is stored in raw_data", Boolean(rec));
  t("...with a workoutType", typeof rec.workoutType === "string" && rec.workoutType !== "");
  t("...a confidence", typeof rec.confidence === "number");
  t("...segments", Array.isArray(rec.segments) && rec.segments.length > 0);
  t("...a coach summary (the stored insight)", typeof rec.coachSummary === "string" && rec.coachSummary.length > 20);
  t("...an analyzedAt timestamp", typeof rec.analyzedAt === "string");
  t("...and a version tag", rec.version === "recognition-v2");
  t("a structured run is recognised as a quality session, not generic",
    ["Threshold", "Intervals", "VO2", "Speed"].includes(rec.workoutType), rec.workoutType);
}

section("1b. Recognition never breaks an import");
{
  // A workout with garbage laps must still import, just without recognition.
  const row = importActivity({ laps: "not-laps" });
  t("the row still builds", Boolean(row && row.raw_data));
  t("recognition is null rather than throwing", row.raw_data.recognition == null ||
    typeof row.raw_data.recognition.workoutType === "string");
}

/* ══════ duplicate prevention — deterministic re-import ═════════════ */

section("2. Re-import never changes a stored recognition (analyze once)");
{
  const a = importActivity({ laps: thresholdLaps });
  const b = importActivity({ laps: thresholdLaps });
  const strip = r => ({ ...r, analyzedAt: null });
  t("the recognition CONTENT is identical on re-import",
    JSON.stringify(strip(a.raw_data.recognition)) === JSON.stringify(strip(b.raw_data.recognition)));
  t("buildRecognition is deterministic",
    JSON.stringify(strip(buildRecognition({ name: "x", laps: thresholdLaps }))) ===
    JSON.stringify(strip(buildRecognition({ name: "x", laps: thresholdLaps }))));
}

/* ══════ PART 2 — activity relabeling ══════════════════════════════ */

section("3. The Train card shows the DETECTED workout, not '12.6 km'");
{
  const row = importActivity({ laps: thresholdLaps });
  const label = Coach.activityLabel(row);
  t("label is a recognised session, not a distance",
    !/km/.test(label) && /Session|Run|Intervals|Threshold/.test(label), label);
  t("a quality session gets a 'Session' suffix", /Session$/.test(label) || label === "Intervals Session", label);
  t("it is flagged as auto-detected", Coach.isAutoDetected(row) === true);

  // An easy steady run with no structure falls back gracefully.
  const easy = importActivity({ id: "i2", name: "Easy", distance: 10000, moving: 3300,
    laps: [lap(2000, 662), lap(2000, 658), lap(2000, 665), lap(2000, 655), lap(2000, 660)] });
  t("an easy run reads as Easy Run", /Easy Run/.test(Coach.activityLabel(easy)), Coach.activityLabel(easy));

  // No recognition at all → distance fallback, never blank.
  const bare = { distance_meters: 8000 };
  t("no recognition → distance fallback", /8\.0 km/.test(Coach.activityLabel(bare)));
}

section("3b. The train card markup surfaces the coach fields");
{
  const cal = readFileSync("./js/trainCalendar.js", "utf8");
  t("card uses AthlevoCoach.activityLabel", /AthlevoCoach\.activityLabel/.test(cal));
  t("card shows a 'Detected automatically' badge", /Detected automatically/.test(cal));
  t("card shows the Workout detail heading", /twm-block-h">Workout</.test(cal));
  t("card shows the coach summary", /AthlevoCoach\.coachSummary/.test(cal));
  t("card offers 'View Analysis'", /View Analysis/.test(cal));
}

/* ══════ PART 3 — the stored coach insight ═════════════════════════ */

section("4. The coach summary IS the persisted, once-generated insight");
{
  const row = importActivity({ laps: thresholdLaps });
  const rec = row.raw_data.recognition;
  t("the summary is stored WITH the activity", typeof rec.coachSummary === "string");
  t("it is generated at import time (analyzedAt present)", Boolean(rec.analyzedAt));
  t("import preserves an existing record instead of regenerating it",
    /recognition: reuseOrBuildRecognition\(w, opts\.existingRecognition/.test(readFileSync("./lib/server/wearable/normalizer.js", "utf8")));
}


/* ══════ PART 6 — first-sync celebration aggregates ════════════════ */

section("6. Celebration stats are real, derived values");
{
  const acts = [];
  for (let i = 0; i < 12; i++) acts.push(importActivity({ id: "th" + i,
    date: `2026-0${1 + (i % 3)}-1${i % 9}T07:00:00`, laps: thresholdLaps }));
  for (let i = 0; i < 5; i++) acts.push(importActivity({ id: "long" + i, name: "Long run",
    date: `2026-04-1${i}T07:00:00`, distance: 26000, moving: 7800 }));

  const c = Coach.syncCelebration(acts);
  t("activities counted", c.activities === 17, String(c.activities));
  t("long runs counted", c.longRuns === 5, String(c.longRuns));
  t("quality sessions counted (threshold-type)", c.qualitySessions >= 12, String(c.qualitySessions));
  t("weeks-of-training is derived from the date span", typeof c.weeks === "number" && c.weeks >= 1);
  t("training load is flagged as estimable once there's data", c.trainingLoadEstimated === true);
  t("empty input yields zeros, not invented values",
    Coach.syncCelebration([]).activities === 0 && Coach.syncCelebration([]).weeks === null);
}

/* ══════ PART 5 — the activity detail modal ════════════════════════ */

section("7. Activity detail renders recognition, not just distance/pace");
{
  const cal = readFileSync("./js/trainCalendar.js", "utf8");
  t("detail reads the STORED recognition", /AthlevoCoach\.getStoredRecognition\(act\)/.test(cal));
  t("shows the Workout detail heading", /twm-block-h">Workout</.test(cal));
  t("shows Confidence", /Confidence/.test(cal));
  t("shows the coach summary", /twm-coachsum/.test(cal));
  t("shows the workout structure visualization", /Workout structure/.test(cal) && /WorkoutStructureView\.render/.test(cal));
  t("metrics come after the workout block", cal.indexOf('twm-block-h">Metrics') > cal.indexOf('twm-block-h">Workout'));
}


section("13. PART 4 — the exact 12.63 km / 4 × 6-min threshold fixture, end to end");
{
  // Realistic laps: faster work reps, slower jog recoveries, warm-up + cooldown.
  const F = [
    lap(3600, 1200),   // 20-min warm-up  ~5:33/km
    lap(1440, 360),    // 6-min threshold ~4:10/km
    lap(400, 120),     // 2-min jog       ~5:00/km
    lap(1440, 360),
    lap(400, 120),
    lap(1440, 360),
    lap(400, 120),
    lap(1440, 360),    // 4th rep
    lap(1400, 480)     // cooldown ~5:43/km (SLOWER than the work reps)
  ];
  const row = importActivity({ id: "prod", name: "Morning Run", distance: 12630, moving: 4500, laps: F });
  const rec = row.raw_data.recognition;

  t("workout type = Threshold-family quality (not a generic run)",
    ["Threshold", "Intervals", "VO2", "Speed"].includes(rec.workoutType), rec.workoutType);
  const workBlocks = rec.segments.filter(s => s.kind === "work");
  t("four work intervals detected", workBlocks.length === 4, JSON.stringify(rec.segments));
  t("work duration ≈ 6 min each", workBlocks.every(w => Math.abs(w.duration - 360) <= 5),
    workBlocks.map(w => w.duration).join(","));
  t("confidence is appropriately high", rec.confidence >= 0.7, String(rec.confidence));

  // Train card label
  const label = Coach.activityLabel(row);
  t("Train card says a Session, not '12.6 km'", /Session$/.test(label) && !/km/.test(label), label);

  // Activity detail: 4 × 6 min derivable from the stored segments
  t("detail can show 4 × 6 min", workBlocks.length === 4 && Math.round(workBlocks[0].duration / 60) === 6);

  // Re-import does not duplicate or alter the analysis
  const rawObj = { id: "prod", name: "Morning Run", type: "Run", start_date_local: "2026-07-22T07:00:00", distance: 12630, moving_time: 4500 };
  const w2 = mapIntervals(rawObj); w2.laps = F;
  const reimport = toActivityRow("u1", w2, rawObj, { existingRecognition: rec });
  t("re-import preserves the SAME analysis object", JSON.stringify(reimport.raw_data.recognition) === JSON.stringify(rec));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

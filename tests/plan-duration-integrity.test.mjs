/*
 * Athlevo — planned-workout duration integrity.
 *
 * Production shipped a Thursday threshold whose card said 117 minutes while its
 * own workout intended 70 ("cool down until 70 minutes total"). The corruption
 * was Athlevo's OWN reconciliation: sectionMinutes() read the "70 total"
 * directive as an additive 70-minute cooldown SEGMENT and summed it on top of
 * warm-up (20) + main (27) = 117, then overwrote the model's correct 70.
 *
 * Uses the exact production fixture. Drives the REAL server + client twins and
 * asserts one canonical duration everywhere.
 *
 * Run: node tests/plan-duration-integrity.test.mjs
 */

import { readFileSync } from "node:fs";
import { validatePrescription, canonicalDurationMinutes, sectionMinutes,
         totalDirectiveMinutes } from "../lib/server/prescription.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

// The REAL client twin, loaded the way the page loads it.
const clientSrc = readFileSync("./js/prescription.js", "utf8");
const cm = { exports: {} };
new Function("module", "window", clientSrc)(cm, {});
const client = cm.exports;

/* The exact observed Thursday workout, phrased as the model emitted it. */
const THURSDAY = {
  session_date: "2026-07-23", session_type: "threshold", title: "Threshold",
  duration_minutes: 70,
  warmup: ["20 min easy warm-up", "4 x 20 sec strides"],
  main_set: ["3 x 8 min threshold", "3 min jog recoveries"],
  cooldown: ["Cool down until 70 min total"]
};

/* ══════ 1. "until 70 minutes total" → 70, everywhere ═══════════════ */

section("1. The 70-total fixture stores and displays 70, not 117");
{
  t("the total directive is recognised, not summed as a segment",
    totalDirectiveMinutes(THURSDAY.cooldown) === 70);
  t("sectionMinutes SKIPS a total directive",
    sectionMinutes(["Cool down until 70 min total"]) === 0);
  t("canonical duration is 70", canonicalDurationMinutes(THURSDAY) === 70);

  t("SERVER validate stores 70", validatePrescription(THURSDAY).session.duration_minutes === 70,
    String(validatePrescription(THURSDAY).session.duration_minutes));
  t("CLIENT repair displays 70", client.repair(THURSDAY).duration_minutes === 70,
    String(client.repair(THURSDAY).duration_minutes));
  t("server and client AGREE",
    validatePrescription(THURSDAY).session.duration_minutes ===
    client.validate(THURSDAY).session.duration_minutes);
}

section("2. A model that WRONGLY says 117 is corrected to 70");
{
  const wrong = { ...THURSDAY, duration_minutes: 117 };
  t("server corrects 117 → 70", validatePrescription(wrong).session.duration_minutes === 70);
  t("client corrects 117 → 70", client.repair(wrong).duration_minutes === 70);
  t("the correction is recorded as a contradiction",
    validatePrescription(wrong).contradictions.some(c => /reconciled/.test(c)));
}

/* ══════ 3. explicit duration is never summed with distance/pace ═════ */

section("3. Distance and pace never inflate duration");
{
  const s = { session_type: "easy", duration_minutes: 50, distance_km: 10,
    warmup: [], main_set: ["50 min easy"], cooldown: [] };
  t("a 50-min run with 10 km stays 50 min",
    validatePrescription(s).session.duration_minutes === 50);
  t("canonical ignores distance entirely",
    canonicalDurationMinutes({ ...s, distance_km: 999 }) === 50);
}

section("3b. Seconds are never counted as minutes");
{
  t("'4 x 20 sec strides' contributes 0 minutes",
    sectionMinutes(["4 x 20 sec strides"]) === 0);
  t("'20 sec' near a number does not become 20 min",
    sectionMinutes(["20 sec on, 40 sec off"]) === 0);
}

/* ══════ 4. Tuesday: no total directive → structural, not the raw 129 ═ */

section("4. A too-high model duration is reconciled to the structure");
{
  const tuesday = { session_type: "threshold", duration_minutes: 129, distance_km: 12.6,
    warmup: ["15 min easy"], main_set: ["4 x 8 min threshold", "2 min recovery"], cooldown: ["10 min easy"] };
  const stored = validatePrescription(tuesday).session.duration_minutes;
  t("129 is replaced by the structural sum (59)", stored === 59, String(stored));
  t("the absurd 10-min/km implied pace is gone", 59 / 12.6 < 6);
}

/* ══════ 5. planned vs completed stay separate ═════════════════════ */

section("5. An imported activity never mutates planned duration");
{
  const cal = readFileSync("./js/trainCalendar.js", "utf8");
  t("the planned card reads s.duration_minutes",
    /num\(s\.duration_minutes\) > 0.*min/.test(cal) || /s\.duration_minutes/.test(cal));
  t("the completed side reads the ACTIVITY's moving_time_seconds separately",
    /a\.moving_time_seconds|act\.moving_time_seconds/.test(cal));
  t("planned duration is NOT computed from moving_time",
    !/duration_minutes\s*=\s*[^;]*moving_time/.test(cal));

  // A 75-min imported activity paired to a 70-min planned workout: planned stays 70.
  const planned = validatePrescription(THURSDAY).session;
  const completed = { moving_time_seconds: 75 * 60, distance_meters: 12630 };
  t("planned stays 70 regardless of a 75-min completion",
    planned.duration_minutes === 70);
  t("completed 75 min is a separate value", Math.round(completed.moving_time_seconds / 60) === 75);
}

/* ══════ 6. server safety validator ════════════════════════════════ */

section("6. The generate-plan safety pass clears impossible values");
{
  const gen = readFileSync("./api/training/generate-plan.js", "utf8");
  t("a safety validator exists", /function validateWorkoutSafety/.test(gen));
  t("...and runs inside saveTrainingSessions before storage",
    /validateWorkoutSafety\(v\.session\)/.test(gen));
  t("it logs machine-readable findings, not athlete data",
    /event: "plan_workout_normalized"/.test(gen) &&
    !/notes|pace_guidance|athlete_name/.test(gen.slice(gen.indexOf("plan_workout_normalized") - 200,
                                                       gen.indexOf("plan_workout_normalized") + 200)));
  ["DURATION_NORMALIZED", "DISTANCE_INVALID_CLEARED", "DURATION_IMPLAUSIBLE_CLEARED",
   "IMPLIED_PACE_IMPLAUSIBLE", "REST_DURATION_CLEARED"].forEach(code =>
    t(`checks ${code}`, gen.includes(code)));
  t("a rest day carries a null duration", /REST_DURATION_CLEARED/.test(gen));
}

/* ══════ 7/8. contradictions normalized, never both stored ═════════ */

section("7/8. Contradictory output is normalized, never stored as-is");
{
  const both = { session_type: "threshold", duration_minutes: 117,
    warmup: ["20 min warm-up"], main_set: ["3 x 8 min threshold"], cooldown: ["until 70 minutes total"] };
  const stored = validatePrescription(both).session;
  t("only ONE duration is stored", typeof stored.duration_minutes === "number");
  t("...and it is the intended 70, not the contradictory 117", stored.duration_minutes === 70);
  t("the raw 117 is not retained anywhere on the row",
    JSON.stringify(stored).indexOf("117") === -1);
}

/* ══════ 9. first-plan success UX ══════════════════════════════════ */

section("9. First successful generation shows a clear milestone");
{
  const ps = readFileSync("./js/planSetup.js", "utf8");
  const fn = ps.slice(ps.indexOf("function showSuccess"), ps.indexOf("if (!reduceMotion()) setTimeout"));
  t("title 'Your AI coach is ready.'", /Your AI coach is ready\./.test(fn));
  t("copy names profile + recent training analysis",
    /analyzed your athlete profile and recent\s*training/.test(fn));
  t("CTA is 'Open My Coach'", /Open My Coach/.test(fn));
  t("the first-plan state does NOT auto-dismiss", /return;\s*\/\/ an intentional/.test(fn));
  t("first vs repeat is driven by alreadyExists",
    /showSuccess\(outcome\.alreadyExists !== true\)/.test(ps));
  t("no 'Build My Coach' anywhere", !/Build My Coach/.test(ps));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

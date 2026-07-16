/* Athlevo — Aerobic Calibration (client mirror of lib/server/aerobicCalibration.js).
   Reuses window.AthleteEngine + window.AthlevoPerformance. Parity-tested. */
(function(){
"use strict";
const WINDOW_DAYS = 56;          // recent 8 weeks
const MIN_RUNS = 2;              // below this → insufficient (RPE-first)
const MIN_DIST_M = 2000;
const MIN_DUR_MIN = 15;
const SANE_PACE_MIN = 180;       // 3:00/km — faster than this on an "easy" run = GPS error
const SANE_PACE_MAX = 600;       // 10:00/km

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function ageDays(iso, nowMs) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 86400000 : Infinity;
}
// Linear-interpolated percentile of an ascending array.
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
function median(arr) { return percentile([...arr].sort((a, b) => a - b), 50); }

/*
 * Selects valid aerobic runs from recent activities. Excludes races,
 * quality sessions, treadmill runs (different pace), GPS-implausible paces,
 * and anything too short. Reuses the shared workout classifier.
 */
function selectAerobicRuns(activities, fitness, nowMs) {
  const now = nowMs || Date.now();
  const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;
  const paces = vdot != null ? window.AthlevoPerformance.trainingPaces(vdot) : null;
  const ctx = paces ? {
    easySec: paces.easy.secPerKm,
    thresholdSec: paces.threshold.secPerKm,
    intervalSec: paces.vo2.secPerKm
  } : {};

  const runs = [];
  (activities || []).forEach(a => {
    if (ageDays(a.start_date, now) > WINDOW_DAYS) return;
    if (a.trainer === true) return; // treadmill: not terrain-comparable
    const meters = num(a.distance_meters);
    const seconds = num(a.moving_time_seconds);
    if (!meters || meters < MIN_DIST_M || !seconds || seconds / 60 < MIN_DUR_MIN) return;

    const paceSec = seconds / (meters / 1000);
    if (paceSec < SANE_PACE_MIN || paceSec > SANE_PACE_MAX) return; // GPS error guard

    const type = window.AthleteEngine.classifyWorkout({
      isRun: true, title: a.name || "", distanceKm: meters / 1000,
      durationMin: seconds / 60, paceSec,
      hr: num(a.average_heartrate), maxHr: num(a.max_heartrate),
      elevPerKm: num(a.elevation_gain_meters) != null && meters ? num(a.elevation_gain_meters) / (meters / 1000) : null
    }, ctx).type;

    // Keep only genuinely aerobic runs.
    if (!["Easy", "Recovery", "Long Run"].includes(type)) return;

    runs.push({
      paceSec,
      hr: num(a.average_heartrate),
      durationMin: seconds / 60,
      date: String(a.start_date).slice(0, 10),
      ts: Date.parse(a.start_date),
      type
    });
  });

  return runs;
}

/*
 * The athlete-specific aerobic ranges. Robust: uses trimmed percentiles so
 * one unusually fast easy run can't drag the range faster. Recovery is
 * always the slowest and most flexible; Long Run allows a slower band for
 * duration. Returns null-ranges + insufficient when evidence is thin.
 */
function computeAerobicCalibration(activities, fitness, nowMs) {
  const now = nowMs || Date.now();
  const runs = selectAerobicRuns(activities, fitness, now);
  const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;
  const vdotEasySec = vdot != null ? window.AthlevoPerformance.trainingPaces(vdot).easy.secPerKm : null;

  if (runs.length < MIN_RUNS) {
    return {
      valid: false,
      source: "insufficient",
      confidence: "insufficient",
      reason: "Estimated from limited aerobic data. Follow effort first.",
      lastRecalculated: runs.length ? runs.map(r => r.date).sort().pop() : null,
      validRunCount: runs.length,
      ranges: null
    };
  }

  const paces = runs.map(r => r.paceSec).sort((a, b) => a - b);
  const hrRuns = runs.filter(r => r.hr != null);
  const hrCoverage = runs.length ? hrRuns.length / runs.length : 0;

  // Conservative anchors from the SLOWER side of the distribution.
  let easyFast = Math.round(percentile(paces, 40));   // fast end (min sec)
  let easySlow = Math.round(percentile(paces, 75));   // slow end (max sec)
  const easyMed = Math.round(median(paces));

  // Broad VDOT boundary: never prescribe FASTER than the VDOT easy pace.
  if (vdotEasySec != null && easyFast < vdotEasySec) easyFast = vdotEasySec;
  // Guarantee a sensible spread.
  if (easySlow - easyFast < 20) easySlow = easyFast + 20;

  // Recovery: slower than easy and most flexible (slower is fine).
  const recoveryFast = easySlow;
  const recoverySlow = easySlow + 45;

  // Long run: may start slower than easy; slower band for duration/fatigue.
  const longFast = Math.max(easyMed, easyFast);
  const longSlow = easySlow + 20;

  let confidence, source;
  if (runs.length >= 6 && hrCoverage >= 0.5) { confidence = "high"; source = "pace-heart-rate relationship"; }
  else if (runs.length >= 4) { confidence = "moderate"; source = "recent aerobic history"; }
  else { confidence = "developing"; source = "recent aerobic history"; }

  const reason = runs.length >= 4
    ? "Calibrated from your recent conversational runs."
    : "Estimated from limited aerobic data. Follow effort first.";

  return {
    valid: true,
    source,
    confidence,
    reason,
    lastRecalculated: runs.map(r => r.date).sort().pop(),
    validRunCount: runs.length,
    hrCoverage: Math.round(hrCoverage * 100) / 100,
    medianEasySec: easyMed,
    ranges: {
      recovery: { minSec: recoveryFast, maxSec: recoverySlow },
      easy: { minSec: easyFast, maxSec: easySlow },
      long: { minSec: longFast, maxSec: longSlow }
    }
  };
}

/*
 * Conservative daily modifiers (Part 5). Adjust an aerobic range for
 * today's context. NEVER speeds a range up. Low readiness widens the slow
 * end and lowers the ceiling; heat/hills/trail/treadmill push to effort;
 * pain removes intensity rather than only slowing.
 */
function applyDailyModifiers(range, ctx) {
  ctx = ctx || {};
  if (!range) return { range: null, rpeFirst: true, removeIntensity: ctx.pain === true, notes: buildNotes(ctx, null) };

  let min = range.minSec, max = range.maxSec;
  let rpeFirst = false;

  const readiness = num(ctx.readinessScore);
  if (readiness != null && readiness < 55) {
    max += 20;      // widen the slow end
    min += 8;       // lower the ceiling (slightly slower fast end)
    rpeFirst = true;
  }
  if (ctx.heat === true || ctx.hills === true || ctx.trail === true) rpeFirst = true;

  return {
    range: { minSec: min, maxSec: max },
    rpeFirst,
    removeIntensity: ctx.pain === true,
    notes: buildNotes(ctx, readiness)
  };
}

function buildNotes(ctx, readiness) {
  ctx = ctx || {};
  const notes = [];
  if (ctx.pain === true) notes.push("If pain changes your stride, stop — a slower pace alone won't fix it.");
  if (readiness != null && readiness < 55) notes.push("Readiness is low — keep it easy and follow effort.");
  if (ctx.heat === true || ctx.hills === true || ctx.trail === true) notes.push("Use effort rather than pace in heat or on hills.");
  if (ctx.treadmill === true) notes.push("On a treadmill, follow effort and duration.");
  return notes.slice(0, 2);
}

/*
 * Aggregates recent athlete pace feedback into a small, capped bias in
 * seconds/km (applied to the SLOW direction only). One "too hard" nudges
 * gently; it never rewrites the model. Positive = slower.
 */
function computeFeedbackBias(feedbackRows) {
  let bias = 0;
  (feedbackRows || []).forEach(f => {
    const v = String(f && f.rating || "").toLowerCase();
    if (v === "too_hard") bias += 4;
    else if (v === "too_easy") bias -= 3;
    // "about_right" → no change
  });
  return Math.max(-15, Math.min(20, bias));
}

window.AthlevoAerobic = { selectAerobicRuns, computeAerobicCalibration, applyDailyModifiers, computeFeedbackBias, AEROBIC_CALIBRATION_VERSION:"aerobic-calibration-v1" };

})();

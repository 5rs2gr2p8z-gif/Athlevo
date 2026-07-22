/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Workout Recognition Engine
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The first real coaching feature: it recognises WHAT a run was, not just
 *  that a run happened. A 75-minute activity built from a warm-up, four 6-min
 *  threshold reps with jog recoveries and a cooldown is a "Threshold Session",
 *  not a "12.6 km Run".
 *
 *  DETERMINISTIC. No AI, no I/O, no randomness — a workout always recognises
 *  the same way, which is what lets Score, Recovery, adaptive plans and coach
 *  memory build on it safely. Pure function of its input.
 *
 *  recognizeWorkout(activity, opts?) → {
 *    workoutType,        // one of TYPES
 *    confidence,         // 0..1
 *    confidenceLabel,    // "High" | "Moderate" | "Low"
 *    segments: [ { kind, reps?, repDurationSec?, ... } ],
 *    coachSummary,       // one honest sentence about the session
 *    signals             // machine-readable, why it decided (no PII)
 *  }
 *
 *  Signal priority (strongest first):
 *    1. LAP / SPLIT structure  → true interval detection (highest confidence)
 *    2. TITLE / DESCRIPTION keywords
 *    3. SUMMARY ensemble        → pace variation, HR, distance, duration
 *
 *  It never claims High confidence without corroborating structure, and it
 *  degrades to "Unknown" rather than guessing.
 */

import { segmentWorkout } from "./workoutSegmentation.js";

const TYPES = {
  EASY: "Easy Run",
  RECOVERY: "Recovery Run",
  LONG: "Long Run",
  THRESHOLD: "Threshold",
  VO2: "VO2",
  TEMPO: "Tempo",
  INTERVALS: "Intervals",
  SPEED: "Speed",
  HILLS: "Hill Repeats",
  RACE: "Race",
  PROGRESSION: "Progression Run",
  FARTLEK: "Fartlek",
  UNKNOWN: "Unknown"
};

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function lc(v) { return String(v == null ? "" : v).toLowerCase(); }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function label(c) { return c >= 0.75 ? "High" : c >= 0.5 ? "Moderate" : "Low"; }

/* ── input normalisation ─────────────────────────────────────────────── */

function readActivity(a) {
  a = a || {};
  const distanceKm = num(a.distanceKm) != null ? num(a.distanceKm)
    : (num(a.distance_meters) != null ? num(a.distance_meters) / 1000 : null);
  const movingSec = num(a.movingSec) != null ? num(a.movingSec) : num(a.moving_time_seconds);
  const elapsedSec = num(a.elapsedSec) != null ? num(a.elapsedSec) : num(a.elapsed_time_seconds);
  const avgPaceSec = num(a.avgPaceSec) != null ? num(a.avgPaceSec)
    : (distanceKm && movingSec ? movingSec / distanceKm : null);
  const avgHr = num(a.avgHr) != null ? num(a.avgHr) : num(a.average_heartrate);
  const maxHr = num(a.maxHr) != null ? num(a.maxHr) : num(a.max_heartrate);
  const maxSpeed = num(a.maxSpeed) != null ? num(a.maxSpeed) : num(a.max_speed_mps);
  const maxPaceSec = maxSpeed && maxSpeed > 0 ? 1000 / maxSpeed : null;
  const elevGain = num(a.elevGain) != null ? num(a.elevGain)
    : num(a.total_elevation_gain != null ? a.total_elevation_gain : a.elevation_gain_meters);
  const laps = a.laps || (a.raw_data && a.raw_data.laps) || a.splits || null;
  const title = a.title || a.name || (a.raw_data && a.raw_data.name) || "";
  return { distanceKm, movingSec, elapsedSec, avgPaceSec, avgHr, maxHr, maxPaceSec, elevGain, laps, title };
}

function lapPaceSec(lap) {
  const dm = num(lap.distance_meters != null ? lap.distance_meters : lap.distance);
  const ms = num(lap.moving_time_seconds != null ? lap.moving_time_seconds
    : (lap.moving_time != null ? lap.moving_time : lap.elapsed_time));
  if (!dm || !ms || dm <= 0) return null;
  return ms / (dm / 1000);
}

/* ── 1. lap / split structure ────────────────────────────────────────── */

/*
 * Detect a work/recovery repetition pattern from laps. Returns the rep count,
 * the typical work-rep duration and a pace-variation ratio, or null when the
 * laps show no meaningful structure (a steady run).
 */
function detectFromLaps(laps, zones) {
  if (!Array.isArray(laps) || laps.length < 3) return null;
  const enriched = laps.map(l => ({
    paceSec: lapPaceSec(l),
    durSec: num(l.moving_time_seconds != null ? l.moving_time_seconds
      : (l.moving_time != null ? l.moving_time : l.elapsed_time))
  })).filter(l => l.paceSec != null && l.durSec > 0);
  if (enriched.length < 3) return null;

  const paces = enriched.map(l => l.paceSec).slice().sort((a, b) => a - b);
  const fastest = paces[0];
  const slowest = paces[paces.length - 1];
  const median = paces[Math.floor(paces.length / 2)];
  if (!fastest || !slowest) return null;

  // Variation: how much faster the work is than the recoveries.
  const variation = slowest / fastest;                       // >1
  // Work laps = meaningfully faster than the median (the recoveries/warm-up).
  const cut = median * 0.94;
  const work = enriched.filter(l => l.paceSec <= cut);
  const reps = work.length;
  const workDurationSec = work.reduce((s, l) => s + l.durSec, 0);
  const avgRepSec = reps ? workDurationSec / reps : 0;

  // No structure: everything within ~6% of each other → a steady run.
  if (variation < 1.06 || reps < 2) return null;

  return { reps, avgRepSec, workDurationSec, variation, fastestPaceSec: fastest };
}

/* ── zone classification of a work pace ──────────────────────────────── */

function paceZone(paceSec, z) {
  if (paceSec == null || !z) return null;
  const thr = num(z.thresholdSec), vo2 = num(z.intervalSec != null ? z.intervalSec : z.vo2Sec),
    easy = num(z.easySec), rep = num(z.repetitionSec);
  if (rep != null && paceSec <= rep * 1.02) return "rep";
  if (vo2 != null && paceSec <= vo2 * 1.02) return "vo2";
  if (thr != null && paceSec <= thr * 1.035) return "threshold";
  if (easy != null && paceSec >= easy * 0.97) return "easy";
  return "moderate";
}

const TYPE_FOR_ZONE = { rep: TYPES.SPEED, vo2: TYPES.VO2, threshold: TYPES.THRESHOLD, moderate: TYPES.TEMPO };

/* ── 2. title / description keywords ─────────────────────────────────── */

function titleType(title) {
  const t = lc(title);
  if (!t) return null;
  if (/\brace\b|time ?trial|\btt\b|parkrun|marathon\b|half marathon|10 ?k race|5 ?k race/.test(t)) return TYPES.RACE;
  if (/hill (repeat|rep|sprint)|uphill/.test(t)) return TYPES.HILLS;
  if (/fartlek/.test(t)) return TYPES.FARTLEK;
  if (/progression|negative split/.test(t)) return TYPES.PROGRESSION;
  if (/\bvo2\b|v\.?o2/.test(t)) return TYPES.VO2;
  if (/threshold|lactate|cruise/.test(t)) return TYPES.THRESHOLD;
  if (/tempo/.test(t)) return TYPES.TEMPO;
  if (/interval|reps?\b/.test(t)) return TYPES.INTERVALS;
  if (/speed|stride|200 ?m|400 ?m/.test(t)) return TYPES.SPEED;
  if (/long run|long steady/.test(t)) return TYPES.LONG;
  if (/recovery|shake ?out|very easy/.test(t)) return TYPES.RECOVERY;
  if (/easy|aerobic|base/.test(t)) return TYPES.EASY;
  return null;
}

/* ── segments: describe the shape of the session ─────────────────────── */

function buildSegments(seg, lap, kind) {
  // Prefer the real per-block segments from the segmenter (Part 4 shape).
  if (seg && Array.isArray(seg.segments) && seg.segments.length) {
    return seg.segments.map(s => ({
      kind: s.type, duration: s.duration, avgPace: s.avgPace, distance: s.distance
    }));
  }
  if (lap && lap.reps >= 2) {
    return [
      { kind: "warmup" },
      { kind: "work", reps: lap.reps, repDurationSec: Math.round(lap.avgRepSec) },
      { kind: "recovery", between: lap.reps - 1 },
      { kind: "cooldown" }
    ];
  }
  return [{ kind: "steady", note: kind }];
}

/* ── coach summary: one honest sentence, no hype it can't support ────── */

function coachSummary(type, lap, r, confidence) {
  const mins = r.movingSec ? Math.round(r.movingSec / 60) : null;
  const km = r.distanceKm != null ? r.distanceKm.toFixed(1) + " km" : null;
  const hasHr = r.avgHr != null || r.maxHr != null;   // only claim HR facts with HR data
  if (type === TYPES.THRESHOLD && lap) {
    // Honest language: never assert heart-rate behaviour without heart-rate data.
    const observed = hasHr ? "Heart rate and pacing looked consistent" : "Rep pacing looked consistent";
    return `${lap.reps} × ${Math.round(lap.avgRepSec / 60)}-min threshold reps. ` +
      `${observed} across the set — a controlled-effort session for your aerobic base.`;
  }
  if ((type === TYPES.VO2 || type === TYPES.INTERVALS || type === TYPES.SPEED) && lap) {
    return `${lap.reps} hard repetitions with recoveries. High-intensity work that ` +
      `develops speed and running economy — keep the easy days easy around it.`;
  }
  if (type === TYPES.LONG) {
    return `A long run${km ? " of " + km : ""}${mins ? " over " + mins + " min" : ""}. ` +
      `Time on feet like this builds aerobic durability.`;
  }
  if (type === TYPES.RECOVERY) {
    return `An easy recovery run — exactly the low stress that lets the hard days count.`;
  }
  if (type === TYPES.EASY) {
    return `A steady easy run${km ? " of " + km : ""}. Aerobic volume is the foundation everything else sits on.`;
  }
  if (type === TYPES.PROGRESSION) {
    return `A progression run that finished faster than it started — good control and a strong aerobic stimulus.`;
  }
  if (type === TYPES.RACE) {
    return `A race effort${km ? " over " + km : ""}. Athlevo will use this as a fitness anchor for your paces.`;
  }
  if (type === TYPES.HILLS) {
    return `Hill repetitions — strength and power work that transfers to faster, more economical running.`;
  }
  if (type === TYPES.FARTLEK) {
    return `A fartlek session — varied surges within a run. A flexible way to add intensity.`;
  }
  if (type === TYPES.TEMPO) {
    return `A sustained tempo effort — comfortably hard work that lifts your threshold over time.`;
  }
  return `Recorded${km ? " " + km : ""}${mins ? " over " + mins + " min" : ""}. ` +
    `Not enough structure to classify the session precisely yet.`;
}

/* ── the recogniser ──────────────────────────────────────────────────── */

function recognizeWorkout(activity, opts) {
  opts = opts || {};
  const zones = opts.zones || null;
  const r = readActivity(activity);
  const signals = {};

  let type = null, confidence = 0, lap = null;

  // 1. STRUCTURE via the segmenter — merges contiguous effort into real blocks
  //    (or uses the device's explicit interval types), instead of counting
  //    every fast sample. This is what stops "17 × 5:11" from ever happening.
  const seg = segmentWorkout(r.laps);
  if (seg && seg.reps >= 2) {
    // Pace of the work blocks → zone.
    const workPace = (() => {
      const w = seg.segments.filter(s => s.type === "work" && s.avgPace);
      return w.length ? Math.min.apply(null, w.map(s => s.avgPace)) : null;
    })();
    const zoneName = workPace != null ? paceZone(workPace, zones) : null;
    type = (zoneName && TYPE_FOR_ZONE[zoneName]) || TYPES.INTERVALS;
    if (seg.avgWorkSec <= 90 && (zoneName === "rep" || zoneName === "vo2")) type = TYPES.SPEED;
    // Confidence scales with how many clean reps we found and how explicit the
    // structure was.
    const explicit = /explicit interval types/.test(seg.source);
    confidence = (explicit ? 0.9 : 0.72) + Math.min(0.08, (seg.reps - 2) * 0.02);
    lap = { reps: seg.reps, avgRepSec: seg.avgWorkSec };
    signals.structure = { reps: seg.reps, avgWorkSec: seg.avgWorkSec, source: seg.source };
  }

  // 2. Title — corroborates or, absent laps, decides.
  const tType = titleType(r.title);
  if (tType) {
    signals.title = tType;
    if (!type) { type = tType; confidence = Math.max(confidence, 0.55); }
    else if (tType === type) { confidence = Math.min(1, confidence + 0.15); }
    else if (lap && (tType === TYPES.HILLS || tType === TYPES.FARTLEK || tType === TYPES.RACE)) {
      type = tType;   // title-only structural types the laps can't distinguish
    }
  }

  // 3. Summary ensemble — decide easy/long/progression, or hidden quality.
  if (!type || confidence < 0.5) {
    const avgZone = r.avgPaceSec != null ? paceZone(r.avgPaceSec, zones) : null;
    const maxZone = r.maxPaceSec != null ? paceZone(r.maxPaceSec, zones) : null;
    const hrHard = r.maxHr != null && zones && num(zones.maxHr) ? r.maxHr >= num(zones.maxHr) * 0.92 : false;
    const longByDuration = r.movingSec != null && r.movingSec >= 90 * 60;
    const longByDistance = r.distanceKm != null && r.distanceKm >= 21;

    signals.avgZone = avgZone; signals.maxZone = maxZone; signals.hrHard = hrHard;

    if (longByDuration || longByDistance) { type = TYPES.LONG; confidence = 0.65; }
    else if (avgZone === "easy" && !hrHard && (maxZone === "easy" || maxZone === "moderate" || maxZone == null)) {
      // Genuinely easy. Very short + very easy → recovery.
      const shortEasy = r.movingSec != null && r.movingSec <= 40 * 60;
      type = shortEasy ? TYPES.RECOVERY : TYPES.EASY;
      confidence = 0.6;
    }
    else if (avgZone === "moderate" && !lap) { type = TYPES.TEMPO; confidence = 0.5; }
    else if ((maxZone === "threshold" || maxZone === "vo2" || maxZone === "rep") && hrHard && !lap) {
      // Hard MAX inside an easy average, no laps → quality happened, estimated.
      type = maxZone === "threshold" ? TYPES.THRESHOLD : TYPES.VO2;
      confidence = 0.5; signals.estimated = true;
    }
    if (!type) { type = TYPES.UNKNOWN; confidence = 0.2; }
  }

  confidence = clamp01(confidence);
  return {
    workoutType: type,
    confidence: Number(confidence.toFixed(2)),
    confidenceLabel: label(confidence),
    segments: buildSegments(seg, lap, type),
    coachSummary: coachSummary(type, lap, r, confidence),
    signals
  };
}

export { recognizeWorkout, TYPES };
export default recognizeWorkout;

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Pace Service  (Training Engine V2)   ·   authoritative layer
 * ══════════════════════════════════════════════════════════════════════
 *
 *  THE single source of training-pace guidance. Every surface — Today,
 *  Train, Latest Workout Analysis, Daily Coach Briefing, the AI coach, and
 *  the adaptive plan engine — reads paces from here, so Today and Train can
 *  never disagree.
 *
 *  It REUSES the existing engines and adds NO new pace/VDOT maths:
 *    · performance.trainingPaces(vdot)  → the centre pace per zone.
 *    · athleteModel / athleteEngine fitness → vdot + source + confidence.
 *  On top of those single numbers it derives what an athlete actually
 *  needs: a target RANGE (not false precision), an RPE range, optional HR
 *  guidance (only when reliable — omitted otherwise), a plain-English
 *  meaning, and an overall source + confidence + "updated" line.
 *
 *  When pace confidence is insufficient it degrades to RPE-first guidance
 *  rather than fabricating exact targets. Never renders 5:60/km.
 */

import { trainingPaces, formatPace } from "./performance.js";

/* ───────────────── zone definitions (labels/RPE/meaning) ─────────────── */

// Zone keys match performance.ZONE_ORDER. Half-width of the target range as
// a fraction of the centre pace — aerobic zones are wider, quality tighter.
const ZONE_META = {
  recovery:   { label: "Recovery",        band: 0.05,  rpe: [1, 3], meaning: "Very relaxed, full conversation. Slower is always fine." },
  easy:       { label: "Easy",            band: 0.045, rpe: [2, 4], meaning: "Comfortable enough to speak in full sentences." },
  long:       { label: "Long Run",        band: 0.045, rpe: [2, 4], meaning: "Steady, conversational endurance running." },
  marathon:   { label: "Marathon",        band: 0.022, rpe: [5, 6], meaning: "Comfortably hard goal effort you could hold for a long time." },
  tempo:      { label: "Tempo / Control", band: 0.022, rpe: [5, 6], meaning: "Comfortably focused, never straining." },
  threshold:  { label: "Threshold",       band: 0.018, rpe: [7, 8], meaning: "Controlled hard running. You should not sprint or go all-out." },
  vo2:        { label: "VO2 / Interval",  band: 0.020, rpe: [8, 9], meaning: "Hard but repeatable, not a sprint." },
  repetition: { label: "Repetition",      band: 0.025, rpe: [8, 9], meaning: "Fast and relaxed with full recovery — never maximal." }
};

const ZONE_ORDER = ["recovery", "easy", "long", "marathon", "tempo", "threshold", "vo2", "repetition"];

/* ───────────────────────── source & confidence ──────────────────────── */

function distanceLabel(km) {
  const k = Number(km);
  if (!Number.isFinite(k) || k <= 0) return null;
  if (Math.abs(k - 5) <= 0.3) return "5K";
  if (Math.abs(k - 10) <= 0.5) return "10K";
  if (Math.abs(k - 21.0975) <= 1) return "half marathon";
  if (Math.abs(k - 42.195) <= 1.5) return "marathon";
  return `${Math.round(k)} km`;
}

const CONFIDENCE_LABELS = {
  high: "High confidence",
  moderate: "Moderate confidence",
  developing: "Developing estimate",
  insufficient: "Confirm with a race"
};

/*
 * Resolves the athlete-facing source + confidence + copy lines from the
 * fitness object produced by the existing athlete model. `nowMs` lets a
 * stale confirmed race soften from high → moderate confidence.
 */
export function resolvePaceSource(fitness, nowMs) {
  const now = nowMs || Date.now();
  const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;

  const header = "Your current training paces";
  const supporting = "Updated from your recent training and confirmed performances.";

  if (vdot == null || !Number.isFinite(vdot)) {
    return {
      header,
      supporting,
      source: { code: "insufficient", label: "Insufficient data" },
      confidence: { code: "insufficient", label: CONFIDENCE_LABELS.insufficient },
      updatedLine: "Estimated from your current training. Confirm a recent race for greater precision.",
      rpeOnly: true
    };
  }

  const estimated = fitness.estimated === true;
  const hasRace = fitness.hasConfirmedRace === true;
  const source = fitness.source || null;
  const raceKm = fitness.raceDistanceKm != null ? Number(fitness.raceDistanceKm) : null;

  // Confirmed race / time trial is the strongest evidence.
  if (!estimated && (source === "race" || hasRace)) {
    const ageDays = fitness.raceDate
      ? (now - Date.parse(String(fitness.raceDate) + "T12:00:00Z")) / 86400000
      : null;
    const stale = ageDays != null && ageDays > 120;
    const dl = distanceLabel(raceKm);
    return {
      header,
      supporting,
      source: { code: "confirmed_race", label: "Confirmed performance" },
      confidence: {
        code: stale ? "moderate" : "high",
        label: stale ? CONFIDENCE_LABELS.moderate : CONFIDENCE_LABELS.high
      },
      updatedLine: dl ? `Updated from your ${dl} result.` : "Updated from your confirmed race.",
      rpeOnly: false
    };
  }

  // Estimated from a recent run — usable but developing.
  if (estimated) {
    return {
      header,
      supporting,
      source: { code: "recent_workout", label: "Recent training" },
      confidence: { code: "developing", label: CONFIDENCE_LABELS.developing },
      updatedLine: "Updated based on your recent run. Confirm a recent race for greater precision.",
      rpeOnly: false
    };
  }

  // VDOT present from another accepted input (e.g. onboarding effort).
  return {
    header,
    supporting,
    source: { code: "current_vdot", label: "Current fitness" },
    confidence: { code: "moderate", label: CONFIDENCE_LABELS.moderate },
    updatedLine: "Based on your current training fitness.",
    rpeOnly: false
  };
}

/* ─────────────────────────── the zones ──────────────────────────────── */

// Build a single zone's guidance. Pace range is derived from the existing
// centre pace ± the zone band; RPE / meaning come from ZONE_META. HR is only
// included when a reliable value is supplied (never fabricated).
function buildZone(key, centreSec, options) {
  const meta = ZONE_META[key];
  const rpe = { min: meta.rpe[0], max: meta.rpe[1], text: `RPE ${meta.rpe[0]}–${meta.rpe[1]}` };

  let paceRange = null;
  if (centreSec != null && Number.isFinite(centreSec) && !(options && options.rpeOnly)) {
    // Faster end = smaller seconds; slower end = larger seconds.
    const fast = Math.round(centreSec * (1 - meta.band));
    const slow = Math.round(centreSec * (1 + meta.band));
    paceRange = {
      minSecPerKm: fast,
      maxSecPerKm: slow,
      // "4:28–4:38/km" — formatPace guards the :60 rounding bug.
      text: `${formatPace(fast).replace("/km", "")}–${formatPace(slow)}`
    };
  }

  return {
    key,
    label: meta.label,
    paceRange,
    rpe,
    hr: options && options.hr && options.hr[key] ? options.hr[key] : null,
    explanation: meta.meaning
  };
}

/*
 * The authoritative training-pace guidance for an athlete. Pass the fitness
 * object from athleteModel.getFitness() (or the server athlete engine).
 * Returns source/confidence copy + every available zone. When paces are
 * insufficient, zones carry RPE + meaning only (rpeOnly).
 */
export function getTrainingPaces(fitness, options) {
  options = options || {};
  const resolved = resolvePaceSource(fitness, options.nowMs);
  const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;

  // Reuse the existing engine for the centre pace of each zone.
  const centres = (vdot != null && Number.isFinite(vdot)) ? trainingPaces(vdot) : null;

  const zones = ZONE_ORDER.map(key => {
    const centreSec = centres && centres[key] ? centres[key].secPerKm : null;
    return buildZone(key, centreSec, { rpeOnly: resolved.rpeOnly, hr: options.hr });
  });

  return {
    ...resolved,
    vdot,
    zones,
    zoneMap: zones.reduce((m, z) => { m[z.key] = z; return m; }, {})
  };
}

/*
 * One zone's guidance, for the workout-guidance generator and the AI coach.
 * Falls back to RPE-only when pace confidence is insufficient.
 */
export function getZoneGuidance(fitness, zoneKey, options) {
  const all = getTrainingPaces(fitness, options);
  return all.zoneMap[zoneKey] || null;
}

export const PACE_ZONE_ORDER = ZONE_ORDER;
export const PACE_SERVICE_VERSION = "pace-service-v1";

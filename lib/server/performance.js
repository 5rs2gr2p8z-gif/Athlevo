/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Performance Engine  (pure, deterministic, no I/O)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The single source of truth for Athlevo's fitness math:
 *    · VDOT from a race result   (Jack Daniels' model)
 *    · training paces            (8 zones, derived by inverting the
 *                                 oxygen-cost curve at each %VDOT)
 *    · Current Running Level     (Athlevo's internal fitness index —
 *                                 a composite that is VDOT-weighted today
 *                                 and accepts more components later)
 *    · Athlevo Score + sub-scores (Aerobic Base, Threshold, Speed,
 *                                 Durability, Consistency)
 *
 *  DESIGN PRINCIPLES
 *  1. Pure functions only. No DOM, no Supabase, no network. This module
 *     is imported by the server (plan generation) AND mirrored verbatim
 *     for the client in js/performance.js, so the number an athlete sees
 *     is the same number the plan is built from.
 *  2. Store nothing derived. Everything here is recomputed from raw
 *     inputs (race distance/time/date, activities, profile) on demand, so
 *     the model can improve without a database migration.
 *  3. Extensible by construction. Current Running Level and Athlevo Score
 *     are weighted composites of independent component functions; adding
 *     a new signal (threshold workouts, HR response, recovery, load) means
 *     adding a component + weight, not rewriting the engine.
 *
 *  Keep this file and js/performance.js in sync — the client mirror is a
 *  byte-for-byte copy of the math (a parity test guards it).
 */

/* ─────────────────────────── VDOT core ──────────────────────────────── */

// Oxygen cost (ml/kg/min) of running at velocity v (metres per minute).
// Daniels & Gilbert regression.
function oxygenCost(vMetersPerMin) {
  return -4.60 + 0.182258 * vMetersPerMin + 0.000104 * vMetersPerMin * vMetersPerMin;
}

// Fraction of VO2max sustainable for a race lasting t minutes
// (the Daniels "drop-dead" curve).
function fractionOfMax(minutes) {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * minutes) +
    0.2989558 * Math.exp(-0.1932605 * minutes)
  );
}

/*
 * VDOT for a race of `distanceMeters` run in `durationSeconds`.
 * Returns null for impossible input. VDOT is an intensity-normalised
 * VO2max proxy: two efforts of different distances that reflect the same
 * fitness yield (near) the same VDOT.
 */
export function vdotFromRace(distanceMeters, durationSeconds) {
  const meters = Number(distanceMeters);
  const seconds = Number(durationSeconds);

  if (
    !Number.isFinite(meters) || meters < 800 ||
    !Number.isFinite(seconds) || seconds < 90
  ) {
    return null;
  }

  const minutes = seconds / 60;
  const velocity = meters / minutes; // metres per minute
  const vo2 = oxygenCost(velocity);
  const pct = fractionOfMax(minutes);

  if (pct <= 0) return null;

  const vdot = vo2 / pct;

  // Guard against nonsensical outputs from junk input.
  if (!Number.isFinite(vdot) || vdot < 15 || vdot > 100) return null;

  return Math.round(vdot * 10) / 10;
}

/*
 * Velocity (metres per minute) that costs `targetVo2` ml/kg/min — the
 * inverse of oxygenCost(), solving the quadratic for the positive root.
 */
function velocityForVo2(targetVo2) {
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.60 - targetVo2;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

// Seconds-per-kilometre to run at a given fraction of VDOT.
function paceSecPerKmAtPct(vdot, pct) {
  const targetVo2 = vdot * pct;
  const v = velocityForVo2(targetVo2);
  if (!v || v <= 0) return null;
  return 60000 / v; // (1000 m / v m·min⁻¹) minutes → seconds
}

/*
 * The %VDOT anchors for each training zone (Daniels' E/M/T/I/R system,
 * with Recovery, Long and Tempo split out as Athlevo zones). Editing a
 * single number here reshapes that zone everywhere paces are used.
 */
export const ZONE_INTENSITY = {
  recovery: 0.63,
  easy: 0.70,
  long: 0.70,
  marathon: 0.84,
  tempo: 0.86,
  threshold: 0.88,
  vo2: 0.98,
  repetition: 1.06
};

export const ZONE_ORDER = [
  "recovery", "easy", "long", "marathon",
  "tempo", "threshold", "vo2", "repetition"
];

export const ZONE_LABELS = {
  recovery: "Recovery",
  easy: "Easy",
  long: "Long Run",
  marathon: "Marathon Pace",
  tempo: "Tempo",
  threshold: "Threshold",
  vo2: "VO2",
  repetition: "Repetition"
};

// "m:ss/km" from seconds-per-km (rounds total seconds first so :60 can
// never appear).
export function formatPace(secPerKm) {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) {
    return null;
  }
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

/*
 * Full training-pace set for a VDOT. Each zone reports raw seconds-per-km
 * (for downstream math) and a formatted string (for display). Returns
 * null when VDOT is unknown — callers decide how to degrade.
 */
export function trainingPaces(vdot) {
  const v = Number(vdot);
  if (!Number.isFinite(v) || v < 15) return null;

  const paces = {};
  for (const zone of ZONE_ORDER) {
    const sec = paceSecPerKmAtPct(v, ZONE_INTENSITY[zone]);
    paces[zone] = {
      zone,
      label: ZONE_LABELS[zone],
      secPerKm: sec != null ? Math.round(sec) : null,
      pace: formatPace(sec)
    };
  }
  return paces;
}

/* ────────────────────── Current Running Level ───────────────────────── */

const LEVEL_TIERS = [
  { min: 75, tier: "World Class" },
  { min: 65, tier: "Elite" },
  { min: 55, tier: "Advanced" },
  { min: 45, tier: "Intermediate" },
  { min: 35, tier: "Recreational" },
  { min: 0, tier: "Beginner" }
];

// VDOT → 1–99 fitness index. VDOT ~25 maps near the floor, ~80 near the
// ceiling; the mapping is intentionally linear and easy to re-tune.
export function vdotToLevel(vdot) {
  const v = Number(vdot);
  if (!Number.isFinite(v)) return null;
  const level = ((v - 25) / (80 - 25)) * 100;
  return Math.max(1, Math.min(99, Math.round(level)));
}

export function tierForVdot(vdot) {
  const v = Number(vdot);
  if (!Number.isFinite(v)) return "Unrated";
  return (LEVEL_TIERS.find(t => v >= t.min) || LEVEL_TIERS[LEVEL_TIERS.length - 1]).tier;
}

/*
 * Current Running Level — Athlevo's internal fitness index.
 *
 * A weighted composite of independent COMPONENTS. Today the only wired
 * component is race-derived VDOT (weight 1.0). Future components
 * (threshold ability, aerobic development, consistency, load, HR response,
 * durability, long-run progression) each supply a 0–100 value and a
 * weight; the aggregator renormalises over whatever components are
 * present, so partial data still yields a level and new signals plug in
 * without touching callers.
 */
export function currentRunningLevel(inputs = {}) {
  const components = [];

  if (inputs.vdot != null && Number.isFinite(Number(inputs.vdot))) {
    components.push({
      key: "race_vdot",
      weight: 1.0,
      value: vdotToLevel(inputs.vdot)
    });
  }

  // ── future components plug in here, e.g. ──
  // if (inputs.thresholdAbility != null) components.push({ key:"threshold", weight:0.4, value:inputs.thresholdAbility });
  // if (inputs.aerobicDevelopment != null) components.push({ key:"aerobic", weight:0.3, value:inputs.aerobicDevelopment });
  // if (inputs.consistency != null) components.push({ key:"consistency", weight:0.2, value:inputs.consistency });

  if (!components.length) {
    return { level: null, tier: "Unrated", estimated: false, components: [] };
  }

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const level = Math.round(
    components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight
  );

  return {
    level: Math.max(1, Math.min(99, level)),
    tier: inputs.vdot != null ? tierForVdot(inputs.vdot) : "Unrated",
    estimated: inputs.estimated === true,
    components
  };
}

/* ───────────────────────── Athlevo Score ────────────────────────────── */

const clamp100 = n => Math.max(0, Math.min(100, Math.round(n)));

/*
 * Each sub-score is an independent pure function taking the shared
 * `inputs` bag and returning { value, basis } (or null when it cannot be
 * estimated at all). This is the extension surface: richer signals make
 * the same sub-score smarter without changing the aggregator.
 */

// Aerobic Base — engine size + easy volume.
function subAerobic(inputs) {
  const level = inputs.level;
  const km = Number(inputs.weeklyDistanceKm);
  if (level == null && !(km > 0)) return null;
  const volume = Number.isFinite(km) ? Math.min(30, km) : 0; // up to +30
  const base = level != null ? level * 0.72 : 30;
  return { value: clamp100(base + volume), basis: "VDOT + weekly volume" };
}

// Threshold — sustainable-effort ability (VDOT-derived today; threshold
// workouts will refine it later).
function subThreshold(inputs) {
  const level = inputs.level;
  if (level == null) return null;
  return { value: clamp100(level * 0.95 + 3), basis: "VDOT-derived threshold" };
}

// Speed — top-end economy. VDOT-derived, nudged by recent race distance
// (a fast short race is stronger speed evidence than a marathon).
function subSpeed(inputs) {
  const level = inputs.level;
  if (level == null) return null;
  let adj = 0;
  const raceKm = Number(inputs.raceDistanceKm);
  if (Number.isFinite(raceKm) && raceKm > 0) {
    if (raceKm <= 10) adj += 6;
    else if (raceKm >= 30) adj -= 6;
  }
  return { value: clamp100(level * 0.9 + adj), basis: "VDOT + race distance" };
}

// Durability — ability to hold form deep into long efforts. From longest
// recent run, weekly volume and years of training.
function subDurability(inputs) {
  const longKm = Number(inputs.longRunKm);
  const km = Number(inputs.weeklyDistanceKm);
  const years = Number(inputs.experienceYears);
  if (!(longKm > 0) && !(km > 0) && !(years > 0)) return null;
  const longScore = Number.isFinite(longKm) ? Math.min(45, longKm * 2) : 0;
  const volScore = Number.isFinite(km) ? Math.min(35, km * 0.7) : 0;
  const expScore = Number.isFinite(years) ? Math.min(20, years * 4) : 0;
  return { value: clamp100(longScore + volScore + expScore), basis: "long run + volume + experience" };
}

// Consistency — how reliably the athlete trains. From recent activity
// frequency vs. the days they said they can train.
function subConsistency(inputs) {
  const perWeek = Number(inputs.activitiesPerWeek);
  const target = Number(inputs.availableDays);
  if (!(perWeek >= 0) && !(target > 0)) return null;
  if (!(perWeek >= 0)) return null;
  const goalDays = Number.isFinite(target) && target > 0 ? target : 5;
  const ratio = perWeek / goalDays;
  return { value: clamp100(ratio * 100), basis: "sessions/week vs. available days" };
}

export const SUB_SCORES = [
  { key: "aerobic", label: "Aerobic Base", weight: 0.30, fn: subAerobic },
  { key: "threshold", label: "Threshold", weight: 0.25, fn: subThreshold },
  { key: "speed", label: "Speed", weight: 0.15, fn: subSpeed },
  { key: "durability", label: "Durability", weight: 0.15, fn: subDurability },
  { key: "consistency", label: "Consistency", weight: 0.15, fn: subConsistency }
];

/*
 * Athlevo Score — overall athletic capability. A weighted blend of the
 * sub-scores above, renormalised over whichever ones could be computed,
 * so the headline degrades gracefully with partial data. Returns null
 * only when nothing at all can be estimated (UI then shows a CTA).
 */
export function athlevoScore(inputs = {}) {
  const subs = {};
  let weighted = 0;
  let weightSum = 0;

  for (const def of SUB_SCORES) {
    const result = def.fn(inputs);
    if (result && Number.isFinite(result.value)) {
      subs[def.key] = { label: def.label, value: result.value, basis: result.basis };
      weighted += result.value * def.weight;
      weightSum += def.weight;
    } else {
      subs[def.key] = { label: def.label, value: null, basis: result ? result.basis : "needs more data" };
    }
  }

  const score = weightSum > 0 ? clamp100(weighted / weightSum) : null;
  return { score, subScores: subs, coverage: weightSum };
}

/* ───────────────────── one-call athlete fitness ─────────────────────── */

/*
 * Convenience aggregator: given a normalised `inputs` bag (built by the
 * athlete model on the client or the plan generator on the server),
 * returns the whole fitness picture in one shot. Never throws; missing
 * inputs simply produce null sub-results.
 */
export function computeFitness(inputs = {}) {
  const vdot = inputs.vdot != null ? Number(inputs.vdot) : null;

  const runningLevel = currentRunningLevel({
    vdot,
    estimated: inputs.estimated === true
  });

  const scoreInputs = { ...inputs, level: runningLevel.level };
  const score = athlevoScore(scoreInputs);
  const paces = vdot != null ? trainingPaces(vdot) : null;

  return {
    vdot,
    estimated: inputs.estimated === true,
    runningLevel,
    athlevoScore: score,
    paces,
    source: inputs.source || null,
    raceDate: inputs.raceDate || null
  };
}

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — TrainingMemory   ·  Adaptive Smart Plan v2   ·  pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The athlete's CURRENT training status — not just today's workout. This is
 *  the source of truth every planning decision reads from, so future weeks
 *  reflect what actually happened, the way a coach carries a mental model of
 *  where an athlete is right now.
 *
 *  It is deliberately independent: no database, no network, no UI, and it
 *  does NOT touch the frozen recognition / segmentation / import engines — it
 *  only READS the recognition record they already produced.
 *
 *  Input (all normalized, plain data — the caller maps DB rows into this):
 *    buildTrainingMemory({
 *      workouts: [ {                       // completed, imported workouts
 *        date:"2026-07-20", type:"Threshold",
 *        distanceKm:12.6, durationMin:75, rpe:6,
 *        recognition:{ workoutType, confidenceLabel, segments }  // read-only
 *      } ],
 *      plannedSessions: [ {                // the prescribed calendar
 *        date, type, distanceKm, durationMin,
 *        status:"completed"|"skipped"|"planned"|"missed",
 *        quality?:bool, long?:bool
 *      } ],
 *      block?:"Base"|"Build"|"Peak"|"Recovery",   // optional override
 *      now:"2026-07-22", timezone?
 *    })
 *
 *  Output: a TrainingMemory snapshot (see buildTrainingMemory's return).
 *  Every value is derived; nothing is invented. Missing data degrades to a
 *  neutral value and lowers `confidence`, never throws.
 */

export const MEMORY_CONFIG = {
  acuteWindowDays: 7,          // "recent" load window
  chronicWindowDays: 28,       // baseline window for the load ramp
  qualityWindowDays: 14,       // window for counting recent quality
  longRunWindowDays: 28,       // window for "recent longest"
  missedWindowDays: 14,        // window for missed-workout signals
  // Deterministic fatigue mapping from the acute:chronic load ratio (ACWR-like).
  fatigueRatioAnchors: [       // [ratio, fatigueScore] — linear between anchors
    [0.6, 20], [0.8, 32], [1.0, 45], [1.3, 70], [1.5, 85], [2.0, 100]
  ],
  fatiguePerRecentQuality: 4,  // each recent quality session nudges fatigue up
  fatigueHigh: 66,             // >= → "high"
  fatigueModerate: 42,         // >= → "moderate", else "low"
  fatigueRisingRatio: 1.15,    // acute:chronic above this → trend "rising"
  fatigueFallingRatio: 0.85,   // below this → "falling"
  // Consistency labels from completed ÷ planned.
  consistencyExcellent: 0.9,
  consistencyGood: 0.75,
  consistencyFair: 0.5
};

export const TRAINING_MEMORY_VERSION = "training-memory-v1";

const QUALITY_TYPES = new Set(["threshold", "vo2", "intervals", "speed", "tempo"]);

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function ymd(d) { return typeof d === "string" ? d.slice(0, 10) : null; }
function daysBetween(aKey, bKey) {
  if (!aKey || !bKey) return null;
  const a = Date.parse(aKey + "T00:00:00Z"), b = Date.parse(bKey + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);      // b - a in days (positive = a is in the past)
}
function round(n, p = 0) { const f = Math.pow(10, p); return Math.round((num(n) || 0) * f) / f; }

// The canonical type string for a workout: prefer the frozen recognition
// record, fall back to the logged/planned type. Recognition is READ-ONLY.
function canonicalType(w) {
  const rec = w && w.recognition;
  const t = (rec && rec.workoutType) || w.type || "";
  return String(t).trim();
}
function typeKey(t) { return String(t || "").toLowerCase().replace(/\s*(session|run)\s*$/, "").trim(); }
function isQualityType(t) { return QUALITY_TYPES.has(typeKey(t)); }
function isLongType(t) { return /long/.test(typeKey(t)); }

// Linear interpolation across the fatigue anchor table (clamped at the ends).
function fatigueFromRatio(ratio) {
  const A = MEMORY_CONFIG.fatigueRatioAnchors;
  if (ratio <= A[0][0]) return A[0][1];
  if (ratio >= A[A.length - 1][0]) return A[A.length - 1][1];
  for (let i = 1; i < A.length; i++) {
    if (ratio <= A[i][0]) {
      const [r0, f0] = A[i - 1], [r1, f1] = A[i];
      return f0 + (f1 - f0) * (ratio - r0) / (r1 - r0);
    }
  }
  return 45;
}

function consistencyLabel(ratio) {
  if (ratio >= MEMORY_CONFIG.consistencyExcellent) return "Excellent";
  if (ratio >= MEMORY_CONFIG.consistencyGood) return "Good";
  if (ratio >= MEMORY_CONFIG.consistencyFair) return "Fair";
  return "Poor";
}

// Infer the current training block from the recent workout mix when the
// caller did not state one explicitly.
function inferBlock(recentTypes) {
  const has = t => recentTypes.some(x => typeKey(x) === t);
  if (has("vo2") || has("speed")) return "Peak";
  if (has("threshold") || has("intervals") || has("tempo")) return "Build";
  if (recentTypes.length === 0) return "Base";
  return "Base";
}

export function buildTrainingMemory(input = {}) {
  const now = ymd(input.now) || ymd(new Date().toISOString());
  const workouts = Array.isArray(input.workouts) ? input.workouts.filter(Boolean) : [];
  const planned = Array.isArray(input.plannedSessions) ? input.plannedSessions.filter(Boolean) : [];

  // ── load windows (acute vs chronic) from completed workouts ──────────
  let acuteKm = 0, chronicKm = 0;
  const weeklyKm = [0, 0, 0, 0];       // last 4 rolling weeks, [0]=most recent
  workouts.forEach(w => {
    const age = daysBetween(ymd(w.date), now);
    const km = num(w.distanceKm) || 0;
    if (age == null || age < 0) return;
    if (age < MEMORY_CONFIG.acuteWindowDays) acuteKm += km;
    if (age < MEMORY_CONFIG.chronicWindowDays) {
      chronicKm += km;
      const wk = Math.floor(age / 7);
      if (wk >= 0 && wk < 4) weeklyKm[wk] += km;
    }
  });
  const chronicWeekly = chronicKm / (MEMORY_CONFIG.chronicWindowDays / 7);  // avg km/week
  const loadRatio = chronicWeekly > 0 ? acuteKm / chronicWeekly : (acuteKm > 0 ? 1.3 : 0.8);

  // ── recent quality + long-run history ────────────────────────────────
  const recentTypes = [];
  let recentQualitySessions = 0;
  const longRunHistory = [];
  workouts.forEach(w => {
    const age = daysBetween(ymd(w.date), now);
    if (age == null || age < 0) return;
    const t = canonicalType(w);
    if (age < MEMORY_CONFIG.qualityWindowDays) {
      recentTypes.push(t);
      if (isQualityType(t)) recentQualitySessions++;
    }
    if (isLongType(t) || (num(w.distanceKm) || 0) >= 18) {
      longRunHistory.push({ date: ymd(w.date), km: round(w.distanceKm, 1) });
    }
  });
  longRunHistory.sort((a, b) => (a.date < b.date ? 1 : -1));   // newest first
  const recentLongs = longRunHistory.filter(l => {
    const age = daysBetween(l.date, now);
    return age != null && age >= 0 && age < MEMORY_CONFIG.longRunWindowDays;
  });
  const longestRecentKm = recentLongs.reduce((m, l) => Math.max(m, l.km), 0) || null;

  // ── fatigue estimate (deterministic) ─────────────────────────────────
  let fatigueScore = fatigueFromRatio(loadRatio);
  fatigueScore += recentQualitySessions * MEMORY_CONFIG.fatiguePerRecentQuality;
  fatigueScore = Math.max(0, Math.min(100, Math.round(fatigueScore)));
  const fatigueLevel = fatigueScore >= MEMORY_CONFIG.fatigueHigh ? "high"
    : fatigueScore >= MEMORY_CONFIG.fatigueModerate ? "moderate" : "low";
  const fatigueTrend = loadRatio >= MEMORY_CONFIG.fatigueRisingRatio ? "rising"
    : loadRatio <= MEMORY_CONFIG.fatigueFallingRatio ? "falling" : "steady";

  // ── consistency + missed workouts from the planned calendar ──────────
  const windowPlanned = planned.filter(s => {
    const age = daysBetween(ymd(s.date), now);
    return age != null && age >= 0 && age < MEMORY_CONFIG.missedWindowDays;
  });
  const isMissed = s => s.status === "skipped" || s.status === "missed" ||
    (s.status !== "completed" && (daysBetween(ymd(s.date), now) || 0) > 0);
  const doneCount = windowPlanned.filter(s => s.status === "completed").length;
  const dueCount = windowPlanned.filter(s => s.status === "completed" || isMissed(s)).length;
  const consistencyRatio = dueCount > 0 ? doneCount / dueCount : 1;

  const recentMissed = windowPlanned.filter(isMissed).map(s => ({
    date: ymd(s.date), type: canonicalType(s),
    quality: s.quality != null ? !!s.quality : isQualityType(canonicalType(s)),
    long: s.long != null ? !!s.long : isLongType(canonicalType(s))
  }));
  const missedQualityCount = recentMissed.filter(m => m.quality).length;
  const missedLongRun = recentMissed.some(m => m.long);

  const hasLoad = workouts.length > 0;
  const hasPlan = windowPlanned.length > 0;
  const confidence = hasLoad && hasPlan ? "high" : (hasLoad || hasPlan ? "medium" : "low");

  return {
    version: TRAINING_MEMORY_VERSION,
    asOf: now,
    block: input.block || inferBlock(recentTypes),
    weeklyLoadKm: round(acuteKm, 1),
    chronicWeeklyKm: round(chronicWeekly, 1),
    weeklyLoadByWeek: weeklyKm.map(k => round(k, 1)),
    loadRatio: round(loadRatio, 2),
    recentQualitySessions,
    longRunHistory,
    longestRecentKm,
    fatigue: { score: fatigueScore, level: fatigueLevel, trend: fatigueTrend },
    consistency: {
      completed: doneCount, due: dueCount,
      ratio: round(consistencyRatio, 2), label: consistencyLabel(consistencyRatio)
    },
    recentMissed,
    missedQualityCount,
    missedLongRun,
    confidence
  };
}

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — ProgressionRules   ·  Adaptive Smart Plan v2   ·  pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Deterministic, gradual progression for each training discipline. A coach
 *  never bumps everything at once, so every rule here progresses ONE workout
 *  by a small, capped amount and explains why. The PlanAdjustmentEngine picks
 *  which single discipline to advance in a given week — these rules only say
 *  HOW MUCH a given discipline may move.
 *
 *  No I/O, no UI, no AI, no randomness. Each function takes the current
 *  prescription + a light context and returns:
 *    { field, from, to, delta, unit, changed, reason }
 *  `changed:false` (with from===to) means "hold" — the safe default.
 */

export const PROGRESSION_CONFIG = {
  easy:      { stepPct: 0.08, capPct: 0.10, unit: "km", field: "distanceKm" },
  threshold: { stepMin: 3, capMin: 6, unit: "min", field: "workMinutes" },   // total time at threshold
  vo2:       { stepReps: 1, capReps: 1, unit: "reps", field: "reps" },        // one rep at a time
  long:      { stepKm: 2, capKm: 2, unit: "km", field: "distanceKm", ceilingKm: 36 },
  tempo:     { stepMin: 2, capMin: 4, unit: "min", field: "durationMin" },
  recovery:  { unit: "min", field: "durationMin" }                            // never progressed
};

export const PROGRESSION_RULES_VERSION = "progression-rules-v1";

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function r1(n) { return Math.round((num(n) || 0) * 10) / 10; }

function hold(field, value, reason) {
  return { field, from: value, to: value, delta: 0, unit: null, changed: false,
    reason: reason || "Held steady." };
}

/*
 * Easy runs — grow aerobic volume slowly, capped at +10%. Only when the
 * athlete is consistent and not fatigued; otherwise hold.
 */
export function progressEasy(current, ctx = {}) {
  const c = PROGRESSION_CONFIG.easy;
  const km = num(current && current.distanceKm);
  if (km == null) return hold(c.field, current && current.distanceKm, "No distance to progress.");
  if (ctx.allowProgression === false) return hold(c.field, km, "Holding easy volume while recovering.");
  const step = Math.min(km * c.stepPct, km * c.capPct);
  const to = r1(km + step);
  if (to <= km) return hold(c.field, km, "Already at target easy volume.");
  return { field: c.field, from: r1(km), to, delta: r1(to - km), unit: c.unit, changed: true,
    reason: `Easy volume nudged up ${r1(to - km)} km (+${Math.round(c.stepPct * 100)}%) — aerobic base building.` };
}

/*
 * Threshold — add a few minutes of total time-at-threshold after the athlete
 * completes a threshold session comfortably. Capped so a block builds over
 * weeks, not in one jump.
 */
export function progressThreshold(current, ctx = {}) {
  const c = PROGRESSION_CONFIG.threshold;
  const mins = num(current && current.workMinutes);
  if (mins == null) return hold(c.field, current && current.workMinutes, "No threshold volume to progress.");
  if (ctx.lastOutcome === "hard" || ctx.allowProgression === false)
    return hold(c.field, mins, "Holding threshold volume — last session was demanding.");
  if (ctx.lastOutcome !== "easy" && ctx.lastOutcome !== "on_target")
    return hold(c.field, mins, "Need a clean threshold session before progressing.");
  const step = Math.min(c.stepMin, c.capMin);
  const to = mins + step;
  return { field: c.field, from: mins, to, delta: step, unit: c.unit, changed: true,
    reason: `Threshold volume increased ${step} min after a controlled session.` };
}

/*
 * VO2 — the sharpest stimulus; progress by a single rep only, and only when
 * the previous VO2 session was completed on target or easily.
 */
export function progressVO2(current, ctx = {}) {
  const c = PROGRESSION_CONFIG.vo2;
  const reps = num(current && current.reps);
  if (reps == null) return hold(c.field, current && current.reps, "No VO2 reps to progress.");
  if (ctx.allowProgression === false || ctx.lastOutcome === "hard")
    return hold(c.field, reps, "Holding VO2 reps — protecting freshness.");
  if (ctx.lastOutcome !== "easy" && ctx.lastOutcome !== "on_target")
    return hold(c.field, reps, "Need a solid VO2 session before adding a rep.");
  const to = reps + c.stepReps;
  return { field: c.field, from: reps, to, delta: c.stepReps, unit: c.unit, changed: true,
    reason: `Added one VO2 rep (${reps} → ${to}) after a strong session.` };
}

/*
 * Long run — extend by at most +2 km per week, never past a sensible ceiling,
 * and never if a recent long run was missed (rebuild first).
 */
export function progressLong(current, ctx = {}) {
  const c = PROGRESSION_CONFIG.long;
  const km = num(current && current.distanceKm);
  if (km == null) return hold(c.field, current && current.distanceKm, "No long-run distance to progress.");
  if (ctx.allowProgression === false)
    return hold(c.field, km, "Holding long-run distance this week.");
  if (ctx.missedLastLong)
    return hold(c.field, km, "Repeating last long-run distance after a missed long run.");
  if (km >= c.ceilingKm)
    return hold(c.field, km, `Long run held at ${km} km (at planned ceiling).`);
  const to = Math.min(km + c.stepKm, c.ceilingKm);
  return { field: c.field, from: r1(km), to: r1(to), delta: r1(to - km), unit: c.unit, changed: true,
    reason: `Long run extended ${r1(to - km)} km (${r1(km)} → ${r1(to)}) — steady endurance build.` };
}

/*
 * Tempo — modest continuous-effort growth, a couple of minutes at a time.
 */
export function progressTempo(current, ctx = {}) {
  const c = PROGRESSION_CONFIG.tempo;
  const mins = num(current && current.durationMin);
  if (mins == null) return hold(c.field, current && current.durationMin, "No tempo duration to progress.");
  if (ctx.allowProgression === false || ctx.lastOutcome === "hard")
    return hold(c.field, mins, "Holding tempo duration.");
  const step = Math.min(c.stepMin, c.capMin);
  const to = mins + step;
  return { field: c.field, from: mins, to, delta: step, unit: c.unit, changed: true,
    reason: `Tempo duration increased ${step} min.` };
}

/*
 * Recovery — by definition never progressed. Kept easy and short; may only be
 * held or trimmed elsewhere. Always returns a hold.
 */
export function progressRecovery(current) {
  const c = PROGRESSION_CONFIG.recovery;
  return hold(c.field, current && current.durationMin, "Recovery stays easy — never progressed.");
}

// Dispatch by discipline so the adjustment engine can progress "the one thing".
export const PROGRESSORS = {
  easy: progressEasy,
  threshold: progressThreshold,
  vo2: progressVO2,
  intervals: progressVO2,      // intervals progress like VO2 (rep-based)
  long: progressLong,
  tempo: progressTempo,
  recovery: progressRecovery
};

export function progressDiscipline(discipline, current, ctx) {
  const fn = PROGRESSORS[String(discipline || "").toLowerCase()];
  return fn ? fn(current, ctx) : hold(null, null, "Unknown discipline — held.");
}

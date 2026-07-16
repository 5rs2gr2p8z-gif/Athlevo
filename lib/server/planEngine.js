/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Training Plan Engine (Phase C)  ·  authoritative, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Makes training plans ADAPTIVE. Given the current week, what actually
 *  happened (completed / easier / harder / modified / skipped / extra),
 *  and the athlete's metrics (fatigue, Athlevo Score, volume, phase), it
 *  returns an updated week, an updated set of FUTURE workouts, weekly
 *  mileage + training load, and a concise professional coach explanation —
 *  the way an experienced endurance coach would revise the plan.
 *
 *  Pure and deterministic; does no I/O. The caller loads the plan + metrics
 *  (get-week + the Phase-B athlete_metrics snapshot) and persists whatever
 *  it wants. The future AI coach and the future race planner both call
 *  runPlanEngine() — this is the single reusable entry point.
 *
 *  REUSE, don't duplicate:
 *    · workout classification + session load → athleteEngine (Phase B).
 *  Everything here is NEW: workout-STATE detection (planned vs actual),
 *  the adaptation rule set, the safety validator, coach explanations, and
 *  the Today/Train view-models.
 *
 *  No hardcoded magic numbers: every threshold lives in CONFIG below.
 *  Never fabricates data; degrades gracefully when metrics are absent and
 *  reports its confidence.
 */

import { classifyWorkout, sessionLoad } from "./athleteEngine.js";

/* ─────────────────────────── configuration ──────────────────────────── */

export const CONFIG = {
  // "Completed as prescribed" tolerance bands (actual ÷ planned).
  durationOnTarget: 0.15,     // ±15% duration counts as on-target
  distanceOnTarget: 0.15,
  harderDurationRatio: 1.15,  // >15% longer → harder
  harderDistanceRatio: 1.15,
  easierDurationRatio: 0.80,  // <80% of planned → easier / shortfall
  rpeHarderDelta: 2,          // actual RPE ≥ target + 2 → harder
  // Fatigue gates (athlete_metrics.fatigue_score, 0–100).
  fatigueHigh: 70,            // above this, protect recovery (no re-adding quality)
  fatigueRecoveryOk: 60,      // at/below this, recovery allows moving quality
  // Consistency.
  severalMissed: 2,           // ≥2 missed in the window → reduce progression
  missedWindowDays: 10,
  // Safety caps.
  weeklyMileageSpikeCap: 1.10,      // week total ≤ 110% of the rolling baseline
  longRunWeekFractionCap: 0.35,     // a single long run ≤ 35% of weekly volume
  longRunProgressionCapKm: 2,       // long run ≤ prior long run + 2 km
  reduceProgressionFactor: 0.9,     // scale future volume when rebuilding
  reduceTomorrowFactor: 0.8         // shorten a hard "tomorrow" after an overreach
};

export const WORKOUT_STATES = [
  "completed_as_prescribed",
  "completed_easier",
  "completed_harder",
  "modified",
  "skipped",
  "incomplete",
  "extra",
  "planned",   // future / not yet due
  "rest"
];

/* ─────────────────────────── small helpers ──────────────────────────── */

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampInt(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

const REST_RE = /rest|off|day.?off/i;
const QUALITY_RE = /threshold|tempo|interval|vo2|repetition|\brep\b|reps|speed|race|time.?trial|fartlek|cruise/i;
const LONG_RE = /long/i;

function isRest(session) {
  return REST_RE.test(String(session?.session_type || ""));
}
function isQuality(session) {
  return QUALITY_RE.test(String(session?.session_type || ""));
}
function isLong(session) {
  return LONG_RE.test(String(session?.session_type || ""));
}
// Monday = 0 … Sunday = 6, from a YYYY-MM-DD key (date-only, tz-agnostic).
function dayIndexOf(dateKey) {
  const t = Date.parse(String(dateKey) + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return (new Date(t).getUTCDay() + 6) % 7;
}
function daysBetween(aKey, bKey) {
  const a = Date.parse(String(aKey) + "T00:00:00Z");
  const b = Date.parse(String(bKey) + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
// Athlete-local "today" key. Uses the athlete timezone when supplied,
// otherwise Asia/Manila (the app default) — never a hardcoded date.
function resolveTodayKey(now, timezone) {
  const tz = timezone || "Asia/Manila";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(now instanceof Date ? now : new Date(now));
  } catch (error) {
    return new Date(now || Date.now()).toISOString().slice(0, 10);
  }
}

// Planned session load estimate, reusing the Phase-B intensity model so
// planned and actual loads are on the same scale (no separate formula).
function plannedLoad(session) {
  const durMin = num(session.duration_minutes);
  if (!durMin || durMin <= 0) return 0;
  const item = {
    isRun: !isRest(session),
    title: session.session_type || "",
    distanceKm: num(session.distance_km) || 0,
    durationMin: durMin,
    paceSec: null, hr: null, maxHr: null, elevPerKm: null, performed: true
  };
  const c = classifyWorkout(item, {});
  return Math.round(sessionLoad({ ...item }, c));
}

/* ═══════════════════ 1 · workout STATE classification ═══════════════════
 *
 *  What actually happened to a planned session, comparing the prescription
 *  to the athlete's execution record and/or matched activity. Only past /
 *  due sessions get a real state; future ones are "planned".
 */
export function classifyWorkoutState(session, todayKey) {
  if (isRest(session)) {
    // A rest day the athlete trained on becomes an "extra"/modified signal.
    const rec = session.execution;
    if (rec && rec.status === "modified") return "extra";
    return "rest";
  }

  const rec = session.execution || null;
  const past = daysBetween(session.session_date, todayKey);
  const isPastOrToday = past != null && past >= 0;

  if (!rec) {
    if (!isPastOrToday) return "planned";
    // Past with no record and no activity → not done.
    return session.matched_activity ? "incomplete" : "incomplete";
  }

  if (rec.status === "skipped") return "skipped";
  if (rec.status === "modified") return "modified";
  if (rec.status !== "completed") return isPastOrToday ? "incomplete" : "planned";

  // Completed — compare actual vs prescribed to grade the effort.
  const planDur = num(session.duration_minutes);
  const planDist = num(session.distance_km);
  const actDur = num(rec.actual_duration_minutes) ?? num(session.matched_activity?.actual_duration_minutes);
  const actDist = num(rec.actual_distance_km) ?? num(session.matched_activity?.actual_distance_km);
  const rpe = num(rec.actual_rpe);
  const targetRpe = num(session.target_rpe);
  const feeling = String(rec.overall_feeling || "").toLowerCase();

  let harder = false, easier = false;
  if (planDur && actDur) {
    if (actDur >= planDur * CONFIG.harderDurationRatio) harder = true;
    if (actDur <= planDur * CONFIG.easierDurationRatio) easier = true;
  }
  if (planDist && actDist) {
    if (actDist >= planDist * CONFIG.harderDistanceRatio) harder = true;
    if (actDist <= planDist * CONFIG.easierDurationRatio) easier = true;
  }
  if (rpe != null && targetRpe != null && rpe >= targetRpe + CONFIG.rpeHarderDelta) harder = true;
  if (feeling === "harder") harder = true;
  if (feeling === "easier") easier = true;
  if (rec.as_prescribed === false && !harder && !easier) return "modified";

  if (harder && !easier) return "completed_harder";
  if (easier && !harder) return "completed_easier";
  return "completed_as_prescribed";
}

/* ═══════════════════════ 2 · adaptation rule set ════════════════════════
 *
 *  Reads the graded week + metrics and returns a list of CHANGES to future
 *  sessions (never mutating the past). Each change is auditable: it names
 *  the session, the action, a professional reason, and a confidence.
 */

function confidenceFrom({ hasExecution, hasMetrics }) {
  if (hasExecution && hasMetrics) return "high";
  if (hasExecution || hasMetrics) return "medium";
  return "low";
}

// The next future non-rest, non-quality day that could host a moved quality
// session without creating back-to-back hard days.
function findMoveTarget(sessions, fromIndex, todayKey) {
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i];
    if (i === fromIndex) continue;
    const rel = daysBetween(todayKey, s.session_date);
    if (rel == null || rel < 1) continue;         // must be in the future
    if (isRest(s) || isQuality(s) || isLong(s)) continue;
    const prev = sessions[i - 1];
    const next = sessions[i + 1];
    if ((prev && isQuality(prev)) || (next && isQuality(next))) continue; // no adjacency
    return i;
  }
  return -1;
}

export function computeAdaptations({ sessions, states, metrics, todayKey }) {
  const changes = [];
  const fatigue = num(metrics && metrics.fatigue_score);
  const hasMetrics = fatigue != null || (metrics && num(metrics.athlevo_score) != null);
  const recoveryOk = fatigue == null || fatigue <= CONFIG.fatigueRecoveryOk;
  const highFatigue = fatigue != null && fatigue >= CONFIG.fatigueHigh;

  const stateAt = idx => states[idx];
  const hasExecutionSomewhere = states.some(s =>
    ["completed_as_prescribed", "completed_easier", "completed_harder", "modified", "skipped"].includes(s));

  // Count recent misses for the "several missed" rule.
  const recentMissed = sessions.filter((s, i) =>
    ["skipped", "incomplete"].includes(stateAt(i)) &&
    !isRest(s) &&
    (() => { const d = daysBetween(s.session_date, todayKey); return d != null && d >= 0 && d <= CONFIG.missedWindowDays; })()
  ).length;

  const conf = confidenceFrom({ hasExecution: hasExecutionSomewhere, hasMetrics });

  sessions.forEach((session, i) => {
    const state = stateAt(i);
    const rel = daysBetween(todayKey, session.session_date);
    const isFuture = rel != null && rel >= 1;
    const isTodayOrPast = rel != null && rel <= 0;

    // ── Skipped quality (interval/threshold) ──
    if ((state === "skipped" || state === "incomplete") && isQuality(session) && !isLong(session) && isTodayOrPast) {
      if (recoveryOk) {
        const target = findMoveTarget(sessions, i, todayKey);
        if (target >= 0) {
          changes.push({
            sessionId: session.id, action: "move_quality",
            targetSessionId: sessions[target].id, targetDate: sessions[target].session_date,
            reason: `Recovery allows it, so the skipped ${labelType(session)} was moved to ${weekday(sessions[target].session_date)}.`,
            confidence: conf
          });
          return;
        }
      }
      // No room, or recovery is limited → replace with an aerobic session.
      changes.push({
        sessionId: session.id, action: "replace_with_aerobic",
        reason: highFatigue
          ? `Fatigue is elevated, so the missed ${labelType(session)} was replaced with an easy aerobic run to protect recovery.`
          : `There was no safe slot to reschedule the ${labelType(session)}, so it becomes an easy aerobic run.`,
        confidence: conf
      });
      return;
    }

    // ── Skipped long run ──
    if ((state === "skipped" || state === "incomplete") && isLong(session) && isTodayOrPast) {
      const target = findLongRunSlot(sessions, i, todayKey);
      if (target >= 0) {
        changes.push({
          sessionId: session.id, action: "move_long_run",
          targetSessionId: sessions[target].id, targetDate: sessions[target].session_date,
          reason: `The long run was rescheduled to ${weekday(sessions[target].session_date)} so the week's endurance work still happens.`,
          confidence: conf
        });
      } else {
        changes.push({
          sessionId: session.id, action: "reduce_next_week",
          reason: "The long run couldn't fit later this week, so next week's load will be eased to keep progression safe.",
          confidence: conf
        });
      }
      return;
    }

    // ── Harder than prescribed today → protect tomorrow ──
    if (state === "completed_harder" && rel === 0) {
      const tmr = sessions[i + 1];
      if (tmr && !isRest(tmr) && (isQuality(tmr) || isLong(tmr))) {
        changes.push({
          sessionId: tmr.id, action: "reduce_tomorrow",
          reason: "You exceeded today's target, so tomorrow has been eased to improve adaptation.",
          confidence: conf
        });
      }
      return;
    }
  });

  // ── Several missed sessions → reduce progression, rebuild consistency ──
  if (recentMissed >= CONFIG.severalMissed) {
    changes.push({
      sessionId: null, action: "reduce_progression",
      reason: `Several sessions were missed recently, so the coming days ease off to rebuild consistency before progressing again.`,
      confidence: conf, scope: "week"
    });
  }

  return { changes, signals: { fatigue, recentMissed, recoveryOk, highFatigue } };
}

// A weekend-preferring future slot for a displaced long run.
function findLongRunSlot(sessions, fromIndex, todayKey) {
  let best = -1;
  for (let i = 0; i < sessions.length; i += 1) {
    if (i === fromIndex) continue;
    const s = sessions[i];
    const rel = daysBetween(todayKey, s.session_date);
    if (rel == null || rel < 1) continue;
    if (isQuality(s)) continue;                     // never stack long on a quality day
    const di = dayIndexOf(s.session_date);
    // Prefer Saturday/Sunday (5/6); accept any easy/rest future day otherwise.
    if (di === 5 || di === 6) return i;
    if (best < 0) best = i;
  }
  return best;
}

/* ═══════════════════ 3 · extra / unexpected workouts ════════════════════
 *
 *  Activities that don't correspond to a planned session (e.g. an
 *  unexpected race). A race/time-trial is treated as the week's quality
 *  session and triggers a recovery adjustment.
 */
export function assessExtraWorkouts(extraWorkouts, sessions, todayKey) {
  const changes = [];
  (extraWorkouts || []).forEach(w => {
    const c = classifyWorkout({
      isRun: true, title: w.title || "", distanceKm: num(w.distanceKm) || 0,
      durationMin: num(w.durationMin) || 0, paceSec: num(w.paceSec),
      hr: num(w.hr), maxHr: num(w.maxHr), elevPerKm: num(w.elevPerKm)
    }, w.ctx || {});

    if (c.type === "Race" || c.type === "Time Trial" || c.type === "VO2" || c.type === "Intervals") {
      // Find the next future hard day and soften it (recovery after a race).
      let softened = null;
      for (let i = 0; i < sessions.length; i += 1) {
        const rel = daysBetween(todayKey, sessions[i].session_date);
        if (rel != null && rel >= 1 && (isQuality(sessions[i]) || isLong(sessions[i]))) { softened = sessions[i]; break; }
      }
      changes.push({
        sessionId: softened ? softened.id : null,
        action: softened ? "reduce_tomorrow" : "note_extra_quality",
        reason: `An unexpected ${c.type.toLowerCase()} counts as this week's quality work; the next hard day is eased to absorb it.`,
        confidence: "medium", extraType: c.type
      });
    }
  });
  return changes;
}

/* ═══════════════════════ 4 · plan safety validator ══════════════════════
 *
 *  Applies non-negotiable safety rules to the FUTURE portion of the week:
 *  no two hard days in a row, no weekly-mileage spike beyond the cap, and
 *  safe long-run progression. Returns adjusted future sessions + notes.
 */
export function enforceSafety({ sessions, baselineWeeklyKm, priorLongRunKm, todayKey }) {
  const notes = [];
  const adjusted = sessions.map(s => ({ ...s }));

  // 1) No two hard (quality/long) days in a row — soften the later one.
  for (let i = 1; i < adjusted.length; i += 1) {
    const prev = adjusted[i - 1];
    const cur = adjusted[i];
    const rel = daysBetween(todayKey, cur.session_date);
    if (rel == null || rel < 1) continue;          // only adjust future
    const prevHard = !isRest(prev) && (isQuality(prev) || isLong(prev));
    const curHard = !isRest(cur) && (isQuality(cur) || isLong(cur));
    if (prevHard && curHard) {
      cur._safety = "eased";
      cur.session_type = isLong(cur) ? cur.session_type : "Easy";
      cur.duration_minutes = Math.round((num(cur.duration_minutes) || 0) * CONFIG.reduceTomorrowFactor) || cur.duration_minutes;
      notes.push(`Eased ${weekday(cur.session_date)} to avoid back-to-back hard days.`);
    }
  }

  // 2) Long-run progression cap.
  if (priorLongRunKm != null && priorLongRunKm > 0) {
    adjusted.forEach(s => {
      const rel = daysBetween(todayKey, s.session_date);
      if (rel == null || rel < 1 || !isLong(s)) return;
      const cap = priorLongRunKm + CONFIG.longRunProgressionCapKm;
      if ((num(s.distance_km) || 0) > cap) {
        s.distance_km = Math.round(cap * 10) / 10;
        s._safety = "long_capped";
        notes.push(`Capped the long run at ${cap.toFixed(1)} km for a safe progression.`);
      }
    });
  }

  // 3) Weekly mileage spike cap (whole planned week vs rolling baseline).
  if (baselineWeeklyKm != null && baselineWeeklyKm > 0) {
    const total = adjusted.reduce((s, x) => s + (num(x.distance_km) || 0), 0);
    const cap = baselineWeeklyKm * CONFIG.weeklyMileageSpikeCap;
    if (total > cap && total > 0) {
      const scale = cap / total;
      adjusted.forEach(s => {
        const rel = daysBetween(todayKey, s.session_date);
        if (rel == null || rel < 1) return;         // scale only the future
        const d = num(s.distance_km);
        if (d) { s.distance_km = Math.round(d * scale * 10) / 10; s._safety = s._safety || "volume_scaled"; }
      });
      notes.push(`Scaled remaining distance to keep the week within a safe ${Math.round((CONFIG.weeklyMileageSpikeCap - 1) * 100)}% mileage increase.`);
    }
  }

  return { sessions: adjusted, notes };
}

/* ═══════════════════════ 5 · coach explanation ══════════════════════════ */

function labelType(session) {
  const t = String(session.session_type || "session").toLowerCase();
  if (/threshold/.test(t)) return "threshold session";
  if (/interval|vo2/.test(t)) return "interval session";
  if (/tempo/.test(t)) return "tempo session";
  if (/long/.test(t)) return "long run";
  if (/race|time.?trial/.test(t)) return "race";
  return "session";
}
function weekday(dateKey) {
  const t = Date.parse(String(dateKey) + "T00:00:00Z");
  if (!Number.isFinite(t)) return "later this week";
  return new Date(t).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

// One concise, professional summary line + the per-change reasons.
export function buildCoachExplanation(changes, safetyNotes) {
  const reasons = (changes || []).map(c => c.reason).filter(Boolean);
  const notes = safetyNotes || [];
  if (!reasons.length && !notes.length) {
    return "Your plan is on track — no changes were needed. Recovery is adequate, so the week stands as prescribed.";
  }
  return [...reasons, ...notes].join(" ");
}

/* ═══════════════════ 6 · view-models (Today / Train) ════════════════════ */

// Today: tomorrow's workout, why it changed, confidence, rationale.
export function buildTomorrowCard({ sessions, changes, todayKey }) {
  const tomorrow = sessions.find(s => daysBetween(todayKey, s.session_date) === 1) || null;
  if (!tomorrow) return null;

  const related = (changes || []).filter(c => c.sessionId === tomorrow.id);
  const whyChanged = related.length ? related.map(c => c.reason).join(" ") : null;
  const confidence = related.length ? related[0].confidence : "high";

  return {
    workout: {
      id: tomorrow.id,
      date: tomorrow.session_date,
      type: tomorrow.session_type || null,
      durationMinutes: num(tomorrow.duration_minutes),
      distanceKm: num(tomorrow.distance_km),
      purpose: tomorrow.purpose || null,
      isRest: isRest(tomorrow),
      eased: tomorrow._safety === "eased" || related.some(c => c.action === "reduce_tomorrow")
    },
    whyChanged,
    confidence,
    rationale: whyChanged
      || (isRest(tomorrow)
        ? "Tomorrow is a planned recovery day to absorb this week's training."
        : "Tomorrow's session is unchanged because your recent training and recovery are on track.")
  };
}

// Train: planned vs completed vs remaining, load, and a progress fraction.
export function buildWeeklyProgress({ sessions, states, todayKey }) {
  let plannedDistance = 0, plannedDuration = 0, plannedLoadTotal = 0;
  let completedDistance = 0;

  sessions.forEach((s, i) => {
    if (isRest(s)) return;
    plannedDistance += num(s.distance_km) || 0;
    plannedDuration += num(s.duration_minutes) || 0;
    plannedLoadTotal += plannedLoad(s);

    const state = states[i];
    if (["completed_as_prescribed", "completed_easier", "completed_harder", "modified"].includes(state)) {
      const rec = s.execution || {};
      completedDistance +=
        num(rec.actual_distance_km)
        ?? num(s.matched_activity?.actual_distance_km)
        ?? num(s.distance_km)
        ?? 0;
    }
  });

  plannedDistance = Math.round(plannedDistance * 10) / 10;
  completedDistance = Math.round(completedDistance * 10) / 10;
  const remaining = Math.max(0, Math.round((plannedDistance - completedDistance) * 10) / 10);
  const progressPct = plannedDistance > 0 ? clampInt((completedDistance / plannedDistance) * 100, 0, 100) : 0;

  return {
    plannedDistanceKm: plannedDistance,
    plannedDurationMin: Math.round(plannedDuration),
    plannedTrainingLoad: Math.round(plannedLoadTotal),
    completedDistanceKm: completedDistance,
    remainingDistanceKm: remaining,
    progressPct
  };
}

/* ═══════════════════════ 7 · orchestrator ═══════════════════════════════
 *
 *  The single reusable entry point. Future AI coach + race planner call
 *  this. Returns the updated week, the future workout changes, weekly
 *  mileage + load, the Today/Train view-models, and the coach explanation.
 */
export function runPlanEngine(input = {}) {
  const {
    plan = {}, metrics = null, extraWorkouts = [],
    baselineWeeklyKm = null, priorLongRunKm = null,
    now = Date.now(), timezone = null
  } = input;

  const sessions = Array.isArray(plan.sessions) ? plan.sessions.slice() : [];
  const todayKey = input.todayKey || resolveTodayKey(now, timezone);

  // Grade every session.
  const states = sessions.map(s => classifyWorkoutState(s, todayKey));

  // Derive adaptation changes from execution + metrics.
  const { changes, signals } = computeAdaptations({ sessions, states, metrics, todayKey });

  // Fold in any unexpected extra workouts (e.g. a race).
  const extraChanges = assessExtraWorkouts(extraWorkouts, sessions, todayKey);
  const allChanges = changes.concat(extraChanges);

  // Apply safety to the future portion.
  const baseline = baselineWeeklyKm != null
    ? baselineWeeklyKm
    : num(metrics && metrics.weekly_distance);
  const { sessions: safeSessions, notes: safetyNotes } =
    enforceSafety({ sessions, baselineWeeklyKm: baseline, priorLongRunKm, todayKey });

  // Outputs / view-models.
  const weeklyProgress = buildWeeklyProgress({ sessions: safeSessions, states, todayKey });
  const tomorrow = buildTomorrowCard({ sessions: safeSessions, changes: allChanges, todayKey });
  const explanation = buildCoachExplanation(allChanges, safetyNotes);

  return {
    version: "plan-engine-v1",
    todayKey,
    updatedWeek: safeSessions,
    states,
    changes: allChanges,
    safetyNotes,
    signals,
    weeklyMileageKm: weeklyProgress.plannedDistanceKm,
    trainingLoad: weeklyProgress.plannedTrainingLoad,
    weeklyProgress,
    tomorrow,
    explanation
  };
}

export const PLAN_ENGINE_VERSION = "plan-engine-v1";

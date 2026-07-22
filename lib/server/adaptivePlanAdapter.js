/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — AdaptivePlanAdapter   ·  wires Adaptive Smart Plan v2 to real data
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The boundary between the database/providers and the PURE planning engines
 *  (TrainingMemory · PlanAdjustmentEngine · WeeklyReview · ProgressionRules).
 *  It takes already-loaded rows (the server does the I/O) and:
 *    1. normalizes them into the exact engine input shapes,
 *    2. runs the engines,
 *    3. maps the engine's changes into athlete-facing proposedChanges with a
 *       concrete before/after and a stored reason,
 *    4. applies the wiring-layer safety guards (taper/race week, injury/pain),
 *    5. produces a deterministic fingerprint so identical inputs never create
 *       duplicate proposals.
 *
 *  Pure: no network, no database, no UI. The engines are consumed, never
 *  modified. Recognition records are READ-ONLY.
 */

import { buildTrainingMemory } from "./trainingMemory.js";
import { adjustPlan } from "./planAdjustmentEngine.js";
import { buildWeeklyReview } from "./weeklyReview.js";

export const ADAPTIVE_ADAPTER_VERSION = "adaptive-adapter-v1";
export const ADAPTIVE_ENGINE_VERSION = "adaptive-smart-plan-v2";

const QUALITY_TYPES = new Set(["threshold", "vo2", "intervals", "speed", "tempo"]);

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function ymd(d) { return typeof d === "string" ? d.slice(0, 10) : (d ? new Date(d).toISOString().slice(0, 10) : null); }
function typeKey(t) { return String(t || "").toLowerCase().replace(/\s*(session|run)\s*$/, "").trim(); }
function isQualityType(t) { return QUALITY_TYPES.has(typeKey(t)); }
function isLongType(t) { return /long/.test(typeKey(t)); }
function daysBetween(aKey, bKey) {
  const a = Date.parse(aKey + "T00:00:00Z"), b = Date.parse(bKey + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
function mondayOf(key) {
  const d = new Date(key + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;           // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// The canonical workout type: prefer the frozen recognition record.
function activityType(a, rec) {
  const r = rec || a.recognition || (a.raw_data && a.raw_data.recognition) || null;
  return (r && r.workoutType) || a.sport_type || a.activity_type || a.type || "Run";
}

// Derive a completed session's outcome vs its prescription (deterministic).
function outcomeOf(exec, session) {
  if (!exec || exec.status !== "completed") return null;
  const planDur = num(session.duration_minutes);
  const actDur = num(exec.actual_duration_minutes);
  const rpe = num(exec.actual_rpe), target = num(session.target_rpe);
  const feeling = String(exec.overall_feeling || "").toLowerCase();
  if (feeling === "harder") return "hard";
  if (feeling === "easier") return "easy";
  if (rpe != null && target != null) {
    if (rpe >= target + 2) return "hard";
    if (rpe <= target - 2) return "easy";
  }
  if (planDur && actDur) {
    if (actDur >= planDur * 1.15) return "hard";
    if (actDur <= planDur * 0.85) return "easy";
  }
  return "on_target";
}

/*
 * normalizeInputs(raw) → the engine-ready inputs. `raw` is DB rows:
 *   { plan, sessions[], activities[], executions[], profile, now, timezone }
 * executions are indexed onto their session; recognition stays read-only.
 */
export function normalizeInputs(raw = {}) {
  const now = ymd(raw.now) || ymd(new Date().toISOString());
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(Boolean) : [];
  const activities = Array.isArray(raw.activities) ? raw.activities.filter(Boolean) : [];
  const executions = Array.isArray(raw.executions) ? raw.executions.filter(Boolean) : [];
  const profile = raw.profile || {};

  const execBySession = {};
  executions.forEach(e => { if (e && e.training_session_id != null) execBySession[String(e.training_session_id)] = e; });

  // status per planned session
  const statusOf = s => {
    const e = execBySession[String(s.id)];
    if (e && e.status) return e.status;                        // completed | skipped | modified
    const age = daysBetween(ymd(s.session_date), now);
    if (age != null && age > 0) return "missed";               // past, no record
    return "planned";
  };

  // memory: completed imported activities (real training load + recognition)
  const workouts = activities.map(a => ({
    date: ymd(a.start_date || a.date),
    type: activityType(a),
    distanceKm: num(a.distance_meters) != null ? a.distance_meters / 1000 : num(a.distanceKm),
    durationMin: num(a.moving_time_seconds) != null ? a.moving_time_seconds / 60 : num(a.durationMin),
    rpe: num(a.rpe),
    recognition: a.recognition || (a.raw_data && a.raw_data.recognition) || null
  })).filter(w => w.date);

  // memory: the prescribed calendar with derived status
  const plannedSessions = sessions.map(s => ({
    date: ymd(s.session_date),
    type: s.session_type,
    distanceKm: num(s.distance_km),
    durationMin: num(s.duration_minutes),
    status: statusOf(s),
    quality: isQualityType(s.session_type),
    long: isLongType(s.session_type)
  })).filter(s => s.date);

  // upcoming = future, still-planned sessions (never past/completed)
  const upcoming = sessions.filter(s => {
    const age = daysBetween(ymd(s.session_date), now);
    const e = execBySession[String(s.id)];
    return age != null && age < 0 && !(e && e.status);          // strictly future, no record
  }).map(s => ({
    id: s.id,
    date: ymd(s.session_date),
    type: s.session_type,
    distanceKm: num(s.distance_km),
    durationMin: num(s.duration_minutes),
    workMinutes: num(s.duration_minutes)                        // threshold/tempo progress on duration
  }));

  // outcomes: last clean/hard result per discipline (from completed sessions)
  const outcomes = {};
  sessions.forEach(s => {
    const e = execBySession[String(s.id)];
    const o = outcomeOf(e, s);
    if (!o) return;
    const k = typeKey(s.session_type);
    const disc = /threshold/.test(k) ? "threshold" : /vo2|interval/.test(k) ? "vo2"
      : /long/.test(k) ? "long" : /tempo/.test(k) ? "tempo" : null;
    if (disc) outcomes[disc] = o;                               // latest wins (sessions asc → last is most recent)
  });

  // completedWeek: the most recent finished Mon–Sun week, for the review
  const thisMon = mondayOf(now);
  const lastMon = ymd(new Date(Date.parse(thisMon + "T00:00:00Z") - 7 * 86400000).toISOString());
  const weekSessions = plannedSessions.filter(s => {
    const m = mondayOf(s.date);
    return m === lastMon;
  });
  const completedWeek = weekSessions.length ? { weekStart: lastMon, sessions: weekSessions } : null;

  // guard signals (wiring layer)
  const raceDate = profile.race_date ? ymd(profile.race_date) : null;
  const daysToRace = raceDate ? daysBetween(now, raceDate) : null;
  const taperByRace = daysToRace != null && daysToRace >= 0 && daysToRace <= 14;
  const taperByType = upcoming.some(s => /taper|race/.test(typeKey(s.type)));
  const recentPain = executions.some(e => {
    const on = e && (e.pain_present === true || e.pain_present === "true");
    if (!on) return false;
    const age = daysBetween(ymd(e.completed_at || e.created_at || e.updated_at), now);
    return age == null || (age >= 0 && age <= 21);
  });

  return {
    now,
    memoryInput: { workouts, plannedSessions, now, block: raw.block || null },
    upcoming,
    outcomes,
    completedWeek,
    guards: {
      taperOrRaceWeek: taperByRace || taperByType,
      injuryPain: recentPain,
      injurySignal: "workout_execution_records.pain_present"
    }
  };
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Concrete before/after + DB patch for one engine change. Returns null for a
// change the current schema cannot represent (e.g. rep-count VO2), which the
// caller reports rather than applies.
export function mapChangeToDb(c, sess, ctx = {}) {
  if (!sess) return null;
  if (c.action === "reschedule" || c.action === "convert") {
    const toLong = c.to === "long";
    const toType = toLong ? "Long Run" : (c.to === "easy" ? "Easy Run" : sess.type);
    const after = { session_type: toType };
    if (toLong) after.distance_km = num(ctx.longTargetKm) || Math.max(num(sess.distanceKm) || 0, 16);
    return {
      workoutId: sess.id, date: sess.date, field: "session_type",
      before: { session_type: sess.type, distance_km: num(sess.distanceKm) },
      after, reason: c.reason, action: c.action, actionType: "modify_workout",
      patch: { session_type: toType, ...(after.distance_km != null ? { distance_km: after.distance_km } : {}) }
    };
  }
  if (c.field === "reps") return null;                          // no reps column yet — reported, not applied
  const col = c.field === "distanceKm" ? "distance_km" : "duration_minutes";
  return {
    workoutId: sess.id, date: sess.date, field: col,
    before: { [col]: c.from }, after: { [col]: c.to },
    reason: c.reason, action: c.action, actionType: "modify_workout",
    patch: { [col]: c.to }
  };
}

/*
 * buildProposal(raw) → the full preview payload (Part 2), deterministic.
 */
export function buildProposal(raw = {}) {
  const inp = normalizeInputs(raw);
  const memory = buildTrainingMemory(inp.memoryInput);
  const adj = adjustPlan({
    memory, upcoming: inp.upcoming, outcomes: inp.outcomes,
    completedWeek: inp.completedWeek, todayKey: inp.now
  });

  const upById = {};
  inp.upcoming.forEach(s => { upById[String(s.id)] = s; });

  let proposedChanges = [];
  const unrepresentable = [];
  adj.changes.forEach(c => {
    const sess = upById[String(c.sessionId)];
    const db = mapChangeToDb(c, sess, { longTargetKm: memory.longestRecentKm });
    if (db) proposedChanges.push(db); else unrepresentable.push(c.discipline || c.field);
  });

  // ── wiring-layer safety guards ───────────────────────────────────────
  const guardsReport = {
    oneVariablePerWeek: true,
    taperRaceHold: false,
    injuryHold: false,
    injurySignalActive: true,                 // pain_present exists → guard is live
    injurySignal: inp.guards.injurySignal,
    unrepresentableChanges: unrepresentable
  };
  const stripIncreases = () => { proposedChanges = proposedChanges.filter(c => c.action !== "increase"); };
  if (inp.guards.taperOrRaceWeek) { stripIncreases(); guardsReport.taperRaceHold = true; }
  if (inp.guards.injuryPain) { stripIncreases(); guardsReport.injuryHold = true; }

  // never more than one progression in a week
  const increases = proposedChanges.filter(c => c.action === "increase");
  if (increases.length > 1) proposedChanges = proposedChanges.filter((c, i) =>
    c.action !== "increase" || c === increases[0]);

  const postureEffective = (guardsReport.taperRaceHold || guardsReport.injuryHold)
    ? "maintain" : adj.posture;

  const memorySummary = {
    block: memory.block,
    fatigue: memory.fatigue,
    consistency: memory.consistency && { label: memory.consistency.label, ratio: memory.consistency.ratio },
    weeklyLoadKm: memory.weeklyLoadKm,
    recentQualitySessions: memory.recentQualitySessions,
    longestRecentKm: memory.longestRecentKm,
    missedQualityCount: memory.missedQualityCount,
    missedLongRun: memory.missedLongRun
  };

  const basis = JSON.stringify({
    posture: postureEffective,
    changes: proposedChanges
      .map(c => [String(c.workoutId), c.field, JSON.stringify(c.after)])
      .sort()
  });
  const fingerprint = "adp_" + djb2(basis);

  return {
    version: ADAPTIVE_ADAPTER_VERSION,
    engineVersion: ADAPTIVE_ENGINE_VERSION,
    posture: postureEffective,
    stable: proposedChanges.length === 0,
    memorySummary,
    proposedChanges: proposedChanges.map(c => ({
      workoutId: c.workoutId, date: c.date, field: c.field,
      before: c.before, after: c.after, reason: c.reason,
      action: c.action, actionType: c.actionType, patch: c.patch
    })),
    weeklyReview: adj.weeklyReview,
    guards: guardsReport,
    fingerprint,
    confidence: memory.confidence
  };
}

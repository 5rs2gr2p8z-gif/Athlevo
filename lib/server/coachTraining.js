/*
 * Coach-facing training helpers. Pure and deliberately separate from I/O so
 * authorization, response shaping, and workout-write validation can be tested
 * without a Supabase connection.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL_EXECUTION = new Set(["completed", "modified", "skipped"]);

function text(value, max) {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function number(value, min, max) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export function dateKey(value) {
  const candidate = String(value || "").slice(0, 10);
  if (!DATE_KEY.test(candidate)) return null;
  const parsed = Date.parse(candidate + "T00:00:00Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === candidate
    ? candidate : null;
}

export function weekStartFor(value) {
  const key = dateKey(value);
  if (!key) return null;
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function addDateDays(value, amount) {
  const key = dateKey(value);
  if (!key) return null;
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(amount || 0));
  return d.toISOString().slice(0, 10);
}

export function executionForSession(executions, sessionId) {
  return (Array.isArray(executions) ? executions : []).find(row =>
    row && String(row.training_session_id || "") === String(sessionId || "")
  ) || null;
}

export function coachSessionStatus(session, execution, todayValue) {
  const recorded = String((execution && execution.status) || "").toLowerCase();
  if (TERMINAL_EXECUTION.has(recorded)) return recorded;
  const sessionDate = dateKey(session && session.session_date);
  const today = dateKey(todayValue) || new Date().toISOString().slice(0, 10);
  if (sessionDate === today) return "pending";
  if (sessionDate && sessionDate > today) return "upcoming";
  return "planned";
}

export function canSafelyMutateCoachSession(session, execution, todayValue) {
  const today = dateKey(todayValue) || new Date().toISOString().slice(0, 10);
  const sessionDate = dateKey(session && session.session_date);
  const executionStatus = String((execution && execution.status) || "").toLowerCase();
  if (!sessionDate || sessionDate < today) return false;
  return !TERMINAL_EXECUTION.has(executionStatus);
}

export function sanitizeCoachWorkoutInput(input) {
  const raw = input && typeof input === "object" ? input : {};
  const sessionDate = dateKey(raw.session_date);
  const title = text(raw.title, 160);
  const sessionType = text(raw.session_type, 80);
  if (!sessionDate) return { ok: false, error: "Choose a valid workout date." };
  if (!title && !sessionType) return { ok: false, error: "Add a workout title or type." };

  const duration = number(raw.duration_minutes, 0, 1440);
  const distance = number(raw.distance_km, 0, 1000);
  if (raw.duration_minutes !== "" && raw.duration_minutes != null && duration == null) {
    return { ok: false, error: "Duration must be between 0 and 1,440 minutes." };
  }
  if (raw.distance_km !== "" && raw.distance_km != null && distance == null) {
    return { ok: false, error: "Distance must be between 0 and 1,000 km." };
  }

  return {
    ok: true,
    value: {
      session_date: sessionDate,
      day: new Date(sessionDate + "T00:00:00Z").toLocaleDateString("en", { weekday: "long", timeZone: "UTC" }),
      title: title || sessionType,
      session_type: sessionType || title,
      sport: text(raw.sport, 40),
      duration_minutes: duration,
      distance_km: distance,
      intensity: text(raw.intensity, 120),
      target_rpe: text(raw.target_rpe, 80),
      pace_guidance: text(raw.pace_guidance, 400),
      heart_rate_guidance: text(raw.heart_rate_guidance, 400),
      description: text(raw.description, 1200),
      notes: text(raw.notes, 1200),
      status: "planned",
      plan_week_start: weekStartFor(sessionDate)
    }
  };
}

export function buildCoachTrainingWeek({ sessions, executions, weekStart, today } = {}) {
  const fallback = dateKey(today) || new Date().toISOString().slice(0, 10);
  const start = weekStartFor(weekStart) || weekStartFor(fallback);
  const end = addDateDays(start, 6);
  const rows = (Array.isArray(sessions) ? sessions : [])
    .filter(session => {
      const key = dateKey(session && session.session_date);
      return key && key >= start && key <= end;
    })
    .sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)))
    .map(session => {
      const execution = executionForSession(executions, session.id);
      const status = coachSessionStatus(session, execution, today);
      const mutable = canSafelyMutateCoachSession(session, execution, today);
      return {
        id: session.id == null ? null : String(session.id),
        date: dateKey(session.session_date),
        day: text(session.day, 20),
        sport: text(session.sport, 40),
        type: text(session.session_type, 80),
        title: text(session.title, 160) || text(session.session_type, 80) || "Workout",
        duration_minutes: number(session.duration_minutes, 0, 1440),
        distance_km: number(session.distance_km, 0, 1000),
        intensity: text(session.intensity, 120),
        target_rpe: text(session.target_rpe, 80),
        pace_guidance: text(session.pace_guidance, 400),
        heart_rate_guidance: text(session.heart_rate_guidance, 400),
        description: text(session.description, 1200),
        notes: text(session.notes, 1200),
        phase: text(session.phase, 80),
        week_focus: text(session.week_focus, 240),
        owner_type: text(session.owner_type, 40),
        execution_status: status,
        actual_duration_minutes: number(execution && execution.actual_duration_minutes, 0, 1440),
        actual_distance_km: number(execution && execution.actual_distance_km, 0, 1000),
        can_edit: mutable,
        can_reschedule: mutable,
        can_remove: mutable
      };
    });

  return { week_start: start, week_end: end, sessions: rows };
}

export function recentSkippedCount(sessions, executions, todayValue, days = 7) {
  const today = dateKey(todayValue) || new Date().toISOString().slice(0, 10);
  const since = addDateDays(today, -Math.max(1, Number(days || 7)));
  return (Array.isArray(sessions) ? sessions : []).reduce((count, session) => {
    const key = dateKey(session && session.session_date);
    const execution = executionForSession(executions, session && session.id);
    return key && key >= since && key <= today && execution && execution.status === "skipped"
      ? count + 1 : count;
  }, 0);
}

export const COACH_TRAINING_VERSION = "coach-training-v1";

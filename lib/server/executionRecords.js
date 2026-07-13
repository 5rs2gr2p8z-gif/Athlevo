/*
 * Reusable, pure-ish helpers for workout execution & feedback records.
 *
 * This module lives OUTSIDE /api on purpose: it is imported by several
 * serverless functions (get-week, weekly-analysis, generate-plan,
 * daily-brief) without itself counting against the Vercel function
 * budget.
 *
 * Nothing here performs network I/O except where a caller passes in the
 * data it already loaded. The DB round-trips stay in the API handlers.
 */

import {
  isRestSession,
  isRunActivity,
  manilaDateKey,
  toNumber
} from "./weeklyAnalysis.js";

export const EXECUTION_STATUSES = [
  "planned",
  "completed",
  "skipped",
  "modified"
];

export const FEELING_VALUES = ["easier", "as_expected", "harder"];

export const SKIP_REASONS = [
  "fatigue",
  "pain",
  "illness",
  "schedule",
  "weather",
  "travel",
  "motivation",
  "other"
];

/* ─── small coercion helpers ──────────────────────────────────── */

function cleanStr(value, maxLength = 2000) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (
    !trimmed ||
    trimmed === "null" ||
    trimmed === "undefined"
  ) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function intInRange(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(max, Math.max(min, Math.round(number)));
}

function nonNegativeInt(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Math.round(number);
}

function nonNegativeNumber(value, decimals = 2) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Number(number.toFixed(decimals));
}

function oneOf(value, allowed) {
  const clean = cleanStr(value, 40);

  if (!clean) {
    return null;
  }

  const lowered = clean.toLowerCase();

  return allowed.includes(lowered) ? lowered : null;
}

/*
 * Formats an average running pace ("m:ss/km") from distance + moving
 * time. Rounds total seconds-per-km before splitting so the seconds
 * field can never be 60. Returns null for missing/impossible input.
 */
export function formatPaceFromActivity(distanceMeters, movingSeconds) {
  const meters = toNumber(distanceMeters);
  const seconds = toNumber(movingSeconds);

  if (!meters || meters <= 0 || !seconds || seconds <= 0) {
    return null;
  }

  const perKm = Math.round(seconds / (meters / 1000));

  if (!Number.isFinite(perKm) || perKm <= 0) {
    return null;
  }

  return `${Math.floor(perKm / 60)}:${String(perKm % 60).padStart(2, "0")}/km`;
}

/* ─── prescription snapshot ───────────────────────────────────── */

/*
 * A compact, human-meaningful snapshot of the prescription at the time
 * feedback is recorded. Kept small on purpose — this is stored per
 * record and read back into coaching context.
 */
export function buildSessionSnapshot(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  const snapshot = {
    session_date: session.session_date || null,
    title: session.title || null,
    session_type: session.session_type || null,
    sport: session.sport || null,
    intensity: session.intensity || null,
    duration_minutes: toNumber(session.duration_minutes),
    distance_km: toNumber(session.distance_km),
    purpose: session.purpose || null,
    target_rpe: session.target_rpe || null
  };

  // Drop empty keys so the AI never sees explicit nulls it might echo.
  Object.keys(snapshot).forEach(key => {
    if (snapshot[key] === null || snapshot[key] === undefined) {
      delete snapshot[key];
    }
  });

  return Object.keys(snapshot).length ? snapshot : null;
}

/* ─── feedback validation / row building ──────────────────────── */

/*
 * Turns a raw client payload into a validated DB row, or returns an
 * error string. `session` is the prescribed training_sessions row (may
 * be null for a pure rest-day report). `userId` is the authenticated
 * athlete. Nothing here trusts client-supplied user_id.
 */
export function buildExecutionRow({ body, userId, session }) {
  const status = oneOf(body?.status, EXECUTION_STATUSES);

  if (!status || status === "planned") {
    return {
      error:
        "A feedback status of completed, skipped, or modified is required."
    };
  }

  const painPresent = body?.pain_present === true;

  const nowIso = new Date().toISOString();

  const completedAt =
    status === "skipped"
      ? null
      : cleanStr(body?.completed_at, 40) || nowIso;

  const row = {
    user_id: userId,
    training_session_id:
      cleanStr(body?.training_session_id, 64) ||
      session?.id ||
      null,

    status,
    completed_at: completedAt,

    actual_duration_minutes: nonNegativeInt(
      body?.actual_duration_minutes
    ),
    actual_distance_km: nonNegativeNumber(body?.actual_distance_km),
    actual_average_pace: cleanStr(body?.actual_average_pace, 20),
    actual_average_hr: intInRange(body?.actual_average_hr, 20, 260),
    actual_rpe: intInRange(body?.actual_rpe, 1, 10),

    overall_feeling: oneOf(body?.overall_feeling, FEELING_VALUES),

    pain_present: painPresent,
    pain_location: painPresent
      ? cleanStr(body?.pain_location, 200)
      : null,
    pain_severity: painPresent
      ? intInRange(body?.pain_severity, 1, 10)
      : null,

    athlete_notes: cleanStr(body?.athlete_notes, 2000),
    modification_reason:
      status === "modified"
        ? cleanStr(body?.modification_reason, 1000)
        : null,

    skip_reason:
      status === "skipped"
        ? oneOf(body?.skip_reason, SKIP_REASONS) || "other"
        : null,
    adjust_remaining_week:
      status === "skipped"
        ? body?.adjust_remaining_week === true
        : false,

    as_prescribed:
      status === "completed"
        ? body?.as_prescribed !== false
        : status === "modified"
        ? false
        : null,

    original_session_snapshot:
      buildSessionSnapshot(session) ||
      (body?.original_session_snapshot &&
      typeof body.original_session_snapshot === "object"
        ? body.original_session_snapshot
        : null),

    imported_activity_id:
      cleanStr(body?.imported_activity_id, 64) || null,

    // True when the athlete deliberately rejected the auto-suggested
    // Strava match (so we never silently trust the wrong activity).
    manual_activity_override:
      body?.manual_activity_override === true,

    updated_at: nowIso
  };

  return { row };
}

/* ─── Strava day-matching ─────────────────────────────────────── */

function sessionIsRun(session) {
  const haystack = [session?.session_type, session?.sport]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /run|jog|tempo|interval|threshold|long/.test(haystack);
}

/*
 * For each non-rest session, suggests the best same-day (Asia/Manila)
 * imported activity to prefill the feedback sheet. Selection considers,
 * in order: activity type (a run session prefers a run activity), then
 * closeness of duration and distance to the prescription, then simply
 * the longest activity. This is only a SUGGESTION — the athlete always
 * confirms and can reject it — so we never silently link the wrong one.
 * Returns a plain object keyed by training_session_id.
 */
export function matchActivitiesToSessions(sessions, activities) {
  const byDay = new Map();

  (activities || []).forEach(activity => {
    const key = manilaDateKey(activity.start_date);

    if (!key) {
      return;
    }

    if (!byDay.has(key)) {
      byDay.set(key, []);
    }

    byDay.get(key).push(activity);
  });

  const matches = {};

  (sessions || []).forEach(session => {
    if (!session?.id || isRestSession(session)) {
      return;
    }

    const dayKey = String(session.session_date || "").slice(0, 10);
    const dayActivities = byDay.get(dayKey) || [];

    if (!dayActivities.length) {
      return;
    }

    const wantRun = sessionIsRun(session);
    const plannedMinutes = toNumber(session.duration_minutes);
    const plannedKm = toNumber(session.distance_km);

    // Score each candidate; higher is better. Type agreement dominates,
    // then duration/distance proximity, with total time as a tiebreak.
    const scored = dayActivities.map(activity => {
      const seconds = toNumber(activity.moving_time_seconds) || 0;
      const meters = toNumber(activity.distance_meters) || 0;
      const minutes = seconds / 60;
      const km = meters / 1000;
      const isRun = isRunActivity(activity);

      let score = 0;

      if (wantRun && isRun) score += 100;
      if (wantRun && !isRun) score -= 40;

      if (plannedMinutes && minutes > 0) {
        score -= Math.min(50, Math.abs(minutes - plannedMinutes));
      }

      if (plannedKm && km > 0) {
        score -= Math.min(30, Math.abs(km - plannedKm) * 3);
      }

      // Small nudge toward the longer session when nothing else decides.
      score += Math.min(10, minutes / 12);

      return { activity, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0]?.activity || null;

    if (!best) {
      return;
    }

    const seconds = toNumber(best.moving_time_seconds) || 0;
    const meters = toNumber(best.distance_meters) || 0;

    matches[session.id] = {
      id: best.id || null,
      name: best.name || null,
      date: manilaDateKey(best.start_date),
      start_date: best.start_date || null,
      activity_type:
        best.sport_type || best.activity_type || null,
      actual_duration_minutes: seconds
        ? Math.round(seconds / 60)
        : null,
      actual_distance_km: meters
        ? Number((meters / 1000).toFixed(2))
        : null,
      average_pace: formatPaceFromActivity(meters, seconds),
      average_heartrate: toNumber(best.average_heartrate),
      candidate_count: dayActivities.length
    };
  });

  return matches;
}

/* ─── indexing / reading records ──────────────────────────────── */

export function indexRecordsBySession(records) {
  const map = new Map();

  (records || []).forEach(record => {
    if (record?.training_session_id) {
      map.set(String(record.training_session_id), record);
    }
  });

  return map;
}

/*
 * A record turned into clean, null-free fields for an AI payload. Only
 * meaningful values survive so the model never sees null/undefined.
 */
export function summarizeExecutionRecord(record) {
  if (!record) {
    return null;
  }

  const out = {};

  const put = (key, value) => {
    if (
      value !== null &&
      value !== undefined &&
      value !== "" &&
      !(typeof value === "number" && !Number.isFinite(value))
    ) {
      out[key] = value;
    }
  };

  put("status", record.status);
  put("as_prescribed", record.as_prescribed);
  put("actual_duration_minutes", toNumber(record.actual_duration_minutes));
  put("actual_distance_km", toNumber(record.actual_distance_km));
  put("actual_average_pace", record.actual_average_pace);
  put("actual_average_hr", toNumber(record.actual_average_hr));
  put("actual_rpe", toNumber(record.actual_rpe));
  put("overall_feeling", record.overall_feeling);

  if (record.pain_present === true) {
    put("pain_present", true);
    put("pain_location", record.pain_location);
    put("pain_severity", toNumber(record.pain_severity));
  }

  put("modification_reason", record.modification_reason);
  put("skip_reason", record.skip_reason);

  if (record.adjust_remaining_week === true) {
    put("athlete_requested_week_adjustment", true);
  }

  put("athlete_notes", record.athlete_notes);
  put("completed_at", record.completed_at);

  return Object.keys(out).length ? out : null;
}

/*
 * Combines prescriptions + explicit feedback + Strava matches into an
 * ordered array the AI can read directly. Each entry names the
 * prescribed session, the athlete's reported status/feedback, and any
 * matching activity. Sessions with no feedback report status "planned".
 */
export function buildExecutionContext({
  sessions,
  records,
  activities
}) {
  const recordMap = indexRecordsBySession(records);
  const activityMatches = matchActivitiesToSessions(
    sessions,
    activities
  );

  return (sessions || []).map(session => {
    const record = session?.id
      ? recordMap.get(String(session.id))
      : null;

    const feedback = summarizeExecutionRecord(record);
    const matched = session?.id
      ? activityMatches[session.id] || null
      : null;

    const entry = {
      session_date: session.session_date || null,
      title: session.title || null,
      session_type: isRestSession(session)
        ? "rest"
        : session.session_type || null,
      prescribed_duration_minutes: toNumber(session.duration_minutes),
      prescribed_distance_km: toNumber(session.distance_km),
      status: feedback?.status || "planned"
    };

    Object.keys(entry).forEach(key => {
      if (entry[key] === null || entry[key] === undefined) {
        delete entry[key];
      }
    });

    if (feedback) {
      entry.athlete_feedback = feedback;
    }

    if (matched) {
      entry.matching_activity = {
        name: matched.name,
        duration_minutes: matched.actual_duration_minutes,
        distance_km: matched.actual_distance_km,
        average_heartrate: matched.average_heartrate
      };

      Object.keys(entry.matching_activity).forEach(key => {
        const value = entry.matching_activity[key];

        if (value === null || value === undefined) {
          delete entry.matching_activity[key];
        }
      });
    }

    return entry;
  });
}

/*
 * Pulls the pain and modification signals out of a set of execution
 * records. Used to make pain-related skips available to injury memory
 * and to bias the next plan without inventing anything.
 */
export function extractExecutionSignals(records) {
  const painReports = [];
  const skips = [];
  const highEffort = [];
  let adjustmentRequested = false;

  (records || []).forEach(record => {
    if (record?.pain_present === true) {
      painReports.push({
        location: cleanStr(record.pain_location, 200) || "unspecified",
        severity: toNumber(record.pain_severity),
        when: record.completed_at || null,
        from: record.status || null
      });
    }

    if (record?.status === "skipped") {
      skips.push({
        reason: record.skip_reason || "other",
        adjust_remaining_week: record.adjust_remaining_week === true
      });

      if (record.adjust_remaining_week === true) {
        adjustmentRequested = true;
      }
    }

    const rpe = toNumber(record?.actual_rpe);

    if (
      record?.overall_feeling === "harder" ||
      (rpe !== null && rpe >= 8)
    ) {
      highEffort.push({
        rpe,
        feeling: record.overall_feeling || null
      });
    }
  });

  return {
    painReports,
    skips,
    highEffort,
    adjustmentRequested
  };
}

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach data sanitization   ·   pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Turns raw, service-role-loaded athlete rows into the MINIMAL shape a coach
 *  needs, and produces the categorical-only analytics props. This is the
 *  privacy boundary:
 *    · The coach RESPONSE may include operational data (name, sport, goal,
 *      readiness status, adherence, athlete_id so the drawer can open) but
 *      NEVER OAuth tokens, provider account ids, refresh/access tokens,
 *      payment/subscription secrets, or email.
 *    · The ANALYTICS props are categorical ONLY — never name, email, UUID,
 *      workout titles, pain notes, readiness values, distances, power, etc.
 *
 *  Sport-aware units reuse the multisport foundation (sportClassification).
 */

import {
  canonicalSportOf,
  classifyActivity,
  metricStyleForSport,
  activityDataQuality
} from "./sportClassification.js";

// Canonicalize a profile's primary_sport string ("Running"/"Cycling"/…) into a
// canonical sport key (run/ride/…), so UI labels and units resolve. Returns
// null when there is no primary sport.
function canonicalPrimarySport(primarySport) {
  if (!primarySport) return null;
  return classifyActivity({ providerActivityType: String(primarySport) }).sport;
}

// Keys that must NEVER appear in any coach-facing payload OR analytics.
export const SENSITIVE_KEYS = [
  "access_token", "refresh_token", "token", "provider_user_id",
  "providerUserId", "email", "strava_id", "athlete_id_provider",
  "password", "secret", "apikey", "api_key", "authorization"
];

// Extra keys forbidden specifically in ANALYTICS (operational, but sensitive
// as free-form or high-cardinality values).
const ANALYTICS_FORBIDDEN = [
  ...SENSITIVE_KEYS,
  "athlete_id", "athleteId", "user_id", "userId", "id", "name", "full_name",
  "title", "notes", "pain_location", "distance", "power", "heart", "hr",
  "readiness_score", "readinessScore"
];

function str(v) {
  return v == null ? null : String(v);
}
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Initials from a display name (fallback "A"). No email is ever used. */
export function initialsFrom(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "A";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* Coaching label for a readiness score (never a medical statement). */
export function readinessStatusLabel(score) {
  const s = num(score);
  if (s == null) return "No recent data";
  if (s >= 75) return "Optimal";
  if (s >= 55) return "Good";
  if (s >= 35) return "Moderate";
  return "Low";
}

/* Most recent of several ISO signals → last-active. Null when none exist. */
export function deriveLastActiveAt(signals) {
  let best = null;
  for (const v of signals || []) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

// A roster-size band (categorical, for analytics — never the exact count as a
// high-cardinality dimension is unnecessary).
export function rosterSizeBand(n) {
  const c = num(n) || 0;
  if (c === 0) return "0";
  if (c <= 5) return "1-5";
  if (c <= 15) return "6-15";
  if (c <= 40) return "16-40";
  return "40+";
}

/*
 * Build one sanitized roster entry from raw rows already scoped to an assigned
 * athlete. `raw` is a bundle the API assembles:
 *   { profile, metrics, weeklySummary, readiness, todaySession,
 *     latestActivity, providerAccount, attention, lastActiveAt }
 * NOTE: providerAccount is used ONLY for last_sync_at / status — never tokens.
 */
export function buildRosterEntry(raw) {
  const p = (raw && raw.profile) || {};
  const m = (raw && raw.metrics) || {};
  const w = (raw && raw.weeklySummary) || {};
  const rd = (raw && raw.readiness) || {};
  const today = (raw && raw.todaySession) || null;
  const latest = (raw && raw.latestActivity) || null;
  const provider = (raw && raw.providerAccount) || {};
  const todayExecution = (raw && raw.todayExecution) || null;
  const attention = (raw && raw.attention) || { status: "no_recent_data", severity: "low", reasons: [] };

  const name = str(p.full_name) || "Athlete";
  const sport = canonicalPrimarySport(p.primary_sport);

  // Adherence from planned vs completed (null when not computable — never 0).
  const plannedMin = num(w.planned_duration_minutes);
  const completedMin = num(w.completed_duration_minutes);
  const adherencePct =
    plannedMin != null && plannedMin > 0 && completedMin != null
      ? Math.round((completedMin / plannedMin) * 100)
      : null;

  return {
    // athlete_id is required so the drawer can open; it is NEVER sent to
    // analytics (see attentionAnalyticsProps / rosterAnalyticsProps).
    athlete_id: str(p.id),
    name,
    initials: initialsFrom(name),
    primary_sport: sport || null,
    goal: str(p.goal),
    target_event: str(p.target_race),
    target_date: str(p.race_date),
    today_planned: today
      ? {
          title: str(today.title) || str(today.session_type),
          sport: today.sport ? String(today.sport).toLowerCase() : sport,
          duration_minutes: num(today.duration_minutes),
          distance_km: num(today.distance_km),
          execution_status: ["completed", "modified", "skipped"].includes(String(todayExecution && todayExecution.status).toLowerCase())
            ? String(todayExecution.status).toLowerCase()
            : "pending"
        }
      : null,
    latest_activity: latest
      ? {
          sport: canonicalSportOf(latest),
          date: str(latest.start_date),
          distance_km: num(latest.distance_meters) != null ? Math.round(num(latest.distance_meters) / 100) / 10 : null,
          duration_min: num(latest.moving_time_seconds) != null ? Math.round(num(latest.moving_time_seconds) / 60) : null
        }
      : null,
    readiness_status: readinessStatusLabel(rd.readinessScore ?? rd.readiness_score),
    recovery_status: str(w.recovery_status) || "unknown",
    seven_day_load: num(m.weekly_training_load),
    adherence_pct: adherencePct,
    last_active_at: str(raw && raw.lastActiveAt),
    attention_status: attention.status,
    attention_severity: attention.severity,
    attention_reason_keys: (attention.reasons || []).map(r => r.key),
    // Placeholder only — messaging is not built this sprint.
    unread_count: null
  };
}

/*
 * Build the detailed (but still sanitized) athlete overview. Recent activities
 * are sport-aware; provider tokens and account ids are never included.
 */
export function buildAthleteOverview(raw) {
  const p = (raw && raw.profile) || {};
  const rd = (raw && raw.readiness) || {};
  const w = (raw && raw.weeklySummary) || {};
  const activities = Array.isArray(raw && raw.recentActivities) ? raw.recentActivities : [];

  const name = str(p.full_name) || "Athlete";

  const recent = activities.map(a => {
    const sport = canonicalSportOf(a);
    const style = metricStyleForSport(sport);
    const distanceM = num(a.distance_meters);
    const movingS = num(a.moving_time_seconds);
    const rawData = a.raw_data && typeof a.raw_data === "object" ? a.raw_data : {};
    const base = {
      sport,
      date: str(a.start_date),
      duration_min: movingS != null ? Math.round(movingS / 60) : null,
      indoor: rawData.classification ? rawData.classification.indoor : Boolean(a.trainer)
    };
    if (style === "pace") {
      base.distance_km = distanceM != null ? Math.round(distanceM / 100) / 10 : null;
      base.pace_sec_per_km = distanceM > 0 && movingS > 0 ? Math.round(movingS / (distanceM / 1000)) : null;
    } else if (style === "speed") {
      base.distance_km = distanceM != null ? Math.round(distanceM / 100) / 10 : null;
      base.speed_kph = distanceM > 0 && movingS > 0 ? Math.round(((distanceM / movingS) * 3.6) * 10) / 10 : null;
      base.avg_power_watts = num(rawData.average_power_watts);
      base.avg_cadence = num(a.average_cadence);
      base.data_quality = activityDataQuality(a);
    } else {
      base.category = sport; // strength/mobility/etc → duration + category
    }
    return base;
  });

  return {
    athlete_id: str(p.id),
    name,
    initials: initialsFrom(name),
    primary_sport: canonicalPrimarySport(p.primary_sport),
    goal: str(p.goal),
    target_event: str(p.target_race),
    target_date: str(p.race_date),
    plan_phase: str(raw && raw.planPhase),
    plan_week_focus: str(raw && raw.planWeekFocus),
    assignment_permission: str(raw && raw.assignmentPermission) || "read",
    today_planned: raw && raw.todaySession
      ? {
          title: str(raw.todaySession.title) || str(raw.todaySession.session_type),
          sport: raw.todaySession.sport || null,
          duration_minutes: num(raw.todaySession.duration_minutes),
          distance_km: num(raw.todaySession.distance_km)
        }
      : null,
    upcoming_session: raw && raw.upcomingSession
      ? {
          date: str(raw.upcomingSession.session_date),
          title: str(raw.upcomingSession.title) || str(raw.upcomingSession.session_type),
          duration_minutes: num(raw.upcomingSession.duration_minutes),
          distance_km: num(raw.upcomingSession.distance_km)
        }
      : null,
    week_planned_vs_completed: {
      planned_minutes: num(w.planned_duration_minutes),
      completed_minutes: num(w.completed_duration_minutes),
      planned_distance_km: num(w.planned_distance_km),
      completed_distance_km: num(w.completed_distance_km)
    },
    readiness: {
      status: readinessStatusLabel(rd.readinessScore ?? rd.readiness_score),
      pain_present: rd.pain_present === true,
      check_in_date: str(rd.readiness_date || rd.checkInDate)
    },
    recovery_status: str(w.recovery_status) || "unknown",
    recent_activities: recent,
    training_week: raw && raw.trainingWeek ? raw.trainingWeek : null,
    attention_reasons: (raw && raw.attention && raw.attention.reasons) || [],
    last_sync_at: str(raw && raw.lastSyncAt),
    last_active_at: str(raw && raw.lastActiveAt)
  };
}

/*
 * Assert an object is free of sensitive keys (used by tests and as a runtime
 * guard). Deep-scans keys. Returns the list of offending key paths (empty when
 * clean).
 */
export function findSensitiveKeys(obj, forbidden) {
  const bad = [];
  const deny = (forbidden || SENSITIVE_KEYS).map(k => k.toLowerCase());
  const walk = (o, path) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (deny.includes(String(k).toLowerCase())) bad.push(path ? path + "." + k : k);
      walk(o[k], path ? path + "." + k : k);
    }
  };
  walk(obj, "");
  return bad;
}

/* Categorical-only analytics props for a roster view. */
export function rosterAnalyticsProps({ dashboardSurface, rosterSize } = {}) {
  return {
    dashboard_surface: dashboardSurface || "coach_dashboard",
    roster_size_band: rosterSizeBand(rosterSize)
  };
}

/* Categorical-only analytics props for an attention item. */
export function attentionAnalyticsProps({ reasonKey, severity, sport } = {}) {
  return {
    attention_reason: reasonKey || "unknown",
    attention_severity: severity || "none",
    athlete_sport: sport ? String(sport).toLowerCase() : "unknown"
  };
}

export const ANALYTICS_FORBIDDEN_KEYS = ANALYTICS_FORBIDDEN;
export const COACH_SANITIZE_VERSION = "coach-sanitize-v1";

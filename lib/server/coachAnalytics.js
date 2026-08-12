/*
 * Pure, athlete-scoped Coach Analytics aggregation.
 *
 * The API loads rows only after JWT, role, and active-assignment checks, then
 * this module reduces them to small, non-sensitive coaching signals. Raw
 * activities, workout text, health fields, and provider data never cross the
 * server boundary.
 */

import { canonicalSportOf } from "./sportClassification.js";

const RANGE_WEEKS = [4, 8, 12];
const TERMINAL = new Set(["completed", "modified", "skipped"]);

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKey(value) {
  const key = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Date.parse(key + "T00:00:00Z"))
    ? key : null;
}

function shiftDate(value, days) {
  const parsed = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + days * 86400000).toISOString().slice(0, 10);
}

function inWindow(key, start, end) {
  return key && key >= start && key <= end;
}

function percentChange(current, previous) {
  if (!(previous > 0) || current == null) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function executionMap(executions) {
  const map = new Map();
  for (const row of Array.isArray(executions) ? executions : []) {
    if (!row || row.training_session_id == null) continue;
    const status = String(row.status || "").toLowerCase();
    if (TERMINAL.has(status)) map.set(String(row.training_session_id), status);
  }
  return map;
}

function activityDate(activity) {
  return dateKey(activity && activity.start_date);
}

function activityDurationMinutes(activity) {
  const seconds = number(activity && activity.moving_time_seconds);
  return seconds != null && seconds > 0 ? seconds / 60 : null;
}

function runDistanceKm(activity) {
  if (canonicalSportOf(activity) !== "run") return null;
  const metres = number(activity && activity.distance_meters);
  return metres != null && metres > 0 ? metres / 1000 : null;
}

function reliableCount(rows, getter) {
  return rows.reduce((count, row) => getter(row) != null ? count + 1 : count, 0);
}

function sumBy(rows, getter) {
  return rows.reduce((sum, row) => sum + (getter(row) || 0), 0);
}

function weeklySeries(rows, getter, start, weeks) {
  return Array.from({ length: weeks }, (_, index) => {
    const weekStart = shiftDate(start, index * 7);
    const weekEnd = shiftDate(weekStart, 6);
    const value = sumBy(rows.filter(row => inWindow(activityDate(row), weekStart, weekEnd)), getter);
    return { week_start: weekStart, value: Math.round(value * 10) / 10 };
  });
}

function volumeForRange(activities, start, end, previousStart, previousEnd, weeks) {
  const current = activities.filter(row => inWindow(activityDate(row), start, end));
  const previous = activities.filter(row => inWindow(activityDate(row), previousStart, previousEnd));
  const minimumSamples = Math.max(2, Math.ceil(weeks / 2));
  const currentRuns = reliableCount(current, runDistanceKm);
  const useDistance = currentRuns >= minimumSamples;
  const getter = useDistance ? runDistanceKm : activityDurationMinutes;
  const currentCount = reliableCount(current, getter);
  if (currentCount < minimumSamples) return { available: false };

  const currentTotal = sumBy(current, getter);
  const previousCount = reliableCount(previous, getter);
  const previousTotal = previousCount >= minimumSamples ? sumBy(previous, getter) : null;
  const weeklyAverage = Math.round((currentTotal / weeks) * 10) / 10;
  const previousWeeklyAverage = previousTotal == null ? null : Math.round((previousTotal / weeks) * 10) / 10;
  const change = percentChange(weeklyAverage, previousWeeklyAverage);
  let direction = "insufficient_baseline";
  if (change != null) direction = change >= 5 ? "rising" : change <= -5 ? "falling" : "stable";
  const noun = useDistance ? "Volume" : "Training time";
  const interpretation = direction === "rising"
    ? noun + " has increased over this period."
    : direction === "falling"
      ? noun + " has decreased over this period."
      : direction === "stable"
        ? noun + " has remained broadly stable."
        : noun + " is available, but prior history is not yet sufficient for comparison.";

  return {
    available: true,
    metric: useDistance ? "run_distance" : "duration",
    unit: useDistance ? "km" : "min",
    weekly_average: weeklyAverage,
    previous_weekly_average: previousWeeklyAverage,
    change_pct: change,
    direction,
    series: weeklySeries(current, getter, start, weeks),
    interpretation
  };
}

function adherenceForRange(sessions, executions, start, end, previousStart, previousEnd) {
  const bySession = executionMap(executions);
  function result(from, to) {
    const statuses = sessions
      .filter(row => inWindow(dateKey(row && row.session_date), from, to))
      .map(row => bySession.get(String(row.id)))
      .filter(Boolean);
    const completed = statuses.filter(status => status === "completed" || status === "modified").length;
    return {
      completed,
      recorded: statuses.length,
      pct: statuses.length >= 2 ? Math.round((completed / statuses.length) * 100) : null
    };
  }
  const current = result(start, end);
  if (current.pct == null) return { available: false };
  const previous = result(previousStart, previousEnd);
  const change = previous.pct == null ? null : current.pct - previous.pct;
  const direction = change == null ? "insufficient_baseline" : change >= 6 ? "rising" : change <= -6 ? "falling" : "stable";
  const interpretation = current.pct >= 85
    ? "Execution has remained consistent in this period."
    : current.pct >= 70
      ? "Most recorded sessions were completed, with some missed execution."
      : "Recorded session completion has been inconsistent in this period.";
  return {
    available: true,
    pct: current.pct,
    completed: current.completed,
    recorded: current.recorded,
    previous_pct: previous.pct,
    change_points: change,
    direction,
    interpretation
  };
}

function thresholdPace(activity) {
  if (canonicalSportOf(activity) !== "run") return null;
  const recognition = activity && (activity.recognition || activity.raw_data && activity.raw_data.recognition);
  if (!recognition || String(recognition.workoutType || "").toLowerCase() !== "threshold") return null;
  if (!["high", "moderate"].includes(String(recognition.confidenceLabel || "").toLowerCase())) return null;
  const distance = number(activity.distance_meters);
  const seconds = number(activity.moving_time_seconds);
  return distance > 0 && seconds > 0 ? Math.round(seconds / (distance / 1000)) : null;
}

function mean(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function performanceForRange(activities, start, end, previousStart, previousEnd) {
  const collect = (from, to) => activities
    .filter(row => inWindow(activityDate(row), from, to))
    .map(thresholdPace)
    .filter(value => value != null);
  const current = collect(start, end);
  const previous = collect(previousStart, previousEnd);
  if (current.length < 2 || previous.length < 2) return {
    available: false,
    interpretation: "More comparable sessions are needed before performance trend is reliable."
  };
  const currentPace = mean(current);
  const previousPace = mean(previous);
  const delta = currentPace - previousPace;
  const direction = delta <= -3 ? "improving" : delta >= 3 ? "slowing" : "stable";
  return {
    available: true,
    metric: "threshold_pace",
    pace_sec_per_km: currentPace,
    previous_pace_sec_per_km: previousPace,
    delta_sec_per_km: delta,
    direction,
    sample_size: current.length,
    interpretation: direction === "improving"
      ? "Classified threshold sessions are trending faster than the previous period."
      : direction === "slowing"
        ? "Classified threshold pace is slower than the previous period."
        : "Classified threshold pace is broadly stable."
  };
}

function coachingSummary(volume, adherence, performance) {
  const clauses = [];
  if (volume.available && volume.direction !== "insufficient_baseline") {
    clauses.push((volume.metric === "run_distance" ? "Training volume" : "Training time") + " is " + volume.direction);
  }
  if (adherence.available) {
    clauses.push("adherence is " + (adherence.pct >= 85 ? "consistent" : adherence.pct >= 70 ? "mixed" : "inconsistent"));
  }
  if (performance.available) {
    clauses.push("classified threshold pace is " + performance.direction);
  }
  if (!clauses.length) return "Not enough training history yet to identify a reliable trend.";
  if (clauses.length === 1) return clauses[0].charAt(0).toUpperCase() + clauses[0].slice(1) + ".";
  const last = clauses.pop();
  return clauses.map((clause, index) => index === 0 ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause).join(", ") + ", and " + last + ".";
}

export function buildCoachAnalytics({ activities, sessions, executions, today } = {}) {
  const end = dateKey(today) || new Date().toISOString().slice(0, 10);
  const activityRows = Array.isArray(activities) ? activities : [];
  const sessionRows = Array.isArray(sessions) ? sessions : [];
  const executionRows = Array.isArray(executions) ? executions : [];
  const ranges = {};

  for (const weeks of RANGE_WEEKS) {
    const start = shiftDate(end, -(weeks * 7 - 1));
    const previousEnd = shiftDate(start, -1);
    const previousStart = shiftDate(previousEnd, -(weeks * 7 - 1));
    const volume = volumeForRange(activityRows, start, end, previousStart, previousEnd, weeks);
    const adherence = adherenceForRange(sessionRows, executionRows, start, end, previousStart, previousEnd);
    const performance = performanceForRange(activityRows, start, end, previousStart, previousEnd);
    ranges[String(weeks)] = {
      weeks,
      start,
      end,
      summary: coachingSummary(volume, adherence, performance),
      volume,
      adherence,
      performance,
      has_meaningful_history: Boolean(volume.available || adherence.available || performance.available)
    };
  }

  return { default_range_weeks: 4, ranges };
}

export const COACH_ANALYTICS_VERSION = "coach-analytics-v1";

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — WeeklyReview   ·  Adaptive Smart Plan v2   ·  pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Turns a completed training week into an honest one-glance summary plus a
 *  single concise coach takeaway. Pure and deterministic; no UI, no AI. Every
 *  figure is counted from the week's sessions — nothing is invented.
 *
 *  Input:
 *    buildWeeklyReview({
 *      weekStart:"2026-07-13",
 *      sessions:[ {
 *        date, type, distanceKm, durationMin,
 *        status:"completed"|"skipped"|"planned"|"missed",
 *        quality?:bool, long?:bool
 *      } ]
 *    })
 */

export const WEEKLY_REVIEW_VERSION = "weekly-review-v1";

const QUALITY_TYPES = new Set(["threshold", "vo2", "intervals", "speed", "tempo"]);

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function r1(n) { return Math.round((num(n) || 0) * 10) / 10; }
function typeKey(t) { return String(t || "").toLowerCase().replace(/\s*(session|run)\s*$/, "").trim(); }
function isQuality(s) { return s.quality != null ? !!s.quality : QUALITY_TYPES.has(typeKey(s.type)); }
function isLong(s) { return s.long != null ? !!s.long : /long/.test(typeKey(s.type)); }
function isCompleted(s) { return s.status === "completed"; }
function isMissed(s) { return s.status === "skipped" || s.status === "missed"; }

function consistencyLabel(ratio, missed) {
  if (ratio >= 0.9) return "Excellent";
  if (ratio >= 0.75) return "Good";
  if (ratio >= 0.5) return "Fair";
  return missed ? "Needs attention" : "Fair";
}

// One concise paragraph — praises what went well, names the single most
// important gap, and points forward. Never scolds, never lists.
function takeaway({ doneQuality, dueQuality, completed, planned, mileageKm, longestKm, label, missedLong }) {
  const parts = [];
  if (label === "Excellent") parts.push("A complete, well-executed week.");
  else if (label === "Good") parts.push("A solid week of training.");
  else if (label === "Fair") parts.push("A partial week — the base is intact.");
  else parts.push("A light week; consistency is the next focus.");

  if (dueQuality > 0 && doneQuality >= dueQuality) parts.push(`Both quality sessions landed and ${r1(mileageKm)} km is in the bank.`);
  else if (dueQuality > 0 && doneQuality > 0) parts.push(`${doneQuality} of ${dueQuality} quality sessions done, ${r1(mileageKm)} km total.`);
  else parts.push(`${r1(mileageKm)} km of aerobic work banked.`);

  if (missedLong) parts.push("The long run slipped — protecting endurance next week matters most.");
  else if (longestKm) parts.push(`Longest run reached ${r1(longestKm)} km.`);

  parts.push(label === "Excellent" ? "Ready to build carefully from here."
    : "Repeat the pattern next week and progress will follow.");
  return parts.join(" ");
}

export function buildWeeklyReview(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions.filter(Boolean) : [];
  const planned = sessions.filter(s => isCompleted(s) || isMissed(s) || s.status === "planned");
  const completedList = sessions.filter(isCompleted);

  const completed = completedList.length;
  const plannedCount = planned.length;
  const dueQuality = planned.filter(isQuality).length;
  const doneQuality = completedList.filter(isQuality).length;
  const mileageKm = r1(completedList.reduce((a, s) => a + (num(s.distanceKm) || 0), 0));
  const longestKm = completedList.reduce((m, s) => Math.max(m, num(s.distanceKm) || 0), 0) || null;
  const missedLong = planned.some(s => isLong(s) && isMissed(s));

  const ratio = plannedCount > 0 ? completed / plannedCount : 1;
  const label = consistencyLabel(ratio, plannedCount > completed);

  return {
    version: WEEKLY_REVIEW_VERSION,
    weekStart: input.weekStart || null,
    completed, planned: plannedCount,
    completedLabel: `${completed} / ${plannedCount}`,
    quality: { completed: doneQuality, due: dueQuality, label: `${doneQuality} / ${dueQuality}` },
    mileageKm,
    longestRunKm: longestKm != null ? r1(longestKm) : null,
    consistency: consistencyLabel(ratio, plannedCount > completed),
    consistencyRatio: Math.round(ratio * 100) / 100,
    takeaway: takeaway({ doneQuality, dueQuality, completed, planned: plannedCount,
      mileageKm, longestKm, label, missedLong })
  };
}

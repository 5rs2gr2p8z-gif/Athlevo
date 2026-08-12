/*
 * Read-only Coach Workspace view of athlete-submitted daily readiness.
 * Input rows are loaded only after the Coach API verifies JWT, role, and an
 * active assignment. This module returns the smallest truthful shape needed
 * by Athlete Detail and never includes user ids or provider/account data.
 */

const SLEEP_LABELS = {
  1: "Very poor",
  2: "Poor",
  3: "Fair",
  4: "Good",
  5: "Excellent"
};

function boundedNumber(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function text(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function dateKey(value) {
  const key = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(Date.parse(key + "T00:00:00Z"))
    ? key : null;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function sanitizeCoachCheckIn(row) {
  const date = dateKey(row && row.readiness_date);
  if (!date) return null;
  const sleep = boundedNumber(row.sleep_quality, 1, 5);
  const painPresent = row.pain_present === true;
  const checkIn = {
    date,
    submitted_at: timestamp(row.updated_at) || timestamp(row.created_at),
    sleep_quality: sleep,
    sleep_label: sleep == null ? null : SLEEP_LABELS[sleep],
    energy: boundedNumber(row.energy, 1, 10),
    muscle_soreness: boundedNumber(row.muscle_soreness, 1, 10),
    mental_stress: boundedNumber(row.mental_stress, 1, 10),
    pain_present: painPresent,
    pain_location: painPresent ? text(row.pain_location, 200) : null,
    pain_severity: painPresent ? boundedNumber(row.pain_severity, 1, 10) : null,
    notes: text(row.notes, 1000)
  };
  return checkIn;
}

export function buildCoachCheckIns(rows) {
  const records = (Array.isArray(rows) ? rows : [])
    .map(sanitizeCoachCheckIn)
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14);
  return { records };
}

export const COACH_CHECK_INS_VERSION = "coach-check-ins-v1";

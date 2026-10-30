/*
 * Resolves ONE athlete's training paces for the coach workout builder.
 * Mirrors the evidence rules api/training/generate-plan.js already uses for
 * the AI planner (best confirmed race in ~13 months, otherwise the best recent
 * run) and REUSES lib/server/performance.js for every number. It adds no new
 * pace or VDOT maths. Returns null paces when there is no usable evidence, so
 * the builder falls back to zone names instead of inventing numbers.
 */
import { vdotFromRace, trainingPaces, ZONE_ORDER, ZONE_LABELS } from "./performance.js";

const ELIGIBLE_RACE_TYPES = new Set(["official", "time_trial", "training_effort"]);

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function ageDays(dateValue, nowMs) {
  const t = Date.parse(dateValue);
  return Number.isFinite(t) ? (nowMs - t) / 86400000 : Infinity;
}
function isRun(a) {
  return /run|jog|tempo|interval|threshold|long/.test(
    String((a && (a.activity_type || a.sport_type)) || "").toLowerCase()
  );
}

export function resolveAthletePaces({ raceResults, activities, nowMs } = {}) {
  const now = nowMs || Date.now();
  let best = null;
  let source = null;

  for (const r of Array.isArray(raceResults) ? raceResults : []) {
    if (!r || !ELIGIBLE_RACE_TYPES.has(r.race_type)) continue;
    if (r.race_date && ageDays(r.race_date, now) > 400) continue;
    const vdot = vdotFromRace(r.distance_meters, r.duration_seconds);
    if (vdot == null) continue;
    if (!best || vdot > best.vdot) best = { vdot, detail: num(r.distance_meters) / 1000, date: r.race_date || null };
  }
  if (best) source = "confirmed_race";

  if (!best) {
    for (const a of Array.isArray(activities) ? activities : []) {
      if (!isRun(a) || ageDays(a.start_date, now) > 120) continue;
      const meters = num(a.distance_meters), seconds = num(a.moving_time_seconds);
      if (!meters || meters < 3000 || !seconds) continue;
      const vdot = vdotFromRace(meters, seconds);
      if (vdot == null) continue;
      if (!best || vdot > best.vdot) best = { vdot, detail: meters / 1000, date: String(a.start_date || "").slice(0, 10) || null };
    }
    if (best) source = "recent_run";
  }

  if (!best) return { vdot: null, source: null, zones: null };

  const centres = trainingPaces(best.vdot);
  if (!centres) return { vdot: null, source: null, zones: null };
  const zones = {};
  for (const key of ZONE_ORDER) {
    const c = centres[key];
    if (c && c.secPerKm) zones[key] = { key, label: ZONE_LABELS[key], secPerKm: c.secPerKm, pace: c.pace };
  }
  return { vdot: Math.round(best.vdot * 10) / 10, source, basis_km: Math.round(best.detail * 10) / 10, basis_date: best.date, zones };
}

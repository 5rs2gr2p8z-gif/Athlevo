/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Attention classifier   ·   deterministic, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ONE centralized, deterministic, explainable classifier that turns an
 *  athlete's ALREADY-LOADED, sanitized snapshot into a coaching attention
 *  status. It is independent of UI rendering and fully unit-testable.
 *
 *  Principles:
 *    · Coaching language, never medical diagnosis. We say "Pain was reported
 *      in the latest check-in", never "possible injury detected". We never
 *      label an athlete healthy, injured, safe, or medically cleared.
 *    · Conservative and based only on data that already exists. No new
 *      medical-risk algorithm is invented.
 *    · Deterministic: same snapshot + same `now` → same output.
 *
 *  Output:
 *    { status, severity, reasons: [{ key, severity, explanation, date }] }
 *    status   : "needs_attention" | "monitor" | "on_track" | "no_recent_data"
 *    severity : "high" | "medium" | "low" | "none"
 */

export const ATTENTION_STATUSES = [
  "needs_attention",
  "monitor",
  "on_track",
  "no_recent_data"
];

// Tunable, documented thresholds. Passed-in overrides keep tests deterministic.
export const DEFAULT_ATTENTION_CONFIG = {
  noActivityDays: 7,        // no synced activity within N days
  noReadinessDays: 4,       // no readiness check-in within N days
  noAppActivityDays: 10,    // no app activity (any signal) within N days
  veryLowReadinessScore: 30,// readiness score at/below this is "very low"
  eventApproachingDays: 21, // target event within N days
  minMissedSessions: 2      // this many missed planned sessions → alert
};

const SEV_RANK = { none: 0, low: 1, medium: 2, high: 3 };

function toDate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function daysSince(v, nowMs) {
  const t = toDate(v);
  return t == null ? Infinity : (nowMs - t) / 86400000;
}
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/*
 * classifyAttention(snapshot, opts)
 *
 * `snapshot` (all fields optional; missing data never fabricates a reason):
 *   {
 *     lastActivityAt, lastReadinessAt, lastActiveAt,   // ISO timestamps
 *     readiness: { painPresent, painDate, illnessReported, readinessScore,
 *                  energy, soreness, checkInDate },
 *     recoveryStatus,                                  // 'good'|'fair'|'poor'|'unknown'
 *     missedKeyWorkout,                                // boolean
 *     missedSessionCount,                              // number (last 7d)
 *     loadFlag,                                        // 'high_risk' | null (existing trusted rule)
 *     targetEventDate,                                 // ISO date
 *     syncFailed, planMissing,                         // booleans
 *     hasAnyData                                       // boolean (any signal ever)
 *   }
 */
export function classifyAttention(snapshot, opts) {
  const cfg = { ...DEFAULT_ATTENTION_CONFIG, ...(opts && opts.config) };
  const nowMs = opts && opts.now ? Date.parse(opts.now) : Date.now();
  const s = snapshot || {};
  const r = s.readiness || {};
  const reasons = [];
  const add = (key, severity, explanation, date) =>
    reasons.push({ key, severity, explanation, date: date || null });

  // ── No recent data at all → a STATE, not an alarm. Assessed first. ──
  const noActivity = daysSince(s.lastActivityAt, nowMs) > cfg.noActivityDays;
  const noReadiness = daysSince(s.lastReadinessAt, nowMs) > cfg.noReadinessDays;
  const noAppActivity = daysSince(s.lastActiveAt, nowMs) > cfg.noAppActivityDays;
  const hasAnyData = s.hasAnyData === true ||
    toDate(s.lastActivityAt) != null || toDate(s.lastReadinessAt) != null;

  if (!hasAnyData) {
    return {
      status: "no_recent_data",
      severity: "low",
      reasons: [{ key: "no_recent_data", severity: "low",
        explanation: "No recent training or check-in data is available yet.",
        date: null }]
    };
  }

  // ── High-severity coaching signals ──────────────────────────────────
  if (r.painPresent === true) {
    add("pain_reported", "high",
      "Pain was reported in the latest check-in.", r.painDate || r.checkInDate);
  }
  if (r.illnessReported === true) {
    add("illness_reported", "high",
      "Illness was reported in the latest check-in.", r.checkInDate);
  }
  if (s.missedKeyWorkout === true) {
    add("missed_key_workout", "high",
      "A key planned session was not completed.", null);
  }
  {
    const score = num(r.readinessScore);
    if (score != null && score <= cfg.veryLowReadinessScore) {
      add("very_low_readiness", "high",
        "Readiness was very low in the latest check-in.", r.checkInDate);
    }
  }

  // ── Medium-severity signals ─────────────────────────────────────────
  if (String(s.recoveryStatus || "").toLowerCase() === "poor") {
    add("low_recovery", "medium",
      "Recovery status is currently poor.", null);
  }
  {
    const missed = num(s.missedSessionCount);
    if (missed != null && missed >= cfg.minMissedSessions) {
      add("multiple_missed_sessions", "medium",
        `${missed} planned sessions were missed recently.`, null);
    }
  }
  if (String(s.loadFlag || "").toLowerCase() === "high_risk") {
    add("high_recent_load", "medium",
      "Recent training load is unusually high for this athlete.", null);
  }
  if (s.syncFailed === true) {
    add("provider_sync_failed", "medium",
      "The most recent provider sync did not complete.", null);
  }
  if (s.planMissing === true) {
    add("no_active_plan", "medium",
      "No active training plan is present.", null);
  }
  if (noActivity && hasAnyData) {
    add("no_recent_activity", "medium",
      "No synced activity in the recent window.", s.lastActivityAt || null);
  }

  // ── Low-severity / informational ────────────────────────────────────
  if (noReadiness) {
    add("no_readiness_checkin", "low",
      "No readiness check-in in the recent window.", s.lastReadinessAt || null);
  }
  if (noAppActivity) {
    add("no_recent_app_activity", "low",
      "No recent app activity from this athlete.", s.lastActiveAt || null);
  }
  {
    const d = daysSince(s.targetEventDate, nowMs);
    // negative daysSince → event is in the future
    const daysUntil = d === Infinity ? Infinity : -d;
    if (daysUntil >= 0 && daysUntil <= cfg.eventApproachingDays) {
      add("event_approaching", "low",
        "A target event is approaching.", s.targetEventDate || null);
    }
  }

  // ── Roll up to a single status/severity ─────────────────────────────
  let topRank = 0;
  for (const x of reasons) topRank = Math.max(topRank, SEV_RANK[x.severity] || 0);
  const severity = ["none", "low", "medium", "high"][topRank];

  let status;
  if (topRank >= SEV_RANK.high) status = "needs_attention";
  else if (topRank >= SEV_RANK.medium) status = "monitor";
  else if (topRank === SEV_RANK.low && (noActivity && noReadiness)) status = "no_recent_data";
  else status = "on_track";

  // Order reasons strongest-first for display.
  reasons.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));

  return { status, severity: severity === "none" ? "none" : severity, reasons };
}

// Sort key for the roster: needs_attention → monitor → no_recent_data → on_track.
export const STATUS_SORT_ORDER = {
  needs_attention: 0,
  monitor: 1,
  no_recent_data: 2,
  on_track: 3
};

export function compareByAttention(a, b) {
  const ra = STATUS_SORT_ORDER[a && a.status] ?? 99;
  const rb = STATUS_SORT_ORDER[b && b.status] ?? 99;
  if (ra !== rb) return ra - rb;
  // Within a status, higher severity first.
  return (SEV_RANK[b && b.severity] || 0) - (SEV_RANK[a && a.severity] || 0);
}

export const ATTENTION_CLASSIFIER_VERSION = "attention-classifier-v1";

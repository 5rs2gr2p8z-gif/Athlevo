/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Analytics Aggregation  (pure funnel / retention / segments)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Turns raw activation_events rows into the beta dashboard's numbers. Pure and
 *  deterministic: takes rows in, returns aggregates out — no I/O, no database,
 *  no PII. Rows: { user_id, event_name, occurred_at }.
 *
 *  Retention definition (documented): a user has "returned on/after day N" if
 *  they started a meaningful authenticated app session (app_session_started) on
 *  a CALENDAR day at least N days after their first session day. Calendar days
 *  use UTC — activation_events carries no reliable per-user timezone, so UTC is
 *  the documented fallback. This yields monotonic D1 ≥ D3 ≥ D7 ≥ D14.
 */

// Legacy names → canonical, mirrored from js/analyticsRegistry.js so server
// aggregation is correct even for rows written before the taxonomy migration.
const ALIASES = {
  signup_completed: "account_created",
  profile_completed: "athlete_onboarding_completed",
  connect_step_viewed: "wearable_setup_started",
  intervals_connected: "wearable_connection_succeeded",
  initial_sync_started: "first_sync_started",
  initial_sync_completed: "first_activity_imported",
  activities_detected: "first_sync_started",
  dashboard_opened: "app_session_started",
  sync_failed: "wearable_connection_failed"
};

function canon(name) { return ALIASES[name] || name; }
function dayNum(iso) {                                   // UTC calendar day index
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
}

// The ordered acquisition→activation funnel shown on the dashboard.
export const FUNNEL_STAGES = [
  ["account_created", "Account created"],
  ["athlete_onboarding_completed", "Onboarding completed"],
  ["wearable_setup_started", "Wearable setup started"],
  ["wearable_connection_succeeded", "Wearable connected"],
  ["first_activity_imported", "First activity imported"],
  ["first_plan_generated", "First plan generated"],
  ["first_workout_analysis_viewed", "First workout analysis"],
  ["first_coach_message_sent", "First coach message"]
];

/*
 * buildUserStates(rows, nowMs) → { [userId]: { events:Set, firstSeenMs,
 *   lastSeenMs, sessionDays:Set<dayNum>, failedWearableMs:[], sessionCount } }
 */
export function buildUserStates(rows, nowMs) {
  const list = Array.isArray(rows) ? rows : [];
  const states = {};
  list.forEach(r => {
    if (!r || !r.user_id) return;
    const name = canon(r.event_name);
    const ms = Date.parse(r.occurred_at);
    const u = states[r.user_id] || (states[r.user_id] = {
      events: new Set(), firstSeenMs: null, lastSeenMs: null,
      sessionDays: new Set(), failedWearableMs: [], sessionCount: 0
    });
    u.events.add(name);
    if (Number.isFinite(ms)) {
      if (u.firstSeenMs == null || ms < u.firstSeenMs) u.firstSeenMs = ms;
      if (u.lastSeenMs == null || ms > u.lastSeenMs) u.lastSeenMs = ms;
      if (name === "app_session_started") { u.sessionDays.add(dayNum(r.occurred_at)); u.sessionCount++; }
      if (name === "wearable_connection_failed") u.failedWearableMs.push(ms);
    }
  });
  return states;
}

/*
 * buildFunnel(rows) → { stages:[{key,label,users,pctFromPrev,pctFromStart}],
 *   totalAccounts }
 */
export function buildFunnel(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byStage = {};
  FUNNEL_STAGES.forEach(([k]) => (byStage[k] = new Set()));
  list.forEach(r => {
    const name = canon(r && r.event_name);
    if (byStage[name] && r.user_id) byStage[name].add(r.user_id);
  });
  const start = byStage[FUNNEL_STAGES[0][0]].size;
  let prev = start;
  const stages = FUNNEL_STAGES.map(([key, label]) => {
    const users = byStage[key].size;
    const pctFromPrev = prev > 0 ? Math.round((users / prev) * 1000) / 10 : 0;
    const pctFromStart = start > 0 ? Math.round((users / start) * 1000) / 10 : 0;
    prev = users;
    return { key, label, users, pctFromPrev, pctFromStart };
  });
  return { stages, totalAccounts: start };
}

/*
 * computeRetention(rows, nowMs) → { cohort, d1, d3, d7, d14 } with counts + pct.
 * cohort = users with ≥1 app session.
 */
export function computeRetention(rows, nowMs) {
  const states = buildUserStates(rows, nowMs);
  const users = Object.values(states).filter(u => u.sessionDays.size > 0);
  const cohort = users.length;
  const bucket = { d1: 0, d3: 0, d7: 0, d14: 0 };
  users.forEach(u => {
    const days = [...u.sessionDays].sort((a, b) => a - b);
    const first = days[0];
    const maxGap = days[days.length - 1] - first;   // largest later-day gap
    if (maxGap >= 1) bucket.d1++;
    if (maxGap >= 3) bucket.d3++;
    if (maxGap >= 7) bucket.d7++;
    if (maxGap >= 14) bucket.d14++;
  });
  const pct = n => (cohort > 0 ? Math.round((n / cohort) * 1000) / 10 : 0);
  return {
    cohort,
    d1: { users: bucket.d1, pct: pct(bucket.d1) },
    d3: { users: bucket.d3, pct: pct(bucket.d3) },
    d7: { users: bucket.d7, pct: pct(bucket.d7) },
    d14: { users: bucket.d14, pct: pct(bucket.d14) }
  };
}

// Active-user counts over trailing windows (distinct users with a session).
export function activeUsers(rows, nowMs) {
  const now = nowMs || Date.now();
  const win = { d1: new Set(), d7: new Set(), d30: new Set() };
  (rows || []).forEach(r => {
    if (canon(r && r.event_name) !== "app_session_started" || !r.user_id) return;
    const ms = Date.parse(r.occurred_at);
    if (!Number.isFinite(ms)) return;
    const ageDays = (now - ms) / 86400000;
    if (ageDays <= 1) win.d1.add(r.user_id);
    if (ageDays <= 7) win.d7.add(r.user_id);
    if (ageDays <= 30) win.d30.add(r.user_id);
  });
  return { last1: win.d1.size, last7: win.d7.size, last30: win.d30.size };
}

/*
 * classifySegments(rows, nowMs) → { [segment]: { count, userIds:[] } }
 * Safe server-side references only (user UUIDs) — no PII, for a future email
 * integration. Segments are mutually informative, not mutually exclusive.
 */
export function classifySegments(rows, nowMs) {
  const now = nowMs || Date.now();
  const states = buildUserStates(rows, now);
  const seg = {
    signed_up_onboarding_incomplete: [],
    onboarding_complete_no_wearable: [],
    wearable_connected_no_activity: [],
    activity_no_plan: [],
    plan_generated_inactive_3d: [],
    active_beta_user: [],
    failed_wearable_recent: []
  };
  const has = (u, e) => u.events.has(e);
  Object.keys(states).forEach(uid => {
    const u = states[uid];
    const inactiveDays = u.lastSeenMs != null ? (now - u.lastSeenMs) / 86400000 : Infinity;
    if (has(u, "account_created") && !has(u, "athlete_onboarding_completed")) seg.signed_up_onboarding_incomplete.push(uid);
    if (has(u, "athlete_onboarding_completed") && !has(u, "wearable_connection_succeeded")) seg.onboarding_complete_no_wearable.push(uid);
    if (has(u, "wearable_connection_succeeded") && !has(u, "first_activity_imported")) seg.wearable_connected_no_activity.push(uid);
    if (has(u, "first_activity_imported") && !has(u, "first_plan_generated")) seg.activity_no_plan.push(uid);
    if (has(u, "first_plan_generated") && inactiveDays >= 3) seg.plan_generated_inactive_3d.push(uid);
    if (inactiveDays <= 7 && u.sessionDays.size > 0) seg.active_beta_user.push(uid);
    if (u.failedWearableMs.some(ms => (now - ms) / 86400000 <= 7)) seg.failed_wearable_recent.push(uid);
  });
  const out = {};
  Object.keys(seg).forEach(k => (out[k] = { count: seg[k].length, userIds: seg[k] }));
  return out;
}

// Top-line milestone counts (distinct users per milestone).
export function topline(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const distinct = name => {
    const s = new Set();
    list.forEach(r => { if (canon(r && r.event_name) === name && r.user_id) s.add(r.user_id); });
    return s.size;
  };
  return {
    accounts: distinct("account_created"),
    verified: distinct("email_verified"),
    onboardingCompleted: distinct("athlete_onboarding_completed"),
    wearableConnected: distinct("wearable_connection_succeeded"),
    firstActivityImported: distinct("first_activity_imported"),
    firstPlanGenerated: distinct("first_plan_generated")
  };
}

// Recent failures grouped by safe category (no messages, no payloads).
export function recentFailures(rows, nowMs) {
  const now = nowMs || Date.now();
  const groups = { wearable: {}, plan: {}, sync: {} };
  const bump = (g, cat) => { g[cat] = (g[cat] || 0) + 1; };
  (rows || []).forEach(r => {
    const name = canon(r && r.event_name);
    const ms = Date.parse(r.occurred_at);
    if (!Number.isFinite(ms) || (now - ms) / 86400000 > 30) return;
    const cat = (r.metadata && r.metadata.failure_category) || "unknown";
    if (name === "wearable_connection_failed") bump(groups.wearable, cat);
    else if (name === "plan_generation_failed") bump(groups.plan, cat);
  });
  return groups;
}

export const ANALYTICS_AGGREGATION_VERSION = "analytics-aggregation-v1";

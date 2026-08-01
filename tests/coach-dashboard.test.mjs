/*
 * Athlevo — Coach Dashboard MVP tests.
 *
 * ROLE SECURITY · ASSIGNMENTS · RLS/API · ROSTER · ATTENTION ·
 * ATHLETE OVERVIEW · ANALYTICS PRIVACY · REGRESSION (source-level).
 *
 * Pure logic is tested directly; client + registry are loaded in a sandbox;
 * security-critical wiring is asserted against source (no live DB needed).
 *
 * Run: node tests/coach-dashboard.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  resolveRole, isCoach, isAdmin, canAccessCoachDashboard, canManageAssignments
} from "../lib/server/coachRoles.js";
import {
  activeAssignmentsForCoach, assignedAthleteIds, canCoachAccessAthlete,
  wouldDuplicateLiveAssignment, validateNewAssignment
} from "../lib/server/coachAssignments.js";
import {
  classifyAttention, compareByAttention, STATUS_SORT_ORDER
} from "../lib/server/attentionClassifier.js";
import {
  buildRosterEntry, buildAthleteOverview, findSensitiveKeys,
  rosterAnalyticsProps, attentionAnalyticsProps, deriveLastActiveAt,
  initialsFrom, readinessStatusLabel, SENSITIVE_KEYS, ANALYTICS_FORBIDDEN_KEYS
} from "../lib/server/coachSanitize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n)) : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

function loadGlobal(relPath, extra) {
  const code = readFileSync(join(root, relPath), "utf8");
  const sandbox = Object.assign({ window: {}, document: {}, location: { hash: "" }, history: {}, console, fetch: () => {} }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window;
}

const NOW = "2026-08-01T12:00:00Z";
const recent = "2026-07-31T08:00:00Z";
const old = "2026-06-01T08:00:00Z";
const COACH = "coach-1", COACH2 = "coach-2", A1 = "ath-1", A2 = "ath-2";

/* ═══════════════════════════ ROLE SECURITY ════════════════════════════ */
section("ROLE SECURITY");

t("default/missing role resolves to athlete", resolveRole(null) === "athlete" && resolveRole({}) === "athlete" && resolveRole({ role: "bogus" }) === "athlete");
t("athlete cannot access coach dashboard", canAccessCoachDashboard({ role: "athlete" }) === false);
t("coach can access coach dashboard", canAccessCoachDashboard({ role: "coach" }) === true);
t("admin can access coach dashboard", canAccessCoachDashboard({ role: "admin" }) === true);
t("role is case/whitespace tolerant but explicit", resolveRole({ role: " Coach " }) === "coach");
t("only admin may manage assignments", canManageAssignments({ role: "admin" }) === true && canManageAssignments({ role: "coach" }) === false);
t("isCoach/isAdmin helpers correct", isCoach({ role: "coach" }) && isAdmin({ role: "admin" }) && !isCoach({ role: "admin" }));
// Client-side role spoofing: the API reads role from the caller's OWN profile
// (loadCoachProfile), never from the request body/query.
{
  const src = readFileSync(join(root, "api/providers/index.js"), "utf8");
  t("API derives role from server-loaded profile, not client input", /loadCoachProfile\(user\.id\)/.test(src) && /canAccessCoachDashboard\(profile\)/.test(src));
  t("API never trusts a client-supplied role field", !/req\.body\.role|req\.query\.role/.test(src));
}

/* ═══════════════════════════ ASSIGNMENTS ══════════════════════════════ */
section("ASSIGNMENTS");

const assignments = [
  { coach_id: COACH, athlete_id: A1, status: "active" },
  { coach_id: COACH, athlete_id: A2, status: "ended" },
  { coach_id: COACH2, athlete_id: A1, status: "active" }
];
t("coach sees active assigned athlete", canCoachAccessAthlete(assignments, COACH, A1) === true);
t("coach cannot see unassigned athlete", canCoachAccessAthlete(assignments, COACH, "ath-999") === false);
t("ended assignment grants no access", canCoachAccessAthlete(assignments, COACH, A2) === false);
t("paused/invited assignment grants no access", canCoachAccessAthlete([{ coach_id: COACH, athlete_id: A1, status: "paused" }], COACH, A1) === false && canCoachAccessAthlete([{ coach_id: COACH, athlete_id: A1, status: "invited" }], COACH, A1) === false);
t("assignedAthleteIds returns only active, deduped", JSON.stringify(assignedAthleteIds(assignments, COACH)) === JSON.stringify([A1]));
t("coach A cannot see coach B's athlete via A's assignments", canCoachAccessAthlete(assignments, COACH, A1) && !canCoachAccessAthlete([{ coach_id: COACH2, athlete_id: A1, status: "active" }], COACH, A1));
t("duplicate live assignment is detected", wouldDuplicateLiveAssignment(assignments, COACH, A1) === true);
t("re-assign allowed after ended (not a live duplicate)", wouldDuplicateLiveAssignment(assignments, COACH, A2) === false);
t("duplicate active assignment prevented by validateNewAssignment", validateNewAssignment(assignments, COACH, A1).ok === false);
t("coach cannot self-assign (coach_id === athlete_id)", validateNewAssignment([], COACH, COACH).ok === false && validateNewAssignment([], COACH, COACH).reason === "coach_is_athlete");
t("a client athlete_id alone cannot bypass authorization", canCoachAccessAthlete(assignments, COACH, "any-id-they-supply") === false);

/* ═══════════════════════════ RLS / API SECURITY ═══════════════════════ */
section("RLS / API SECURITY");

{
  // Service-role key must be absent from ALL browser-shipped code.
  const clientFiles = ["js/coachDashboard.js", "js/brain.js", "js/analyticsRegistry.js", "index.html"];
  const leak = clientFiles.some(f => /SERVICE_ROLE|service_role|serviceRole/.test(readFileSync(join(root, f), "utf8")));
  t("service-role key absent from browser bundle", leak === false);

  const api = readFileSync(join(root, "api/providers/index.js"), "utf8");
  t("API authorizes athlete_id against active assignments before loading data", /canCoachAccessAthlete\(assignments, user\.id, athleteId\)/.test(api));
  t("API never SELECTs provider tokens", !/select=[^`'"]*(access_token|refresh_token)/.test(api));
  t("API provider read is limited to last_sync fields", /provider_accounts\?[^`]*select=provider,last_sync_at,last_sync_status/.test(api));
  t("API does not leak raw DB errors", /could not load|could not record|not configured/i.test(api));

  const mig = readFileSync(join(root, "migrations/2026-08-01_coach_dashboard.sql"), "utf8");
  t("RLS: coach read gated by active-assignment predicate", /athlevo_is_active_coach_of/.test(mig) && /status = 'active'/.test(mig));
  t("RLS: coach policies are SELECT-only on athlete data", /for select using \(public\.athlevo_is_active_coach_of/.test(mig));
  t("RLS: provider/subscription tables get NO coach policy", /DELIBERATELY OMITTED[\s\S]*provider_accounts[\s\S]*subscriptions/.test(mig));
  t("RLS: assignments have no client insert/update/delete policy", /NO client insert\/update\/delete policy/.test(mig));
  t("migration is additive and not auto-applied", /Run MANUALLY/.test(mig) && /add column if not exists role/.test(mig));
  t("assignment table enforces distinct coach/athlete + live uniqueness", /coach_athlete_distinct check \(coach_id <> athlete_id\)/.test(mig) && /coach_athlete_live_unique/.test(mig));
}
{
  // Overview and roster payloads must be free of sensitive keys.
  const rawWithSecrets = {
    profile: { id: A1, full_name: "Dana Ruiz", primary_sport: "Running", goal: "Sub-3 marathon", access_token: "SECRET", email: "x@y.z" },
    metrics: { weekly_training_load: 320 },
    weeklySummary: { recovery_status: "good", planned_duration_minutes: 300, completed_duration_minutes: 270 },
    readiness: { readinessScore: 68, pain_present: false },
    recentActivities: [],
    attention: { status: "on_track", severity: "low", reasons: [] }
  };
  const overview = buildAthleteOverview(rawWithSecrets);
  t("provider tokens/email never appear in athlete overview", findSensitiveKeys(overview).length === 0);
  const rosterEntry = buildRosterEntry(rawWithSecrets);
  t("provider tokens/email never appear in roster entry", findSensitiveKeys(rosterEntry).length === 0);
}

/* ═══════════════════════════════ ROSTER ═══════════════════════════════ */
section("ROSTER");

const baseRaw = {
  profile: { id: A1, full_name: "Dana Ruiz", primary_sport: "Cycling", goal: "Gran Fondo", target_race: "Alpine Fondo", target_race_date: "2026-08-20" },
  metrics: { weekly_training_load: 410 },
  weeklySummary: { recovery_status: "good", planned_duration_minutes: 300, completed_duration_minutes: 240 },
  readiness: { readinessScore: 70, pain_present: false },
  latestActivity: { source: "strava", activity_type: "Ride", sport_type: "Ride", start_date: recent, distance_meters: 42000, moving_time_seconds: 5400 },
  attention: { status: "on_track", severity: "low", reasons: [] },
  lastActiveAt: recent
};
{
  const e = buildRosterEntry(baseRaw);
  t("assigned athlete renders operational fields", e.name === "Dana Ruiz" && e.primary_sport === "ride" && e.seven_day_load === 410);
  t("adherence computed from planned vs completed (80%)", e.adherence_pct === 80);
  t("latest activity is sport-aware (ride)", e.latest_activity.sport === "ride");
  t("initials derived without email", initialsFrom("Dana Ruiz") === "DR" && e.initials === "DR");
  t("unread_count is a placeholder (messaging not built)", e.unread_count === null);
}
{
  // Missing metrics must show unavailable, never fabricated zeroes.
  const sparse = buildRosterEntry({ profile: { id: A2, full_name: "Sam" }, attention: { status: "no_recent_data", severity: "low", reasons: [] } });
  t("missing seven-day load is null (not 0)", sparse.seven_day_load === null);
  t("missing adherence is null (not 0)", sparse.adherence_pct === null);
  t("missing recovery falls back to 'unknown'", sparse.recovery_status === "unknown");
  t("readiness with no data reads 'No recent data'", readinessStatusLabel(null) === "No recent data");
}
{
  // Sorting: needs_attention → monitor → no_recent_data → on_track.
  const roster = [
    { name: "OnTrack", attention_status: "on_track", attention_severity: "low" },
    { name: "Needs", attention_status: "needs_attention", attention_severity: "high" },
    { name: "NoData", attention_status: "no_recent_data", attention_severity: "low" },
    { name: "Monitor", attention_status: "monitor", attention_severity: "medium" }
  ];
  const win = loadGlobal("js/coachDashboard.js");
  const sorted = win.AthlevoCoachDashboard._sortRoster(roster).map(a => a.name);
  t("client roster sort prioritizes needs-attention", JSON.stringify(sorted) === JSON.stringify(["Needs", "Monitor", "NoData", "OnTrack"]));
  t("STATUS_SORT_ORDER matches spec ordering", STATUS_SORT_ORDER.needs_attention === 0 && STATUS_SORT_ORDER.on_track === 3);
}
t("server compareByAttention prioritizes needs-attention then severity", (() => {
  const arr = [{ status: "monitor", severity: "medium" }, { status: "needs_attention", severity: "high" }];
  return arr.slice().sort(compareByAttention)[0].status === "needs_attention";
})());

/* ═══════════════════════════════ ATTENTION ════════════════════════════ */
section("ATTENTION");

const opt = { now: NOW };
t("pain report produces needs_attention (high)", (() => {
  const r = classifyAttention({ hasAnyData: true, lastActivityAt: recent, lastReadinessAt: recent, readiness: { painPresent: true } }, opt);
  return r.status === "needs_attention" && r.reasons.some(x => x.key === "pain_reported" && x.severity === "high");
})());
t("illness report produces needs_attention", (() => {
  const r = classifyAttention({ hasAnyData: true, lastReadinessAt: recent, readiness: { illnessReported: true } }, opt);
  return r.status === "needs_attention" && r.reasons.some(x => x.key === "illness_reported");
})());
t("very low readiness produces a high alert", (() => {
  const r = classifyAttention({ hasAnyData: true, lastReadinessAt: recent, readiness: { readinessScore: 20 } }, opt);
  return r.status === "needs_attention" && r.reasons.some(x => x.key === "very_low_readiness");
})());
t("missed key workout produces needs_attention", (() => {
  const r = classifyAttention({ hasAnyData: true, lastActivityAt: recent, missedKeyWorkout: true }, opt);
  return r.status === "needs_attention" && r.reasons.some(x => x.key === "missed_key_workout");
})());
t("two missed sessions produce a monitor alert", (() => {
  const r = classifyAttention({ hasAnyData: true, lastActivityAt: recent, lastReadinessAt: recent, missedSessionCount: 2 }, opt);
  return r.status === "monitor" && r.reasons.some(x => x.key === "multiple_missed_sessions");
})());
t("no data at all → no_recent_data (a state, not an alarm)", (() => {
  const r = classifyAttention({ hasAnyData: false }, opt);
  return r.status === "no_recent_data" && r.severity === "low";
})());
t("healthy/on-track athlete is NOT falsely flagged", (() => {
  const r = classifyAttention({ hasAnyData: true, lastActivityAt: recent, lastReadinessAt: recent, lastActiveAt: recent, readiness: { readinessScore: 80, painPresent: false }, recoveryStatus: "good", missedSessionCount: 0 }, opt);
  return r.status === "on_track" && r.severity === "none";
})());
t("classifier uses coaching language, not medical diagnosis", (() => {
  const r = classifyAttention({ hasAnyData: true, lastReadinessAt: recent, readiness: { painPresent: true } }, opt);
  const txt = r.reasons.map(x => x.explanation).join(" ");
  return /Pain was reported/.test(txt) && !/injury|diagnos|medical|healthy|cleared/i.test(txt);
})());
t("review does not erase the underlying condition (classifier is review-independent)", (() => {
  // Reviews are stored separately; the classifier only reads athlete data, so a
  // reviewed pain report still classifies as pain until the data changes.
  const r = classifyAttention({ hasAnyData: true, lastReadinessAt: recent, readiness: { painPresent: true } }, opt);
  return r.reasons.some(x => x.key === "pain_reported");
})());
{
  const mig = readFileSync(join(root, "migrations/2026-08-01_coach_dashboard.sql"), "utf8");
  t("reviewed alert remains historically traceable (upsert, not per-render insert)", /coach_attention_reviews_unique/.test(mig) && /on_conflict=coach_id,athlete_id,alert_key/.test(readFileSync(join(root, "api/providers/index.js"), "utf8")));
}

/* ═══════════════════════════ ATHLETE OVERVIEW ═════════════════════════ */
section("ATHLETE OVERVIEW");

{
  const raw = {
    profile: { id: A1, full_name: "Dana Ruiz", primary_sport: "Running", goal: "Sub-3", target_race_date: "2026-09-01" },
    readiness: { readinessScore: 65, pain_present: false, readiness_date: "2026-07-31" },
    weeklySummary: { planned_duration_minutes: 300, completed_duration_minutes: 280, recovery_status: "fair" },
    recentActivities: [
      { source: "strava", activity_type: "Run", sport_type: "Run", start_date: recent, distance_meters: 12000, moving_time_seconds: 3600 },
      { source: "strava", activity_type: "Ride", sport_type: "Ride", start_date: old, distance_meters: 40000, moving_time_seconds: 5400, raw_data: { average_power_watts: 190 }, average_cadence: 88 },
      { source: "strava", activity_type: "WeightTraining", sport_type: "WeightTraining", start_date: old, moving_time_seconds: 2400 }
    ],
    attention: { status: "monitor", severity: "medium", reasons: [{ key: "low_recovery", severity: "medium", explanation: "Recovery status is currently poor." }] },
    lastActiveAt: recent, lastSyncAt: recent
  };
  const ov = buildAthleteOverview(raw);
  t("overview shows correct athlete identity + goal", ov.name === "Dana Ruiz" && ov.goal === "Sub-3");
  const run = ov.recent_activities.find(a => a.sport === "run");
  const ride = ov.recent_activities.find(a => a.sport === "ride");
  const str = ov.recent_activities.find(a => a.sport === "strength");
  t("recent run activity is pace/distance", run.pace_sec_per_km != null && run.distance_km === 12 && run.speed_kph === undefined);
  t("recent ride activity is speed/power/cadence (no running pace)", ride.speed_kph != null && ride.avg_power_watts === 190 && ride.avg_cadence === 88 && ride.pace_sec_per_km === undefined);
  t("recent strength activity is duration/category (no distance/pace)", str.category === "strength" && str.distance_km === undefined);
  t("overview carries active attention reasons", ov.attention_reasons.length === 1 && ov.attention_reasons[0].key === "low_recovery");
  t("no sensitive fields leak into overview", findSensitiveKeys(ov).length === 0);
}
t("unassigned athlete is blocked at the authorization layer", canCoachAccessAthlete([{ coach_id: COACH, athlete_id: A1, status: "active" }], COACH, "someone-else") === false);
t("deriveLastActiveAt picks the most recent signal", Date.parse(deriveLastActiveAt([old, recent, null])) === Date.parse(recent));

/* ═══════════════════════════ ANALYTICS PRIVACY ════════════════════════ */
section("ANALYTICS PRIVACY");

{
  const rp = rosterAnalyticsProps({ rosterSize: 12 });
  const ap = attentionAnalyticsProps({ reasonKey: "pain_reported", severity: "high", sport: "run" });
  t("roster analytics props are categorical only", JSON.stringify(Object.keys(rp).sort()) === JSON.stringify(["dashboard_surface", "roster_size_band"]) && rp.roster_size_band === "6-15");
  t("attention analytics props are categorical only", JSON.stringify(Object.keys(ap).sort()) === JSON.stringify(["athlete_sport", "attention_reason", "attention_severity"]));
  t("analytics props contain no sensitive keys", findSensitiveKeys(rp, ANALYTICS_FORBIDDEN_KEYS).length === 0 && findSensitiveKeys(ap, ANALYTICS_FORBIDDEN_KEYS).length === 0);

  const reg = readFileSync(join(root, "js/analyticsRegistry.js"), "utf8");
  ["coach_dashboard_viewed", "coach_roster_athlete_opened", "coach_attention_item_viewed", "coach_attention_item_reviewed"].forEach(ev => {
    t(`registry declares ${ev}`, new RegExp(ev + ":").test(reg));
  });
  const coachBlocks = (reg.match(/props:\s*\[[^\]]*\]/g) || []).filter(b => /dashboard_surface|attention_reason|roster_size_band/.test(b));
  const forbidden = /(email|name|token|uuid|user_id|athlete_id|distance|power|heart|readiness_score|notes|pain)/i;
  t("coach analytics events declare no forbidden props", coachBlocks.every(b => !forbidden.test(b)));

  // Client never puts athlete name/uuid into tracked coach analytics calls.
  const client = readFileSync(join(root, "js/coachDashboard.js"), "utf8");
  const trackCalls = client.match(/analytics\(\)\.track\([^;]*\)/g) || [];
  t("client coach analytics calls carry only categorical props", trackCalls.every(c => !/\bname\b|athlete_id|\.email|readiness_status|seven_day_load/.test(c)));
}

/* ═══════════════════════════ SENSITIVE-KEY GUARD ══════════════════════ */
section("SENSITIVE-KEY GUARD");
t("findSensitiveKeys detects a planted token", findSensitiveKeys({ a: { refresh_token: "x" } }).length === 1);
t("SENSITIVE_KEYS covers tokens + email", SENSITIVE_KEYS.includes("access_token") && SENSITIVE_KEYS.includes("refresh_token") && SENSITIVE_KEYS.includes("email"));

/* ═══════════════════════════════ SUMMARY ══════════════════════════════ */
console.log(`\n════════════════════════════════════════`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

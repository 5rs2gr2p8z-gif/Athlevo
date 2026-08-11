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
  canCoachManageAthlete, wouldDuplicateLiveAssignment, validateNewAssignment
} from "../lib/server/coachAssignments.js";
import {
  buildCoachTrainingWeek, canSafelyMutateCoachSession, coachSessionStatus,
  sanitizeCoachWorkoutInput
} from "../lib/server/coachTraining.js";
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
  { coach_id: COACH, athlete_id: A1, status: "active", permission_level: "read_write" },
  { coach_id: COACH, athlete_id: A2, status: "ended" },
  { coach_id: COACH2, athlete_id: A1, status: "active" }
];
t("coach sees active assigned athlete", canCoachAccessAthlete(assignments, COACH, A1) === true);
t("coach cannot see unassigned athlete", canCoachAccessAthlete(assignments, COACH, "ath-999") === false);
t("read_write assignment permits coach programming", canCoachManageAthlete(assignments, COACH, A1) === true);
t("read-only assignment cannot mutate programming", canCoachManageAthlete([{ coach_id: COACH, athlete_id: A1, status: "active", permission_level: "read" }], COACH, A1) === false);
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
  const coachBundle = api.slice(
    api.indexOf("async function loadAthleteBundle"),
    api.indexOf("function readinessScoreFrom")
  );
  t("API authorizes athlete_id against active assignments before loading data", /canCoachAccessAthlete\(assignments, user\.id, athleteId\)/.test(api));
  t("Coach API never SELECTs provider tokens", coachBundle.length > 0 && !/select=[^`'"]*(access_token|refresh_token)/.test(coachBundle));
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
  profile: { id: A1, full_name: "Dana Ruiz", primary_sport: "Cycling", goal: "Gran Fondo", target_race: "Alpine Fondo" },
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

/* ═══════════════════════════ PROFILE MAPPING ════════════════════════════ */
section("PROFILE MAPPING");

{
  // Populated profile renders real name, sport, goal
  const populated = buildRosterEntry({
    profile: { id: "pm-1", full_name: "Jordan Bell", primary_sport: "Running", goal: "BQ", target_race: "Boston Marathon" },
    attention: { status: "no_recent_data", severity: "low", reasons: [] }
  });
  t("populated profile renders real name", populated.name === "Jordan Bell");
  t("populated profile renders correct initials", populated.initials === "JB");
  t("primary sport renders canonical key (run)", populated.primary_sport === "run");
  t("goal renders from profile.goal", populated.goal === "BQ");
  t("target_event renders from profile.target_race", populated.target_event === "Boston Marathon");
}
{
  // No activities still shows "No recent data" for readiness
  const noActs = buildRosterEntry({
    profile: { id: "pm-2", full_name: "Lin Sato", primary_sport: "Cycling", goal: "Century ride" },
    readiness: {},
    latestActivity: null,
    attention: { status: "no_recent_data", severity: "low", reasons: [] },
    lastActiveAt: null
  });
  t("no activities: readiness shows 'No recent data'", noActs.readiness_status === "No recent data");
  t("no activities: latest_activity is null", noActs.latest_activity === null);
  t("no activities: last_active_at is null", noActs.last_active_at === null);
  t("no activities: name still renders from profile", noActs.name === "Lin Sato");
}
{
  // Missing profile safely falls back to "Athlete"
  const missing = buildRosterEntry({
    profile: {},
    attention: { status: "no_recent_data", severity: "low", reasons: [] }
  });
  t("missing profile falls back to 'Athlete'", missing.name === "Athlete");
  t("missing profile: initials fallback to 'A'", missing.initials === "A");
  t("missing profile: primary_sport is null", missing.primary_sport === null);
  t("missing profile: goal is null", missing.goal === null);
  t("missing profile: target_event is null", missing.target_event === null);
}
{
  // Sensitive fields from profile never reach the response
  const withSecrets = buildRosterEntry({
    profile: {
      id: "pm-3", full_name: "Test User", email: "secret@example.com",
      access_token: "BEARER_TOKEN", refresh_token: "REFRESH",
      strava_id: "12345", provider_user_id: "ext-999",
      password: "hunter2", secret: "shhh", apikey: "key123",
      primary_sport: "Running", goal: "5K PR"
    },
    attention: { status: "on_track", severity: "none", reasons: [] }
  });
  const sensitiveFound = findSensitiveKeys(withSecrets);
  t("sensitive profile fields never reach roster response", sensitiveFound.length === 0,
    sensitiveFound.join(", "));
  // Also verify the overview path
  const overviewSecrets = buildAthleteOverview({
    profile: {
      id: "pm-3", full_name: "Test User", email: "secret@example.com",
      access_token: "BEARER_TOKEN", refresh_token: "REFRESH",
      provider_user_id: "ext-999", primary_sport: "Running", goal: "5K PR"
    },
    attention: { status: "on_track", severity: "none", reasons: [] }
  });
  t("sensitive profile fields never reach overview response", findSensitiveKeys(overviewSecrets).length === 0);
}
{
  // The overview uses the same profile mapping as the roster
  const profile = { id: "pm-4", full_name: "Kai Rivera", primary_sport: "Cycling", goal: "Everesting", target_race: "Mt. Ventoux" };
  const rEntry = buildRosterEntry({ profile, attention: { status: "on_track", severity: "none", reasons: [] } });
  const oEntry = buildAthleteOverview({ profile, attention: { status: "on_track", severity: "none", reasons: [] } });
  t("overview matches roster: name", rEntry.name === oEntry.name && rEntry.name === "Kai Rivera");
  t("overview matches roster: sport", rEntry.primary_sport === oEntry.primary_sport && rEntry.primary_sport === "ride");
  t("overview matches roster: goal", rEntry.goal === oEntry.goal && rEntry.goal === "Everesting");
  t("overview matches roster: target_event", rEntry.target_event === oEntry.target_event && rEntry.target_event === "Mt. Ventoux");
}
{
  // The same race_date field already written by onboarding and read by the
  // athlete planning APIs powers the coach target-date display.
  const apiSrc = readFileSync(join(root, "api/providers/index.js"), "utf8");
  const profileQuery = apiSrc.match(/profiles\?id=eq\.\$\{idf\}&select=([^\)]+)\)/);
  t("profiles query does not include target_race_date", profileQuery && !profileQuery[1].includes("target_race_date"));
  t("profiles query includes identity, goal, target race, and real race_date", profileQuery && /full_name/.test(profileQuery[1]) && /primary_sport/.test(profileQuery[1]) && /goal/.test(profileQuery[1]) && /target_race/.test(profileQuery[1]) && /race_date/.test(profileQuery[1]));
}

/* ═══════════════════════════ COACH TRAINING ══════════════════════════ */
section("COACH TRAINING");
{
  const sessions = [
    { id: "s1", session_date: "2026-07-27", day: "Monday", title: "Easy Run", session_type: "easy", duration_minutes: 45, target_rpe: "3", owner_type: "human_coach" },
    { id: "s2", session_date: "2026-07-29", day: "Wednesday", title: "Threshold", session_type: "threshold", distance_km: 10 },
    { id: "s3", session_date: "2026-08-01", day: "Saturday", title: "Long Run", session_type: "long", duration_minutes: 100 }
  ];
  const executions = [
    { training_session_id: "s1", status: "completed", actual_duration_minutes: 46 },
    { training_session_id: "s2", status: "modified", actual_distance_km: 8 }
  ];
  const week = buildCoachTrainingWeek({ sessions, executions, weekStart: "2026-07-27", today: "2026-08-01" });
  t("training week preserves prescriptions and execution statuses", week.sessions.length === 3 && week.sessions[0].execution_status === "completed" && week.sessions[1].execution_status === "modified" && week.sessions[2].execution_status === "pending");
  t("completed workout is immutable from coach calendar", week.sessions[0].can_edit === false && week.sessions[0].can_remove === false);
  t("today pending workout remains safely editable", week.sessions[2].can_edit === true && week.sessions[2].can_reschedule === true);
  t("future workout status is upcoming", coachSessionStatus({ session_date: "2026-08-03" }, null, "2026-08-01") === "upcoming");
  t("past prescription without execution is not falsely called missed", coachSessionStatus({ session_date: "2026-07-30" }, null, "2026-08-01") === "planned");
  t("past and executed workouts cannot be removed", !canSafelyMutateCoachSession({ session_date: "2026-07-30" }, null, "2026-08-01") && !canSafelyMutateCoachSession({ session_date: "2026-08-02" }, { status: "skipped" }, "2026-08-01"));
}
{
  const valid = sanitizeCoachWorkoutInput({ session_date: "2026-08-04", title: "Aerobic Run", duration_minutes: "50", distance_km: "8", target_rpe: "3" });
  t("coach workout input is allowlisted and normalized", valid.ok && valid.value.duration_minutes === 50 && valid.value.distance_km === 8 && !("owner_type" in valid.value));
  t("invalid workout date is rejected", sanitizeCoachWorkoutInput({ session_date: "2026-02-31", title: "Run" }).ok === false);
}
{
  const apiSrc = readFileSync(join(root, "api/providers/index.js"), "utf8");
  t("workout mutations re-check active assignment and read_write permission", /canCoachAccessAthlete\(assignments, user\.id, athleteId\)/.test(apiSrc) && /canCoachManageAthlete\(assignments, user\.id, athleteId\)/.test(apiSrc));
  t("workout mutations scope session reads and writes to athlete", /training_sessions\?\$\{userFilter\}&id=eq\.\$\{enc\(sessionId\)\}/.test(apiSrc));
  t("coach writes stamp existing human-coach authority", /stampOwnership\(\{[\s\S]*mode: "human_coached"/.test(apiSrc) && /created_by: user\.id/.test(apiSrc));
  t("client authority fields are stripped before mutation", /stripClientAuthorityFields\(request\.body \|\| \{\}\)/.test(apiSrc));
}

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
    profile: { id: A1, full_name: "Dana Ruiz", primary_sport: "Running", goal: "Sub-3", target_race: "Fall Marathon" },
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

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Mode tests
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Tests for the Coach Mode shell, navigation, Coach Today command center,
 *  placeholder tabs, privacy/analytics, and integration with existing
 *  coach-dashboard security and attention classifier.
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";

/* ─────────── Server-side imports (pure, no I/O) ─────────── */
import { classifyAttention, ATTENTION_STATUSES, DEFAULT_ATTENTION_CONFIG } from "../lib/server/attentionClassifier.js";
import { resolveRole, canAccessCoachDashboard, ROLES, DEFAULT_ROLE } from "../lib/server/coachRoles.js";
import { assignedAthleteIds, canCoachAccessAthlete } from "../lib/server/coachAssignments.js";
import {
  buildRosterEntry, buildAthleteOverview, initialsFrom, readinessStatusLabel,
  deriveLastActiveAt, rosterSizeBand, findSensitiveKeys, SENSITIVE_KEYS,
  rosterAnalyticsProps, attentionAnalyticsProps, ANALYTICS_FORBIDDEN_KEYS
} from "../lib/server/coachSanitize.js";

/* ═══════════════════════════════════════════════════════════════════
 *  MODE RESOLUTION
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — mode resolution", () => {

  it("athlete role remains athlete_mode (resolveRole returns athlete)", () => {
    assert.equal(resolveRole({ role: "athlete" }), "athlete");
    assert.equal(canAccessCoachDashboard({ role: "athlete" }), false);
  });

  it("coach role resolves coach_mode", () => {
    assert.equal(resolveRole({ role: "coach" }), "coach");
    assert.equal(canAccessCoachDashboard({ role: "coach" }), true);
  });

  it("admin role resolves coach_mode", () => {
    assert.equal(resolveRole({ role: "admin" }), "admin");
    assert.equal(canAccessCoachDashboard({ role: "admin" }), true);
  });

  it("unknown/null/missing role does not grant coach access", () => {
    assert.equal(resolveRole(null), "athlete");
    assert.equal(resolveRole({}), "athlete");
    assert.equal(resolveRole({ role: null }), "athlete");
    assert.equal(resolveRole({ role: "" }), "athlete");
    assert.equal(resolveRole({ role: "superadmin" }), "athlete");
    assert.equal(canAccessCoachDashboard(null), false);
    assert.equal(canAccessCoachDashboard({}), false);
  });

  it("client spoofing cannot activate Coach Mode — spoofed roles resolve to athlete", () => {
    assert.equal(resolveRole({ role: "COACH" }), "coach"); // case insensitive is fine
    assert.equal(resolveRole({ role: " coach " }), "coach"); // trimming is fine
    assert.equal(resolveRole({ role: "coach_admin" }), "athlete"); // non-standard → athlete
    assert.equal(resolveRole({ role: "admin;coach" }), "athlete"); // injection → athlete
  });

  it("retry can resolve confirmed role after initial failure", () => {
    // First call fails (returns null/undefined)
    assert.equal(resolveRole(undefined), "athlete");
    // Second call succeeds
    assert.equal(resolveRole({ role: "coach" }), "coach");
  });

  it("ROLES contains exactly athlete, coach, admin", () => {
    assert.deepEqual(ROLES, ["athlete", "coach", "admin"]);
    assert.equal(DEFAULT_ROLE, "athlete");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ATTENTION CLASSIFIER
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — attention classifier integration", () => {
  const NOW = "2026-08-02T10:00:00Z";

  it("pain reported → needs_attention, high severity", () => {
    const result = classifyAttention({
      readiness: { painPresent: true, painDate: "2026-08-02" },
      hasAnyData: true
    }, { now: NOW });
    assert.equal(result.status, "needs_attention");
    assert.equal(result.severity, "high");
    assert.ok(result.reasons.some(r => r.key === "pain_reported"));
  });

  it("very low readiness → needs_attention, high severity", () => {
    const result = classifyAttention({
      readiness: { readinessScore: 25 },
      hasAnyData: true
    }, { now: NOW });
    assert.equal(result.status, "needs_attention");
    assert.equal(result.severity, "high");
    assert.ok(result.reasons.some(r => r.key === "very_low_readiness"));
  });

  it("low recovery → monitor, medium severity", () => {
    const result = classifyAttention({
      recoveryStatus: "poor",
      lastActivityAt: "2026-08-01T12:00:00Z",
      lastReadinessAt: "2026-08-01T12:00:00Z",
      hasAnyData: true
    }, { now: NOW });
    assert.equal(result.status, "monitor");
    assert.equal(result.severity, "medium");
  });

  it("missed session → monitor", () => {
    const result = classifyAttention({
      missedSessionCount: 3,
      lastActivityAt: "2026-08-01T12:00:00Z",
      lastReadinessAt: "2026-08-01T12:00:00Z",
      hasAnyData: true
    }, { now: NOW });
    assert.ok(result.reasons.some(r => r.key === "multiple_missed_sessions"));
  });

  it("no data → no_recent_data status", () => {
    const result = classifyAttention({ hasAnyData: false }, { now: NOW });
    assert.equal(result.status, "no_recent_data");
    assert.equal(result.severity, "low");
  });

  it("athlete on track → on_track", () => {
    const result = classifyAttention({
      lastActivityAt: "2026-08-01T12:00:00Z",
      lastReadinessAt: "2026-08-01T12:00:00Z",
      lastActiveAt: "2026-08-01T12:00:00Z",
      readiness: { readinessScore: 80 },
      recoveryStatus: "good",
      hasAnyData: true
    }, { now: NOW });
    assert.equal(result.status, "on_track");
  });

  it("sort order: needs_attention first", () => {
    const reasons = [
      { key: "low_recovery", severity: "medium" },
      { key: "pain_reported", severity: "high" },
      { key: "no_readiness_checkin", severity: "low" }
    ];
    reasons.sort((a, b) => ({"high":3,"medium":2,"low":1,"none":0}[b.severity]||0) - ({"high":3,"medium":2,"low":1,"none":0}[a.severity]||0));
    assert.equal(reasons[0].key, "pain_reported");
    assert.equal(reasons[1].key, "low_recovery");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ROSTER / SANITIZE
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — roster sanitization", () => {

  it("buildRosterEntry produces safe output", () => {
    const entry = buildRosterEntry({
      profile: { id: "uuid-1", full_name: "Test Athlete", primary_sport: "Running", goal: "5K", target_race: "City 5K" },
      metrics: { weekly_training_load: 42 },
      weeklySummary: { planned_duration_minutes: 120, completed_duration_minutes: 90, recovery_status: "good" },
      readiness: { readinessScore: 70 },
      todaySession: { title: "Easy Run", session_type: "easy", sport: "run" },
      latestActivity: { start_date: "2026-08-01T08:00:00Z", sport_type: "Run", distance_meters: 5000, moving_time_seconds: 1800 },
      providerAccount: { last_sync_at: "2026-08-01T09:00:00Z", last_sync_status: "success" },
      attention: { status: "on_track", severity: "none", reasons: [] },
      lastActiveAt: "2026-08-01T09:00:00Z"
    });
    assert.equal(entry.name, "Test Athlete");
    assert.equal(entry.initials, "TA");
    assert.equal(entry.primary_sport, "run");
    assert.equal(entry.goal, "5K");
    assert.equal(entry.attention_status, "on_track");
    assert.equal(entry.adherence_pct, 75);
    // Sensitive keys must NOT appear
    const bad = findSensitiveKeys(entry);
    assert.deepEqual(bad, []);
  });

  it("buildAthleteOverview includes recent activities safely", () => {
    const overview = buildAthleteOverview({
      profile: { id: "uuid-1", full_name: "Runner", primary_sport: "Running", goal: "Marathon" },
      readiness: { readinessScore: 65, pain_present: false },
      weeklySummary: { planned_duration_minutes: 300, completed_duration_minutes: 250 },
      recentActivities: [
        { start_date: "2026-08-01T08:00:00Z", sport_type: "Run", distance_meters: 10000, moving_time_seconds: 3600, raw_data: {} }
      ],
      todaySession: null,
      attention: { status: "on_track", severity: "none", reasons: [] }
    });
    assert.equal(overview.name, "Runner");
    assert.ok(Array.isArray(overview.recent_activities));
    assert.equal(overview.recent_activities.length, 1);
    const bad = findSensitiveKeys(overview);
    assert.deepEqual(bad, []);
  });

  it("no email or UUID in roster entry DOM-safe fields", () => {
    const entry = buildRosterEntry({
      profile: { id: "secret-uuid", full_name: "Test", primary_sport: "Running" },
      metrics: {},
      weeklySummary: {},
      readiness: {},
      attention: { status: "on_track", severity: "none", reasons: [] }
    });
    // athlete_id is necessary for UI but must not be sent to analytics
    const analyticsProps = rosterAnalyticsProps({ dashboardSurface: "coach_today", rosterSize: 5 });
    const bad = findSensitiveKeys(analyticsProps);
    assert.deepEqual(bad, []);
    assert.ok(!("athlete_id" in analyticsProps));
    assert.ok(!("email" in analyticsProps));
    assert.ok(!("name" in analyticsProps));
  });

  it("initials from name variations", () => {
    assert.equal(initialsFrom("Dean Castro"), "DC");
    assert.equal(initialsFrom("Dean"), "D");
    assert.equal(initialsFrom(""), "A");
    assert.equal(initialsFrom(null), "A");
  });

  it("readinessStatusLabel buckets correctly", () => {
    assert.equal(readinessStatusLabel(80), "Optimal");
    assert.equal(readinessStatusLabel(60), "Good");
    assert.equal(readinessStatusLabel(40), "Moderate");
    assert.equal(readinessStatusLabel(20), "Low");
    assert.equal(readinessStatusLabel(null), "No recent data");
  });

  it("rosterSizeBand returns correct bands", () => {
    assert.equal(rosterSizeBand(0), "0");
    assert.equal(rosterSizeBand(3), "1-5");
    assert.equal(rosterSizeBand(10), "6-15");
    assert.equal(rosterSizeBand(25), "16-40");
    assert.equal(rosterSizeBand(50), "40+");
  });

  it("deriveLastActiveAt picks latest timestamp", () => {
    const result = deriveLastActiveAt([
      "2026-08-01T10:00:00Z",
      "2026-08-02T08:00:00Z",
      null,
      "2026-07-30T12:00:00Z"
    ]);
    assert.ok(result.startsWith("2026-08-02"));
  });

  it("deriveLastActiveAt returns null when no signals", () => {
    assert.equal(deriveLastActiveAt([null, null]), null);
    assert.equal(deriveLastActiveAt([]), null);
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ASSIGNMENTS
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — assignments", () => {
  const assignments = [
    { coach_id: "coach-1", athlete_id: "ath-1", status: "active" },
    { coach_id: "coach-1", athlete_id: "ath-2", status: "active" },
    { coach_id: "coach-2", athlete_id: "ath-3", status: "active" }
  ];

  it("assignedAthleteIds returns only this coach's athletes", () => {
    const ids = assignedAthleteIds(assignments, "coach-1");
    assert.deepEqual(ids, ["ath-1", "ath-2"]);
  });

  it("canCoachAccessAthlete validates assignment", () => {
    assert.equal(canCoachAccessAthlete(assignments, "coach-1", "ath-1"), true);
    assert.equal(canCoachAccessAthlete(assignments, "coach-1", "ath-3"), false);
    assert.equal(canCoachAccessAthlete(assignments, "coach-2", "ath-1"), false);
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  PRIVACY / ANALYTICS
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — privacy and analytics", () => {

  it("SENSITIVE_KEYS prevents leaking tokens/emails in coach data", () => {
    const dangerous = {
      name: "Test",
      email: "test@example.com",
      access_token: "secret",
      athlete_id: "uuid"
    };
    const bad = findSensitiveKeys(dangerous);
    assert.ok(bad.includes("email"));
    assert.ok(bad.includes("access_token"));
  });

  it("attentionAnalyticsProps are categorical only", () => {
    const props = attentionAnalyticsProps({
      reasonKey: "pain_reported",
      severity: "high",
      sport: "run"
    });
    assert.deepEqual(Object.keys(props).sort(), ["athlete_sport", "attention_reason", "attention_severity"]);
    const bad = findSensitiveKeys(props);
    assert.deepEqual(bad, []);
  });

  it("rosterAnalyticsProps never contains PII", () => {
    const props = rosterAnalyticsProps({ dashboardSurface: "coach_today", rosterSize: 12 });
    assert.equal(props.dashboard_surface, "coach_today");
    assert.equal(props.roster_size_band, "6-15");
    assert.ok(!("name" in props));
    assert.ok(!("email" in props));
    assert.ok(!("athlete_id" in props));
  });

  it("ANALYTICS_FORBIDDEN_KEYS is a superset of SENSITIVE_KEYS", () => {
    for (const k of SENSITIVE_KEYS) {
      assert.ok(ANALYTICS_FORBIDDEN_KEYS.includes(k), `${k} should be in ANALYTICS_FORBIDDEN_KEYS`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  MULTISPORT CLASSIFICATION
 * ═══════════════════════════════════════════════════════════════════ */

import { classifyActivity, metricStyleForSport } from "../lib/server/sportClassification.js";

describe("Coach Mode — sport classification unchanged", () => {
  it("Run classification is unchanged", () => {
    assert.equal(classifyActivity({ providerActivityType: "Run" }).sport, "run");
    assert.equal(classifyActivity({ providerActivityType: "Running" }).sport, "run");
    assert.equal(metricStyleForSport("run"), "pace");
  });

  it("Ride classification is unchanged", () => {
    assert.equal(classifyActivity({ providerActivityType: "Ride" }).sport, "ride");
    assert.equal(classifyActivity({ providerActivityType: "Cycling" }).sport, "ride");
    assert.equal(metricStyleForSport("ride"), "speed");
  });

  it("Strength classification is unchanged", () => {
    assert.equal(classifyActivity({ providerActivityType: "WeightTraining" }).sport, "strength");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  VERCEL FUNCTION COUNT
 * ═══════════════════════════════════════════════════════════════════ */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

describe("Coach Mode — Vercel function count unchanged", () => {

  function loadVercelIgnore(root) {
    const p = join(root, ".vercelignore");
    try {
      return readFileSync(p, "utf8").split("\n").map(l => l.replace(/#.*$/, "").trim()).filter(Boolean);
    } catch (e) { return []; }
  }

  function findFunctions(dir, rel, ignored) {
    const results = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const dirPath = `api/${entryRel}`;
        if (ignored.some(ig => dirPath === ig || dirPath === ig.replace(/\/$/, "") || `${dirPath}/` === ig)) continue;
        results.push(...findFunctions(full, entryRel, ignored));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const filePath = `api/${entryRel}`;
        if (ignored.some(ig => filePath === ig)) continue;
        results.push(filePath);
      }
    }
    return results;
  }

  it("deployed function count is at most 12 (Vercel Hobby limit)", () => {
    const root = resolve(import.meta.dirname, "..");
    const ignored = loadVercelIgnore(root);
    const apiDir = join(root, "api");
    const fns = findFunctions(apiDir, "", ignored);
    assert.ok(fns.length <= 12, `Expected ≤12 deployed functions, found ${fns.length}: ${fns.join(", ")}`);
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  CLIENT MODULE STRUCTURE (static analysis)
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — client module structure", () => {
  const coachModeSource = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
  const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf-8");

  it("coachMode.js exposes AthlevoCoachMode on window", () => {
    assert.ok(coachModeSource.includes("window.AthlevoCoachMode"));
  });

  it("coachMode.js has init, go, getMode, isCoachMode", () => {
    assert.ok(coachModeSource.includes("init: init"));
    assert.ok(coachModeSource.includes("go: coachGo"));
    assert.ok(coachModeSource.includes("getMode:"));
    assert.ok(coachModeSource.includes("isCoachMode:"));
  });

  it("coachMode.js defines all five coach tab targets", () => {
    // Coach Today reuses screen-today; the other four are dynamic
    assert.ok(coachModeSource.includes('"screen-today"'),          "Today tab must target screen-today");
    assert.ok(coachModeSource.includes("screen-coach-messaging"));
    assert.ok(coachModeSource.includes("screen-coach-train"));
    assert.ok(coachModeSource.includes("screen-coach-trends"));
    assert.ok(coachModeSource.includes("screen-coach-you"));
  });

  it("coachMode.js tracks only categorical analytics events", () => {
    // Must track these events
    assert.ok(coachModeSource.includes("coach_mode_resolved"));
    assert.ok(coachModeSource.includes("coach_today_viewed"));
    assert.ok(coachModeSource.includes("coach_today_athlete_opened"));
    assert.ok(coachModeSource.includes("coach_tab_viewed"));
    assert.ok(coachModeSource.includes("coach_train_viewed"));
    assert.ok(coachModeSource.includes("coach_trends_viewed"));
    assert.ok(coachModeSource.includes("coach_you_viewed"));
    assert.ok(coachModeSource.includes("coach_attention_item_reviewed"));
  });

  it("coachMode.js never sends email/UUID/name to analytics", () => {
    // Analytics calls should use categorical props only
    const trackCalls = coachModeSource.match(/trackCoach\([^)]+\)/g) || [];
    for (const call of trackCalls) {
      assert.ok(!call.includes("email"), `track call should not contain email: ${call.slice(0,80)}`);
      assert.ok(!call.includes("athlete_id"), `track call should not contain athlete_id: ${call.slice(0,80)}`);
      assert.ok(!call.includes("_coachName"), `track call should not contain coach name: ${call.slice(0,80)}`);
    }
  });

  it("index.html includes coachMode.js script tag", () => {
    assert.ok(indexSource.includes('js/coachMode.js'));
  });

  it("index.html calls AthlevoCoachMode.init()", () => {
    assert.ok(indexSource.includes("AthlevoCoachMode.init"));
  });

  it("index.html skips athlete UI when Coach Workspace is active", () => {
    assert.ok(indexSource.includes("AthlevoCoachMode.isCoachWorkspace()"));
  });

  it("coachMode.js has three valid app modes", () => {
    assert.ok(coachModeSource.includes('"athlete_mode"'));
    assert.ok(coachModeSource.includes('"coach_mode"'));
    assert.ok(coachModeSource.includes('"unknown"'));
  });

  it("coachMode.js uses server-authoritative role check (coaching_dashboard_roster)", () => {
    assert.ok(coachModeSource.includes("coaching_dashboard_roster"));
    // Must NOT infer role from email
    assert.ok(!coachModeSource.match(/email.*role|role.*email/));
  });

  it("Coach messaging placeholder is clearly not AI coach", () => {
    assert.ok(coachModeSource.includes("Human coach messaging will appear here"));
  });

  it("Coach trends shows coming-next placeholder", () => {
    assert.ok(coachModeSource.includes("Detailed coach trends are coming next"));
  });

  it("Coach You tab includes logout", () => {
    assert.ok(coachModeSource.includes("cmLogout"));
    assert.ok(coachModeSource.includes("signOut"));
  });
});

describe("Coach Mode — coaching command center UI", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
  const dashboardSource = readFileSync(resolve(import.meta.dirname, "..", "js", "coachDashboard.js"), "utf-8");
  const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf-8");

  it("uses the approved command-center hierarchy with the roster last", () => {
    const renderStart = source.indexOf("function renderCoachToday");
    const renderEnd = source.indexOf("function renderCoachSkeleton", renderStart);
    const render = source.slice(renderStart, renderEnd);
    assert.ok(render.includes("Coach Dashboard"));
    assert.ok(render.indexOf("renderAttentionSection") < render.indexOf("renderTrainingTodaySection"));
    assert.ok(render.indexOf("renderTrainingTodaySection") < render.indexOf("renderRecentActivitySection"));
    assert.ok(render.indexOf("renderRecentActivitySection") < render.indexOf("renderRosterStatusSection"));
  });

  it("derives all summary metrics from the returned roster", () => {
    assert.ok(source.includes('sorted.filter(function (a) { return Boolean(a.today_planned); })'));
    assert.ok(source.includes('Boolean(a.target_event && a.target_date'));
    assert.ok(source.includes('{ label: "Athletes", value: total }'));
    assert.ok(source.includes('{ label: "Need attention", value: attn }'));
    assert.ok(source.includes('{ label: "Training today", value: training }'));
    assert.ok(source.includes('{ label: "Upcoming races", value: races }'));
  });

  it("renders a compact all-clear state instead of an empty attention panel", () => {
    assert.ok(source.includes('<div class="cm-quiet-state cm-quiet-state--clear">All clear.</div>'));
    assert.ok(source.includes(".cm-quiet-state{display:flex"));
    assert.ok(source.includes('<div class="cm-quiet-state">No sessions planned today.</div>'));
  });

  it("shows execution-backed statuses for today's sessions", () => {
    assert.ok(source.includes('var status = s.execution_status || "pending"'));
    assert.ok(source.includes('status === "skipped"'));
    assert.ok(source.includes('status === "modified"'));
  });

  it("recent activity is a who/what/when feed without sync events", () => {
    const start = source.indexOf("function renderRecentActivitySection");
    const end = source.indexOf("function renderRaceGoalsSection", start);
    const render = source.slice(start, end);
    assert.ok(render.includes("a.name"));
    assert.ok(render.includes("latestActivitySummary(a)"));
    assert.ok(render.includes("fmtDateTime(a.latest_activity.date)"));
    assert.ok(!/sync/i.test(render));
  });

  it("collapses repeated missing metrics into one truthful roster status", () => {
    const start = source.indexOf("function renderRosterList");
    const end = source.indexOf("function bindCoachTodayEvents", start);
    const render = source.slice(start, end);
    assert.ok(render.includes("rosterStatusLine(a)"));
    assert.ok(source.includes('return "No recent training data"'));
    assert.ok(!render.includes("Readiness:"));
    assert.ok(!render.includes("Recovery:"));
    assert.ok(!render.includes("Adh:"));
  });

  it("supports zero, small, and larger rosters inside the phone-width shell", () => {
    assert.ok(source.includes("No athletes assigned yet."));
    assert.ok(!source.includes("Invite Athlete"));
    assert.ok(source.includes("width:100%;max-width:430px"));
    assert.ok(source.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));
    assert.ok(source.includes('sorted.length <= 3 ? " cm-command--small-roster"'));
    assert.ok(source.includes(".cm-command--small-roster .cm-command-grid{gap:26px}"));
  });

  it("keeps every summary label complete at 375, 390, and 430px", () => {
    for (const label of ["Athletes", "Need attention", "Training today", "Upcoming races"]) {
      assert.ok(source.includes(`label: "${label}"`));
    }
    assert.ok(source.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));
    assert.ok(source.includes("white-space:normal;overflow:visible"));
    const metricRule = source.match(/\.cm-summary-metric span\{[^\"]+/)?.[0] || "";
    assert.ok(metricRule && !metricRule.includes("text-overflow"));
  });

  it("renders roster name, context, and status as separate wrapping lines", () => {
    assert.ok(source.includes(".cm-row-name,.cm-row-primary,.cm-row-meta{display:block;}"));
    assert.ok(source.includes(".cm-roster-item .cm-row-name{font-size:15px"));
    assert.ok(source.includes(".cm-roster-item .cm-row-primary{font-size:12px"));
    assert.ok(source.includes(".cm-roster-item .cm-row-meta{font-size:11px"));
    assert.ok((source.match(/overflow-wrap:anywhere/g) || []).length >= 3);
  });

  it("keeps mobile phone-first and expands only the coach workspace on desktop", () => {
    assert.ok(source.includes(".cm-command{width:100%;max-width:430px"));
    assert.ok(source.includes(".cm-command-pair{display:grid;grid-template-columns:minmax(0,1fr)"));
    assert.ok(source.includes("body.coach-workspace-active .device"));
    assert.ok(source.includes("max-width:980px"));
    assert.ok(source.includes('document.body.classList.remove("coach-workspace-active")'));
  });

  it("uses the shared shimmer for a dashboard-shaped loading hierarchy", () => {
    assert.ok(source.includes('class="skel cm-skel-line'));
    assert.ok(source.includes('class="skel cm-skel-number'));
    assert.ok(source.includes('class="skel cm-skel-stat-label'));
    assert.equal((source.match(/compactSection\(\)/g) || []).length, 2);
    assert.equal((source.match(/cm-skel-roster-row/g) || []).length >= 2, true);
    assert.ok(source.includes("cm-skel-avatar"));
    assert.ok(source.includes("cm-skel-name"));
    assert.ok(source.includes("cm-skel-context"));
    assert.ok(source.includes("cm-skel-status"));
    assert.ok(source.includes("cm-skel-search"));
    assert.ok(source.includes("@media(prefers-reduced-motion:reduce)"));
    assert.ok(!source.includes("Loading roster…"));
  });

  it("swaps the boot content only for an authenticated coach dashboard context", () => {
    const start = source.indexOf("function prepareDashboardLoading");
    const end = source.indexOf("async function init", start);
    const prepare = source.slice(start, end);
    assert.ok(prepare.includes('profile.role === "coach"'));
    assert.ok(prepare.includes('profile.role === "admin"'));
    assert.ok(prepare.includes('readWorkspacePref() === "athlete_workspace"'));
    assert.ok(prepare.includes('document.body.classList.contains("booting")'));
    assert.ok(prepare.includes('content.innerHTML = renderCoachSkeleton()'));
    assert.ok(indexSource.includes("AthlevoCoachMode.prepareDashboardLoading(profile)"));
    assert.ok(indexSource.indexOf("AthlevoCoachMode.prepareDashboardLoading(profile)") > indexSource.indexOf("if (!completed)"));
  });

  it("keeps the static athlete Today skeleton intact for athletes and anonymous visitors", () => {
    const boot = indexSource.slice(indexSource.indexOf('<div id="boot-gate"'), indexSource.indexOf('<div class="device">'));
    assert.ok(boot.includes("boot-score-radar"));
    assert.ok(boot.includes('class="boot-primary-card"'));
    assert.ok(boot.includes('class="boot-status-row"'));
    assert.ok(boot.includes('class="boot-week-row"'));
  });

  it("keeps the shared bottom navigation stable while coach content loads", () => {
    const boot = indexSource.slice(indexSource.indexOf('<div id="boot-gate"'), indexSource.indexOf('<div class="device">'));
    assert.ok(!boot.includes("boot-tabbar"));
    assert.equal((indexSource.match(/id="tabbar"/g) || []).length, 1);
    assert.ok(indexSource.includes("body.booting #tabbar{display:flex!important;z-index:9999;pointer-events:none}"));
    assert.ok(source.includes('content.innerHTML = renderCoachSkeleton()'));
    assert.ok(!source.includes('gate.innerHTML = renderCoachSkeleton()'));
  });

  it("rewrites and synchronizes coach navigation before showing the coach skeleton", () => {
    const start = source.indexOf("function prepareDashboardLoading");
    const end = source.indexOf("async function init", start);
    const prepare = source.slice(start, end);
    assert.ok(prepare.indexOf("rewriteNavigation()") < prepare.indexOf('document.body.classList.add("coach-loading")'));
    assert.ok(prepare.indexOf("syncIndicator(false)") < prepare.indexOf('content.innerHTML = renderCoachSkeleton()'));
    assert.ok(source.includes('btn.className = "tab" + (i === 0 ? " on" : "")'));
    assert.ok(source.includes('{ screen: "screen-today",            label: "Today"'));
  });

  it("does not retain a loading-only tabbar or coach visibility override", () => {
    assert.ok(!indexSource.includes('class="boot-tabbar"'));
    assert.ok(!source.includes("body.coach-loading #tabbar"));
  });

  it("does not flash a loading skeleton when returning to cached Coach Today", () => {
    const goStart = source.indexOf("function coachGo");
    const goEnd = source.indexOf("COACH TODAY", goStart);
    const go = source.slice(goStart, goEnd);
    assert.ok(go.includes('if (screenId === "screen-today") renderCoachToday()'));
    assert.ok(!go.includes("_rosterLoading = true"));
    const initStart = source.indexOf("async function init");
    const initEnd = source.indexOf("PUBLIC API", initStart);
    const init = source.slice(initStart, initEnd);
    assert.ok(init.indexOf("await resolveMode()") < init.indexOf("renderCoachToday()"));
  });

  it("refresh exposes the skeleton before the authorized roster request completes", () => {
    const start = source.indexOf("async function refreshRoster");
    const end = source.indexOf("INITIALIZATION", start);
    const refresh = source.slice(start, end);
    assert.ok(refresh.indexOf("_rosterLoading = true") < refresh.indexOf("renderCoachToday()"));
    assert.ok(refresh.indexOf("renderCoachToday()") < refresh.indexOf('api("roster")'));
  });

  it("every command-center row opens the dedicated athlete page", () => {
    assert.ok(source.includes('container.querySelectorAll("[data-open-athlete]")'));
    assert.ok(source.includes("openCoachAthletePage(id"));
    assert.ok(source.includes('var tabs = ["overview", "training", "analytics", "check-ins", "notes"]'));
    assert.ok(!source.includes("openCoachAthleteDrawer"));
    assert.ok(dashboardSource.includes("switchToCoachWorkspace"));
  });

  it("provides a real current-week programming workspace", () => {
    assert.ok(source.includes("function renderAthleteTraining"));
    assert.ok(source.includes("Add workout"));
    assert.ok(source.includes('method: session ? "PATCH" : "POST"'));
    assert.ok(source.includes('method: "DELETE"'));
    assert.ok(source.includes("window.confirm"));
  });

  it("keeps one athlete context across all five workspace tabs", () => {
    assert.ok(source.includes('var _athleteDetailId = null'));
    assert.ok(source.includes('var tabs = ["overview", "training", "analytics", "check-ins", "notes"]'));
    const switchStart = source.indexOf("function switchAthleteTab");
    const switchEnd = source.indexOf("function renderAthletePage", switchStart);
    const switchTab = source.slice(switchStart, switchEnd);
    assert.ok(switchTab.includes("_athleteDetailTab = tab"));
    assert.ok(switchTab.includes("athletePanelContent(_athleteDetail)"));
    assert.ok(!switchTab.includes('api("athlete"'));
    assert.ok(source.includes("if (_athleteDetailId)"));
    assert.ok(source.includes("_athleteDetailTab = \"overview\""));
  });

  it("keeps all five Athlete Detail tabs interactive independent of mutation permission", () => {
    const renderStart = source.indexOf("function renderAthletePage()");
    const renderEnd = source.indexOf("function metric", renderStart);
    const render = source.slice(renderStart, renderEnd);
    const switchStart = source.indexOf("function switchAthleteTab");
    const switchEnd = source.indexOf("function renderAthletePage", switchStart);
    const switchTab = source.slice(switchStart, switchEnd);
    assert.ok(render.includes('var tabs = ["overview", "training", "analytics", "check-ins", "notes"]'));
    assert.ok(render.includes('<button type="button" class="cm-athlete-tab'));
    assert.ok(render.includes('btn.addEventListener("click"'));
    assert.ok(!render.includes("disabled"));
    assert.ok(!switchTab.includes("assignment_permission"));
    assert.ok(!switchTab.includes("read_write"));
    assert.ok(switchTab.includes("athletePanelContent(_athleteDetail)"));
  });

  it("isolates readiness from Coach Workspace so its inert backdrop cannot intercept detail tabs", () => {
    const activateStart = source.indexOf("function activateCoachWorkspace");
    const activateEnd = source.indexOf("function activateAthleteWorkspace", activateStart);
    const activate = source.slice(activateStart, activateEnd);
    const initStart = source.indexOf("async function init()");
    const initEnd = source.indexOf("PUBLIC API", initStart);
    const init = source.slice(initStart, initEnd);
    assert.ok(source.includes("function suppressAthleteReadiness"));
    assert.ok(source.includes("window.closeReadinessCheck()"));
    assert.ok(activate.indexOf("suppressAthleteReadiness()") < activate.indexOf('if (_workspace === "coach_workspace") return'));
    assert.ok(init.indexOf('writeWorkspacePref("coach_workspace")') < init.indexOf("suppressAthleteReadiness()"));
  });

  it("renders the approved five-second Overview hierarchy from real fields", () => {
    for (const label of ["Current direction", "Current status", "This week", "Latest activity", "Needs attention", "Upcoming race"]) {
      assert.ok(source.includes(label), `missing ${label}`);
    }
    assert.ok(source.includes("function renderWeekSnapshot"));
    assert.ok(source.includes('statusCount("completed") + statusCount("modified")'));
    assert.ok(source.includes('wk.completed_distance_km != null'));
    assert.ok(source.includes('wk.completed_minutes != null'));
    assert.ok(source.includes('"Execution updates will appear here"'));
    assert.ok(source.includes("No immediate issues."));
    assert.ok(source.includes("function renderUpcomingRace"));
    assert.ok(source.includes("ath.target_event || ath.target_date ? renderUpcomingRace(ath) : ''"));
  });

  it("uses compact status rows instead of a generic 2x2 metric-card grid", () => {
    const overviewStart = source.indexOf("function renderAthleteOverview");
    const overviewEnd = source.indexOf("function workoutMeta", overviewStart);
    const overview = source.slice(overviewStart, overviewEnd);
    assert.ok(overview.includes('statusRow("Readiness"'));
    assert.ok(overview.includes('statusRow("Recovery"'));
    assert.ok(overview.includes('statusRow("Training load"'));
    assert.ok(overview.includes('statusRow("Adherence"'));
    assert.ok(overview.includes("No recent data"));
    assert.ok(overview.includes("Building baseline"));
    assert.ok(overview.includes("Not enough history"));
    assert.ok(source.includes(".cm-status-row{display:grid"));
    assert.ok(!source.includes(".cm-overview-status,.cm-analytics-grid"));
    assert.ok(!overview.includes("cm-detail-grid"));
  });

  it("prioritizes genuine attention above Latest Activity but keeps all-clear quiet", () => {
    const overviewStart = source.indexOf("function renderAthleteOverview");
    const overviewEnd = source.indexOf("function workoutMeta", overviewStart);
    const overview = source.slice(overviewStart, overviewEnd);
    assert.ok(overview.includes("reasons ? attention + latestSection : latestSection + attention"));
    assert.ok(overview.includes("No immediate issues."));
    assert.ok(overview.includes("cm-attention-section"));
    assert.ok(overview.includes("Mark reviewed"));
  });

  it("keeps Latest Activity and Upcoming Race compact and omits unavailable metrics", () => {
    const latestStart = source.indexOf("function renderLatestActivity");
    const latestEnd = source.indexOf("function renderUpcomingRace", latestStart);
    const latest = source.slice(latestStart, latestEnd);
    const raceStart = source.indexOf("function renderUpcomingRace");
    const raceEnd = source.indexOf("function workoutMeta", raceStart);
    const race = source.slice(raceStart, raceEnd);
    assert.ok(latest.includes("a.distance_km != null"));
    assert.ok(latest.includes("a.duration_min != null"));
    assert.ok(latest.includes("a.pace_sec_per_km"));
    assert.ok(latest.includes("a.avg_power_watts != null"));
    assert.ok(latest.includes("Completed"));
    assert.ok(race.includes("if (ath.target_date)"));
    assert.ok(race.includes("days >= 0"));
    assert.ok(!race.includes("21.1"));
  });

  it("renders a seven-day execution-backed training week and truthful no-plan state", () => {
    assert.ok(source.includes("for (var i = 0; i < 7; i += 1)"));
    assert.ok(source.includes('sessionStatusLabel(session.execution_status)'));
    for (const status of ["Completed", "Pending", "Modified", "Skipped", "Planned", "Upcoming", "Rest"]) {
      assert.ok(source.includes(status), `missing ${status}`);
    }
    assert.ok(source.includes('class="cm-day-row cm-day-rest'));
    assert.ok(source.includes("key === ath.today_key"));
    assert.ok(source.includes("No active training plan."));
    assert.ok(source.includes("ath.has_active_plan"));
    assert.ok(source.includes('aria-label="Previous week"'));
    assert.ok(source.includes('aria-label="Next week"'));
    assert.ok(source.includes('plannedDistance ? Math.round(plannedDistance * 10) / 10 + " km planned"'));
    assert.ok(source.includes('plannedMinutes ? plannedMinutes + " min planned"'));
    assert.ok(source.includes("+ Add workout"));
    const panelStart = source.indexOf("function athletePanelContent");
    const panelEnd = source.indexOf("function positionAthleteTabIndicator", panelStart);
    assert.ok(!source.slice(panelStart, panelEnd).includes("Coming soon"));
  });

  it("keeps mutation controls permission-aware and uses coaching language", () => {
    assert.ok(source.includes('var canWrite = ath.assignment_permission === "read_write"'));
    assert.ok(source.includes("View-only assignment."));
    assert.ok(source.includes("Adjust session"));
    assert.ok(source.includes("Move session to"));
    assert.ok(source.includes("Remove from plan"));
    assert.ok(source.includes("can_reschedule"));
    assert.ok(source.includes("can_remove"));
    const trainingStart = source.indexOf("function renderAthleteTraining");
    const trainingEnd = source.indexOf("function renderAthleteAnalytics", trainingStart);
    const training = source.slice(trainingStart, trainingEnd);
    assert.ok(training.includes("!canWrite ? '<div class=\"cm-readonly-note\""));
    assert.ok(training.includes("canWrite ? '<button type=\"button\" class=\"cm-add-workout\""));
  });

  it("scopes Analytics, Check-ins, and Notes without athlete selectors", () => {
    const detailStart = source.indexOf("function athletePanelContent");
    const detailEnd = source.indexOf("function positionAthleteTabIndicator", detailStart);
    const detail = source.slice(detailStart, detailEnd);
    assert.ok(detail.includes("renderAthleteAnalytics(ath)"));
    assert.ok(detail.includes("No check-ins available yet."));
    assert.ok(detail.includes("Coach notes will appear here."));
    assert.ok(!detail.includes("Choose athlete"));
    assert.ok(source.includes("Not enough training history yet."));
    assert.ok(source.includes("More comparable sessions are needed before performance trend is reliable."));
  });

  it("uses a dedicated athlete skeleton and immediate cache return", () => {
    assert.ok(source.includes('class="cm-athlete-page cm-athlete-skeleton"'));
    assert.ok(source.includes("cm-athlete-skel-tabs"));
    assert.ok(source.includes("cm-athlete-skel-section"));
    assert.ok(source.includes("cm-athlete-skel-rows"));
    assert.ok(source.includes("cm-athlete-skel-row"));
    const openStart = source.indexOf("async function openCoachAthletePage");
    const openEnd = source.indexOf("function renderAthletePageLoading", openStart);
    const open = source.slice(openStart, openEnd);
    assert.ok(open.indexOf("if (cached)") < open.indexOf("renderAthletePageLoading()"));
    assert.ok(open.includes("_athleteDetailCache[cacheKey]"));
  });

  it("uses one moving athlete-tab indicator and composition-level motion", () => {
    assert.ok(source.includes("cm-athlete-tab-indicator"));
    assert.ok(source.includes("positionAthleteTabIndicator"));
    assert.ok(source.includes('panel.classList.add("is-leaving")'));
    assert.ok(source.includes("cm-athlete-panel.is-entering"));
    assert.ok(source.includes('(prefers-reduced-motion: reduce)'));
    assert.ok(source.includes("@media(prefers-reduced-motion:reduce)"));
    assert.ok(!source.includes("cm-athlete-stagger"));
  });

  it("keeps Athlete Detail mobile-first at 375, 390, and 430px without page overflow", () => {
    assert.ok(source.includes(".cm-athlete-page{width:100%;max-width:920px"));
    assert.ok(source.includes("box-sizing:border-box"));
    assert.ok(source.includes(".cm-athlete-tabs{display:flex"));
    assert.ok(source.includes("overflow-x:auto"));
    assert.ok(source.includes("@media(max-width:380px)"));
    assert.ok(source.includes(".cm-athlete-page{padding-inline:14px}"));
    assert.ok(source.includes("@media(min-width:760px)"));
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ANALYTICS REGISTRY
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — analytics registry has new events", () => {
  const registrySource = readFileSync(resolve(import.meta.dirname, "..", "js", "analyticsRegistry.js"), "utf-8");

  const requiredEvents = [
    "coach_mode_resolved",
    "coach_today_viewed",
    "coach_today_attention_opened",
    "coach_today_athlete_opened",
    "coach_tab_viewed",
    "coach_train_viewed",
    "coach_trends_viewed",
    "coach_you_viewed"
  ];

  for (const event of requiredEvents) {
    it(`registry includes ${event}`, () => {
      assert.ok(registrySource.includes(event), `Missing event: ${event}`);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════
 *  LAYOUT / MOUNTING (static source analysis)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  These tests verify the coach-mode mounting fix by inspecting the
 *  source code.  Coach Today reuses the existing #screen-today element
 *  (same position in the .device flex layout as athlete Today).  The
 *  other four coach tabs get dynamically created sections inserted
 *  before #tabbar inside .device.
 */

describe("Coach Mode — layout / mounting", () => {
  const coachModeSource = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
  const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf-8");

  /* ─── Coach Today inside #screen-today ─── */

  it("Coach Today renders inside #screen-today, not a separate screen-coach-today", () => {
    // renderCoachToday must target the existing screen-today element
    assert.ok(
      coachModeSource.includes('getElementById("screen-today")'),
      "renderCoachToday must target #screen-today"
    );
    // COACH_SCREENS array must NOT include screen-coach-today — extract just the array
    const screenArrayMatch = coachModeSource.match(/COACH_SCREENS\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(screenArrayMatch, "COACH_SCREENS array must exist");
    assert.ok(
      !screenArrayMatch[1].includes("screen-coach-today"),
      "COACH_SCREENS array must not include screen-coach-today"
    );
  });

  it("Coach Today tab navigates to screen-today, not screen-coach-today", () => {
    // COACH_TABS first entry must target screen-today
    assert.ok(
      coachModeSource.match(/COACH_TABS\s*=\s*\[[\s\S]*?"screen-today"/),
      "COACH_TABS Today entry must target screen-today"
    );
  });

  it("Coach Today is not a direct child of document.body", () => {
    // No coach screen section is appended to document.body
    const lines = coachModeSource.split("\n");
    const bodyAppends = lines.filter(l =>
      l.includes("document.body.appendChild") || l.includes("document.body.append(")
    );
    for (const line of bodyAppends) {
      assert.ok(
        line.includes("overlay") || line.includes("drawer"),
        `Unexpected document.body.appendChild: ${line.trim().slice(0, 100)}`
      );
    }
  });

  it("Coach Today and Coach You share the same screen parent (.device)", () => {
    // Both use screens that are children of .device:
    // - Coach Today reuses #screen-today (static child of .device)
    // - Coach You is dynamically inserted into .device via ensureCoachScreens
    // Verify ensureCoachScreens targets .device
    assert.ok(
      coachModeSource.includes('document.querySelector(".device")'),
      "ensureCoachScreens must target .device"
    );
    // Verify #screen-today exists inside .device in index.html
    const deviceStart = indexSource.indexOf('class="device"');
    const deviceEnd = indexSource.indexOf("</div>", indexSource.indexOf("</nav>", indexSource.indexOf('id="tabbar"')));
    const deviceContent = indexSource.slice(deviceStart, deviceEnd);
    assert.ok(
      deviceContent.includes('id="screen-today"'),
      "#screen-today must be inside .device"
    );
  });

  it("Only one Coach Today root exists — no duplicate screen-coach-today", () => {
    // ensureCoachScreens must clean up any orphaned screen-coach-today
    assert.ok(
      coachModeSource.includes('getElementById("screen-coach-today")') &&
        coachModeSource.includes("orphan") &&
        coachModeSource.includes(".remove()"),
      "ensureCoachScreens must remove orphaned screen-coach-today elements"
    );
    // COACH_SCREENS must NOT create a screen-coach-today
    const screenList = coachModeSource.match(/COACH_SCREENS\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(screenList, "COACH_SCREENS array must exist");
    assert.ok(
      !screenList[1].includes("screen-coach-today"),
      "COACH_SCREENS must not include screen-coach-today"
    );
  });

  it("Only one active screen after selecting Today (coachGo deactivates all)", () => {
    assert.ok(
      coachModeSource.includes('querySelectorAll(".screen").forEach'),
      "coachGo must deactivate all screens"
    );
    assert.ok(
      coachModeSource.includes('s.classList.remove("active")'),
      "coachGo must remove .active from every screen"
    );
    assert.ok(
      coachModeSource.includes('screenEl.classList.add("active")'),
      "coachGo must activate exactly one screen"
    );
  });

  it("No Coach Today text appears outside the app shell in static HTML", () => {
    const deviceOpen = indexSource.indexOf('class="device"');
    const tabbarClose = indexSource.indexOf("</nav>", indexSource.indexOf('id="tabbar"'));
    const deviceClose = indexSource.indexOf("</div>", tabbarClose);
    const afterDevice = indexSource.slice(deviceClose);
    const coachScreenIds = [
      "screen-coach-today", "screen-coach-messaging",
      "screen-coach-train", "screen-coach-trends", "screen-coach-you"
    ];
    for (const id of coachScreenIds) {
      assert.ok(
        !afterDevice.includes(`id="${id}"`),
        `${id} must not appear after the .device container in static HTML`
      );
    }
  });

  it("Athlete Today markup is saved before coach render for restore", () => {
    assert.ok(
      coachModeSource.includes("_athleteTodayHTML"),
      "coachMode.js must track athlete Today HTML for restore"
    );
    assert.ok(
      coachModeSource.includes("_athleteTodayHTML = el.innerHTML"),
      "renderCoachToday must save athlete innerHTML before overwriting"
    );
  });

  it("restoreAthleteToday restores saved athlete markup", () => {
    assert.ok(
      coachModeSource.includes("function restoreAthleteToday"),
      "restoreAthleteToday function must exist"
    );
    assert.ok(
      coachModeSource.includes("el.innerHTML = _athleteTodayHTML"),
      "restoreAthleteToday must write back the saved HTML"
    );
    assert.ok(
      coachModeSource.includes("_athleteTodayHTML = null"),
      "restoreAthleteToday must clear the saved HTML after restore"
    );
  });

  it("Repeated init does not create duplicates (idempotent guard)", () => {
    assert.ok(
      coachModeSource.includes("if (_initialized) return"),
      "init must guard against double initialization"
    );
    // ensureCoachScreens also guards
    assert.ok(
      coachModeSource.includes('getElementById("screen-coach-you")) return'),
      "ensureCoachScreens must guard against creating duplicate screens"
    );
  });

  it("Athlete Today save is idempotent (only saves once)", () => {
    assert.ok(
      coachModeSource.includes("if (_athleteTodayHTML === null)"),
      "renderCoachToday must only save athlete HTML on first call"
    );
  });

  /* ─── General layout assertions ─── */

  it("Athlete screens remain unchanged — standard screen IDs exist in .device", () => {
    const athleteScreens = ["screen-today", "screen-train", "screen-trends", "screen-you", "screen-coachai"];
    for (const id of athleteScreens) {
      assert.ok(
        indexSource.includes(`id="${id}"`),
        `Athlete screen ${id} must still exist in index.html`
      );
    }
  });

  it("Only one .device shell exists in index.html", () => {
    const deviceMatches = indexSource.match(/class="device"/g) || [];
    assert.equal(deviceMatches.length, 1, "There must be exactly one .device shell");
  });

  it("Only one #tabbar exists in index.html", () => {
    const tabbarMatches = indexSource.match(/id="tabbar"/g) || [];
    assert.equal(tabbarMatches.length, 1, "There must be exactly one #tabbar");
  });

  it("Athlete go() also deactivates all screens (including coach)", () => {
    assert.ok(
      indexSource.includes(".querySelectorAll('.screen').forEach(s=>s.classList.remove('active'))"),
      "athlete go() must deactivate all screens including coach screens"
    );
  });

  it("Dynamic coach screens use insertBefore(tabbar)", () => {
    assert.ok(
      coachModeSource.includes("host.insertBefore(el, tabbar)"),
      "Dynamic coach screens must be inserted before the tabbar"
    );
  });

  it("No horizontal overflow — coach wrap uses max-width + auto margins", () => {
    assert.ok(
      coachModeSource.includes("max-width:720px;margin:0 auto"),
      "Coach content wraps should be constrained to prevent overflow"
    );
  });

  it("Coach screens scroll internally, not via window.scrollTo", () => {
    assert.ok(
      coachModeSource.includes("screenEl.scrollTop = 0"),
      "coachGo should scroll the screen element"
    );
    assert.ok(
      !coachModeSource.includes("window.scrollTo"),
      "coachMode.js must not use window.scrollTo"
    );
  });

  it("rewriteNavigation replaces tab content, does not create a second nav", () => {
    assert.ok(
      coachModeSource.includes('tabbar.innerHTML = ""'),
      "rewriteNavigation must clear existing tabbar contents"
    );
    assert.ok(
      !coachModeSource.includes('createElement("nav")'),
      "coachMode.js must not create a second navigation element"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  JAVASCRIPT SYNTAX CHECK
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Mode — syntax validation", () => {
  it("coachMode.js parses without syntax errors", () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
    // Using Function constructor to check for syntax errors
    assert.doesNotThrow(() => new Function(source));
  });
});

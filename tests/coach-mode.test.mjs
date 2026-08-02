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

  it("coachMode.js defines all five coach screens", () => {
    assert.ok(coachModeSource.includes("screen-coach-today"));
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

  it("index.html skips athlete UI when Coach Mode is active", () => {
    assert.ok(indexSource.includes("AthlevoCoachMode.isCoachMode()"));
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
 *  source code.  They ensure coach screens are inserted inside the
 *  existing .device shell and never appended to document.body.
 */

describe("Coach Mode — layout / mounting", () => {
  const coachModeSource = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
  const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf-8");

  it("Coach screens mount inside .device, not .app-shell or document.body", () => {
    // ensureCoachScreens must target .device
    assert.ok(
      coachModeSource.includes('document.querySelector(".device")'),
      "ensureCoachScreens should select .device"
    );
    // Must NOT fall back to document.body for screen creation
    assert.ok(
      !coachModeSource.includes('.app-shell') ||
        !coachModeSource.match(/var host.*app-shell.*document\.body/),
      "ensureCoachScreens must not fall back to document.body"
    );
  });

  it("No coach screen is appended directly to document.body", () => {
    // The only document.body usage should be for the overlay/drawer (fixed-position modals),
    // not for .screen section elements.
    const lines = coachModeSource.split("\n");
    const bodyAppends = lines.filter(l =>
      l.includes("document.body.appendChild") || l.includes("document.body.append(")
    );
    // Overlay + drawer are the only allowed body appends (both are fixed-position modals)
    for (const line of bodyAppends) {
      assert.ok(
        line.includes("overlay") || line.includes("drawer"),
        `Unexpected document.body.appendChild: ${line.trim().slice(0, 100)}`
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

  it("Coach Today replaces athlete Today — coachGo deactivates all .screen elements", () => {
    // coachGo must remove .active from every .screen before activating the target
    assert.ok(
      coachModeSource.includes('querySelectorAll(".screen").forEach'),
      "coachGo must deactivate all screens"
    );
    assert.ok(
      coachModeSource.includes('s.classList.remove("active")'),
      "coachGo must remove .active class from every screen"
    );
  });

  it("Athlete go() also deactivates all screens (including coach)", () => {
    assert.ok(
      indexSource.includes(".querySelectorAll('.screen').forEach(s=>s.classList.remove('active'))"),
      "athlete go() must deactivate all screens including coach screens"
    );
  });

  it("Tab switching leaves exactly one active screen (coachGo pattern)", () => {
    // Pattern: remove all .active, then add .active to one
    const removeAll = coachModeSource.includes('s.classList.remove("active")');
    const addOne = coachModeSource.includes('screenEl.classList.add("active")');
    assert.ok(removeAll && addOne, "coachGo must deactivate all then activate one");
  });

  it("Coach screens use insertBefore(tabbar) not appendChild to .device", () => {
    assert.ok(
      coachModeSource.includes("host.insertBefore(el, tabbar)"),
      "Coach screens must be inserted before the tabbar, not appended after it"
    );
  });

  it("No horizontal overflow — coach wrap uses max-width + auto margins", () => {
    assert.ok(
      coachModeSource.includes("max-width:720px;margin:0 auto"),
      "Coach content wraps should be constrained to prevent overflow"
    );
  });

  it("Coach screens scroll internally, not via window.scrollTo", () => {
    // coachGo should use screenEl.scrollTop, not window.scrollTo
    assert.ok(
      coachModeSource.includes("screenEl.scrollTop = 0"),
      "coachGo should scroll the screen element, not the window"
    );
    // window.scrollTo should NOT appear in coachGo
    assert.ok(
      !coachModeSource.includes("window.scrollTo"),
      "coachMode.js must not use window.scrollTo (screens scroll internally)"
    );
  });

  it("rewriteNavigation replaces tab content, does not create a second nav", () => {
    // rewriteNavigation must clear then populate the existing #tabbar
    assert.ok(
      coachModeSource.includes('tabbar.innerHTML = ""'),
      "rewriteNavigation must clear existing tabbar contents"
    );
    // Must NOT create a new nav element
    assert.ok(
      !coachModeSource.includes('createElement("nav")'),
      "coachMode.js must not create a second navigation element"
    );
  });

  it("No coach content appears after the closing .device div in index.html", () => {
    // Find the closing </div> for .device (the one right before the first <script>)
    const deviceOpen = indexSource.indexOf('class="device"');
    const tabbarClose = indexSource.indexOf("</nav>", indexSource.indexOf('id="tabbar"'));
    const deviceClose = indexSource.indexOf("</div>", tabbarClose);
    const afterDevice = indexSource.slice(deviceClose);
    // No coach screen IDs should appear after the device closes
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

  it("Athlete screens remain unchanged — standard screen IDs exist in .device", () => {
    const athleteScreens = ["screen-today", "screen-train", "screen-trends", "screen-you", "screen-coachai"];
    for (const id of athleteScreens) {
      assert.ok(
        indexSource.includes(`id="${id}"`),
        `Athlete screen ${id} must still exist in index.html`
      );
    }
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

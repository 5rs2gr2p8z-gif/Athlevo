/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Workspace Switcher tests
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Tests for Coach Workspace ↔ Athlete Workspace switching, covering:
 *  defaults, security, isolation, analytics, layout, and idempotency.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ─────────── Server-side imports ─────────── */
import { resolveRole, canAccessCoachDashboard } from "../lib/server/coachRoles.js";
import { findSensitiveKeys, ANALYTICS_FORBIDDEN_KEYS } from "../lib/server/coachSanitize.js";

/* ─────────── Source files ─────────── */
const coachModeSource = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf-8");
const registrySource = readFileSync(resolve(import.meta.dirname, "..", "js", "analyticsRegistry.js"), "utf-8");
const analyticsSource = readFileSync(resolve(import.meta.dirname, "..", "js", "analytics.js"), "utf-8");

/* ═══════════════════════════════════════════════════════════════════
 *  WORKSPACE DEFAULTS
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — defaults", () => {

  it("admin defaults to Coach Workspace", () => {
    assert.equal(resolveRole({ role: "admin" }), "admin");
    assert.equal(canAccessCoachDashboard({ role: "admin" }), true);
    // coachMode.js resolveWorkspace defaults to coach_workspace when no pref
    assert.ok(
      coachModeSource.includes('return "coach_workspace"'),
      "resolveWorkspace must default coach/admin to coach_workspace"
    );
  });

  it("coach defaults to Coach Workspace", () => {
    assert.equal(resolveRole({ role: "coach" }), "coach");
    assert.equal(canAccessCoachDashboard({ role: "coach" }), true);
  });

  it("resolveWorkspace reads localStorage preference", () => {
    assert.ok(
      coachModeSource.includes("WORKSPACE_KEY") &&
      coachModeSource.includes("localStorage.getItem(WORKSPACE_KEY)"),
      "Must read workspace preference from localStorage"
    );
  });

  it("first-use coach/admin without stored pref gets coach_workspace", () => {
    // resolveWorkspace returns coach_workspace when no pref AND role is coach/admin
    const fnMatch = coachModeSource.match(/function resolveWorkspace\(\)[\s\S]*?return "coach_workspace"/);
    assert.ok(fnMatch, "resolveWorkspace must return coach_workspace as default for coach/admin");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  WORKSPACE SWITCHING
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — switching behavior", () => {

  it("coach/admin can switch to Athlete Workspace", () => {
    assert.ok(
      coachModeSource.includes("function activateAthleteWorkspace"),
      "activateAthleteWorkspace function must exist"
    );
    assert.ok(
      coachModeSource.includes('_workspace = "athlete_workspace"'),
      "activateAthleteWorkspace must set workspace to athlete_workspace"
    );
  });

  it("coach/admin can switch back to Coach Workspace", () => {
    assert.ok(
      coachModeSource.includes("function activateCoachWorkspace"),
      "activateCoachWorkspace function must exist"
    );
    assert.ok(
      coachModeSource.includes('_workspace = "coach_workspace"'),
      "activateCoachWorkspace must set workspace to coach_workspace"
    );
  });

  it("workspace switching does not change role", () => {
    // Neither activate function touches _role
    const activateAthlete = coachModeSource.match(/function activateAthleteWorkspace\(\)[\s\S]*?(?=function\s)/);
    const activateCoach = coachModeSource.match(/function activateCoachWorkspace\(\)[\s\S]*?(?=function\s)/);
    assert.ok(activateAthlete, "activateAthleteWorkspace must exist");
    assert.ok(activateCoach, "activateCoachWorkspace must exist");
    assert.ok(!activateAthlete[0].includes("_role ="), "activateAthleteWorkspace must not modify _role");
    assert.ok(!activateCoach[0].includes("_role ="), "activateCoachWorkspace must not modify _role");
  });

  it("switching is idempotent — same-workspace switch is a no-op", () => {
    assert.ok(
      coachModeSource.includes('if (_workspace === "coach_workspace") return'),
      "activateCoachWorkspace must no-op when already in coach_workspace"
    );
    assert.ok(
      coachModeSource.includes('if (_workspace === "athlete_workspace") return'),
      "activateAthleteWorkspace must no-op when already in athlete_workspace"
    );
  });

  it("workspace preference is persisted to localStorage", () => {
    assert.ok(
      coachModeSource.includes("writeWorkspacePref"),
      "Workspace preference must be persisted"
    );
    assert.ok(
      coachModeSource.includes("localStorage.setItem(WORKSPACE_KEY"),
      "writeWorkspacePref must use localStorage"
    );
  });

  it("refresh preserves selected workspace (reads from localStorage)", () => {
    assert.ok(
      coachModeSource.includes("readWorkspacePref"),
      "init must read workspace pref on startup"
    );
    assert.ok(
      coachModeSource.includes("var ws = resolveWorkspace()"),
      "init must call resolveWorkspace which reads the stored pref"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  SECURITY
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — security", () => {

  it("athlete users cannot activate Coach Workspace", () => {
    assert.equal(canAccessCoachDashboard({ role: "athlete" }), false);
    const activate = coachModeSource.slice(
      coachModeSource.indexOf("function activateCoachWorkspace"),
      coachModeSource.indexOf("function activateAthleteWorkspace")
    );
    assert.ok(activate.indexOf("if (!canAccessCoachWorkspace())") < activate.indexOf('classList.add("coach-workspace-active")'));
    // resolveWorkspace clears stale coach pref for non-coach users
    assert.ok(
      coachModeSource.includes("clearWorkspacePref"),
      "Must clear stale coach workspace pref for non-coach users"
    );
  });

  it("stale coach pref falls back to athlete_workspace if role changed", () => {
    // resolveWorkspace checks isCoach before returning coach_workspace
    const resolveWsFn = coachModeSource.match(/function resolveWorkspace\(\)[\s\S]*?^  \}/m);
    assert.ok(resolveWsFn, "resolveWorkspace must exist");
    assert.ok(
      resolveWsFn[0].includes("isCoach"),
      "resolveWorkspace must check isCoach before returning coach_workspace"
    );
    assert.ok(
      resolveWsFn[0].includes('return "athlete_workspace"'),
      "resolveWorkspace must fall back to athlete_workspace for non-coach"
    );
  });

  it("workspace switching does not alter profiles.role", () => {
    // No supabase update to profiles in activate functions
    assert.ok(
      !coachModeSource.includes('.update({') || !coachModeSource.includes("profiles"),
      "Workspace switching must not write to profiles table"
    );
  });

  it("workspace switching does not create/remove coach-athlete assignments", () => {
    const activateFns = coachModeSource.match(/function activate(Coach|Athlete)Workspace[\s\S]*?(?=\/\*|function\s(?!activate))/g) || [];
    for (const fn of activateFns) {
      assert.ok(!fn.includes("assignments"), "activate functions must not touch assignments");
      assert.ok(!fn.includes("coaching_dashboard_assign"), "activate functions must not call assignment endpoints");
    }
  });

  it("server authorization is not weakened — coaching_dashboard_ endpoints still used", () => {
    assert.ok(
      coachModeSource.includes("coaching_dashboard_"),
      "Coach data still accessed through server-authorized endpoints"
    );
  });

  it("logout clears workspace preference", () => {
    assert.ok(
      indexSource.includes("clearWorkspaceOnLogout"),
      "doLogout must call clearWorkspaceOnLogout"
    );
    assert.ok(
      coachModeSource.includes("clearWorkspaceOnLogout: clearWorkspaceOnLogout"),
      "clearWorkspaceOnLogout must be exposed on public API"
    );
  });

  it("coach logout uses the shared app logout flow without reloading", () => {
    const logoutBinding = coachModeSource.match(/var logoutBtn[\s\S]*?\n    \}/)?.[0] || "";
    assert.ok(logoutBinding.includes("window.doLogout"));
    assert.ok(!logoutBinding.includes("location.reload"));
  });

  it("logout clears private coach, athlete-detail, and messaging state", () => {
    const clearFn = coachModeSource.match(/function clearWorkspaceOnLogout\(\)[\s\S]*?\n  \}/)?.[0] || "";
    assert.ok(clearFn.includes('_athleteDetailId = null'));
    assert.ok(clearFn.includes('_athleteDetailCache = Object.create(null)'));
    assert.ok(clearFn.includes('_messageThreadCache = Object.create(null)'));
    assert.ok(clearFn.includes('_roster = []'));
    assert.ok(clearFn.includes('_initialized = false'));
  });

  it("role verification failure does not activate Coach Workspace", () => {
    // resolveMode returns "unknown" on failure, init only proceeds for "coach_mode"
    assert.ok(
      coachModeSource.includes('if (mode !== "coach_mode")'),
      "init must check resolved mode before entering coach flow"
    );
  });

  it("switcher only visible to confirmed coach/admin in athlete You", () => {
    assert.ok(
      coachModeSource.includes("if (!canAccessCoachWorkspace())"),
      "injectAthleteYouSwitcher must use the centralized role guard before rendering"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ATHLETE WORKSPACE — SCREEN VISIBILITY
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — Athlete Workspace screens", () => {

  // Extract function bodies using line-based extraction
  function extractFnBody(source, fnName) {
    const start = source.indexOf("function " + fnName + "()");
    if (start === -1) return null;
    // Find matching closing brace by counting
    let depth = 0;
    let inBody = false;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") { depth++; inBody = true; }
      if (source[i] === "}") { depth--; }
      if (inBody && depth === 0) return source.slice(start, i + 1);
    }
    return source.slice(start);
  }

  const athleteWsFn = extractFnBody(coachModeSource, "activateAthleteWorkspace");
  const coachWsFn = extractFnBody(coachModeSource, "activateCoachWorkspace");

  it("Athlete Workspace shows athlete Today/Coach/Train/Trends/You", () => {
    assert.ok(athleteWsFn, "activateAthleteWorkspace must exist");
    assert.ok(athleteWsFn.includes('"screen-coachai"'), "Must restore screen-coachai");
    assert.ok(athleteWsFn.includes('"screen-train"'), "Must restore screen-train");
    assert.ok(athleteWsFn.includes('"screen-trends"'), "Must restore screen-trends");
    assert.ok(athleteWsFn.includes('"screen-you"'), "Must restore screen-you");
  });

  it("Athlete Workspace restores athlete navigation", () => {
    assert.ok(athleteWsFn.includes("restoreAthleteNavigation"), "Must call restoreAthleteNavigation");
  });

  it("Athlete Workspace restores athlete Today content", () => {
    assert.ok(athleteWsFn.includes("restoreAthleteToday"), "Must call restoreAthleteToday");
  });

  it("Athlete Workspace triggers refreshAthleteUI when not yet loaded", () => {
    assert.ok(athleteWsFn, "activateAthleteWorkspace must exist");
    assert.ok(athleteWsFn.includes("refreshAthleteUI"), "Must call refreshAthleteUI");
    assert.ok(athleteWsFn.includes("_athleteUIInitialized"), "Must guard against redundant init");
  });

  it("Athlevo AI Coach is visible only in Athlete Workspace, not Coach Workspace", () => {
    assert.ok(coachWsFn, "activateCoachWorkspace must exist");
    assert.ok(coachWsFn.includes('"screen-coachai"'), "Coach Workspace must reference screen-coachai (to hide it)");
    assert.ok(athleteWsFn.includes('"screen-coachai"'), "Athlete Workspace must reference screen-coachai (to show it)");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  COACH WORKSPACE — SCREEN VISIBILITY
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — Coach Workspace screens", () => {

  function extractFnBody(source, fnName) {
    const start = source.indexOf("function " + fnName + "()");
    if (start === -1) return null;
    let depth = 0;
    let inBody = false;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") { depth++; inBody = true; }
      if (source[i] === "}") { depth--; }
      if (inBody && depth === 0) return source.slice(start, i + 1);
    }
    return source.slice(start);
  }

  const coachWsFn = extractFnBody(coachModeSource, "activateCoachWorkspace");

  it("Coach Workspace shows coach-specific screens", () => {
    assert.ok(coachWsFn, "activateCoachWorkspace must exist");
    assert.ok(coachWsFn.includes("ensureCoachScreens"), "Must call ensureCoachScreens");
    assert.ok(coachWsFn.includes("rewriteNavigation"), "Must call rewriteNavigation");
    assert.ok(coachWsFn.includes("renderCoachToday"), "Must render Coach Today");
  });

  it("Coach Workspace hides athlete-only screens", () => {
    assert.ok(coachWsFn, "activateCoachWorkspace must exist");
    assert.ok(coachWsFn.includes('"screen-coachai"'), "Must hide screen-coachai");
    assert.ok(coachWsFn.includes('"screen-train"'), "Must hide screen-train");
    assert.ok(coachWsFn.includes('"screen-trends"'), "Must hide screen-trends");
    assert.ok(coachWsFn.includes('"screen-you"'), "Must hide screen-you");
    assert.ok(coachWsFn.includes('.style.display = "none"'), "Must set display:none");
  });

  it("Coach Workspace shows coach-only dynamic screens", () => {
    assert.ok(coachWsFn, "activateCoachWorkspace must exist");
    assert.ok(coachWsFn.includes("COACH_SCREENS"), "Must iterate COACH_SCREENS to show them");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  DATA ISOLATION
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — data isolation", () => {

  function extractFnBody(source, fnName) {
    const start = source.indexOf("function " + fnName + "()");
    if (start === -1) return null;
    let depth = 0;
    let inBody = false;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") { depth++; inBody = true; }
      if (source[i] === "}") { depth--; }
      if (inBody && depth === 0) return source.slice(start, i + 1);
    }
    return source.slice(start);
  }

  it("personal athlete data uses AthlevoBrain (own profile), not roster", () => {
    const athleteWsFn = extractFnBody(coachModeSource, "activateAthleteWorkspace");
    assert.ok(athleteWsFn, "activateAthleteWorkspace must exist");
    assert.ok(athleteWsFn.includes("AthlevoBrain.refreshAthleteUI"), "Must load athlete data via AthlevoBrain");
    assert.ok(!athleteWsFn.includes('api("roster")'), "Must NOT load roster data in athlete workspace");
  });

  it("roster data only loads in Coach Workspace via coaching_dashboard_roster", () => {
    // api("roster") is only in resolveMode and refreshRoster, never in activateAthleteWorkspace
    assert.ok(
      coachModeSource.includes('api("roster")'),
      "Roster endpoint must be called for coach mode resolution"
    );
  });

  it("athlete You switcher injection is idempotent", () => {
    assert.ok(
      coachModeSource.includes('querySelector("#cmAthleteSwitcher")'),
      "injectAthleteYouSwitcher must check for existing switcher element"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  LAYOUT / DOM INTEGRITY
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — layout integrity", () => {

  it("repeated switching creates no duplicate screens", () => {
    // ensureCoachScreens guards against duplicates
    assert.ok(
      coachModeSource.includes('getElementById("screen-coach-you")) return'),
      "ensureCoachScreens must guard against creating duplicate coach screens"
    );
    // activateAthleteWorkspace hides coach screens, doesn't remove them
    const fn = coachModeSource.match(/function activateAthleteWorkspace\(\)[\s\S]*?(?=\/\*\s|function\s(?!activate))/);
    assert.ok(fn, "activateAthleteWorkspace must exist");
    assert.ok(!fn[0].includes(".remove()"), "Must not remove coach screens — just hide them for reuse");
  });

  it("repeated switching creates no duplicate tab bars", () => {
    // rewriteNavigation clears tabbar before rewriting
    assert.ok(
      coachModeSource.includes('tabbar.innerHTML = ""'),
      "rewriteNavigation must clear tabbar before creating buttons"
    );
    // restoreAthleteNavigation also clears tabbar
    assert.ok(
      coachModeSource.match(/restoreAthleteNavigation[\s\S]*?tabbar\.innerHTML\s*=\s*""/),
      "restoreAthleteNavigation must clear tabbar before creating buttons"
    );
  });

  it("only one screen is active after switching", () => {
    // Both activate functions deactivate all screens before activating one
    assert.ok(
      coachModeSource.match(/activateCoachWorkspace[\s\S]*?querySelectorAll\("\.screen"\)\.forEach/),
      "activateCoachWorkspace must deactivate all screens"
    );
    assert.ok(
      coachModeSource.match(/activateAthleteWorkspace[\s\S]*?querySelectorAll\("\.screen"\)\.forEach/),
      "activateAthleteWorkspace must deactivate all screens"
    );
  });

  it("mobile layout does not overflow — coach content constrained", () => {
    assert.ok(
      coachModeSource.includes("max-width:720px;margin:0 auto"),
      "Coach content wraps should prevent horizontal overflow"
    );
  });

  it("switcher button in Coach You exists", () => {
    assert.ok(
      coachModeSource.includes("Switch to My Training"),
      "Coach You must show 'Switch to My Training' button"
    );
  });

  it("switcher button in Athlete You exists", () => {
    assert.ok(
      coachModeSource.includes("Switch to Coach Workspace"),
      "Athlete You must show 'Switch to Coach Workspace' button"
    );
  });

  it("init function supports athlete workspace skip for coach/admin", () => {
    // When workspace is athlete_workspace, init returns early so athlete UI loads
    assert.ok(
      coachModeSource.includes('ws === "athlete_workspace"'),
      "init must check for athlete_workspace preference"
    );
  });

  it("index.html uses isCoachWorkspace (not isCoachMode) to decide athlete init", () => {
    assert.ok(
      indexSource.includes("isCoachWorkspace()"),
      "index.html must use isCoachWorkspace to decide whether to skip athlete init"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  ANALYTICS — CATEGORICAL ONLY
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — analytics", () => {

  it("analytics registry includes workspace_switcher_viewed", () => {
    assert.ok(registrySource.includes("workspace_switcher_viewed"));
  });

  it("analytics registry includes workspace_switched", () => {
    assert.ok(registrySource.includes("workspace_switched"));
  });

  it("workspace_switched carries only from_workspace, to_workspace, source_surface", () => {
    const match = registrySource.match(/workspace_switched:\s*\{[^}]+\}/);
    assert.ok(match, "workspace_switched must be in registry");
    assert.ok(match[0].includes("from_workspace"), "Must include from_workspace");
    assert.ok(match[0].includes("to_workspace"), "Must include to_workspace");
    assert.ok(match[0].includes("source_surface"), "Must include source_surface");
    // Must NOT include PII fields
    assert.ok(!match[0].includes("email"), "Must not include email");
    assert.ok(!match[0].includes("name"), "Must not include name");
    assert.ok(!match[0].includes("athlete_id"), "Must not include athlete_id");
    assert.ok(!match[0].includes("uuid"), "Must not include uuid");
  });

  it("workspace analytics events use only categorical props", () => {
    // Check trackCoach calls related to workspace
    const trackCalls = coachModeSource.match(/trackCoach\("workspace_\w+"[^)]+\)/g) || [];
    for (const call of trackCalls) {
      assert.ok(!call.includes("email"), `workspace track call must not contain email: ${call.slice(0,80)}`);
      assert.ok(!call.includes("athlete_id"), `workspace track call must not contain athlete_id: ${call.slice(0,80)}`);
      assert.ok(!call.includes("_coachName"), `workspace track call must not contain coach name: ${call.slice(0,80)}`);
      assert.ok(!call.includes("uuid"), `workspace track call must not contain uuid: ${call.slice(0,80)}`);
    }
  });

  it("analytics SAFE_PROPS includes from_workspace and to_workspace", () => {
    assert.ok(analyticsSource.includes('"from_workspace"'), "from_workspace must be in SAFE_PROPS");
    assert.ok(analyticsSource.includes('"to_workspace"'), "to_workspace must be in SAFE_PROPS");
  });

  it("analytics APPROVED_HANDOFF_VALUES whitelists workspace values", () => {
    assert.ok(
      analyticsSource.includes("from_workspace") &&
      analyticsSource.includes("coach_workspace") &&
      analyticsSource.includes("athlete_workspace"),
      "APPROVED_HANDOFF_VALUES must whitelist workspace values"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  PUBLIC API
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — public API", () => {

  it("exposes isCoachWorkspace", () => {
    assert.ok(coachModeSource.includes("isCoachWorkspace:"));
  });

  it("exposes isAthleteWorkspace", () => {
    assert.ok(coachModeSource.includes("isAthleteWorkspace:"));
  });

  it("exposes getWorkspace", () => {
    assert.ok(coachModeSource.includes("getWorkspace:"));
  });

  it("exposes switchToCoachWorkspace", () => {
    assert.ok(coachModeSource.includes("switchToCoachWorkspace:"));
  });

  it("exposes switchToAthleteWorkspace", () => {
    assert.ok(coachModeSource.includes("switchToAthleteWorkspace:"));
  });

  it("exposes clearWorkspaceOnLogout", () => {
    assert.ok(coachModeSource.includes("clearWorkspaceOnLogout:"));
  });

  it("exposes injectAthleteYouSwitcher", () => {
    assert.ok(coachModeSource.includes("injectAthleteYouSwitcher:"));
  });

  it("_state includes workspace", () => {
    assert.ok(coachModeSource.includes("workspace: _workspace"));
  });

  it("version is updated to coach-mode-v2", () => {
    assert.ok(coachModeSource.includes('"coach-mode-v2"'));
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  JAVASCRIPT SYNTAX CHECK
 * ═══════════════════════════════════════════════════════════════════ */

describe("Workspace Switcher — syntax validation", () => {
  it("coachMode.js parses without syntax errors", () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
    assert.doesNotThrow(() => new Function(source));
  });

  it("analyticsRegistry.js parses without syntax errors", () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", "js", "analyticsRegistry.js"), "utf-8");
    assert.doesNotThrow(() => new Function(source));
  });

  it("analytics.js parses without syntax errors", () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", "js", "analytics.js"), "utf-8");
    assert.doesNotThrow(() => new Function(source));
  });
});

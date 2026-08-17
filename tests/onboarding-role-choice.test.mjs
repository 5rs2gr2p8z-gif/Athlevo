/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Onboarding Role Choice & Coach Application tests
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Tests for role-aware onboarding: role-choice screen, coach application
 *  flow, security boundaries, analytics, RLS policy structure, and
 *  authorization invariants.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ─────────── Server-side imports ─────────── */
import { resolveRole, canAccessCoachDashboard } from "../lib/server/coachRoles.js";

/* ─────────── Source files ─────────── */
const onboardingSource = readFileSync(resolve(import.meta.dirname, "..", "js", "onboarding.js"), "utf-8");
const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.html"), "utf-8");
const registrySource = readFileSync(resolve(import.meta.dirname, "..", "js", "analyticsRegistry.js"), "utf-8");
const coachModeSource = readFileSync(resolve(import.meta.dirname, "..", "js", "coachMode.js"), "utf-8");
const migrationSource = readFileSync(resolve(import.meta.dirname, "..", "migrations", "2026-08-04_coach_applications.sql"), "utf-8");

/* ═══════════════════════════════════════════════════════════════════
 *  1. ROLE-CHOICE SCREEN
 * ═══════════════════════════════════════════════════════════════════ */

describe("Role-choice screen", () => {

  it("renders two role cards: athlete and coach", () => {
    assert.ok(
      onboardingSource.includes("obRoleAthlete") &&
      onboardingSource.includes("obRoleCoach"),
      "Must render both athlete and coach role cards"
    );
  });

  it("keeps the athlete-or-coach question explicit", () => {
    assert.ok(
      onboardingSource.includes("Are you an athlete or a coach?"),
      "Role-choice title must be present"
    );
  });

  it("marks the public Coach option as intentionally unavailable", () => {
    assert.ok(onboardingSource.includes("const COACH_PUBLIC_ACCESS_ENABLED = false"));
    assert.ok(onboardingSource.includes("Coming soon"));
    assert.ok(onboardingSource.includes('aria-disabled="${coachLocked ? "true" : "false"}"'));
  });

  it("stores intent in sessionStorage (not localStorage)", () => {
    assert.ok(
      onboardingSource.includes('sessionStorage.setItem(OB_ROLE_KEY'),
      "Intent must be stored in sessionStorage"
    );
    assert.ok(
      !onboardingSource.includes('localStorage.setItem(OB_ROLE_KEY'),
      "Intent must NOT be stored in localStorage"
    );
  });

  it("uses 'athlevo_onboarding_intent' as the sessionStorage key", () => {
    assert.ok(
      onboardingSource.includes('"athlevo_onboarding_intent"'),
      "OB_ROLE_KEY must be 'athlevo_onboarding_intent'"
    );
  });

  it("hides progress bar and footer during role choice", () => {
    assert.ok(
      onboardingSource.includes('progress.style.display = "none"'),
      "Progress bar must be hidden during role choice"
    );
  });

  it("fires onboarding_role_choice_viewed analytics on render", () => {
    assert.ok(
      onboardingSource.includes('"onboarding_role_choice_viewed"'),
      "Must fire onboarding_role_choice_viewed event"
    );
  });

  it("fires onboarding_role_selected with selected_role on card click", () => {
    assert.ok(
      onboardingSource.includes('"onboarding_role_selected"'),
      "Must fire onboarding_role_selected event"
    );
    assert.ok(
      onboardingSource.includes('selected_role: "athlete"') &&
      onboardingSource.includes('selected_role: "coach"'),
      "Must include selected_role property for both athlete and coach"
    );
  });

  it("athlete card calls obStartAthleteFlow", () => {
    assert.ok(
      onboardingSource.includes("obStartAthleteFlow()"),
      "Athlete card must call obStartAthleteFlow"
    );
  });

  it("public Coach taps stop before intent or application flow", () => {
    const start = onboardingSource.indexOf('body.querySelector("#obRoleCoach")');
    const end = onboardingSource.indexOf("/* ─── Restore progress", start);
    const handler = onboardingSource.slice(start, end);
    const gate = handler.indexOf("if (!obCoachPublicAccessEnabled())");
    const stop = handler.indexOf("return;", gate);
    assert.ok(gate >= 0 && stop > gate);
    assert.ok(handler.indexOf('obWriteIntent("coach")') > stop);
    assert.ok(handler.indexOf("obStartCoachFlow()") > stop);
    assert.ok(handler.includes("Coach tools are coming soon."));
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  2. COACH ONBOARDING STEPS
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach onboarding steps", () => {

  it("defines COACH_OB_STEPS with 3 steps", () => {
    const match = onboardingSource.match(/const COACH_OB_STEPS\s*=\s*\[/);
    assert.ok(match, "COACH_OB_STEPS array must be defined");

    // Count step keys
    const keys = onboardingSource.match(/key:\s*"coach_/g);
    assert.ok(keys && keys.length === 3, "Must have exactly 3 coach steps");
  });

  it("coach step 1 collects name", () => {
    assert.ok(
      onboardingSource.includes('"coachName"'),
      "Must collect coachName field"
    );
  });

  it("coach step 2 collects brand (optional), sports, experience", () => {
    assert.ok(
      onboardingSource.includes('"coachBrand"') &&
      onboardingSource.includes('"coachSports"') &&
      onboardingSource.includes('"coachExperience"'),
      "Step 2 must collect brand, sports, and experience"
    );
    // Brand is optional
    const brandSection = onboardingSource.match(/id:\s*"coachBrand"[\s\S]{0,200}/);
    assert.ok(
      brandSection && brandSection[0].includes("optional"),
      "coachBrand must be optional"
    );
  });

  it("coach step 3 collects athlete count and coaching setup", () => {
    assert.ok(
      onboardingSource.includes('"coachAthleteCount"') &&
      onboardingSource.includes('"coachSetup"'),
      "Step 3 must collect athlete count and coaching setup"
    );
  });

  it("fires coach_application_started analytics on flow entry", () => {
    assert.ok(
      onboardingSource.includes('"coach_application_started"'),
      "Must fire coach_application_started event"
    );
  });

  it("fires coach_application_submitted analytics after submission", () => {
    assert.ok(
      onboardingSource.includes('"coach_application_submitted"'),
      "Must fire coach_application_submitted event"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  3. SECURITY: CLIENT CANNOT SET ROLE
 * ═══════════════════════════════════════════════════════════════════ */

describe("Security — role never set by client", () => {

  it("onboarding.js never writes profiles.role", () => {
    // The obBuildUpdates function must never include role
    const buildUpdates = onboardingSource.match(/function obBuildUpdates\(\)[\s\S]*?return updates;/);
    assert.ok(buildUpdates, "obBuildUpdates must exist");
    assert.ok(
      !buildUpdates[0].includes("updates.role"),
      "obBuildUpdates must never set updates.role"
    );

    // The coach application submission must never update profiles.role
    const submitFn = onboardingSource.match(/async function obSubmitCoachApplication\(\)[\s\S]*?obRenderCoachPending\(\)/);
    assert.ok(submitFn, "obSubmitCoachApplication must exist");
    assert.ok(
      !submitFn[0].includes("role:") &&
      !submitFn[0].includes(".role =") &&
      !submitFn[0].includes("role ="),
      "obSubmitCoachApplication must never set role"
    );
  });

  it("coach application row forces status = 'pending'", () => {
    assert.ok(
      onboardingSource.includes('status: "pending"'),
      "Application row must force status to 'pending'"
    );
  });

  it("coach application row uses user_id from auth session (user.id)", () => {
    const submitFn = onboardingSource.match(/async function obSubmitCoachApplication\(\)[\s\S]*?obRenderCoachPending\(\)/);
    assert.ok(submitFn, "obSubmitCoachApplication must exist");
    assert.ok(
      submitFn[0].includes("user_id: user.id"),
      "user_id must come from authenticated user session, not from payload"
    );
  });

  it("client cannot submit status = approved", () => {
    // The migration's RLS INSERT policy forces status = 'pending'
    assert.ok(
      migrationSource.includes("AND status = 'pending'"),
      "RLS INSERT policy must enforce status = 'pending'"
    );
    // The client code also forces 'pending'
    const appRow = onboardingSource.match(/applicationRow\s*=\s*\{[\s\S]*?\}/);
    assert.ok(appRow, "applicationRow construction must exist");
    assert.ok(
      appRow[0].includes('status: "pending"'),
      "Client must explicitly set status to pending"
    );
  });

  it("client cannot provide another user_id", () => {
    // RLS INSERT policy requires auth.uid() = user_id
    assert.ok(
      migrationSource.includes("auth.uid() = user_id"),
      "RLS must enforce auth.uid() = user_id"
    );
  });

  it("client cannot update reviewed_by or reviewed_at", () => {
    // RLS INSERT policy requires reviewed_at IS NULL AND reviewed_by IS NULL
    assert.ok(
      migrationSource.includes("reviewed_at IS NULL") &&
      migrationSource.includes("reviewed_by IS NULL"),
      "RLS must enforce reviewed_at and reviewed_by are null"
    );
    // UPDATE policy also enforces this — extract the full update policy block
    const updateStart = migrationSource.indexOf("CREATE POLICY coach_applications_update_own");
    assert.ok(updateStart !== -1, "Update policy must exist");
    const updateBlock = migrationSource.slice(updateStart, updateStart + 600);
    assert.ok(
      updateBlock.includes("WITH CHECK") &&
      updateBlock.includes("reviewed_at IS NULL") &&
      updateBlock.includes("reviewed_by IS NULL"),
      "Update WITH CHECK must enforce reviewed_at/reviewed_by are null"
    );
  });

  it("resolveRole collapses unknown roles to athlete", () => {
    assert.equal(resolveRole({ role: "pending" }), "athlete");
    assert.equal(resolveRole({ role: "coach_applicant" }), "athlete");
    assert.equal(resolveRole({ role: null }), "athlete");
    assert.equal(resolveRole({ role: undefined }), "athlete");
    assert.equal(resolveRole({}), "athlete");
  });

  it("canAccessCoachDashboard denies athlete and unknown roles", () => {
    assert.equal(canAccessCoachDashboard({ role: "athlete" }), false);
    assert.equal(canAccessCoachDashboard({ role: "pending" }), false);
    assert.equal(canAccessCoachDashboard({ role: null }), false);
    assert.equal(canAccessCoachDashboard({}), false);
  });

  it("canAccessCoachDashboard allows only coach and admin", () => {
    assert.equal(canAccessCoachDashboard({ role: "coach" }), true);
    assert.equal(canAccessCoachDashboard({ role: "admin" }), true);
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  4. DUPLICATE SUBMISSION PREVENTION
 * ═══════════════════════════════════════════════════════════════════ */

describe("Duplicate submission prevention", () => {

  it("migration creates unique partial index on pending applications", () => {
    assert.ok(
      migrationSource.includes("CREATE UNIQUE INDEX") &&
      migrationSource.includes("idx_coach_applications_pending") &&
      migrationSource.includes("WHERE status = 'pending'"),
      "Must have unique partial index for pending applications per user"
    );
  });

  it("client uses upsert for idempotent submission", () => {
    assert.ok(
      onboardingSource.includes(".upsert(applicationRow"),
      "Must use upsert for idempotent submission"
    );
  });

  it("client handles duplicate key error as fallback", () => {
    assert.ok(
      onboardingSource.includes("obIsDuplicateError(error)"),
      "Must handle duplicate key errors gracefully"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  5. WORKSPACE ACCESS CANNOT BE UNLOCKED BY CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach Workspace access — authorization boundary", () => {

  it("Coach Workspace is gated by server-authoritative resolveMode", () => {
    assert.ok(
      coachModeSource.includes('api("roster")') ||
      coachModeSource.includes("api('roster')"),
      "Coach Mode must call the roster API endpoint"
    );
  });

  it("resolveMode maps 403 to athlete_mode", () => {
    assert.ok(
      coachModeSource.includes("athlete_mode"),
      "resolveMode must return athlete_mode on 403"
    );
  });

  it("pending application + localStorage manipulation cannot unlock Coach Workspace", () => {
    // The workspace switcher is gated by server-resolved mode + role, not by
    // localStorage alone.
    assert.ok(
      coachModeSource.includes("function canAccessCoachWorkspace()") &&
      coachModeSource.includes("roleCanUseCoachWorkspace(_role)"),
      "Workspace activation must check server-resolved _role"
    );
    // injectAthleteYouSwitcher uses the same centralized guard.
    assert.ok(
      coachModeSource.includes("if (!canAccessCoachWorkspace())"),
      "Switcher injection must guard on role"
    );
  });

  it("direct URL/hash navigation cannot unlock Coach Workspace", () => {
    // Coach workspace activation is behind resolveMode, not URL-based
    assert.ok(
      coachModeSource.includes("resolveMode"),
      "Coach workspace must be behind resolveMode check"
    );
    // No hash-based activation
    assert.ok(
      !coachModeSource.includes("location.hash") ||
      !coachModeSource.match(/if\s*\(.*location\.hash.*coach/),
      "Must not activate coach workspace based on URL hash"
    );
  });

  it("role query failure fails safely to Athlete Workspace", () => {
    const resolveModeFn = coachModeSource.match(/function resolveMode\(\)[\s\S]*?catch/);
    assert.ok(resolveModeFn, "resolveMode must have error handling");
    assert.ok(
      coachModeSource.includes("athlete_mode"),
      "Must have athlete_mode fallback"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  6. ANALYTICS EVENTS
 * ═══════════════════════════════════════════════════════════════════ */

describe("Analytics registry — onboarding role events", () => {

  it("registers onboarding_role_choice_viewed", () => {
    assert.ok(
      registrySource.includes("onboarding_role_choice_viewed"),
      "Must register onboarding_role_choice_viewed event"
    );
  });

  it("registers onboarding_role_selected with selected_role prop", () => {
    assert.ok(
      registrySource.includes("onboarding_role_selected"),
      "Must register onboarding_role_selected event"
    );
    assert.ok(
      registrySource.includes('"selected_role"'),
      "onboarding_role_selected must have selected_role prop"
    );
  });

  it("registers coach_application_started", () => {
    assert.ok(
      registrySource.includes("coach_application_started"),
      "Must register coach_application_started event"
    );
  });

  it("registers coach_application_submitted with application_status prop", () => {
    assert.ok(
      registrySource.includes("coach_application_submitted"),
      "Must register coach_application_submitted event"
    );
    assert.ok(
      registrySource.includes('"application_status"'),
      "coach_application_submitted must have application_status prop"
    );
  });

  it("selected_role whitelist includes only athlete and coach", () => {
    assert.ok(
      registrySource.includes("selected_role: { athlete: true, coach: true }"),
      "selected_role whitelist must be {athlete, coach}"
    );
  });

  it("application_status whitelist includes only pending", () => {
    assert.ok(
      registrySource.includes("application_status: { pending: true }"),
      "application_status whitelist must be {pending}"
    );
  });

  it("analytics helper uses categorical-only allowlist", () => {
    assert.ok(
      onboardingSource.includes("OB_ALLOWED_ANALYTICS_KEYS"),
      "Must use categorical allowlist for analytics"
    );
    // No free-text keys
    assert.ok(
      !onboardingSource.match(/OB_ALLOWED_ANALYTICS_KEYS\s*=\s*\{[^}]*coaching_brand/),
      "Must not allow coaching_brand in analytics"
    );
    assert.ok(
      !onboardingSource.match(/OB_ALLOWED_ANALYTICS_KEYS\s*=\s*\{[^}]*coaching_sports/),
      "Must not allow coaching_sports in analytics"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  7. INDEX.HTML ROUTING
 * ═══════════════════════════════════════════════════════════════════ */

describe("index.html routing updates", () => {

  it("routeAfterAuth selects role from profiles", () => {
    assert.ok(
      indexSource.includes('"onboarding_complete, goal, device, role"'),
      "routeAfterAuth must select role from profiles"
    );
  });

  it("coach/admin bypass routes through onboarding (for auto-complete)", () => {
    assert.ok(
      indexSource.includes('profile.role === "coach"') ||
      indexSource.includes("profile.role === 'coach'"),
      "Must check for coach role in routing"
    );
    assert.ok(
      indexSource.includes('profile.role === "admin"') ||
      indexSource.includes("profile.role === 'admin'"),
      "Must check for admin role in routing"
    );
  });

  it("logout clears athlevo_onboarding_intent from sessionStorage", () => {
    assert.ok(
      indexSource.includes("sessionStorage.removeItem('athlevo_onboarding_intent')"),
      "Logout must clear onboarding intent from sessionStorage"
    );
  });

  it("logout calls AthlevoOnboarding.clearIntent if available", () => {
    assert.ok(
      indexSource.includes("AthlevoOnboarding.clearIntent"),
      "Logout must call clearIntent on the onboarding module"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  8. COACH FLOW NAVIGATION
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach flow navigation", () => {

  it("back from coach step 0 returns to role choice", () => {
    assert.ok(
      onboardingSource.includes("obRenderRoleChoice()") &&
      onboardingSource.match(/coachObStepIndex\s*===\s*0[\s\S]{0,200}obRenderRoleChoice/),
      "Coach back from step 0 must return to role choice"
    );
  });

  it("back from athlete step 0 returns to role choice", () => {
    assert.ok(
      onboardingSource.match(/obStepIndex\s*===\s*0[\s\S]{0,200}obRenderRoleChoice/),
      "Athlete back from step 0 must return to role choice"
    );
  });

  it("dispatchers route based on _obCurrentFlow flag", () => {
    assert.ok(
      onboardingSource.includes("_obCurrentFlow") &&
      onboardingSource.includes('_obCurrentFlow === "coach"'),
      "Dispatchers must check _obCurrentFlow"
    );
  });

  it("wiring uses dispatchers instead of direct handlers", () => {
    assert.ok(
      onboardingSource.includes("obContinueDispatch") &&
      onboardingSource.includes("obBackDispatch"),
      "Wiring must use dispatcher functions"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  9. PENDING SCREEN
 * ═══════════════════════════════════════════════════════════════════ */

describe("Pending approval screen", () => {

  it("renders pending screen after submission", () => {
    assert.ok(
      onboardingSource.includes("obRenderCoachPending"),
      "Must render pending screen after submission"
    );
  });

  it("pending screen shows 'Application submitted'", () => {
    assert.ok(
      onboardingSource.includes("Application submitted"),
      "Pending screen must show 'Application submitted'"
    );
  });

  it("pending screen has 'Continue to My Training' button", () => {
    assert.ok(
      onboardingSource.includes("Continue to My Training"),
      "Pending screen must have 'Continue to My Training'"
    );
  });

  it("'Continue to My Training' clears intent and shows athlete workspace", () => {
    assert.ok(
      onboardingSource.includes("obClearIntent()") &&
      onboardingSource.includes('showScreen("screen-today")'),
      "Continue button must clear intent and show today screen"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  10. MIGRATION STRUCTURE
 * ═══════════════════════════════════════════════════════════════════ */

describe("Migration — coach_applications table", () => {

  it("creates coach_applications table", () => {
    assert.ok(
      migrationSource.includes("CREATE TABLE IF NOT EXISTS coach_applications"),
      "Must create coach_applications table"
    );
  });

  it("has status CHECK constraint limited to pending/approved/rejected", () => {
    assert.ok(
      migrationSource.includes("CHECK (status IN ('pending', 'approved', 'rejected'))"),
      "Status must be constrained to pending/approved/rejected"
    );
  });

  it("has experience_band CHECK constraint", () => {
    assert.ok(
      migrationSource.includes("'new', 'under_2', '2_5', '5_plus'"),
      "experience_band must have valid CHECK values"
    );
  });

  it("has athlete_count_band CHECK constraint", () => {
    assert.ok(
      migrationSource.includes("'0', '1_5', '6_15', '16_30', '31_plus'"),
      "athlete_count_band must have valid CHECK values"
    );
  });

  it("has coaching_setup CHECK constraint", () => {
    assert.ok(
      migrationSource.includes("'online', 'in_person', 'hybrid'"),
      "coaching_setup must have valid CHECK values"
    );
  });

  it("enables RLS", () => {
    assert.ok(
      migrationSource.includes("ALTER TABLE coach_applications ENABLE ROW LEVEL SECURITY"),
      "Must enable RLS on coach_applications"
    );
  });

  it("has INSERT policy requiring auth.uid() = user_id AND status = pending", () => {
    const insertStart = migrationSource.indexOf("CREATE POLICY coach_applications_insert_own");
    assert.ok(insertStart !== -1, "Insert policy must exist");
    const insertBlock = migrationSource.slice(insertStart, insertStart + 400);
    assert.ok(
      insertBlock.includes("auth.uid() = user_id") &&
      insertBlock.includes("status = 'pending'"),
      "Insert policy must enforce auth.uid() = user_id AND status = pending"
    );
  });

  it("has UPDATE policy preventing status/reviewed_at/reviewed_by changes", () => {
    const updateStart = migrationSource.indexOf("CREATE POLICY coach_applications_update_own");
    assert.ok(updateStart !== -1, "Update policy must exist");
    const updateBlock = migrationSource.slice(updateStart, updateStart + 600);
    assert.ok(
      updateBlock.includes("WITH CHECK") &&
      updateBlock.includes("status = 'pending'") &&
      updateBlock.includes("reviewed_at IS NULL") &&
      updateBlock.includes("reviewed_by IS NULL"),
      "Update policy must prevent changing authority fields"
    );
  });

  it("has no DELETE policy (deny all for authenticated users)", () => {
    assert.ok(
      !migrationSource.includes("FOR DELETE"),
      "Must not have a DELETE policy for authenticated users"
    );
  });

  it("has status index for admin review queue", () => {
    assert.ok(
      migrationSource.includes("idx_coach_applications_status") &&
      migrationSource.includes("(status, created_at)"),
      "Must have index for admin review queue"
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  11. PUBLIC API & INTENT CLEARING
 * ═══════════════════════════════════════════════════════════════════ */

describe("Public API", () => {

  it("exposes clearIntent on AthlevoOnboarding", () => {
    assert.ok(
      onboardingSource.includes("clearIntent: obClearIntent"),
      "Must expose clearIntent on AthlevoOnboarding"
    );
  });

  it("obClearIntent removes the sessionStorage key", () => {
    assert.ok(
      onboardingSource.includes("sessionStorage.removeItem(OB_ROLE_KEY)"),
      "obClearIntent must remove sessionStorage key"
    );
  });

  it("intent is cleared on 'Continue to My Training'", () => {
    const pendingSection = onboardingSource.match(
      /obCoachPendingContinue[\s\S]{0,500}obClearIntent/
    );
    assert.ok(pendingSection, "Pending continue button must clear intent");
  });
});

/* ═══════════════════════════════════════════════════════════════════
 *  12. COACH/ADMIN ONBOARDING BYPASS
 * ═══════════════════════════════════════════════════════════════════ */

describe("Coach/admin onboarding bypass", () => {

  it("startAthlevoOnboarding checks profile.role for coach/admin", () => {
    assert.ok(
      onboardingSource.includes('role === "coach"') &&
      onboardingSource.includes('role === "admin"'),
      "startAthlevoOnboarding must check for coach/admin role"
    );
  });

  it("coach/admin bypass marks onboarding_complete without setting role", () => {
    const bypassSection = onboardingSource.match(
      /role === "coach" \|\| role === "admin"[\s\S]{0,600}onboarding_complete: true/
    );
    assert.ok(bypassSection, "Bypass must set onboarding_complete");
    assert.ok(
      !bypassSection[0].includes("role:"),
      "Bypass must not set role in the update"
    );
  });

  it("startAthlevoOnboarding checks saved intent for resume", () => {
    assert.ok(
      onboardingSource.includes("obReadIntent()"),
      "Must check saved intent on entry"
    );
  });

  it("saved coach intent cannot resume while public access is locked", () => {
    assert.ok(
      onboardingSource.match(/savedIntent\s*===\s*"coach"\s*&&\s*obCoachPublicAccessEnabled\(\)[\s\S]{0,200}obStartCoachFlow/),
      "Saved coach intent must be availability-gated"
    );
    assert.ok(onboardingSource.includes('if (savedIntent === "coach") obClearIntent();'));
  });

  it("saved intent 'athlete' resumes athlete flow", () => {
    assert.ok(
      onboardingSource.match(/savedIntent\s*===\s*"athlete"[\s\S]{0,200}obStartAthleteFlow/),
      "Saved athlete intent must resume athlete flow"
    );
  });

  it("no saved intent shows role choice", () => {
    assert.ok(
      onboardingSource.includes("obRenderRoleChoice()"),
      "No intent must show role choice"
    );
  });
});

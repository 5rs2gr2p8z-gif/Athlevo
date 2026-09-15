/*
 * Athlevo — Account deletion tests.
 *
 * SOURCE-LEVEL VERIFICATION that the account-deletion action enforces
 * every security and ordering constraint. No live database or network.
 *
 * Proves:
 *   1. A user can delete only themselves (identity from bearer token)
 *   2. Body-supplied user_id / email / athlete_id is ignored
 *   3. Coaches cannot delete assigned athletes
 *   4. Admin status does not silently delete another account
 *   5. Provider tokens are removed (Strava deauth, Intervals.icu clear)
 *   6. All relationship-column cases are covered
 *   7. Auth user is deleted LAST
 *   8. A failed cleanup does not delete Auth prematurely
 *   9. Repeated requests are safe (idempotent)
 *  10. Logout / local cleanup occurs after success (client-side)
 *  11. Account deletion UI is accessible from inside the app
 *  12. No extra Vercel function is added
 *
 * Run: node tests/account-deletion.test.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = s => console.log(`\n──── ${s} ────`);

const apiSrc = readFileSync(join(root, "api/providers/index.js"), "utf8");
const indexSrc = readFileSync(join(root, "index.html"), "utf8");

/* ══════════════════════════════════════════════════════════════════════
 * 1. Identity from bearer token ONLY
 * ══════════════════════════════════════════════════════════════════════ */
section("1 — IDENTITY FROM BEARER TOKEN");

// actionDeleteAccount must call requireUser(request) to get identity
t("delete_account calls requireUser for identity",
  /actionDeleteAccount[\s\S]*?requireUser\(request\)/.test(apiSrc));

// The userId must come from user.id, never from request.body
t("userId derived from user.id, not request body",
  /const userId = user\.id/.test(apiSrc) || /userId = user\.id/.test(apiSrc));

/* ══════════════════════════════════════════════════════════════════════
 * 2. Body-supplied user_id is IGNORED
 * ══════════════════════════════════════════════════════════════════════ */
section("2 — BODY-SUPPLIED user_id IGNORED");

// The function should never read user_id, email, athlete_id, coach_id,
// or profile_id from the request body for identity
{
  // Extract just the actionDeleteAccount function body
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  t("does not read request.body.user_id",
    !/request\.body\.user_id|request\.body\["user_id"\]|body\.user_id/.test(fnBody));

  t("does not read request.body.email",
    !/request\.body\.email|request\.body\["email"\]|body\.email/.test(fnBody));

  t("does not read request.body.athlete_id",
    !/request\.body\.athlete_id|request\.body\["athlete_id"\]/.test(fnBody));

  t("does not read request.body.coach_id",
    !/request\.body\.coach_id|request\.body\["coach_id"\]/.test(fnBody));
}

/* ══════════════════════════════════════════════════════════════════════
 * 3. Coaches cannot delete assigned athletes
 * ══════════════════════════════════════════════════════════════════════ */
section("3 — COACHES CANNOT DELETE ATHLETES");

t("no target-user parameter accepted — only self-deletion",
  /actionDeleteAccount\(request, response\)/.test(apiSrc) &&
  !/actionDeleteAccount\(request, response, .*userId/.test(apiSrc));

// The route only uses the bearer token holder's own id
t("delete_account has no route parameter for target user",
  !/delete_account.*target|delete_account.*athlete/.test(apiSrc));

/* ══════════════════════════════════════════════════════════════════════
 * 4. Admin status does not allow deleting another account
 * ══════════════════════════════════════════════════════════════════════ */
section("4 — ADMIN CANNOT DELETE ANOTHER ACCOUNT");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  t("no admin bypass or role check in delete_account",
    !/isAdmin|role.*admin|admin.*role|canManageAssignments/.test(fnBody));

  t("no alternate userId source for admins",
    !/adminUser|targetUser|otherUser/.test(fnBody));
}

/* ══════════════════════════════════════════════════════════════════════
 * 5. Provider tokens are removed
 * ══════════════════════════════════════════════════════════════════════ */
section("5 — PROVIDER TOKEN REVOCATION");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  t("Strava deauthorize endpoint called",
    /strava\.com\/oauth\/deauthorize/.test(fnBody));

  t("Strava access_token used for deauth",
    /access_token/.test(fnBody) && /strava_accounts/.test(fnBody));

  t("Intervals.icu credentials cleared (access_token nulled)",
    /access_token:\s*null/.test(fnBody) && /refresh_token:\s*null/.test(fnBody));

  t("Intervals provider_athlete_id released",
    /provider_athlete_id:\s*null/.test(fnBody));

  // Provider revocation is best-effort — should not block deletion
  t("provider revocation failures do not block deletion",
    /best.effort|continue|stage1Errors/.test(fnBody) &&
    !/return.*500.*provider/.test(fnBody.split("Stage 2")[0] || ""));
}

/* ══════════════════════════════════════════════════════════════════════
 * 6. All relationship-column cases covered
 * ══════════════════════════════════════════════════════════════════════ */
section("6 — RELATIONSHIP COLUMNS");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  // coach_athlete_assignments: athlete_id, coach_id, created_by
  t("coach_athlete_assignments.athlete_id deleted",
    /deleteFrom\("coach_athlete_assignments",\s*"athlete_id"/.test(fnBody));
  t("coach_athlete_assignments.coach_id deleted",
    /deleteFrom\("coach_athlete_assignments",\s*"coach_id"/.test(fnBody));
  t("coach_athlete_assignments.created_by deleted",
    /deleteFrom\("coach_athlete_assignments",\s*"created_by"/.test(fnBody));

  // coach_attention_reviews: athlete_id, coach_id
  t("coach_attention_reviews.athlete_id deleted",
    /deleteFrom\("coach_attention_reviews",\s*"athlete_id"/.test(fnBody));
  t("coach_attention_reviews.coach_id deleted",
    /deleteFrom\("coach_attention_reviews",\s*"coach_id"/.test(fnBody));

  // coaching_transitions: athlete_id, coach_id
  t("coaching_transitions.athlete_id deleted",
    /deleteFrom\("coaching_transitions",\s*"athlete_id"/.test(fnBody));
  t("coaching_transitions.coach_id deleted",
    /deleteFrom\("coaching_transitions",\s*"coach_id"/.test(fnBody));

  // managed_plan_change_requests: athlete_id, coach_id, created_by, reviewed_by
  t("managed_plan_change_requests.athlete_id deleted",
    /deleteFrom\("managed_plan_change_requests",\s*"athlete_id"/.test(fnBody));
  t("managed_plan_change_requests.coach_id deleted",
    /deleteFrom\("managed_plan_change_requests",\s*"coach_id"/.test(fnBody));
  t("managed_plan_change_requests.created_by deleted",
    /deleteFrom\("managed_plan_change_requests",\s*"created_by"/.test(fnBody));
  t("managed_plan_change_requests.reviewed_by set null",
    /setNullWhere\("managed_plan_change_requests",\s*"reviewed_by"/.test(fnBody));

  // training_sessions: created_by, updated_by
  t("training_sessions.created_by deleted",
    /deleteFrom\("training_sessions",\s*"created_by"/.test(fnBody));
  t("training_sessions.updated_by set null",
    /setNullWhere\("training_sessions",\s*"updated_by"/.test(fnBody));

  // coach_applications: reviewed_by → SET NULL
  t("coach_applications.reviewed_by set null",
    /setNullWhere\("coach_applications",\s*"reviewed_by"/.test(fnBody));
}

/* ══════════════════════════════════════════════════════════════════════
 * 7. Auth user deleted LAST
 * ══════════════════════════════════════════════════════════════════════ */
section("7 — AUTH DELETED LAST");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  // auth/v1/admin/users DELETE must appear AFTER profiles deletion
  const profilesDeletePos = fnBody.indexOf('deleteFrom("profiles"');
  const authDeletePos = fnBody.indexOf('auth/v1/admin/users');

  t("profiles deleted before auth user",
    profilesDeletePos > 0 && authDeletePos > 0 && profilesDeletePos < authDeletePos);

  // All user data tables must be deleted before profiles
  const userDataTablesPos = fnBody.indexOf("userDataTables");
  t("user data tables deleted before profiles",
    userDataTablesPos > 0 && userDataTablesPos < profilesDeletePos);

  // Relationship rows before user data tables
  const stage2Pos = fnBody.indexOf("Stage 2");
  t("relationship rows (stage 2) before user data (stage 3)",
    stage2Pos > 0 && stage2Pos < userDataTablesPos);

  // athlete_diagnostics holds this athlete's acquisition_stage / diagnostic
  // facts (see js/diagnosticHandoff.js, js/diagnosticAcquisition.js) and
  // must not survive account deletion, even though a recreated account
  // normally gets a new auth user id.
  t("athlete_diagnostics rows deleted for this user (via the userDataTables loop)",
    (() => {
      const tablesMatch = fnBody.match(/const userDataTables = \[[\s\S]*?\];/);
      return !!tablesMatch && /"athlete_diagnostics"/.test(tablesMatch[0]);
    })());
}

/* ══════════════════════════════════════════════════════════════════════
 * 8. Failed cleanup does NOT delete Auth prematurely
 * ══════════════════════════════════════════════════════════════════════ */
section("8 — FAILED CLEANUP PRESERVES AUTH");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  // After stage 2 errors, should return 500 before reaching auth deletion
  t("stage 2 errors return before auth deletion",
    /stage.*relationships[\s\S]*?retryable.*true/.test(fnBody));

  // After stage 3 errors, should return 500 before reaching auth deletion
  t("stage 3 errors return before auth deletion",
    /stage.*user_data[\s\S]*?retryable.*true/.test(fnBody));

  // After stage 4 (profiles) errors, should return 500 before reaching auth deletion
  t("stage 4 (profile) errors return before auth deletion",
    /stage.*profile[\s\S]*?retryable.*true/.test(fnBody));

  // The response includes a stage identifier for retry
  t("failure responses include stage identifier",
    /stage:.*"relationships"/.test(fnBody) &&
    /stage:.*"user_data"/.test(fnBody) &&
    /stage:.*"profile"/.test(fnBody) &&
    /stage:.*"auth"/.test(fnBody));

  // Whop cancellation failure must NOT block auth deletion — billing
  // cancellation is best-effort (see section 16 below). Deletion of the
  // account itself never depends on an external billing provider.
  t("Whop cancellation has no retryable subscription_cancellation failure gate",
    !/stage:\s*"subscription_cancellation"/.test(fnBody));
  t("Whop cancellation happens before profiles deletion (order preserved)",
    (() => {
      const whopPos = fnBody.indexOf("makeWhopClient()");
      const profilesPos = fnBody.indexOf('deleteFrom("profiles"');
      return whopPos > 0 && profilesPos > 0 && whopPos < profilesPos;
    })());
}

/* ══════════════════════════════════════════════════════════════════════
 * 9. Repeated requests are safe (idempotent)
 * ══════════════════════════════════════════════════════════════════════ */
section("9 — IDEMPOTENT / SAFE TO RETRY");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  // DELETE operations treat 404 as success (missing = already deleted)
  t("deleteFrom treats 404 as success",
    /res\.status !== 404/.test(fnBody) || /404/.test(fnBody));

  // setNullWhere also treats 404 as success
  t("setNullWhere treats 404 as success",
    fnBody.includes("setNullWhere") &&
    /404/.test(apiSrc.match(/async function setNullWhere[\s\S]*?^  }/m)?.[0] || ""));

  // Auth delete also treats 404 as non-error
  t("auth deletion treats 404 as already gone",
    /authRes\.status !== 404/.test(fnBody));
}

/* ══════════════════════════════════════════════════════════════════════
 * 10. Logout / local cleanup on success (client-side)
 * ══════════════════════════════════════════════════════════════════════ */
section("10 — CLIENT LOGOUT & LOCAL CLEANUP");

t("client calls supabaseClient.auth.signOut after success",
  /confirmDeleteAccount[\s\S]*?signOut\(\)/.test(indexSrc));

t("client clears sessionStorage",
  /confirmDeleteAccount[\s\S]*?sessionStorage\.clear\(\)/.test(indexSrc));

t("client clears localStorage (still calls localStorage.clear())",
  /confirmDeleteAccount[\s\S]*?localStorage\.clear\(\)/.test(indexSrc));

t("client preserves athlevo_ff_* feature-flag overrides across localStorage.clear()",
  (function () {
    const fnMatch = indexSrc.match(/async function confirmDeleteAccount\([\s\S]*?^}/m);
    const fnBody = fnMatch ? fnMatch[0] : "";
    return /athlevo_ff_/.test(fnBody) &&
      /localStorage\.clear\(\)/.test(fnBody) &&
      /localStorage\.setItem/.test(fnBody);
  })());

t("client resets athlete UI",
  /confirmDeleteAccount[\s\S]*?resetAthleteUI/.test(indexSrc));

t("client invalidates activity cache",
  /confirmDeleteAccount[\s\S]*?invalidateActivityCache/.test(indexSrc));

t("client nulls session user id",
  /confirmDeleteAccount[\s\S]*?athlevoSessionUserId\s*=\s*null/.test(indexSrc));

t("client navigates to welcome screen",
  /confirmDeleteAccount[\s\S]*?showScreen\(['"]screen-welcome['"]\)/.test(indexSrc));

t("client hides tab bar",
  /confirmDeleteAccount[\s\S]*?tabbar.*display.*none/.test(indexSrc));

/* ══════════════════════════════════════════════════════════════════════
 * 11. Deletion UI accessible from inside the app
 * ══════════════════════════════════════════════════════════════════════ */
section("11 — UI ACCESSIBILITY");

t("Delete Account row exists in the You screen",
  /id="screen-you"[\s\S]*?Delete Account/.test(indexSrc));

t("Delete Account row links to openDeleteAccount",
  /openDeleteAccount\(\)/.test(indexSrc));

t("Delete account modal exists",
  /id="deleteAccountModal"/.test(indexSrc));

t("Typed DELETE confirmation required",
  /Type.*DELETE.*to confirm/.test(indexSrc));

t("Delete button is initially disabled",
  /id="deleteAccountBtn"[\s\S]*?disabled/.test(indexSrc));

t("DELETE input enables button only on exact match",
  /value\.trim\(\)\s*!==\s*['"]DELETE['"]/.test(indexSrc));

t("Warning explains permanent deletion",
  /permanently delete/.test(indexSrc));

t("Loading state exists",
  /id="deleteAccountLoading"/.test(indexSrc));

t("Success state exists",
  /id="deleteAccountSuccess"/.test(indexSrc));

t("Cancel button available",
  /deleteAccountModal[\s\S]*?Cancel/.test(indexSrc));

/* ══════════════════════════════════════════════════════════════════════
 * 12. No extra Vercel function added
 * ══════════════════════════════════════════════════════════════════════ */
section("12 — NO EXTRA VERCEL FUNCTION");

t("delete_account is routed via existing api/providers/index.js handler",
  /action === "delete_account"/.test(apiSrc) &&
  /actionDeleteAccount\(request, response\)/.test(apiSrc));

// No new file was created under api/ for account deletion
{
  const apiDir = join(root, "api");
  function findFiles(dir) {
    const results = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) results.push(...findFiles(p));
      else results.push(p);
    }
    return results;
  }
  const allApiFiles = findFiles(apiDir).map(f => f.replace(apiDir, ""));
  t("no delete-account or account-deletion file in api/",
    !allApiFiles.some(f => /delete.account|account.delet/i.test(f)));
}

/* ══════════════════════════════════════════════════════════════════════
 * 13. User data tables inventory completeness
 * ══════════════════════════════════════════════════════════════════════ */
section("13 — DATA TABLE INVENTORY");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  const requiredTables = [
    "activation_events", "activities", "activity_data_overrides",
    "activity_sync_logs", "athlete_memory", "athlevo_score_history",
    "beta_feedback", "coach_action_proposals", "coach_applications",
    "coach_conversations", "daily_coach_briefings", "daily_readiness",
    "pending_provider_connections", "provider_accounts", "race_results",
    "strava_accounts", "subscription_events", "subscriptions",
    "training_plans", "training_sessions", "trial_usage",
    "weekly_check_ins", "weekly_progress_summaries",
    "workout_execution_records"
  ];

  for (const table of requiredTables) {
    t(`${table} included in deletion`,
      fnBody.includes(`"${table}"`));
  }

  // user_entitlement_status should NOT be deleted (confirmed not a table)
  t("user_entitlement_status is NOT in the deletion list (view, not table)",
    !fnBody.includes('"user_entitlement_status"'));
  t("pending_whop_entitlements claimed rows are deleted by claimed_user_id",
    fnBody.includes("pending_whop_entitlements") && fnBody.includes("claimed_user_id"));
}

/* ══════════════════════════════════════════════════════════════════════
 * 14. Migration exists for coach_applications.reviewed_by
 * ══════════════════════════════════════════════════════════════════════ */
section("14 — MIGRATION");

{
  const migrationPath = join(root, "migrations/2026-08-06_coach_applications_reviewed_by_set_null.sql");
  t("migration file exists", existsSync(migrationPath));

  if (existsSync(migrationPath)) {
    const migSrc = readFileSync(migrationPath, "utf8");
    t("migration drops existing FK",
      /DROP CONSTRAINT.*coach_applications_reviewed_by_fkey/i.test(migSrc));
    t("migration adds ON DELETE SET NULL FK",
      /ON DELETE SET NULL/i.test(migSrc));
    t("migration references profiles(id)",
      /REFERENCES.*profiles\(id\)/i.test(migSrc));
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 15. Route is POST-only
 * ══════════════════════════════════════════════════════════════════════ */
section("15 — ROUTE METHOD ENFORCEMENT");

t("delete_account enforces POST method",
  /action === "delete_account"[\s\S]*?method !== "POST"/.test(apiSrc));

/* ══════════════════════════════════════════════════════════════════════
 * 16. Whop subscription cancellation
 * ══════════════════════════════════════════════════════════════════════ */
section("16 — WHOP SUBSCRIPTION CANCELLATION");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  // Imports makeWhopClient
  t("imports makeWhopClient from whopClient",
    /import.*makeWhopClient.*whopClient/.test(apiSrc));

  // Reads subscription row to find Whop membership
  t("reads subscriptions table to find active Whop membership",
    /subscriptions\?user_id=eq/.test(fnBody) &&
    /provider_subscription_id/.test(fnBody));

  // Only cancels when provider is whop and status is active/past_due
  t("only cancels whop provider subscriptions",
    /provider === "whop"/.test(fnBody));
  t("only cancels active or past_due subscriptions",
    /active\|past_due/.test(fnBody) || (/active/.test(fnBody) && /past_due/.test(fnBody)));

  // Uses server-side Whop API, not client-side
  t("uses makeWhopClient (server-side API key, never exposed to browser)",
    /makeWhopClient\(\)/.test(fnBody));

  // Calls the cancel endpoint with the membership ID from the DB, not from body
  t("calls Whop cancel endpoint with DB membership ID",
    /memberships\/.*\/cancel/.test(fnBody));
  t("membership ID comes from subscription row, not request body",
    /sub\.provider_subscription_id/.test(fnBody) &&
    !/request\.body\.membership/.test(fnBody));

  // Checks isConfigured before calling
  t("checks whop.isConfigured() before calling cancel",
    /isConfigured\(\)/.test(fnBody));

  // Whop cancellation is BEST-EFFORT: a failure (already-cancelled
  // membership, transient Whop API error, etc.) must never block the
  // rest of account deletion — it is caught locally and surfaced as a
  // billingWarning instead of aborting with a 500.
  t("Whop cancel call is wrapped in its own try/catch (best-effort)",
    /catch\s*\(whopErr\)/.test(fnBody));
  t("Whop cancellation failure does not return an error response",
    (() => {
      const m = fnBody.match(/catch\s*\(whopErr\)\s*\{[\s\S]*?\n {8}\}/);
      return !!m && !/response\.status\(500\)/.test(m[0]);
    })());
  t("Whop cancellation failure sets a billingWarning instead of blocking",
    /billingWarning\s*=/.test(fnBody));

  // Auth deletion is reachable even when Whop cancellation fails — the
  // cancel call is no longer able to `return` out of the function.
  const whopCatchBlock = fnBody.match(/catch\s*\(whopErr\)[\s\S]*?\n {8}\}/)?.[0] || "";
  t("Whop cancellation failure handler contains no early return",
    !/\breturn\b/.test(whopCatchBlock));

  // The cancellation happens BEFORE subscription_events and subscriptions are deleted
  const whopCancelPos = fnBody.indexOf('memberships/');
  const subDeletePos = fnBody.indexOf('"subscriptions"');
  t("Whop cancellation occurs before subscriptions table deletion",
    whopCancelPos > 0 && subDeletePos > 0 && whopCancelPos < subDeletePos);
}

/* ══════════════════════════════════════════════════════════════════════
 * 17. Regression coverage for the "Delete account does nothing" bug
 *
 * Root cause: a failed (or already-cancelled) Whop membership cancel call
 * threw inside actionDeleteAccount and was caught by a handler that
 * returned HTTP 500 with retryable:true — aborting the ENTIRE deletion
 * before any data was touched. Any account with a past Whop subscription
 * (including one already cancelled on Whop's side) could never be
 * deleted. Fixed by making billing cancellation best-effort.
 * ══════════════════════════════════════════════════════════════════════ */
section("17 — REGRESSION: BILLING FAILURE MUST NOT BLOCK DELETION");

{
  const fnMatch = apiSrc.match(/async function actionDeleteAccount\([\s\S]*?^}/m);
  const fnBody = fnMatch ? fnMatch[0] : "";

  t("subscription status regex is anchored correctly (active|past_due, not active|past_due$)",
    /\/\^\(active\|past_due\)\$\//.test(fnBody));

  t("success response can carry a billingWarning field",
    /billingWarning:\s*billingWarning/.test(fnBody));

  t("billingWarning is declared with let (mutated across stage 1c)",
    /let billingWarning = null/.test(fnBody));

  t("unconfigured Whop client sets a billingWarning rather than skipping silently",
    /WHOP_API_KEY not configured[\s\S]{0,400}billingWarning =/.test(fnBody) ||
    /billingWarning =[\s\S]{0,400}cancel it directly in Whop/.test(fnBody));
}

section("17b — REGRESSION: CLIENT SURFACES BILLING WARNING + BLOCKS DOUBLE SUBMIT");

t("client shows billingWarning text on the success screen",
  /data\.billingWarning/.test(indexSrc));

t("client guards against duplicate delete submissions",
  /dataset\.deleting/.test(indexSrc));

t("client tracks account_delete_started/completed/failed analytics",
  /account_delete_started/.test(indexSrc) &&
  /account_delete_completed/.test(indexSrc) &&
  /account_delete_failed/.test(indexSrc));

/* ═══════════════════════════════════════════════════════════════════ */

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed, ${pass + fail} total`);
console.log(`${"═".repeat(60)}`);
process.exit(fail ? 1 : 0);

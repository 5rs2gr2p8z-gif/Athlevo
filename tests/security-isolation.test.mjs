/*
 * Athlevo — Security isolation tests  (Sprint 4, Phase 2)
 *
 * IMPORTANT DISTINCTION:
 *   - Sections 1–2 verify that MIGRATION FILES define the expected RLS
 *     policies. They do NOT verify production database state. Production
 *     must be verified separately (see security/production-rls-check.sql).
 *   - Sections 3–12 verify runtime code properties (imports, patterns,
 *     logic) that are statically verifiable from the repository.
 *   - Sections 13–14 verify that the split migrations are internally
 *     consistent and do not leak concerns across files.
 *
 * Migration files inspected:
 *   - security/001-atomic-rate-limit-rpc.sql
 *   - security/002-athlete-table-rls.sql
 *
 * Run: node tests/security-isolation.test.mjs
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import {
  verifyWhopSignature, parseWhopEvent, mapWhopEvent
} from "../lib/server/whopWebhook.js";
import { canUse, resolveEntitlement, FEATURE_REGISTRY } from "../lib/server/features.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);


/* ══════════════════════════════════════════════════════════════════════
 * 1. RLS: Migration files exist for all user-data tables
 *    Sources: security/002-athlete-table-rls.sql + migrations/*.sql
 * ══════════════════════════════════════════════════════════════════════ */
section("1 — MIGRATION FILES define RLS for every user-data table (NOT a production check)");

// Tables that hold per-user data and are client-accessible
const CRITICAL_TABLES = [
  "profiles",
  "activities",
  "training_plans",
  "training_sessions",
  "strava_accounts",
];

// Tables already covered by existing migrations
const ALREADY_COVERED = [
  "beta_feedback", "weekly_check_ins", "weekly_progress_summaries",
  "workout_execution_records", "athlete_memory", "coach_conversations",
  "coach_action_proposals", "activity_data_overrides", "daily_readiness",
  "subscriptions", "subscription_events", "subscription_plans",
  "athlete_metrics", "athlevo_score_history", "pace_feedback",
  "race_results", "activation_events", "ai_rate_limits",
  "provider_accounts", "pending_provider_connections",
  "pending_whop_entitlements",
];

// Read all migration files
import { readdirSync } from "node:fs";
const migrationDir = "./migrations";
let allMigrationSql = "";
try {
  const files = readdirSync(migrationDir).filter(f => f.endsWith(".sql"));
  for (const file of files) {
    allMigrationSql += readFileSync(`${migrationDir}/${file}`, "utf8") + "\n";
  }
} catch (e) {
  // migrations/ may not exist in all environments
}

// Read the split security migration files (replaces old combined remediation-migration.sql)
const migration001Sql = (() => {
  try { return readFileSync("./security/001-atomic-rate-limit-rpc.sql", "utf8"); }
  catch { return ""; }
})();
const migration002Sql = (() => {
  try { return readFileSync("./security/002-athlete-table-rls.sql", "utf8"); }
  catch { return ""; }
})();

t("security/001-atomic-rate-limit-rpc.sql exists and is non-empty",
  migration001Sql.length > 0,
  "Migration 001 file missing or empty");

t("security/002-athlete-table-rls.sql exists and is non-empty",
  migration002Sql.length > 0,
  "Migration 002 file missing or empty");

// Combined SQL for broad table-coverage checks
allMigrationSql += "\n" + migration001Sql + "\n" + migration002Sql;
const allSqlLower = allMigrationSql.toLowerCase();

// The old combined file must not exist
import { existsSync } from "node:fs";
t("Old remediation-migration.sql has been removed",
  !existsSync("./security/remediation-migration.sql"),
  "Old combined migration still exists — ambiguous which file to run");
t("Old rollback-migration.sql has been removed",
  !existsSync("./security/rollback-migration.sql"),
  "Old combined rollback still exists — ambiguous which file to run");

for (const table of CRITICAL_TABLES) {
  const hasEnableRls = allSqlLower.includes(`alter table public.${table} enable row level security`);
  t(`${table}: migration defines 'enable row level security'`,
    hasEnableRls,
    `No RLS migration found for ${table}`);

  // strava_accounts intentionally has no SELECT policy (tokens are server-only)
  if (table !== "strava_accounts") {
    const hasSelectPolicy = allSqlLower.includes(`on public.${table} for select`);
    t(`${table}: migration defines SELECT policy`,
      hasSelectPolicy,
      `No SELECT policy found for ${table}`);
  }
}

// Verify all already-covered tables still have RLS
for (const table of ALREADY_COVERED) {
  const hasEnableRls = allSqlLower.includes(`alter table public.${table} enable row level security`);
  t(`${table}: migration defines RLS`, hasEnableRls);
}


/* ══════════════════════════════════════════════════════════════════════
 * 2. RLS policies use auth.uid() — not a parameter or constant
 * ══════════════════════════════════════════════════════════════════════ */
section("2 — Migration policies use auth.uid() for ownership (NOT a production check)");

for (const table of CRITICAL_TABLES) {
  // strava_accounts intentionally has NO policies (tokens are server-only)
  if (table === "strava_accounts") continue;

  // Extract policy definitions for this table
  const policyRegex = new RegExp(
    `on\\s+public\\.${table}\\s+for\\s+(select|insert|update|delete).*?(?:using|with\\s+check)\\s*\\(.*?auth\\.uid\\(\\)`,
    "is"
  );
  const usesAuthUid = policyRegex.test(allMigrationSql);
  t(`${table}: policies reference auth.uid()`,
    usesAuthUid,
    `Policy does not use auth.uid() for ${table}`);
}


/* ══════════════════════════════════════════════════════════════════════
 * 3. Rate limiting on all AI endpoints
 * ══════════════════════════════════════════════════════════════════════ */
section("3 — Rate limiting: all AI endpoints import and call checkAiRateLimit");

const AI_ENDPOINTS = [
  { file: "./api/coach.js",                   name: "coach" },
  { file: "./api/daily-brief.js",             name: "daily-brief" },
  { file: "./api/memory/extract.js",          name: "memory/extract" },
  { file: "./api/training/generate-plan.js",  name: "generate-plan" },
  { file: "./api/training/weekly-analysis.js", name: "weekly-analysis" },
  { file: "./lib/server/diagnosticChatEndpoint.js", name: "diagnostic-chat" },
];

for (const ep of AI_ENDPOINTS) {
  let src;
  try { src = readFileSync(ep.file, "utf8"); } catch { src = ""; }

  const importsRateLimit = /import.*checkAiRateLimit.*from/s.test(src);
  t(`${ep.name}: imports checkAiRateLimit`, importsRateLimit,
    `${ep.file} does not import rate limiter`);

  const callsRateLimit = /checkAiRateLimit\s*\(/.test(src);
  t(`${ep.name}: calls checkAiRateLimit()`, callsRateLimit,
    `${ep.file} does not call rate limiter`);
}


/* ══════════════════════════════════════════════════════════════════════
 * 4. Rate limit config covers all AI endpoint types
 * ══════════════════════════════════════════════════════════════════════ */
section("4 — Rate limit config: AI_LIMITS covers all endpoint types");

const rateLimitSrc = readFileSync("./lib/server/rateLimit.js", "utf8");

const EXPECTED_LIMIT_KEYS = ["coach", "daily-brief", "memory-extract", "generate-plan", "weekly-analysis", "diagnostic-chat"];

for (const key of EXPECTED_LIMIT_KEYS) {
  // Check that the key appears in AI_LIMITS (may be quoted or unquoted)
  const escaped = key.replace("-", "[-_]");
  const pattern = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)\\s*:`);
  t(`AI_LIMITS includes "${key}"`,
    pattern.test(rateLimitSrc),
    `rateLimit.js AI_LIMITS missing "${key}"`);
}


/* ══════════════════════════════════════════════════════════════════════
 * 5. Atomic rate-limit increment
 * ══════════════════════════════════════════════════════════════════════ */
section("5 — Rate limiter uses atomic increment (not read-then-write)");

{
  const hasAtomicUpsert =
    /on_conflict.*do\s+update.*set\s+.*count\s*=.*\+/is.test(rateLimitSrc) ||
    /rpc\/increment_rate_limit/i.test(rateLimitSrc) ||
    /rpc\s*\(\s*["']increment_rate_limit/i.test(rateLimitSrc) ||
    /insert.*on\s+conflict.*count\s*\+\s*1/is.test(rateLimitSrc);

  t("rateLimit.js uses atomic upsert (not read-then-write)",
    hasAtomicUpsert,
    "Non-atomic: SELECT then INSERT/UPDATE allows race-condition bypass");
}


/* ══════════════════════════════════════════════════════════════════════
 * 6. Daily aggregate AI cap
 * ══════════════════════════════════════════════════════════════════════ */
section("6 — Daily aggregate AI cap exists");

{
  const hasDailyCap =
    /daily[_-]?cap|daily[_-]?limit|windowMinutes:\s*1440|per[_-]?day/i.test(rateLimitSrc) ||
    /aggregate.*daily|daily.*aggregate/i.test(rateLimitSrc);

  t("rateLimit.js has a daily aggregate cap",
    hasDailyCap,
    "No daily cap — hourly limits can be exploited 24x");
}


/* ══════════════════════════════════════════════════════════════════════
 * 7. Webhook forgery: tampered payloads are rejected
 * ══════════════════════════════════════════════════════════════════════ */
section("7 — Webhook signature forgery rejection");

{
  const secret = "whsec_test_verification_123";
  const body = JSON.stringify({ type: "membership.activated", data: { id: "mem_x" } });

  // Valid signature
  const keyBuf = Buffer.from(secret.slice(6), "base64");
  const msgId = "msg_forgery_test";
  const ts = String(Math.floor(Date.now() / 1000));
  const validSig = "v1," + crypto.createHmac("sha256", keyBuf)
    .update(`${msgId}.${ts}.${body}`).digest("base64");

  const validHeaders = {
    "webhook-id": msgId,
    "webhook-timestamp": ts,
    "webhook-signature": validSig
  };

  t("Valid signature accepted",
    verifyWhopSignature(Buffer.from(body), validHeaders, secret) === true);

  // Tampered body
  const tamperedBody = body.replace("mem_x", "mem_hacked");
  t("Tampered body rejected",
    verifyWhopSignature(Buffer.from(tamperedBody), validHeaders, secret) === false,
    "Tampered payload was accepted!");

  // Wrong secret
  t("Wrong secret rejected",
    verifyWhopSignature(Buffer.from(body), validHeaders, "whsec_wrong") === false,
    "Wrong secret was accepted!");

  // Replay: timestamp too old (6 minutes ago)
  const oldTs = String(Math.floor(Date.now() / 1000) - 360);
  const oldSig = "v1," + crypto.createHmac("sha256", keyBuf)
    .update(`${msgId}.${oldTs}.${body}`).digest("base64");
  const oldHeaders = { ...validHeaders, "webhook-timestamp": oldTs, "webhook-signature": oldSig };
  t("Replay (6min old) rejected",
    verifyWhopSignature(Buffer.from(body), oldHeaders, secret) === false,
    "Replay attack accepted!");
}


/* ══════════════════════════════════════════════════════════════════════
 * 8. No secrets in frontend code
 * ══════════════════════════════════════════════════════════════════════ */
section("8 — No secrets in frontend code");

{
  const indexSrc = readFileSync("./index.html", "utf8");
  const jsSrcFiles = readdirSync("./js").filter(f => f.endsWith(".js"));
  let allFrontendSrc = indexSrc;
  for (const file of jsSrcFiles) {
    allFrontendSrc += readFileSync(`./js/${file}`, "utf8");
  }

  const SECRET_PATTERNS = [
    { name: "OPENAI_API_KEY",          pattern: /sk-[a-zA-Z0-9]{20,}/ },
    { name: "service_role key",        pattern: /eyJ[a-zA-Z0-9_-]{100,}\.eyJ[a-zA-Z0-9_-]{100,}/ },
    { name: "WHOP_WEBHOOK_SECRET",     pattern: /whsec_[a-zA-Z0-9+/=]{10,}/ },
    { name: "WHOP_API_KEY",            pattern: /whop_[a-zA-Z0-9]{10,}/ },
    { name: "process.env.OPENAI",      pattern: /process\.env\.OPENAI/ },
    { name: "process.env.SERVICE_ROLE", pattern: /process\.env\.SUPABASE_SERVICE_ROLE/ },
  ];

  for (const { name, pattern } of SECRET_PATTERNS) {
    t(`Frontend does not contain ${name}`,
      !pattern.test(allFrontendSrc),
      `${name} found in frontend code!`);
  }
}


/* ══════════════════════════════════════════════════════════════════════
 * 9. API routes never trust user_id from request body
 * ══════════════════════════════════════════════════════════════════════ */
section("9 — API routes derive user_id from JWT, never request body");

{
  const API_FILES = [
    "./api/coach.js",
    "./api/daily-brief.js",
    "./api/memory/extract.js",
    "./api/training/generate-plan.js",
    "./api/training/weekly-analysis.js",
    "./api/training/get-week.js",
    "./api/training/check-in.js",
    "./lib/server/diagnosticChatEndpoint.js",
  ];

  for (const file of API_FILES) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }

    const trustsBody = /(?:req\.body|body)\.user_id/i.test(src) &&
      !/authenticatedUser\.id|user\.id/i.test(src);

    const name = file.split("/").pop();
    t(`${name}: does not trust user_id from request body`,
      !trustsBody,
      `${file} may extract user_id from request body`);
  }
}


/* ══════════════════════════════════════════════════════════════════════
 * 10. Subscription writes are server-only (no INSERT/UPDATE RLS for users)
 * ══════════════════════════════════════════════════════════════════════ */
section("10 — Subscriptions table: users cannot write");

{
  const subsMigration = readFileSync("./migrations/2026-07-14_subscriptions.sql", "utf8");

  const hasInsertPolicy = /create\s+policy.*on\s+public\.subscriptions\s+for\s+insert/i.test(subsMigration);
  const hasUpdatePolicy = /create\s+policy.*on\s+public\.subscriptions\s+for\s+update/i.test(subsMigration);

  t("subscriptions: no INSERT policy for users",
    !hasInsertPolicy,
    "Users can INSERT subscription rows — must be server-only");

  t("subscriptions: no UPDATE policy for users",
    !hasUpdatePolicy,
    "Users can UPDATE subscription rows — must be server-only");
}


/* ══════════════════════════════════════════════════════════════════════
 * 11. strava_accounts: client cannot read tokens
 * ══════════════════════════════════════════════════════════════════════ */
section("11 — strava_accounts: migration enables RLS (tokens become server-only)");

{
  const hasRls = allSqlLower.includes("alter table public.strava_accounts enable row level security");
  t("strava_accounts: migration defines RLS", hasRls,
    "OAuth tokens could be read by any authenticated user!");

  t("strava_accounts: no broad SELECT policy exposes tokens",
    !(/on\s+public\.strava_accounts\s+for\s+select\s+using\s*\(\s*true/is.test(allMigrationSql)),
    "A broad SELECT policy would expose OAuth tokens!");
}


/* ══════════════════════════════════════════════════════════════════════
 * 12. Features.js: unknown features denied by default
 * ══════════════════════════════════════════════════════════════════════ */
section("12 — Feature system: deny-by-default for unknown features");

{
  t("Unknown feature returns false",
    canUse("nonexistent_feature_xyz", { plan_id: "elite", status: "active" }) === false);

  t("Unshipped feature returns false even for elite",
    canUse("coach_reports", { plan_id: "elite", status: "active" }) === false);

  t("Free user can use limited coach_chat",
    canUse("coach_chat", null) === true);

  const inactive = {
    provider: "whop", plan_id: "performance", status: "expired"
  };
  t("Inactive paid subscription retains free Coach access",
    canUse("coach_chat", inactive) === true);
  t("Inactive paid subscription cannot use adaptive AI",
    canUse("adaptive_ai", inactive) === false);
}


/* ══════════════════════════════════════════════════════════════════════
 * 13. Migration separation: 001 contains ONLY rate-limit RPC,
 *     002 contains ONLY RLS policies
 * ══════════════════════════════════════════════════════════════════════ */
section("13 — Migration separation: no cross-contamination between 001 and 002");

{
  const m001 = migration001Sql;
  const m002 = migration002Sql;
  const m001Lower = m001.toLowerCase();
  const m002Lower = m002.toLowerCase();

  // 001 must have RPC, must NOT have athlete RLS
  t("001: defines increment_rate_limit function",
    /create\s+or\s+replace\s+function\s+public\.increment_rate_limit/i.test(m001),
    "Migration 001 missing the RPC function");

  t("001: uses SECURITY DEFINER",
    /security\s+definer/i.test(m001),
    "Migration 001 missing SECURITY DEFINER");

  t("001: sets safe search_path",
    /set\s+search_path/i.test(m001),
    "Migration 001 missing SET search_path");

  t("001: schema-qualifies ai_rate_limits as public.ai_rate_limits",
    /public\.ai_rate_limits/i.test(m001),
    "Migration 001 does not schema-qualify ai_rate_limits");

  t("001: RPC is atomic (INSERT...ON CONFLICT...DO UPDATE)",
    /insert\s+into\s+public\.ai_rate_limits.*on\s+conflict.*do\s+update/is.test(m001),
    "Migration 001 RPC is not atomic");

  t("001: revokes execution from PUBLIC",
    /revoke.*from\s+public\b/i.test(m001),
    "Migration 001 does not revoke from PUBLIC");

  t("001: revokes execution from anon",
    /revoke.*from\s+anon/i.test(m001),
    "Migration 001 does not revoke from anon");

  t("001: revokes execution from authenticated",
    /revoke.*from\s+authenticated/i.test(m001),
    "Migration 001 does not revoke from authenticated");

  t("001: no athlete RLS code (no ENABLE ROW LEVEL SECURITY on athlete tables)",
    !(/alter\s+table\s+public\.(profiles|activities|training_plans|training_sessions|strava_accounts)\s+enable\s+row\s+level\s+security/i.test(m001)),
    "Migration 001 contains athlete table RLS — must be in 002 only");

  t("001: no CREATE POLICY statements",
    !(/create\s+policy/i.test(m001)),
    "Migration 001 contains CREATE POLICY — must be in 002 only");

  // 002 must have RLS, must NOT have RPC
  t("002: no RPC function code",
    !(/create\s+or\s+replace\s+function\s+public\.increment_rate_limit/i.test(m002)),
    "Migration 002 contains RPC function — must be in 001 only");

  t("002: no REVOKE on increment_rate_limit",
    !(/revoke.*increment_rate_limit/i.test(m002)),
    "Migration 002 contains REVOKE on RPC — must be in 001 only");

  // 002 must enable RLS for all 5 tables
  for (const table of CRITICAL_TABLES) {
    t(`002: enables RLS on ${table}`,
      m002Lower.includes(`alter table public.${table} enable row level security`),
      `Migration 002 missing ENABLE RLS for ${table}`);
  }

  // 002 must NOT use FORCE ROW LEVEL SECURITY (check SQL statements, not comments)
  const m002NoComments = m002.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  t("002: does not use FORCE ROW LEVEL SECURITY",
    !(/force\s+row\s+level\s+security/i.test(m002NoComments)),
    "Migration 002 uses FORCE RLS — intentionally excluded");

  // 002: strava_accounts must NOT have a client SELECT policy
  t("002: strava_accounts has no client SELECT policy",
    !(/on\s+public\.strava_accounts\s+for\s+select/i.test(m002)),
    "Migration 002 adds SELECT policy on strava_accounts — tokens would be exposed");

  // 002: policy ownership predicates contain auth.uid() IS NOT NULL
  t("002: policies include auth.uid() IS NOT NULL guard",
    /auth\.uid\(\)\s+is\s+not\s+null/i.test(m002),
    "Migration 002 policies missing auth.uid() IS NOT NULL");

  // 002: write policies contain WITH CHECK
  const withCheckCount = (m002.match(/with\s+check/gi) || []).length;
  t("002: write policies contain WITH CHECK clauses",
    withCheckCount >= 5,
    `Only ${withCheckCount} WITH CHECK clauses found (expected >= 5 for INSERT+UPDATE policies)`);
}


/* ══════════════════════════════════════════════════════════════════════
 * 14. Rollback file safety
 * ══════════════════════════════════════════════════════════════════════ */
section("14 — Rollback files are safe and scoped");

{
  const rollback001 = (() => {
    try { return readFileSync("./security/001-atomic-rate-limit-rpc-rollback.sql", "utf8"); }
    catch { return ""; }
  })();
  const rollback002 = (() => {
    try { return readFileSync("./security/002-athlete-table-rls-rollback.sql", "utf8"); }
    catch { return ""; }
  })();

  t("Rollback 001 exists and is non-empty",
    rollback001.length > 0,
    "Rollback 001 file missing");

  t("Rollback 001: drops only increment_rate_limit function",
    /drop\s+function.*increment_rate_limit/i.test(rollback001),
    "Rollback 001 does not drop the function");

  t("Rollback 001: does not touch RLS or policies",
    !(/row\s+level\s+security|create\s+policy|drop\s+policy/i.test(rollback001)),
    "Rollback 001 touches RLS — must be scoped to RPC only");

  t("Rollback 001: is idempotent (IF EXISTS)",
    /if\s+exists/i.test(rollback001),
    "Rollback 001 missing IF EXISTS");

  t("Rollback 002 exists and is non-empty",
    rollback002.length > 0,
    "Rollback 002 file missing");

  t("Rollback 002: drops policies introduced by migration 002",
    /drop\s+policy.*"Athletes read own profile"/i.test(rollback002),
    "Rollback 002 does not drop expected policies");

  t("Rollback 002: does NOT disable RLS (previous state unknown)",
    !(/disable\s+row\s+level\s+security/i.test(rollback002)),
    "Rollback 002 disables RLS — dangerous because previous state is unknown");

  t("Rollback 002: does not touch rate-limit RPC",
    !(/increment_rate_limit/i.test(rollback002)),
    "Rollback 002 touches rate-limit RPC — must be in rollback 001 only");

  // Strip comments before checking — comment text like "All DROP POLICY statements"
  // would false-positive the regex.
  const rb002NoComments = rollback002.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  t("Rollback 002: all DROP POLICY are idempotent (IF EXISTS)",
    !(/drop\s+policy\s+(?!if)/i.test(rb002NoComments)),
    "Rollback 002 has non-idempotent DROP POLICY");
}


/* ══════════════════════════════════════════════════════════════════════
 * 15. JS RPC name matches SQL function name
 * ══════════════════════════════════════════════════════════════════════ */
section("15 — JS RPC call matches SQL function name");

{
  // rateLimit.js calls rpc/increment_rate_limit
  const jsCallsRpc = /rpc\/increment_rate_limit|rpc\s*\(\s*["']increment_rate_limit/i.test(rateLimitSrc);
  const sqlDefinesFunc = /create\s+or\s+replace\s+function\s+public\.increment_rate_limit/i.test(migration001Sql);

  t("rateLimit.js calls increment_rate_limit RPC", jsCallsRpc,
    "JS does not call the expected RPC function name");
  t("Migration 001 defines increment_rate_limit function", sqlDefinesFunc,
    "SQL does not define the expected function name");

  // Parameter names must match
  const jsParams = rateLimitSrc.match(/p_user_id|p_endpoint|p_window_start|p_limit/g) || [];
  const sqlParams = migration001Sql.match(/p_user_id|p_endpoint|p_window_start|p_limit/g) || [];
  t("JS and SQL use matching parameter names (p_user_id, p_endpoint, p_window_start, p_limit)",
    jsParams.length >= 4 && sqlParams.length >= 4,
    `JS has ${jsParams.length} params, SQL has ${sqlParams.length} params`);
}


/* ══════════════════════════════════════════════════════════════════════
 * Summary
 * ══════════════════════════════════════════════════════════════════════ */
console.log(`\n═══ Security isolation: ${p} passed, ${f} failed ═══`);
process.exit(f ? 1 : 0);

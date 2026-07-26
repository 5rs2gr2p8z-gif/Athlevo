/*
 * Athlevo — Security isolation tests  (Sprint 4, Phase 2)
 *
 * IMPORTANT DISTINCTION:
 *   - Sections 1–2 verify that MIGRATION FILES define the expected RLS
 *     policies. They do NOT verify production database state. Production
 *     must be verified separately (see security/production-rls-check.sql).
 *   - Sections 3–12 verify runtime code properties (imports, patterns,
 *     logic) that are statically verifiable from the repository.
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
  // Also check security/ for remediation migration
}

// Check security remediation migration too
try {
  allMigrationSql += readFileSync("./security/remediation-migration.sql", "utf8") + "\n";
} catch (e) { /* not yet created */ }

const allSqlLower = allMigrationSql.toLowerCase();

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

const EXPECTED_LIMIT_KEYS = ["coach", "daily-brief", "memory-extract", "generate-plan", "weekly-analysis"];

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
  // The current implementation does a SELECT then a separate INSERT/UPDATE.
  // A safe implementation uses a single upsert with an increment expression
  // or a Postgres function. Check for an atomic pattern.
  const hasAtomicUpsert =
    // Pattern: single upsert with on_conflict and increment
    /on_conflict.*do\s+update.*set\s+.*count\s*=.*\+/is.test(rateLimitSrc) ||
    // Pattern: Postgres RPC function call for atomic increment
    /rpc\/increment_rate_limit/i.test(rateLimitSrc) ||
    /rpc\s*\(\s*["']increment_rate_limit/i.test(rateLimitSrc) ||
    // Pattern: single INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1
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
  // Check for a dedicated daily aggregate cap mechanism (not just the
  // "daily-brief" key or hourly windows). A true daily cap would have
  // a 1440-minute window or a separate daily_limit / dailyCap config.
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

  // Known-safe public keys to exclude from the check
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
  ];

  for (const file of API_FILES) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }

    // Red flags: extracting user_id from req.body or req.query
    const trustsBody = /(?:req\.body|body)\.user_id/i.test(src) &&
      // Unless it's explicitly validating against the JWT user
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
  // Check that subscriptions table has no INSERT or UPDATE policy for users
  // (only SELECT). Writes come from webhook via service role.
  const subsMigration = readFileSync("./migrations/2026-07-14_subscriptions.sql", "utf8");
  const subsLower = subsMigration.toLowerCase();

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
 *     (After RLS fix, user can read own row but tokens should ideally
 *      not be in a client-readable column. For now, verify RLS exists.)
 * ══════════════════════════════════════════════════════════════════════ */
section("11 — strava_accounts: migration enables RLS (tokens become server-only)");

{
  const hasRls = allSqlLower.includes("alter table public.strava_accounts enable row level security");
  t("strava_accounts: migration defines RLS", hasRls,
    "OAuth tokens could be read by any authenticated user!");

  // strava_accounts intentionally has NO client SELECT policy.
  // RLS with no SELECT policy means anon/authenticated get zero rows.
  // This is correct: the table contains OAuth tokens that must be
  // server-only. The client existence check will return empty, which
  // the frontend handles gracefully.
  //
  // NOTE: If a narrow SELECT policy is later added, it should be
  // scoped to auth.uid() = user_id. Verify it does not expose
  // access_token or refresh_token columns.
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

  t("Free user cannot use coach_chat",
    canUse("coach_chat", null) === false);

  t("Expired subscription downgrades to free",
    canUse("coach_chat", { plan_id: "performance", status: "expired" }) === false);
}


/* ══════════════════════════════════════════════════════════════════════
 * Summary
 * ══════════════════════════════════════════════════════════════════════ */
console.log(`\n═══ Security isolation: ${p} passed, ${f} failed ═══`);
process.exit(f ? 1 : 0);

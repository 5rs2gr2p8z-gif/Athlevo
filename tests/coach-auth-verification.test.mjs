/**
 * Coach session verification, temporal-token recovery, and server-key safety.
 * Run: node tests/coach-auth-verification.test.mjs
 */

import { readFileSync } from "node:fs";

const authSupportSource = readFileSync("./js/authSupport.js", "utf8");
const rateLimitMigration = readFileSync(
  "./migrations/2026-08-26_increment_rate_limit.sql",
  "utf8"
);

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}`);
  }
}

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not close ${name}()`);
}

const getVerifiedSession = new Function(`
  ${extractFunction(authSupportSource, "isTemporalJwtError")}
  ${extractFunction(authSupportSource, "isDefinitiveSessionRejection")}
  ${extractFunction(authSupportSource, "verifySessionUser")}
  ${extractFunction(authSupportSource, "getVerifiedSession")}
  return getVerifiedSession;
`)();

{
  let refreshCalls = 0;
  const client = {
    auth: {
      async getSession() {
        return { data: { session: {
          access_token: "future-token",
          user: { id: "athlete-1" }
        } }, error: null };
      },
      async getUser(token) {
        return token === "future-token"
          ? { data: { user: null }, error: { status: 401, message: "JWT issued at future" } }
          : { data: { user: { id: "athlete-1" } }, error: null };
      },
      async refreshSession() {
        refreshCalls += 1;
        return { data: { session: {
          access_token: "fresh-token",
          user: { id: "athlete-1" }
        } }, error: null };
      }
    }
  };
  const result = await getVerifiedSession(client);
  test("a future-issued cached JWT is refreshed exactly once",
    refreshCalls === 1 && result.session?.access_token === "fresh-token");
  test("the refreshed JWT is verified against the same user",
    result.user?.id === "athlete-1" && result.reason === null);
}

{
  let refreshCalls = 0;
  const client = {
    auth: {
      async getSession() {
        return { data: { session: {
          access_token: "invalid-token", user: { id: "athlete-1" }
        } }, error: null };
      },
      async getUser() {
        return { data: { user: null }, error: { status: 401, message: "bad jwt" } };
      },
      async refreshSession() { refreshCalls += 1; }
    }
  };
  const result = await getVerifiedSession(client);
  test("a non-temporal invalid JWT remains an auth failure",
    result.reason === "invalid" && refreshCalls === 0);
}

const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalSecretKey = process.env.SUPABASE_SECRET_KEY;
const serverModule = await import("../lib/server/supabaseServer.js?coach-auth-test");

process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy.jwt.value";
delete process.env.SUPABASE_SECRET_KEY;
let headers = serverModule.getSupabaseAdminHeaders();
test("legacy service-role JWT remains a Bearer credential",
  headers.apikey === "legacy.jwt.value" &&
  headers.Authorization === "Bearer legacy.jwt.value");

process.env.SUPABASE_SECRET_KEY = "sb_secret_current";
headers = serverModule.getSupabaseAdminHeaders();
test("opaque secret key is never sent as a Bearer JWT",
  headers.apikey === "sb_secret_current" && !("Authorization" in headers));

test("the missing production RPC now has an atomic, service-only migration",
  /CREATE OR REPLACE FUNCTION public\.increment_rate_limit/.test(rateLimitMigration) &&
  /ON CONFLICT \(user_id, endpoint, window_start\)/.test(rateLimitMigration) &&
  /request_count = ai_rate_limits\.request_count \+ 1/.test(rateLimitMigration) &&
  /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/.test(rateLimitMigration) &&
  /GRANT EXECUTE[\s\S]*TO service_role/.test(rateLimitMigration));

if (originalServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
if (originalSecretKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
else process.env.SUPABASE_SECRET_KEY = originalSecretKey;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

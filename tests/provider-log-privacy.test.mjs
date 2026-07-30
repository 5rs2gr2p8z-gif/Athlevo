import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOAuthState } from "../lib/server/oauthState.js";

process.env.OAUTH_STATE_SECRET = "provider-log-state-secret";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";
process.env.STRAVA_CLIENT_ID = "strava-client";
process.env.STRAVA_CLIENT_SECRET = "strava-client-secret";

const providerSource = readFileSync("api/providers/index.js", "utf8");
const stravaConnectSource = readFileSync("api/strava/connect.js", "utf8");
const stravaCallbackSource = readFileSync("api/strava/callback.js", "utf8");

let passed = 0;
function test(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`✓ ${name}`);
}

test(
  "Intervals log allowlist excludes raw user, athlete, and owner identifiers",
  !/LOG_SAFE[\s\S]*?"userId"[\s\S]*?\]\)/.test(providerSource) &&
    !/LOG_SAFE[\s\S]*?"providerAthleteId"[\s\S]*?\]\)/.test(providerSource) &&
    !/LOG_SAFE[\s\S]*?"ownerUserId"[\s\S]*?\]\)/.test(providerSource)
);

test(
  "Strava callback diagnostics use an explicit categorical allowlist",
  /new Set\(\["cid", "stage", "code", "dbCode"\]\)/.test(stravaCallbackSource) &&
    !/shortHash\s*\(/.test(stravaCallbackSource)
);

test(
  "Strava connect does not log raw error objects",
  /code:\s*"STRAVA_CONNECT_FAILED"/.test(stravaConnectSource) &&
    !/Could not start Strava OAuth:",\s*error/.test(stravaConnectSource)
);

const userId = "281d9a23-raw-user-identifier";
const athleteId = "652649-raw-athlete-identifier";
const accessToken = "strava-access-token-do-not-log";
const refreshToken = "strava-refresh-token-do-not-log";
const authorizationCode = "strava-authorization-code-do-not-log";
const state = createOAuthState({
  userId,
  provider: "strava",
  issuedAt: Date.now(),
  nonce: "d".repeat(32),
  returnTarget: "web"
}, process.env.OAUTH_STATE_SECRET);

globalThis.fetch = async (value, init = {}) => {
  const url = String(value);
  if (url === "https://www.strava.com/oauth/token") {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: 2000000000,
        athlete: { id: athleteId, firstname: "Private", email: "private@example.com" }
      })
    };
  }
  if (url.includes("strava_accounts?strava_athlete_id=")) {
    return { ok: true, status: 200, json: async () => [] };
  }
  if (url.includes("strava_accounts?on_conflict=user_id")) {
    assert.equal((init.method || "GET").toUpperCase(), "POST");
    return { ok: true, status: 201, json: async () => ({}) };
  }
  if (url.includes("/rest/v1/profiles?id=eq.")) {
    return { ok: true, status: 204, json: async () => ({}) };
  }
  throw new Error(`Unexpected request: ${url}`);
};

const logs = [];
const errors = [];
const realLog = console.log;
const realError = console.error;
console.log = (...args) => logs.push(args.map(String).join(" "));
console.error = (...args) => errors.push(args.map(String).join(" "));

const stravaHandler = (await import("../api/strava/callback.js")).default;
const response = {
  statusCode: null,
  headers: {},
  redirect(code, location) {
    this.statusCode = code;
    this.headers.Location = location;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  setHeader(key, value) {
    this.headers[key] = value;
    return this;
  },
  send() {
    return this;
  }
};

await stravaHandler({
  method: "GET",
  query: {
    code: authorizationCode,
    state,
    scope: "read,activity:read_all"
  }
}, response);

console.log = realLog;
console.error = realError;

const output = [...logs, ...errors].join("\n");
test(
  "successful Strava callback retains categorical correlation diagnostics",
  response.statusCode === 302 &&
    response.headers.Location === "https://athlevo.org?strava=connected" &&
    /strava_callback/.test(output) &&
    /STRAVA_CONNECTED/.test(output)
);

for (const [name, prohibited] of [
  ["raw Supabase UUID", userId],
  ["raw provider athlete ID", athleteId],
  ["access token", accessToken],
  ["refresh token", refreshToken],
  ["authorization code", authorizationCode],
  ["signed state", state],
  ["email", "private@example.com"],
  ["provider payload name", "Private"],
  ["service-role key", process.env.SUPABASE_SERVICE_ROLE_KEY],
  ["client secret", process.env.STRAVA_CLIENT_SECRET]
]) {
  test(`${name} is absent from provider logs`, !output.includes(prohibited));
}

console.log(`\n${passed} provider log privacy tests passed.`);

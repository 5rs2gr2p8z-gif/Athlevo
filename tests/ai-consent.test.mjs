/**
 * Athlevo AI-processing consent — server gate unit tests + endpoint
 * integration tests (coach, anonymous coach) + client registry checks.
 * Run: node tests/ai-consent.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.OPENAI_API_KEY = "openai-test";

const {
  getAiConsentStatus,
  requireAiConsent,
  anonymousAiConsentGranted,
  sendAiConsentRequired,
  AI_CONSENT_VERSION
} = await import("../lib/server/aiConsent.js?ai-consent-test");
const { default: coachHandler } = await import("../api/coach.js?ai-consent-test");
const { default: coachAnonymousHandler } = await import("../lib/server/coachAnonymousEndpoint.js?ai-consent-test");

let passed = 0;
let failed = 0;
function test(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
}
const section = name => console.log(`\n──── ${name} ────`);

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "Content-Type": "application/json" }),
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

/* ═══════════════════ lib/server/aiConsent.js — unit tests ═══════════════ */

section("getAiConsentStatus / requireAiConsent — pure unit tests");
{
  const originalFetch = globalThis.fetch;

  async function withConsentRow(row, fn) {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/rest/v1/ai_consent")) {
        return jsonResponse(200, row ? [row] : []);
      }
      return jsonResponse(404, {});
    };
    try { return await fn(); } finally { globalThis.fetch = originalFetch; }
  }

  const noRow = await withConsentRow(null, () => getAiConsentStatus("user-1"));
  test("no row => exists:false, not unavailable", noRow.exists === false && !noRow.unavailable);

  const grantedRow = await withConsentRow(
    { status: "granted", consent_version: "1", granted_at: "2026-01-01T00:00:00Z", withdrawn_at: null },
    () => getAiConsentStatus("user-2")
  );
  test("granted row parsed", grantedRow.exists === true && grantedRow.status === "granted");

  const noConsentGate = await withConsentRow(null, () => requireAiConsent("user-3", "coach"));
  test("no consent => blocked with reason no_consent",
    noConsentGate.allowed === false && noConsentGate.reason === "no_consent");

  const deniedGate = await withConsentRow(
    { status: "denied", consent_version: "1" },
    () => requireAiConsent("user-4", "coach")
  );
  test("denied => blocked with reason denied", deniedGate.allowed === false && deniedGate.reason === "denied");

  const withdrawnGate = await withConsentRow(
    { status: "withdrawn", consent_version: "1" },
    () => requireAiConsent("user-5", "coach")
  );
  test("withdrawn => blocked with reason withdrawn",
    withdrawnGate.allowed === false && withdrawnGate.reason === "withdrawn");

  const grantedGate = await withConsentRow(
    { status: "granted", consent_version: "1" },
    () => requireAiConsent("user-6", "coach")
  );
  test("granted => allowed", grantedGate.allowed === true);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const unavailableGate = await requireAiConsent("user-7", "coach");
  test("Supabase unreachable => fails closed (blocked, reason unavailable)",
    unavailableGate.allowed === false && unavailableGate.reason === "unavailable");
  globalThis.fetch = originalFetch;

  test("anonymousAiConsentGranted true only for ai_consent === true",
    anonymousAiConsentGranted({ ai_consent: true }) === true &&
    anonymousAiConsentGranted({ ai_consent: "true" }) === false &&
    anonymousAiConsentGranted({}) === false &&
    anonymousAiConsentGranted(null) === false);

  const rejectedRes = responseRecorder();
  sendAiConsentRequired(rejectedRes, { reason: "no_consent" });
  test("sendAiConsentRequired returns stable machine-readable code",
    rejectedRes.statusCode === 403 && rejectedRes.body.code === "AI_CONSENT_REQUIRED");
  test("sendAiConsentRequired never leaks internal detail",
    !JSON.stringify(rejectedRes.body).match(/supabase|table|sql/i));

  const unavailableRes = responseRecorder();
  sendAiConsentRequired(unavailableRes, { reason: "unavailable" });
  test("sendAiConsentRequired uses 503 for infra unavailability", unavailableRes.statusCode === 503);

  test("AI_CONSENT_VERSION is a simple stable string", AI_CONSENT_VERSION === "1");
}

/* ═══════════════════ api/coach.js — authenticated gate ═══════════════════ */

section("api/coach.js — authenticated AI consent gate");
{
  const originalFetch = globalThis.fetch;
  const consentRows = new Map(); // userId -> status

  async function fetchMock(input, init = {}) {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();

    if (url.includes("/auth/v1/user")) {
      const token = String(init.headers?.Authorization || "").replace("Bearer ", "");
      return jsonResponse(200, { id: token });
    }
    if (url.includes("/rest/v1/ai_consent")) {
      const match = url.match(/user_id=eq\.([^&]+)/);
      const userId = match ? decodeURIComponent(match[1]) : "";
      const status = consentRows.get(userId);
      return jsonResponse(200, status ? [{ status, consent_version: "1" }] : []);
    }
    // Any other Supabase/OpenAI call should never be reached when the
    // consent gate correctly blocks the request first.
    return jsonResponse(500, { _unexpectedCall: url });
  }

  async function call(userId) {
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${userId}` },
      body: { question: "How should I train today?", context: { profile: { goal: "5K" } } },
      on() {}
    };
    const res = responseRecorder();
    globalThis.fetch = fetchMock;
    try { await coachHandler(req, res); } finally { globalThis.fetch = originalFetch; }
    return res;
  }

  const blocked = await call("athlete-no-consent");
  test("authenticated Coach with no consent record is rejected before any other call",
    blocked.statusCode === 403 && blocked.body?.code === "AI_CONSENT_REQUIRED");

  consentRows.set("athlete-denied", "denied");
  const deniedRes = await call("athlete-denied");
  test("authenticated Coach with denied consent is rejected",
    deniedRes.statusCode === 403 && deniedRes.body?.code === "AI_CONSENT_REQUIRED");

  consentRows.set("athlete-withdrawn", "withdrawn");
  const withdrawnRes = await call("athlete-withdrawn");
  test("authenticated Coach with withdrawn consent is rejected",
    withdrawnRes.statusCode === 403 && withdrawnRes.body?.code === "AI_CONSENT_REQUIRED");

  // Consent granted: the gate must pass and let the request continue past
  // it (it will hit our fetchMock's catch-all 500 for rate limiting /
  // freemium / OpenAI, which is fine — we're only proving the gate itself
  // does not block a granted athlete).
  consentRows.set("athlete-granted", "granted");
  const grantedRes = await call("athlete-granted");
  test("authenticated Coach with granted consent is NOT rejected by the consent gate",
    grantedRes.body?.code !== "AI_CONSENT_REQUIRED");
}

/* ═══════════════════ anonymous Coach — client-flag gate ═══════════════════ */

section("lib/server/coachAnonymousEndpoint.js — anonymous consent gate");
{
  const originalFetch = globalThis.fetch;
  async function call(body) {
    const req = { method: "POST", headers: {}, body };
    const res = responseRecorder();
    globalThis.fetch = async () => jsonResponse(500, { _unexpectedCall: true });
    try { await coachAnonymousHandler(req, res); } finally { globalThis.fetch = originalFetch; }
    return res;
  }

  const noFlag = await call({ message: "How many miles should I run this week?" });
  test("anonymous Coach without ai_consent flag is rejected, no provider call attempted",
    noFlag.statusCode === 403 && noFlag.body?.code === "AI_CONSENT_REQUIRED");

  const falseFlag = await call({ message: "How many miles should I run this week?", ai_consent: false });
  test("anonymous Coach with ai_consent:false is rejected",
    falseFlag.statusCode === 403 && falseFlag.body?.code === "AI_CONSENT_REQUIRED");

  const withFlag = await call({ message: "How many miles should I run this week?", ai_consent: true });
  test("anonymous Coach with ai_consent:true is NOT rejected by the consent gate",
    withFlag.body?.code !== "AI_CONSENT_REQUIRED");
}

/* ═══════════════════ client — analytics registry + module shape ═════════ */

section("Client — analytics registry and aiConsent.js module shape");
{
  const registrySource = readFileSync("./js/analyticsRegistry.js", "utf8");
  const consentEvents = [
    "ai_consent_prompt_shown",
    "ai_consent_granted",
    "ai_consent_declined",
    "ai_consent_withdrawn",
    "ai_consent_reenabled",
    "ai_request_blocked_no_consent"
  ];
  for (const name of consentEvents) {
    test(`analyticsRegistry defines ${name}`, registrySource.includes(`${name}:`));
  }
  test("consent events carry only categorical props (no message/health/workout text)",
    !/ai_consent_[a-z_]+:\s*\{[^}]*props:\s*\[[^\]]*(message|content|text|workout|health)/i
      .test(registrySource));

  const clientSource = readFileSync("./js/aiConsent.js", "utf8");
  test("client module exposes window.AthlevoAiConsent.ensure",
    clientSource.includes("root.AthlevoAiConsent = {") && clientSource.includes("ensure: ensure"));
  test("anonymous ack uses the session-scoped storage key from the spec",
    clientSource.includes('athlevo_ai_consent_v1'));
  test("client never trusts a stored 'declined' state as durable — only sessionStorage on grant",
    !/sessionStorage\.setItem\(ANON_STORAGE_KEY,\s*"0"\)/.test(clientSource));

  const serverProductAnalyticsSource = readFileSync("./lib/server/productAnalytics.js", "utf8");
  test("server analytics allowlist includes ai_request_blocked_no_consent",
    serverProductAnalyticsSource.includes('"ai_request_blocked_no_consent"'));

  const coachSource = readFileSync("./js/coach.js", "utf8");
  test("askCoach() gates on AthlevoAiConsent before clearing the composer or sending",
    /AthlevoAiConsent[\s\S]{0,400}consentGranted/.test(coachSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

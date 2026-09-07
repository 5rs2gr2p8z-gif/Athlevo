/**
 * Cross-browser anonymous continuation handoff.
 *
 * Covers items A–N from the spec for "preserve context across browser
 * handoff": an anonymous visitor who talks to the Coach in a Meta in-app
 * browser, then needs Safari/Chrome for Google OAuth / wearable connection
 * / an explicit "Continue in Safari or Chrome", should not lose what they
 * already told Athlevo — without ever putting that context in a URL.
 *
 * This suite proves the pieces added for this fix at the source and unit
 * level. It reuses the existing DiagnosticEngine (js/diagnostic.js) via the
 * same vm-loading pattern as tests/diagnostic-redesign.test.mjs, and checks
 * the new server endpoint (lib/server/anonymousHandoffEndpoint.js) and the
 * new client module (js/anonymousHandoff.js) at the source level plus a
 * couple of direct function calls. It does not re-implement or duplicate
 * the Meta-IAB acquisition coverage already in
 * tests/meta-iab-acquisition-flow.test.mjs / tests/in-app-browser-handoff.test.mjs
 * — item N below re-runs those as a regression gate instead.
 *
 * Run: node tests/anonymous-handoff-continuation.test.mjs
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const authSupport = readFileSync("./js/authSupport.js", "utf8");
const anonymousHandoffClient = readFileSync("./js/anonymousHandoff.js", "utf8");
const anonymousHandoffServer = readFileSync("./lib/server/anonymousHandoffEndpoint.js", "utf8");
const rateLimit = readFileSync("./lib/server/rateLimit.js", "utf8");
const migration = readFileSync("./migrations/2026-09-07_anonymous_handoffs.sql", "utf8");
const analyticsRegistry = readFileSync("./js/analyticsRegistry.js", "utf8");
const coachAnonymousApi = readFileSync("./api/coach-anonymous.js", "utf8");
const socialAuth = readFileSync("./js/socialAuth.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}
const section = name => console.log(`\n──── ${name} ────`);

function fnBody(source, startMarker, endMarkers) {
  const start = source.indexOf(startMarker);
  let end = source.length;
  for (const marker of endMarkers) {
    const idx = source.indexOf(marker, start + 1);
    if (idx > start && idx < end) end = idx;
  }
  return source.slice(start, end);
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
    _store: store
  };
}

function loadEngineOnly(localStorage) {
  const context = {
    console: { log() {}, warn() {} }, Date, Math, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: localStorage || makeLocalStorage()
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context);
  return context.AthlevoDiagnostic;
}

/* ───────────────────────────────────────────────────────────────────── *
 * A. Anonymous diagnostic data is NOT embedded directly in the URL
 * ───────────────────────────────────────────────────────────────────── */
section("A · No diagnostic data, email, auth token, or free text in the URL");
{
  const buildFn = fnBody(authSupport, "function buildContinuationUrl", ["function readContinuation"]);
  test("buildContinuationUrl only ever sets categorical params plus an opaque handoff token",
    /url\.searchParams\.set\("continue"/.test(buildFn) &&
    /url\.searchParams\.set\("handoff_browser"/.test(buildFn) &&
    /url\.searchParams\.set\("source_surface"/.test(buildFn) &&
    /url\.searchParams\.set\("handoff", opts\.handoffToken\)/.test(buildFn));
  const buildFnCode = buildFn.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  test("no questionAnswers/result/pendingFacts/email/password field is ever assembled into the continuation URL",
    !/questionAnswers|pendingFacts|\.result\b|\.email\b|\.password\b|accessToken|access_token/.test(buildFnCode));
  test("the handoff token is length-capped before being placed in the URL (defence in depth)",
    /opts\.handoffToken\.length <= 200/.test(buildFn));
}

/* ───────────────────────────────────────────────────────────────────── *
 * B. Opaque continuation token generated only when external handoff needed
 * C. Email signup in Meta IAB does not create an external handoff
 * D. Google OAuth in Meta IAB creates a continuation handoff
 * ───────────────────────────────────────────────────────────────────── */
section("B–D · A handoff token is created only for genuinely browser-incompatible actions");
{
  const showNotice = fnBody(authSupport, "function showNotice(opts)", ["function escapeHtml"]);
  test("showNotice() is the single place a handoff is created (fire-and-forget, only reached via guard/guardSignupHandoff)",
    /window\.AthlevoAnonymousHandoff\.create\(/.test(showNotice));
  test("handoff creation happens only inside the browser-incompatible notice flow, not in openSignup/doSignup/doLogin",
    !/AthlevoAnonymousHandoff/.test(fnBody(html, "function openSignup", ["function openLogin"])) &&
    !/AthlevoAnonymousHandoff/.test(fnBody(html, "async function doSignup", ["// ---- Login ----"])) &&
    !/AthlevoAnonymousHandoff/.test(fnBody(html, "async function doLogin", ["async function doLogout", "function doLogout"])));
  test("Google OAuth still routes through guardSignupHandoff → showNotice (which creates the handoff)",
    /guardSignupHandoff\("signup", "auth"\)/.test(socialAuth));
  test("Strava/wearable connection still routes through AthlevoEnv.guard (which creates the handoff)",
    /AthlevoEnv\.guard\('strava', \{ allowContinue: false \}\)/.test(html));
  test("the client module refuses to create a handoff when there is no pending diagnostic (never one per visitor)",
    /if \(!root\.AthlevoDiagnostic \|\| !root\.AthlevoDiagnostic\.hasPending\(\)\) \{\s*\n\s*return null; \/\/ nothing to carry over/.test(anonymousHandoffClient));
}

/* ───────────────────────────────────────────────────────────────────── *
 * E/F. Restored external browser receives the existing DiagnosticEngine
 *      facts, which feed the existing onboarding handoff unchanged
 * ───────────────────────────────────────────────────────────────────── */
section("E–F · Restoring a valid payload repopulates the SAME DiagnosticEngine localStorage the existing diagnosticHandoff flow already reads");
{
  const localStorage = makeLocalStorage();
  const Engine = loadEngineOnly(localStorage);
  const engine = Engine.create();
  engine.acquisitionIntent = "first10k";
  engine._save();
  const savedPayload = JSON.parse(localStorage.getItem("athlevo_pending_diagnostic_v1"));

  // Simulate arriving in a fresh browser: a clean localStorage, restoring
  // from the payload a server handoff would hand back.
  const freshStorage = makeLocalStorage();
  const FreshEngine = loadEngineOnly(freshStorage);
  const restored = FreshEngine.restoreFromServer(savedPayload);
  test("restoreFromServer() returns a live engine instance for a valid payload",
    !!restored && restored.acquisitionIntent === "first10k");
  test("restoreFromServer() writes into the SAME localStorage key diagnosticHandoff.js already reads",
    freshStorage.getItem("athlevo_pending_diagnostic_v1") !== null);
  test("after restoring, hasPending() is true in the new browser (diagnosticHandoff.js's own trigger condition)",
    FreshEngine.hasPending() === true);
}

/* ───────────────────────────────────────────────────────────────────── *
 * G. Token expiry handled gracefully
 * H. Invalid token handled gracefully
 * I. Consumed token cannot leak/replay sensitive state
 * ───────────────────────────────────────────────────────────────────── */
section("G–I · Expired / malformed / already-consumed payloads are rejected, not trusted");
{
  const localStorage = makeLocalStorage();
  const Engine = loadEngineOnly(localStorage);
  const engine = Engine.create();
  engine._save();
  const validPayload = JSON.parse(localStorage.getItem("athlevo_pending_diagnostic_v1"));

  const expiredPayload = { ...validPayload, expiresAt: new Date(Date.now() - 60000).toISOString() };
  test("an expired payload is rejected by restoreFromServer (fails gracefully, does not throw)",
    Engine.restoreFromServer(expiredPayload) === null);

  test("a malformed payload (missing required fields) is rejected, not thrown",
    Engine.restoreFromServer({ v: 1 }) === null);
  test("a null/undefined payload is rejected, not thrown",
    Engine.restoreFromServer(null) === null && Engine.restoreFromServer(undefined) === null);

  // "Consumed token cannot leak/replay" is enforced server-side by the
  // atomic claim (UPDATE ... WHERE consumed_at IS NULL) — verified at the
  // source level here since it requires a live Postgres/PostgREST instance
  // to exercise end-to-end.
  test("the server endpoint claims a token atomically (consumed_at IS NULL guard) so a second GET cannot replay it",
    /consumed_at=is\.null/.test(anonymousHandoffServer) &&
    /Prefer: "return=representation"/.test(anonymousHandoffServer) &&
    /method: "PATCH"/.test(anonymousHandoffServer));
  test("the claim query also excludes already-expired rows (expires_at gt now) in the same atomic step",
    /expires_at=gt\.\$\{encodeURIComponent\(nowIso\)\}/.test(anonymousHandoffServer));
}

/* ───────────────────────────────────────────────────────────────────── *
 * J. URL token removed after restoration
 * ───────────────────────────────────────────────────────────────────── */
section("J · The opaque token is stripped from the visible URL once consumption is attempted");
{
  test("authSupport.js exposes a stripHandoffToken() that removes only the handoff param via history.replaceState",
    /function stripHandoffToken\(\)/.test(authSupport) &&
    /url\.searchParams\.delete\("handoff"\)/.test(authSupport) &&
    /window\.history\.replaceState/.test(fnBody(authSupport, "function stripHandoffToken", ["window.AthlevoEnv ="])));
  test("stripHandoffToken is exported on window.AthlevoEnv",
    /stripHandoffToken,/.test(fnBody(authSupport, "window.AthlevoEnv = {", "};")));
  test("the client module's consume() always calls stripHandoffToken, on both success and failure paths",
    /if \(root\.AthlevoEnv && typeof root\.AthlevoEnv\.stripHandoffToken === "function"\)/.test(anonymousHandoffClient) &&
    fnBody(anonymousHandoffClient, "async function consume()", ["root.AthlevoAnonymousHandoff"]).indexOf("stripHandoffToken") >
      fnBody(anonymousHandoffClient, "async function consume()", ["root.AthlevoAnonymousHandoff"]).indexOf("restored = "));
}

/* ───────────────────────────────────────────────────────────────────── *
 * K. No auth/session/access tokens stored in the handoff payload
 * ───────────────────────────────────────────────────────────────────── */
section("K · No auth/session/access tokens, email, or password ever enter the stored handoff payload");
{
  const toStoredPayloadFn = fnBody(readFileSync("./js/diagnostic.js", "utf8"),
    "DiagnosticEngine.prototype.toStoredPayload", ["DiagnosticEngine.prototype._save"]);
  test("toStoredPayload() (the payload shape sent to the handoff endpoint) has no auth/email/password fields",
    !/email|password|accessToken|access_token|refreshToken|refresh_token|authToken|auth_token/.test(toStoredPayloadFn));
  test("the server endpoint explicitly rejects a payload carrying any auth/credential-shaped field",
    /forbidden = \[.*email.*password.*accessToken/s.test(anonymousHandoffServer) ||
    (/"email"/.test(anonymousHandoffServer) && /"password"/.test(anonymousHandoffServer) && /"accessToken"/.test(anonymousHandoffServer)));
  test("the migration's own comment records the no-credentials / no-wearable-data guarantee",
    /No email, password, auth\/access tokens/.test(migration));
  test("the table stores only a token HASH, never the raw token",
    /token_hash text not null/.test(migration) && !/\braw_token\b/.test(migration));
}

/* ───────────────────────────────────────────────────────────────────── *
 * L. Anonymous Coach messages still do not write to coach_threads
 * M. Authenticated Coach path unchanged
 * ───────────────────────────────────────────────────────────────────── */
section("L–M · Anonymous Coach isolation and the authenticated Coach path are untouched");
{
  test("anonymous Coach endpoint still never references coach_threads/thread_id/trainingState",
    !/coach_threads/.test(coachAnonymousApi) && !/thread_id/.test(coachAnonymousApi) && !/trainingState/.test(coachAnonymousApi));
  test("the new handoff endpoint is a fully separate module from the authenticated /api/coach path",
    !/lib\/server\/coach(?!Anonymous)/i.test(readFileSync("./lib/server/anonymousHandoffEndpoint.js", "utf8")));
  test("the new handoff endpoint never imports or calls anything from coachMessaging/coachAnalytics/trainingState modules",
    !/coachMessaging|coachAnalytics|trainingState/.test(anonymousHandoffServer));
}

/* ───────────────────────────────────────────────────────────────────── *
 * Deployment safety: the new endpoint follows the existing gateway
 * pattern and does not exceed the Vercel Hobby function cap.
 * ───────────────────────────────────────────────────────────────────── */
section("Deployment · new endpoint reuses the gateway pattern, no 13th Hobby function");
{
  let functionCountOutput = "";
  try {
    functionCountOutput = execFileSync(process.execPath, ["tests/vercel-function-count.test.mjs"], { encoding: "utf8" });
  } catch (e) {
    functionCountOutput = (e.stdout || "") + (e.stderr || "");
  }
  test("tests/vercel-function-count.test.mjs still passes (anonymous-handoff did not add a 13th deployed function)",
    /function count \(12\) is within Hobby limit \(12\)/.test(functionCountOutput));
  test("api/anonymous-handoff.js is excluded from deployment via .vercelignore (thin local wrapper only)",
    readFileSync("./.vercelignore", "utf8").includes("api/anonymous-handoff.js"));
  test("vercel.json rewrites /api/anonymous-handoff to the shared provider gateway",
    /"source": "\/api\/anonymous-handoff"/.test(readFileSync("./vercel.json", "utf8")) &&
    /"destination": "\/api\/providers\?action=anonymous_handoff"/.test(readFileSync("./vercel.json", "utf8")));
  test("api/providers/index.js wires the anonymous_handoff action to the new endpoint",
    /if \(action === "anonymous_handoff"\) \{/.test(readFileSync("./api/providers/index.js", "utf8")));
  test("the handoff-create endpoint is rate-limited via the existing anonymous AI rate limiter (not a new mechanism)",
    /checkAnonymousAiRateLimit\(clientKey, "handoff-create"\)/.test(anonymousHandoffServer) &&
    /"handoff-create": \{ limit: \d+, windowMinutes: \d+ \}/.test(rateLimit));
}

/* ───────────────────────────────────────────────────────────────────── *
 * Analytics: minimal new events, reusing the existing enum taxonomy
 * ───────────────────────────────────────────────────────────────────── */
section("Analytics · new events reuse the existing browser/intent/source_surface taxonomy; no message/answer text");
{
  test("all four handoff analytics events are registered",
    /external_handoff_created:/.test(analyticsRegistry) &&
    /external_handoff_restored:/.test(analyticsRegistry) &&
    /external_handoff_failed:/.test(analyticsRegistry) &&
    /external_handoff_expired:/.test(analyticsRegistry));
  test("the new events only use props already in the existing browser/intent/source_surface/failure_category taxonomy",
    /external_handoff_created:\s*\{ kind: "behavioural", props: \["browser", "intent", "source_surface"\] \}/.test(analyticsRegistry) &&
    /external_handoff_failed:\s*\{ kind: "behavioural", props: \["browser", "intent", "source_surface", "failure_category"\] \}/.test(analyticsRegistry));
  test("the client module never sends diagnostic answers or free text as analytics properties",
    !/questionAnswers|pendingFacts|answer_text|message/.test(anonymousHandoffClient));
}

/* ───────────────────────────────────────────────────────────────────── *
 * Failure behaviour never surfaces a scary error (section 8)
 * ───────────────────────────────────────────────────────────────────── */
section("Failure behaviour · never a hard error, always a quiet fallback to normal onboarding");
{
  const consumeServerFn = fnBody(anonymousHandoffServer, "async function consumeHandoff", ["export default async function"]);
  test("GET (consume) always resolves 200 with { payload: null } rather than an error status on any failure path",
    (consumeServerFn.match(/response\.status\(200\)\.json\(\{ ok: true, payload: null \}\)/g) || []).length >= 3);
  const consumeClientFn = fnBody(anonymousHandoffClient, "async function consume()", ["root.AthlevoAnonymousHandoff"]);
  test("the client consume() never throws — network/parse errors are caught and simply mean restored=false",
    /catch \(e\) \{\s*restored = false;\s*\}/.test(consumeClientFn));
  test("restoreSession()'s handoff-consumption call is fire-and-forget and cannot delay or fail the existing routing branches",
    /window\.AthlevoAnonymousHandoff\.consume\(\)\.catch\(function \(\) \{\}\);/.test(html));
}

/* ───────────────────────────────────────────────────────────────────── *
 * N. Meta-IAB acquisition behaviour from 6f1c8c4 has not regressed
 * ───────────────────────────────────────────────────────────────────── */
section("N · Re-run the Meta-IAB acquisition regression gate from 6f1c8c4");
{
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tests/meta-iab-acquisition-flow.test.mjs"], { encoding: "utf8" });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  test("tests/meta-iab-acquisition-flow.test.mjs (the 6f1c8c4 regression gate) passes with zero failures",
    !!m && m[2] === "0");

  let out2 = "";
  try {
    out2 = execFileSync(process.execPath, ["tests/in-app-browser-handoff.test.mjs"], { encoding: "utf8" });
  } catch (e) {
    out2 = (e.stdout || "") + (e.stderr || "");
  }
  const m2 = out2.match(/(\d+) passed, (\d+) failed/);
  test("tests/in-app-browser-handoff.test.mjs passes with zero failures",
    !!m2 && m2[2] === "0");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

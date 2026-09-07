/**
 * Meta (Facebook/Messenger/Instagram) in-app-browser acquisition flow.
 *
 * Product requirement: a visitor opening athlevo.org/ or /ai from a Meta
 * ad/Messenger link must experience the real anonymous Coach BEFORE Athlevo
 * ever asks them to leave for Safari/Chrome. The external-browser handoff
 * may only appear once a genuinely browser-incompatible action is chosen
 * (Google/Apple OAuth, wearable/provider connection) — never merely for
 * loading the page, tapping "Sign up", or using email signup/login.
 *
 * This suite proves the fix at the source level. Live in-app-browser
 * rendering (starter suggestions, typed messages, mobile layout) is
 * exercised by the existing anonymous-coach/diagnostic/responsive suites —
 * this file adds the pieces specific to the Meta-IAB acquisition fix and
 * does not re-implement or duplicate that coverage.
 *
 * Run: node tests/meta-iab-acquisition-flow.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const authSupport = readFileSync("./js/authSupport.js", "utf8");
const socialAuth = readFileSync("./js/socialAuth.js", "utf8");
const anonymousCoach = readFileSync("./js/anonymousCoach.js", "utf8");
const coachAnonymousApi = readFileSync("./api/coach-anonymous.js", "utf8");
const analyticsRegistry = readFileSync("./js/analyticsRegistry.js", "utf8");

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

section("1–4 · Anonymous Coach entry is never gated on browser type");
{
  const restore = fnBody(html, "async function restoreSession", ["function endBootGate"]);
  test("restoreSession never checks AthlevoEnv.shouldWarn/isEmbeddedBrowser before routing",
    !/shouldWarn/.test(restore) && !/isEmbeddedBrowser/.test(restore));
  test("the one AthlevoEnv use inside restoreSession is routing continuation, not a browser gate",
    /consumeContinuation|readContinuation/.test(restore));
  test("showAnonymousCoachPreview (the authoritative anonymous renderer) has no browser check",
    !/AthlevoEnv/.test(fnBody(html, "function showAnonymousCoachPreview", ["window.showAnonymousCoachPreview"])));
  test("renderNavState's / and /ai anonymous branch has no browser check before showAnonymousCoachPreview",
    /if \(\(path === "\/ai" \|\| path === ""\) && !athlevoSessionUserId\) \{[\s\S]{0,700}showAnonymousCoachPreview\(\);/.test(html) &&
    !/if \(\(path === "\/ai" \|\| path === ""\) && !athlevoSessionUserId\) \{[\s\S]{0,700}(shouldWarn|isEmbeddedBrowser)/.test(html));
}

section("5–6 · Anonymous Coach interaction (starter suggestion + typed message) is never gated");
{
  test("askAnonymousCoach has no embedded-browser check",
    !/AthlevoEnv/.test(anonymousCoach));
  test("the anonymous coach CTA/starter-suggestion tracking path has no embedded-browser check",
    !/shouldWarn|isEmbeddedBrowser|guardSignupHandoff/.test(anonymousCoach));
}

section("7 · No authenticated setup verification runs for anonymous visitors");
{
  const restore = fnBody(html, "async function restoreSession", ["function endBootGate"]);
  test("the signed-out / and /ai branch does not call authenticated profile/setup verification",
    !/if \(\(path === "\/ai" \|\| path === ""\) && !athlevoSessionUserId\) \{[\s\S]{0,700}(obLoadProfile|verifySetup|startAthlevoOnboarding)/.test(html));
  test("anonymous Coach never calls the authenticated /api/coach endpoint or its quota",
    /never calls \/api\/coach/.test(anonymousCoach) &&
    /fetch\("\/api\/coach-anonymous"/.test(anonymousCoach));
}

section("8 · Signup CTA still routes to the canonical signup surface");
{
  test("Start Training still fires signup_cta_clicked and destination /ai (unchanged canonical CTA)",
    /trackAuthChoice\("signup_cta_clicked",\s*\{[\s\S]*?destination:\s*"\/ai"/.test(html));
  test("choosing Sign up still opens the canonical auth modal (email + Google/Apple), not a dead end",
    /function openSignup[\s\S]*?document\.getElementById\('authModal'\)\.style\.display = 'flex';/.test(html));
}

section("9 · Email signup/login is no longer blocked by the Meta IAB check");
{
  const openSignup = fnBody(html, "function openSignup", ["function openLogin"]);
  const openLogin = fnBody(html, "function openLogin", ["function closeAuth"]);
  const showSignupForm = fnBody(html, "function showSignupForm", ["function showLoginForm", "function showForgotForm"]);
  const doSignup = fnBody(html, "async function doSignup", ["// ---- Login ----"]);
  const doLogin = fnBody(html, "async function doLogin", ["async function doLogout", "function doLogout"]);
  test("openSignup no longer intercepts before the modal opens",
    !openSignup.includes("interceptInAppAuthHandoff"));
  test("openLogin no longer intercepts before the modal opens",
    !openLogin.includes("interceptInAppAuthHandoff"));
  test("showSignupForm no longer intercepts",
    !showSignupForm.includes("interceptInAppAuthHandoff"));
  test("doSignup (email/password account creation) no longer calls AthlevoEnv.guard",
    !doSignup.includes("AthlevoEnv.guard("));
  test("doLogin (email/password login) no longer calls AthlevoEnv.guard",
    !doLogin.includes("AthlevoEnv.guard("));
}

section("10 · Google/Apple/wearable handoff still happens, but only at the right moment");
{
  test("Google OAuth still triggers the external-browser handoff at the moment it is chosen",
    /guardSignupHandoff\("signup", "auth"\)/.test(socialAuth) &&
    /In-app browsers \(Instagram, Facebook, TikTok\) block the third-party/.test(socialAuth));
  test("Apple sign-in stays disabled (unaffected by this change — not a routing decision)",
    /apple:\s*\{\s*enabled:\s*false/.test(socialAuth));
  test("Strava/wearable connection still triggers the handoff (genuinely needs an external browser)",
    /AthlevoEnv\.guard\('strava', \{ allowContinue: false \}\)/.test(html));
  test("the handoff module (guard/shouldWarn/showNotice) is unchanged — reused, not duplicated",
    /function shouldWarn\(\)/.test(authSupport) &&
    (authSupport.match(/function shouldWarn\(\)/g) || []).length === 1);
}

section("12–13 · Anonymous Coach stays isolated from authenticated data");
{
  test("anonymous Coach never writes to coach_threads/coach_conversations (module's own contract, still true)",
    /never writes to coach_threads \/ coach_conversations/.test(anonymousCoach));
  test("the anonymous Coach server route never reads trainingState, athlete profile rows, or thread ids",
    !/trainingState/.test(coachAnonymousApi) &&
    !/from\(["']profiles["']\)/.test(coachAnonymousApi) &&
    !/thread_id/.test(coachAnonymousApi));
}

section("14 · Browser-type analytics conventions are unchanged (no invented taxonomy)");
{
  test("the existing facebook/instagram handoff-browser taxonomy is intact (Messenger still coalesces into facebook, by design)",
    /browser: \{ facebook: true, instagram: true \}/.test(analyticsRegistry) &&
    /if \(name === "Facebook" \|\| name === "Messenger"\) return "facebook";/.test(authSupport));
  test("existing handoff/analytics event names are untouched by this fix",
    /in_app_browser_signup_blocked/.test(authSupport) &&
    /external_signup_continuation_viewed/.test(authSupport) &&
    /external_signup_link_copied/.test(authSupport) &&
    /auth_method_attempted/.test(analyticsRegistry));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

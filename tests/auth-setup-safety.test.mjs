/*
 * Regression: authenticated user must never remain indefinitely on
 * "Setting up your account…" (screen-auth-setup).
 *
 * Verifies that every code path showing the auth-setup screen has a
 * guaranteed exit — either a try/catch that navigates away, or the
 * global safety timeout.
 *
 * Run: node tests/auth-setup-safety.test.mjs
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");

function sliceFn(name, next) {
  const start = html.indexOf("function " + name);
  const alt = html.indexOf("async function " + name);
  const at = start >= 0 ? start : alt;
  if (at < 0) return "";
  const end = next ? html.indexOf("function " + next, at + 1) : html.length;
  return html.slice(at, end > at ? end : undefined);
}

const showPostAuth = sliceFn("showPostAuthTransition", "claimPostAuthRoute");
const doSignup = sliceFn("doSignup", "doLogin");
const doLogin = sliceFn("doLogin", "doLogout");
const restore = sliceFn("restoreSession", "endBootGate");
const signedIn = html.slice(
  html.indexOf('event === "SIGNED_IN"'),
  html.indexOf("athlevo:native-auth-complete")
);
const beginRouting = sliceFn("beginAuthenticatedRouting", "rememberLandingAuthEntry");

section("Safety timeout on screen-auth-setup");
{
  t("showPostAuthTransition sets a safety timer",
    /authSetupSafetyTimer/.test(showPostAuth) &&
    /setTimeout/.test(showPostAuth));

  t("safety timer checks if screen-auth-setup is still active",
    /screen-auth-setup[\s\S]{0,80}classList\.contains\("active"\)/.test(showPostAuth));

  t("safety timer navigates away on timeout (openAppEntry or showScreen)",
    /openAppEntry|showScreen\("screen-welcome"\)/.test(showPostAuth));

  t("safety timer unlocks auth entry controls",
    /lockAuthEntryControls\(false\)/.test(showPostAuth));

  t("safety timer is cleared when another screen replaces auth-setup",
    /clearTimeout\(window\.__authSetupSafetyTimer\)/.test(html));

  t("showScreen wrapper clears safety timer for non-auth-setup screens",
    /id !== "screen-auth-setup"[\s\S]{0,50}clearTimeout/.test(html) ||
    /clearTimeout[\s\S]{0,50}screen-auth-setup/.test(
      html.slice(html.indexOf("_origShowScreen"), html.indexOf("_origShowScreen") + 300)));
}

section("restoreSession error handling around routeAfterAuth");
{
  // Find all `await routeAfterAuth` calls in restoreSession
  const routeCalls = [...restore.matchAll(/await routeAfterAuth/g)];
  t("restoreSession has routeAfterAuth calls",
    routeCalls.length >= 2,
    `found ${routeCalls.length}`);

  // Every `await routeAfterAuth` in restoreSession must be inside a try block
  for (let i = 0; i < routeCalls.length; i++) {
    const pos = routeCalls[i].index;
    // Look backwards from each call for the nearest try
    const preceding = restore.slice(Math.max(0, pos - 400), pos);
    const hasTry = /try\s*\{/.test(preceding);
    t(`restoreSession routeAfterAuth call #${i + 1} is wrapped in try/catch`,
      hasTry);
  }

  // The catch blocks must navigate away from screen-auth-setup
  const catches = [...restore.matchAll(/catch \(routeErr\)[\s\S]*?\}/g)];
  t("restoreSession catch blocks navigate away on error",
    catches.length >= 2 &&
    catches.every(m => /openAppEntry|showScreen/.test(m[0])));
}

section("doLogin error handling for screen-auth-setup");
{
  t("doLogin catch block checks for stuck auth-setup screen",
    /screen-auth-setup/.test(doLogin) &&
    /classList\.contains\("active"\)/.test(doLogin));

  t("doLogin catch block navigates away if auth-setup is active",
    /screen-auth-setup[\s\S]{0,200}(openAppEntry|showScreen\("screen-welcome"\))/.test(doLogin));
}

section("doSignup error handling for screen-auth-setup");
{
  t("doSignup catch block checks for stuck auth-setup screen",
    /screen-auth-setup/.test(doSignup) &&
    /classList\.contains\("active"\)[\s\S]{0,200}(openAppEntry|showScreen)/.test(doSignup));
}

section("onAuthStateChange error handling");
{
  t("onAuthStateChange routeAfterAuth catch handles auth-setup screen",
    /routeAfterAuth[\s\S]{0,80}\.catch\(function[\s\S]{0,300}screen-auth-setup/.test(signedIn));
}

section("Duplicate auth event ownership");
{
  t("beginAuthenticatedRouting claims ownership before showing auth-setup",
    beginRouting.indexOf("claimPostAuthRoute(userId)") >= 0 &&
    beginRouting.indexOf("claimPostAuthRoute(userId)") <
      beginRouting.indexOf("showPostAuthTransition()"));

  t("duplicate SIGNED_IN exits without repainting auth-setup",
    /__athlevoRoutingFor === nextUserId[\s\S]{0,180}return/.test(signedIn) &&
    !/__athlevoRoutingFor === nextUserId[\s\S]{0,180}showPostAuthTransition/.test(signedIn));

  t("already-claimed restore exits without repainting auth-setup",
    /__athlevoRoutingFor === session\.user\.id[\s\S]{0,180}return true/.test(restore) &&
    !/__athlevoRoutingFor === session\.user\.id[\s\S]{0,180}showPostAuthTransition/.test(restore));
}

section("OAuth pending path has fail-open");
{
  // The OAuth pending path shows showPostAuthTransition and then schedules a fail-open
  t("OAuth pending calls scheduleOAuthHydrationFailOpen after showPostAuthTransition",
    /showPostAuthTransition[\s\S]{0,200}scheduleOAuthHydrationFailOpen/.test(restore));

  // The fail-open timer navigates away from the loading screen
  const failOpen = sliceFn("scheduleOAuthHydrationFailOpen", "showPostAuthTransition");
  t("OAuth hydration fail-open navigates to a usable screen",
    /openAppEntry|openAiSignup|showScreen/.test(failOpen));
}

section("No screen-auth-setup path ends without navigation");
{
  // The routeAfterAuth function itself: every early return after
  // the profile lookup should either call showScreen, startOnboarding,
  // showPaywall, or fall through to showScreen("screen-today")
  const routeAfterAuth = sliceFn("routeAfterAuth", "isStandaloneMode");
  t("routeAfterAuth eventually shows screen-today for paid completed users",
    /showScreen\("screen-today"\)/.test(routeAfterAuth));

  t("routeAfterAuth calls startOnboarding for incomplete profiles",
    /startOnboarding\(\)/.test(routeAfterAuth));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

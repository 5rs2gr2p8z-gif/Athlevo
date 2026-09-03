/*
 * Post-auth transition: confirmed auth must leave signup immediately.
 * Run: node tests/post-auth-transition.test.mjs
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const ui = readFileSync("./js/diagnosticUI.js", "utf8");
const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
const analytics = readFileSync("./js/analytics.js", "utf8");
const meta = readFileSync("./js/metaPixel.js", "utf8");
const authSupport = readFileSync("./js/authSupport.js", "utf8");

function sliceFn(name, next) {
  const start = html.indexOf("function " + name);
  const alt = html.indexOf("async function " + name);
  const at = start >= 0 ? start : alt;
  if (at < 0) return "";
  const end = next ? html.indexOf("function " + next, at + 1) : html.length;
  return html.slice(at, end > at ? end : undefined);
}

const doSignup = sliceFn("doSignup", "doLogin");
const doLogin = sliceFn("doLogin", "doLogout");
const restore = sliceFn("restoreSession", "endBootGate");
const signedIn = html.slice(
  html.indexOf('event === "SIGNED_IN"'),
  html.indexOf("athlevo:native-auth-complete")
);
const init = html.slice(
  html.indexOf("async function initializeAthlevoApp()"),
  html.indexOf("initializeAthlevoApp();")
);

section("Surface");
{
  t("dedicated non-privileged setup screen exists",
    /id="screen-auth-setup"/.test(html) &&
    /Setting up your account/.test(html) &&
    /auth-setup-loader/.test(html));
  t("setup screen is not active in static markup",
    !/<section class="screen[^"]*\bactive\b[^"]*" id="screen-auth-setup"/.test(html));
  t("transition grants no Today, paywall, or paid_active",
    !/paid_active/.test(sliceFn("showPostAuthTransition", "claimPostAuthRoute")) &&
    !/screen-today/.test(sliceFn("showPostAuthTransition", "claimPostAuthRoute")) &&
    !/showPaywall/.test(sliceFn("showPostAuthTransition", "claimPostAuthRoute")));
}

section("Email signup / login");
{
  t("A. doSignup shows transition after confirmed user, before routeAfterAuth",
    doSignup.indexOf("beginAuthenticatedRouting(user.id)") <
      doSignup.indexOf("await routeAfterAuth(user.id)") &&
    doSignup.indexOf("waitForValidUser") <
      doSignup.indexOf("beginAuthenticatedRouting(user.id)"));
  t("A. doSignup no longer reveals welcome via closeAuth-before-route",
    !/closeAuth\(\);\s*try \{\s*if \(window\.AthlevoDiagnosticAcquisition/.test(doSignup));
  t("C. doLogin shows transition after confirmed user, before routeAfterAuth",
    doLogin.indexOf("beginAuthenticatedRouting(user.id)") <
      doLogin.indexOf("await routeAfterAuth(user.id)"));
  t("K. doLogin does not re-enable Log In after success",
    /if \(!authenticatedUser\) \{[\s\S]*?btn\.textContent = 'Log In'/.test(doLogin) &&
    !/if \(btn\) \{ btn\.disabled = false; btn\.textContent = 'Log In'; \}\s*\}\s*\n\s*if \(!authenticatedUser\)/.test(doLogin));
  t("J. locked auth entry blocks openSignup/openLogin",
    /__athlevoAuthEntryLocked/.test(sliceFn("openSignup", "openLogin")) &&
    /__athlevoAuthEntryLocked/.test(sliceFn("openLogin", "closeAuth")));
  t("G. registration_completed still fires from doSignup before the transition",
    doSignup.indexOf("registration_completed") <
      doSignup.indexOf("beginAuthenticatedRouting(user.id)"));
  t("A. beginAuthenticatedRouting itself does not call routeAfterAuth",
    !/routeAfterAuth/.test(sliceFn("beginAuthenticatedRouting", "rememberLandingAuthEntry")));
}

section("Google OAuth");
{
  t("E. pending OAuth does not openAiSignup",
    /aiSignupHandoff && !oauthPending/.test(restore) &&
    /if \(oauthPending\) \{[\s\S]{0,280}showPostAuthTransition/.test(restore));
  t("D. session restore paints transition before routeAfterAuth",
    restore.indexOf("showPostAuthTransition") < restore.lastIndexOf("await routeAfterAuth(session.user.id)"));
  t("F. cancelled/failed OAuth still returns to auth controls",
    /if \(authOAuthReturn\) \{[\s\S]{0,280}openAppEntry/.test(restore));
  t("F. hydration miss has a bounded fail-open, not an infinite spinner",
    /function scheduleOAuthHydrationFailOpen/.test(html) &&
    /__athlevoOAuthHydrationFailMs/.test(html) &&
    /openAiSignup\(\{ fromRestore: true \}\)/.test(sliceFn("scheduleOAuthHydrationFailOpen", "showPostAuthTransition")));
}

section("Duplicate routing");
{
  const begin = sliceFn("beginAuthenticatedRouting", "rememberLandingAuthEntry");
  t("L. claimPostAuthRoute is single-flight per user id",
    /if \(window\.__athlevoRoutingFor === userId\) return false/.test(
      sliceFn("claimPostAuthRoute", "beginAuthenticatedRouting")));
  t("L. transition is painted only after a route claim succeeds",
    begin.indexOf("claimPostAuthRoute(userId)") >= 0 &&
    begin.indexOf("claimPostAuthRoute(userId)") < begin.indexOf("showPostAuthTransition()"));
  t("L. SIGNED_IN reuses beginAuthenticatedRouting instead of a second generation",
    /beginAuthenticatedRouting\(nextUserId\)/.test(signedIn));
  t("L. SIGNED_IN no-ops when routing is already claimed",
    /__athlevoRoutingFor === nextUserId[\s\S]{0,180}return/.test(signedIn));
  t("L. duplicate SIGNED_IN does not repaint the setup transition",
    !/__athlevoRoutingFor === nextUserId[\s\S]{0,180}showPostAuthTransition/.test(signedIn));
  t("L. already-claimed restore does not repaint the setup transition",
    !/__athlevoRoutingFor === session\.user\.id[\s\S]{0,180}showPostAuthTransition/.test(restore));
}

section("Analytics / Meta");
{
  t("G. registration_completed remains milestone-gated once",
    /milestoneStorageKey\("registration_completed"/.test(analytics) &&
    /if \(milestoneSeen\(registrationKey\)\)/.test(analytics));
  t("H. payment_screen_viewed still lives on showPaywall, not transition",
    /function showPaywall[\s\S]{0,900}payment_screen_viewed/.test(acq) &&
    !/payment_screen_viewed/.test(sliceFn("showPostAuthTransition", "claimPostAuthRoute")));
  t("I. Purchase/checkout events are not fired from transition helpers",
    !/checkout_started|payment_completed|Purchase/.test(
      sliceFn("showPostAuthTransition", "rememberLandingAuthEntry")));
  t("Meta mappings unchanged for registration and payment",
    /registration_completed: \{ event:\s*"CompleteRegistration"/.test(meta) &&
    /checkout_started:[\s\S]{0,80}InitiateCheckout/.test(meta) &&
    /payment_completed:[\s\S]{0,80}Purchase/.test(meta) &&
    !/payment_screen_viewed/.test(meta) &&
    !/screen-auth-setup|showPostAuthTransition/.test(meta));
}

section("Acquisition / fail-open / IAB");
{
  t("fromAiSignup snapshot still happens inside routeAfterAuth",
    /var fromAiSignup = false[\s\S]{0,400}hasAiSignupHandoff/.test(
      html.slice(html.indexOf("async function routeAfterAuth"), html.indexOf("async function restoreSession"))));
  t("M. /ai fail-open still runs before restoreSession",
    init.indexOf("earlyStartAnonymousAiDiagnosticIfEligible()") <
      init.indexOf("await restoreSession(") &&
    !/showPostAuthTransition/.test(init.split("await restoreSession")[0]));
  t("N. IAB continuation allowlist is still signup/login only",
    /CONTINUATION_INTENTS = new Set\(\["signup", "login"\]\)/.test(authSupport));
  t("transition does not call AccessGuard or invent paid_active",
    !/AccessGuard|paid_active|verifiedPaidAccess/.test(
      sliceFn("showPostAuthTransition", "rememberLandingAuthEntry")));
  t("K. continueWithGoogle is a no-op while entry controls are locked",
    /if \(window\.__athlevoAuthEntryLocked\) return/.test(
      html.slice(html.indexOf("async function continueWithGoogle"), html.indexOf("async function continueWithApple"))));
  t("startDiagnostic still refuses an authenticated session",
    /if \(root\.athlevoSessionUserId\) \{[\s\S]{0,220}routeAfterAuth/.test(ui));
  t("resolveAfterAuth still checks verified paid access before paywall",
    acq.indexOf("async function resolveAfterAuth") < acq.indexOf("function isPostPaymentOnboarding") &&
    acq.slice(
      acq.indexOf("async function resolveAfterAuth"),
      acq.indexOf("function isPostPaymentOnboarding")
    ).indexOf("verifiedPaidAccess") <
      acq.slice(
        acq.indexOf("async function resolveAfterAuth"),
        acq.indexOf("function isPostPaymentOnboarding")
      ).indexOf("showPaywall"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

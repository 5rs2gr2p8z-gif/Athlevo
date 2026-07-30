/*
 * Athlevo — no-trial acquisition and activation analytics contract.
 *
 * These assertions bind the tested PostHog wrapper to the real UI and exact
 * success paths. Runtime wrapper behavior is exercised in
 * posthog-analytics.test.mjs and social-auth.test.mjs.
 *
 * Run: node tests/signup-funnel-analytics.test.mjs
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const test = (name, condition) => {
  if (condition) {
    passed += 1;
    console.log("PASS — " + name);
  } else {
    failed += 1;
    console.log("FAIL — " + name);
  }
};
const section = name => console.log(`\n──── ${name} ────`);

const html = readFileSync("./index.html", "utf8");
const analytics = readFileSync("./js/analytics.js", "utf8");
const registry = readFileSync("./js/analyticsRegistry.js", "utf8");
const social = readFileSync("./js/socialAuth.js", "utf8");
const onboarding = readFileSync("./js/onboarding.js", "utf8");
const connect = readFileSync("./js/onboardingConnect.js", "utf8");
const plan = readFileSync("./js/planSetup.js", "utf8");
const allRelevant = [
  html, analytics, registry, social, onboarding, connect, plan
].join("\n");

section("Canonical no-trial event schema");

const required = [
  "landing_viewed",
  "signup_cta_clicked",
  "auth_screen_viewed",
  "google_signup_clicked",
  "email_signup_clicked",
  "login_clicked",
  "in_app_browser_signup_blocked",
  "external_signup_link_copied",
  "external_signup_continuation_viewed",
  "registration_completed",
  "onboarding_started",
  "onboarding_completed",
  "first_plan_generated",
  "data_connection_started",
  "data_connection_completed"
];

required.forEach(name => {
  test(`${name} is registered`, new RegExp(`\\b${name}:`).test(registry));
});

test("obsolete trial_cta_clicked is absent", !/trial_cta_clicked/.test(allRelevant));
test("live signup code no longer emits free_account_created",
  !/trackAthlevoEvent\(['"]free_account_created/.test(allRelevant));
test("legacy signup_started/signup_completed calls are absent",
  !/track(?:Funnel)?\(["']signup_(?:started|completed)/.test(allRelevant));

section("Landing and auth intent");

const ctaTags = Array.from(html.matchAll(
  /<button[^>]*data-cta-location="([^"]+)"[^>]*onclick="landingStartFree\(this\)"[^>]*>Build My Training Plan<\/button>/g
));
test("all four public signup CTAs carry an explicit location",
  ctaTags.length === 4);
test("CTA locations cover navigation, hero, mid-page, and footer",
  ["navigation", "hero", "mid_page", "footer"].every(location =>
    ctaTags.some(match => match[1] === location)));
test("signup CTA captures text, location, and auth destination",
  /trackAuthChoice\("signup_cta_clicked",\s*\{[\s\S]*?cta_text:[\s\S]*?cta_location:[\s\S]*?destination:\s*"screen-welcome"/.test(html));
test("logged-in landing users bypass signup intent analytics",
  /function landingStartFree\(trigger\)[\s\S]*?if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); return; \}[\s\S]*?signup_cta_clicked/.test(html));
test("landing view supplies URL, path, and referrer context",
  /landing_viewed[\s\S]*?AthlevoProductAnalytics\.landingProps\(\)/.test(html) &&
  /page_url:[\s\S]*?page_path:[\s\S]*?referrer/.test(analytics));
test("auth screen view uses remembered entry source and previous page",
  /auth_screen_viewed[\s\S]*?AthlevoProductAnalytics\.authEntryProps\(\)/.test(html) &&
  /entry_source:[\s\S]*?previous_page:/.test(analytics));
test("email signup and login intent use separate event names",
  /trackAuthChoice\("email_signup_clicked"\)/.test(html) &&
  /trackAuthChoice\("login_clicked"/.test(html));
test("Google signup is gated by a logged-out Supabase session",
  /loggedOut = !\(data && data\.session && data\.session\.user\)/.test(social) &&
  /providerKey === "google" && loggedOut/.test(social));

section("Confirmed success conditions");

const signupFlow = html.slice(
  html.indexOf("async function doSignup"),
  html.indexOf("// ---- Login ----")
);
test("email registration requires Supabase's non-empty new identity result",
  /completeRegistration\([\s\S]*?data\.user,[\s\S]*?"email",[\s\S]*?Array\.isArray\(data\.user\.identities\)[\s\S]*?data\.user\.identities\.length > 0/.test(signupFlow));
test("existing email handling occurs before registration completion",
  signupFlow.indexOf("data.user.identities.length === 0") <
  signupFlow.indexOf("completeRegistration("));
test("Google registration is completed only from restored verified user data",
  /completeOAuthRegistration\(session\.user\)/.test(html) &&
  /isGenuinelyNewOAuthUser\(user, intent\)/.test(analytics));
test("Google new-account proof compares creation, sign-in, and pending-intent time",
  /Math\.abs\(signedIn - created\) <= 120000/.test(analytics) &&
  /created >= started - 120000/.test(analytics));

const saveIndex = onboarding.indexOf("await obSaveProgress(lastStep)");
const finishIndex = onboarding.indexOf("await obFinish()", saveIndex);
const completedIndex = onboarding.indexOf('"onboarding_completed"', finishIndex);
test("onboarding completion follows the confirmed required-profile save",
  saveIndex >= 0 && finishIndex > saveIndex && completedIndex > finishIndex);
test("onboarding started only for a new registration or newly created profile",
  /const newlyRegistered = Boolean\([\s\S]*?__athlevoNewProfile[\s\S]*?isNewRegistration\(obProfile\.id\)/.test(onboarding) &&
  /if \(newlyRegistered && window\.AthlevoProductAnalytics\)/.test(onboarding));

test("first plan requires a saved plan and at least one dated saved session",
  /data\.success === true[\s\S]*?plan\.id[\s\S]*?sessions\.some\(session => session && session\.session_date\)/.test(plan));
test("first plan event excludes already-existing plan responses",
  /outcome\.alreadyExists !== true && outcome\.firstUsableSaved === true/.test(plan));
test("first plan event includes user, goal distance, and start date when available",
  /user_id: userId/.test(plan) &&
  /props\.goal_distance = goal/.test(plan) &&
  /props\.plan_start_date = start/.test(plan));

const authorizeIndex = connect.indexOf("async function authorize()");
test("connection start fires before provider OAuth begins",
  connect.indexOf("'data_connection_started'", authorizeIndex) <
  connect.indexOf("await DS().connect()", authorizeIndex));
test("connection completion follows a confirmed connected status",
  connect.indexOf("status.connected !== true") <
  connect.indexOf('"data_connection_completed"'));
test("OAuth finalize completion follows successful server confirmation",
  html.indexOf("await AthlevoBrain.finalizeIntervals(completion)") <
  html.indexOf('"data_connection_completed"', html.indexOf("await AthlevoBrain.finalizeIntervals(completion)")));

section("Attribution, deduplication, and privacy");

test("all requested attribution keys are captured and session-persisted",
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"]
    .every(key => analytics.includes(`"${key}"`)) &&
  /sessionStorage\.setItem\(ATTRIBUTION_KEY/.test(analytics));
test("landing URL keeps only approved attribution query keys",
  /ATTRIBUTION_KEYS\.indexOf\(key\) === -1\) url\.searchParams\.delete\(key\)/.test(analytics));
test("view rerenders and user milestones have distinct duplicate guards",
  /VIEW_EVENTS/.test(analytics) &&
  /trackUserMilestone/.test(analytics) &&
  /MILESTONE_PREFIX/.test(analytics));
test("behavioural CTA events are not configured as once-per-view",
  !/VIEW_EVENTS\s*=\s*\{[^}]*signup_cta_clicked/.test(analytics));
test("analytics property sanitizer rejects secret-bearing keys",
  /token\|secret\|code\|password\|email/.test(analytics));

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

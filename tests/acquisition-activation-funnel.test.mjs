/*
 * Executable acquisition → first-value contract for the no-trial funnel.
 * Run: node tests/acquisition-activation-funnel.test.mjs
 */

import { readFileSync } from "node:fs";

const registrySource = readFileSync("./js/analyticsRegistry.js", "utf8");
const analyticsSource = readFileSync("./js/analytics.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");
const planSource = readFileSync("./js/planSetup.js", "utf8");
const connectSource = readFileSync("./js/onboardingConnect.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) {
    passed += 1;
    console.log("PASS — " + name);
  } else {
    failed += 1;
    console.log("FAIL — " + name);
  }
}

function storage(seed = {}) {
  const values = { ...seed };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : null;
    },
    setItem(key, value) { values[key] = String(value); },
    removeItem(key) { delete values[key]; },
    _values: values
  };
}

function runtime({
  search = "",
  localSeed = {},
  sessionSeed = {},
  activeScreen = "screen-landing",
  visible = true
} = {}) {
  const events = [];
  const identified = [];
  let resets = 0;
  const localStorage = storage(localSeed);
  const sessionStorage = storage(sessionSeed);
  const state = { activeScreen, visible };
  const document = {
    referrer: "https://facebook.com/ad?private=1",
    visibilityState: visible ? "visible" : "hidden",
    body: { classList: { contains: () => false } },
    documentElement: { clientWidth: 390, clientHeight: 844 },
    querySelector: () => null,
    getElementById(id) {
      return {
        hidden: false,
        classList: { contains: value =>
          value === "active" && state.activeScreen === id },
        getAttribute: () => null,
        getBoundingClientRect: () => ({
          top: 0, left: 0, right: 390, bottom: 700,
          width: 390, height: 700
        })
      };
    }
  };
  const window = {
    document,
    navigator: { userAgent: "Mozilla/5.0 (iPhone) Mobile" },
    localStorage,
    sessionStorage,
    innerWidth: 390,
    innerHeight: 844,
    location: {
      origin: "https://athlevo.org",
      pathname: "/",
      search,
      href: "https://athlevo.org/" + search,
      hash: ""
    },
    POSTHOG_KEY: "phc_test",
    posthog: {
      init() {},
      capture(name, props) { events.push({ name, props }); },
      identify(id) { identified.push(id); },
      reset() { resets += 1; },
      _i: [],
      __SV: 1
    }
  };
  window.window = window;
  new Function("window", registrySource)(window);
  new Function(
    "window", "document", "navigator", "localStorage", "sessionStorage",
    analyticsSource
  )(window, document, window.navigator, localStorage, sessionStorage);
  return {
    api: window.AthlevoProductAnalytics,
    events,
    identified,
    resetCount: () => resets,
    localStorage,
    sessionStorage,
    setScreen(id) { state.activeScreen = id; },
    setVisible(value) {
      state.visible = value;
      document.visibilityState = value ? "visible" : "hidden";
    }
  };
}

function beginPublicFunnel(value, method) {
  value.api.trackVisibleScreenView(
    "landing_viewed",
    "screen-landing",
    value.api.landingProps()
  );
  value.api.trackAthlevoEvent("signup_cta_clicked", {
    cta_text: "Build My Training Plan",
    cta_location: "hero",
    destination: "screen-welcome"
  });
  value.setScreen("screen-welcome");
  value.api.trackVisibleScreenView(
    "auth_screen_viewed",
    "screen-welcome",
    value.api.authEntryProps()
  );
  value.api.trackAthlevoEvent(
    method === "google" ? "google_signup_clicked" : "email_signup_clicked"
  );
  value.api.beginSignupIntent(method);
}

function finishAuthenticatedFunnel(value, userId, provider) {
  value.api.trackUserMilestone("onboarding_started", userId);
  value.api.trackUserMilestone("onboarding_completed", userId);
  value.api.trackAthlevoEvent("data_connection_started", {
    provider,
    source_surface: "provider_connection"
  });
  value.api.trackUserMilestone("data_connection_completed", userId, {
    provider
  });
  value.api.trackUserMilestone("first_plan_generated", userId, {
    user_id: userId,
    goal_distance: "marathon",
    plan_start_date: "2026-08-03"
  });
  value.setScreen("screen-train");
  value.api.trackVisibleUserMilestone(
    "first_value_viewed",
    userId,
    "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
  value.api.trackVisibleUserMilestone(
    "activation_completed",
    userId,
    "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
}

const expectedGoogle = [
  "landing_viewed",
  "signup_cta_clicked",
  "auth_screen_viewed",
  "google_signup_clicked",
  "registration_completed",
  "onboarding_started",
  "onboarding_completed",
  "data_connection_started",
  "data_connection_completed",
  "first_plan_generated",
  "first_value_viewed",
  "activation_completed"
];

console.log("\n──── Successful signup funnels ────");
{
  const value = runtime({
    search: "?utm_source=meta&utm_medium=paid_social&utm_campaign=launch&fbclid=fb-123"
  });
  beginPublicFunnel(value, "google");
  const now = Date.now();
  const created = value.api.completeOAuthRegistration({
    id: "google-user",
    created_at: new Date(now - 500).toISOString(),
    last_sign_in_at: new Date(now - 200).toISOString()
  });
  finishAuthenticatedFunnel(value, "google-user", "strava");
  test("full successful Google + Strava funnel has the authoritative order",
    created === true &&
    JSON.stringify(value.events.map(event => event.name)) ===
      JSON.stringify(expectedGoogle));
  test("Google registration identifies only the verified Supabase UUID",
    JSON.stringify(value.identified) === JSON.stringify(["google-user"]));
  const activation = value.events.find(event =>
    event.name === "activation_completed");
  test("activation retains approved Meta attribution",
    activation.props.utm_source === "meta" &&
    activation.props.utm_medium === "paid_social" &&
    activation.props.utm_campaign === "launch" &&
    activation.props.fbclid === "fb-123");
}

{
  const value = runtime({
    search: "?utm_source=google&utm_medium=cpc&utm_campaign=marathon"
  });
  beginPublicFunnel(value, "email");
  const created = value.api.completeRegistration(
    { id: "email-user" },
    "email",
    true
  );
  finishAuthenticatedFunnel(value, "email-user", "intervals");
  const expected = expectedGoogle.map(name =>
    name === "google_signup_clicked" ? "email_signup_clicked" : name
  );
  test("full successful email + Intervals funnel has the authoritative order",
    created === true &&
    JSON.stringify(value.events.map(event => event.name)) ===
      JSON.stringify(expected));
}

console.log("\n──── Alternate and failed activation paths ────");
{
  const value = runtime();
  beginPublicFunnel(value, "email");
  value.api.completeRegistration({ id: "skip-user" }, "email", true);
  value.api.trackUserMilestone("onboarding_started", "skip-user");
  value.api.trackUserMilestone("onboarding_completed", "skip-user");
  value.api.trackUserMilestone("provider_skipped", "skip-user", {
    source_surface: "onboarding"
  });
  value.api.trackUserMilestone("first_plan_generated", "skip-user", {
    user_id: "skip-user"
  });
  value.setScreen("screen-train");
  value.api.trackVisibleUserMilestone(
    "first_value_viewed", "skip-user", "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
  value.api.trackVisibleUserMilestone(
    "activation_completed", "skip-user", "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
  const names = value.events.map(event => event.name);
  test("provider skip can activate without a false connection completion",
    names.includes("provider_skipped") &&
    names.includes("activation_completed") &&
    !names.includes("data_connection_completed"));
}

{
  const value = runtime();
  value.api.trackAthlevoEvent("data_connection_started", {
    provider: "strava",
    source_surface: "provider_connection"
  });
  value.api.trackAthlevoEvent("data_connection_failed", {
    stage: "provider_callback",
    failure_category: "cancelled",
    provider: "strava",
    source_surface: "provider_connection",
    raw_error: "private provider response"
  });
  const names = value.events.map(event => event.name);
  test("provider cancellation/failure never emits a completion",
    JSON.stringify(names) === JSON.stringify([
      "data_connection_started", "data_connection_failed"
    ]));
  test("provider failure contains categorical fields only",
    JSON.stringify(Object.keys(value.events[1].props).sort()) ===
      JSON.stringify([
        "failure_category", "provider", "source_surface", "stage"
      ]));
}

{
  const value = runtime();
  value.api.trackAthlevoEvent("plan_generation_failed", {
    stage: "plan_generation",
    failure_category: "provider",
    source_surface: "plan_generation"
  });
  test("plan failure does not synthesize first value or activation",
    value.events.length === 1 &&
    value.events[0].name === "plan_generation_failed");
  const failureBody = planSource.slice(
    planSource.indexOf("function trackPlanFailure"),
    planSource.indexOf("async function trackFirstPlanGenerated")
  );
  test("production plan failure branch contains no activation completion",
    !/activation_completed/.test(failureBody));
}

console.log("\n──── Visibility, replay, restoration, and privacy ────");
{
  const hidden = runtime({ activeScreen: "screen-train", visible: false });
  const emitted = hidden.api.trackVisibleUserMilestone(
    "first_value_viewed", "user-1", "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
  test("hidden personalized rendering does not emit first_value_viewed",
    emitted === false && hidden.events.length === 0);
}

{
  const first = runtime();
  first.api.completeRegistration({ id: "user-1" }, "email", true);
  first.api.trackUserMilestone("onboarding_completed", "user-1");
  const refreshed = runtime({
    localSeed: first.localStorage._values,
    sessionSeed: first.sessionStorage._values
  });
  const registrationReplay = refreshed.api.completeRegistration(
    { id: "user-1" }, "email", true
  );
  const onboardingReplay = refreshed.api.trackUserMilestone(
    "onboarding_completed", "user-1"
  );
  test("refresh and callback replay do not duplicate milestones",
    registrationReplay === false &&
    onboardingReplay === false &&
    refreshed.events.length === 0);
}

{
  const first = runtime({
    search: "?utm_source=meta&utm_medium=paid_social&fbclid=fb-handoff"
  });
  const continuation = runtime({
    localSeed: first.localStorage._values
  });
  continuation.api.trackAthlevoEvent("registration_completed", {
    signup_method: "google",
    user_id: "handoff-user"
  });
  const props = continuation.events[0].props;
  test("UTM/fbclid survive an app close/reopen on the same browser",
    props.utm_source === "meta" &&
    props.utm_medium === "paid_social" &&
    props.fbclid === "fb-handoff");
  test("Facebook/Safari handoff code preserves attribution but excludes auth secrets",
    /utm_source/.test(indexSource + readFileSync("./js/authSupport.js", "utf8")) &&
    !/APPROVED_QUERY_KEYS[\s\S]*?(?:access_token|refresh_token|code)/.test(
      readFileSync("./js/authSupport.js", "utf8")
    ));
}

{
  const value = runtime();
  value.api.identifyAthlete({ id: "user-1" });
  value.api.resetAthleteAnalytics();
  test("logout resets PostHog identity",
    value.resetCount() === 1);
  test("logout clears the pending new-registration and attribution state",
    value.localStorage.getItem("athlevo_new_registration_v1") === null &&
    value.localStorage.getItem("athlevo_utm_persistent_v1") === null);
}

{
  const value = runtime();
  value.api.trackAthlevoEvent("activation_failed", {
    stage: "first_value",
    failure_category: "validation",
    source_surface: "train",
    email: "athlete@example.com",
    token: "secret",
    message: "private",
    pain: "health data",
    raw_error: "stack"
  });
  const dump = JSON.stringify(value.events);
  test("failure analytics exclude sensitive and free-form values",
    !/athlete@example|secret|private|health data|stack/.test(dump) &&
    JSON.stringify(value.events[0].props) === JSON.stringify({
      stage: "first_value",
      failure_category: "validation",
      source_surface: "train"
    }));
}

test("Intervals onboarding renderer never emits completion from existing status",
  !/data_connection_completed/.test(connectSource));
test("first value production call is gated by active Train visibility",
  /screenIsVisible\("screen-train"\)/.test(planSource) &&
  /trackVisibleUserMilestone\(\s*"first_value_viewed"/.test(planSource));

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/*
 * Athlevo — PostHog product analytics tests (js/analytics.js)
 *
 * Covers: event names, success-only firing, identity/reset, duplicate
 * protection, UTM persistence, safe property sanitization.
 *
 * Run: node tests/posthog-analytics.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (name, cond, extra) => {
  if (cond) { p++; console.log("PASS — " + name); }
  else { f++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = s => console.log(`\n──── ${s} ────`);

/* ── helper: build a fresh analytics sandbox ─────────────────────── */

function makeAnalytics(opts = {}) {
  const captured = [];
  const identified = [];
  let resetCount = 0;

  const win = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    navigator: { userAgent: opts.userAgent || "Mozilla/5.0 (Macintosh)" },
    localStorage: (() => {
      const store = Object.assign({}, opts.localStore || {});
      return {
        getItem: k => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _store: store
      };
    })(),
    sessionStorage: (() => {
      const store = Object.assign({}, opts.sessionStore || {});
      return {
        getItem: k => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _store: store
      };
    })(),
    location: {
      origin: opts.origin || "https://athlevo.org",
      pathname: opts.pathname || "/",
      search: opts.search || "",
      hash: "",
      href: (opts.origin || "https://athlevo.org") +
        (opts.pathname || "/") + (opts.search || "")
    },
    document: {
      referrer: opts.referrer || "",
      visibilityState: opts.visibilityState || "visible",
      body: { classList: { contains: value => value === "booting" && opts.booting === true } },
      documentElement: { clientWidth: 390, clientHeight: 844 },
      querySelector: () => opts.metaContent ? { content: opts.metaContent } : null,
      getElementById: id => {
        if (id !== opts.screenId) return null;
        return {
          hidden: false,
          classList: { contains: value => value === "active" && opts.screenActive === true },
          getAttribute: () => null,
          getBoundingClientRect: () => ({ top: 0, left: 0, right: 390, bottom: 700, width: 390, height: 700 })
        };
      }
    }
  };
  win.innerWidth = 390;
  win.innerHeight = 844;

  // Inject a mock PostHog if a key is set
  if (opts.key) {
    win.POSTHOG_KEY = opts.key;
    win.posthog = {
      init: function () {},
      capture: function (name, props) { captured.push({ name, props }); },
      identify: function (id) { identified.push(id); },
      reset: function () { resetCount++; },
      _i: [], __SV: 1
    };
  }

  // Execute analytics.js in our sandbox
  const code = readFileSync("./js/analytics.js", "utf8");
  const fn = new Function("window", "document", "navigator", "localStorage", "sessionStorage",
    code.replace(
      /\}\)\(typeof window[\s\S]*$/,
      "})(window);"
    )
  );
  const registryCode = readFileSync("./js/analyticsRegistry.js", "utf8");
  new Function("window", registryCode)(win);
  fn(win, win.document, win.navigator, win.localStorage, win.sessionStorage);

  return {
    api: win.AthlevoProductAnalytics,
    captured,
    identified,
    resetCount: () => resetCount,
    win
  };
}

/* ═══════════════════════════════════════════════════════════════════ */

section("Module loading");

t("exports AthlevoProductAnalytics on window", (() => {
  const { api } = makeAnalytics();
  return api && typeof api.trackAthlevoEvent === "function"
    && typeof api.identifyAthlete === "function"
    && typeof api.resetAthleteAnalytics === "function";
})());

t("does not throw when PostHog key is absent", (() => {
  try {
    const { api } = makeAnalytics();
    api.trackAthlevoEvent("test_event");
    api.identifyAthlete({ id: "123" });
    api.resetAthleteAnalytics();
    return true;
  } catch (e) { return false; }
})());

/* ─────────────────────── event names ─────────────────────────────── */
section("Event names");

const EXPECTED_EVENTS = [
  "landing_viewed", "signup_cta_clicked", "auth_screen_viewed",
  "google_signup_clicked", "email_signup_clicked", "login_clicked",
  "in_app_browser_signup_blocked", "external_signup_link_copied",
  "external_signup_continuation_viewed",
  "registration_completed", "onboarding_started", "onboarding_completed",
  "data_connection_started", "provider_skipped", "data_connection_completed",
  "first_plan_generated", "first_value_viewed", "activation_completed",
  "signup_failed", "onboarding_failed", "data_connection_failed",
  "plan_generation_failed", "activation_failed",
  "free_limit_reached", "premium_feature_viewed", "upgrade_clicked",
  "upgrade_sheet_viewed", "checkout_started", "checkout_failed",
  "subscription_activated", "readiness_prompt_shown",
  "readiness_prompt_dismissed", "readiness_check_completed",
  "coach_message_submitted",
  "coach_message_completed", "coach_weekly_limit_reached",
  "coach_request_failed", "app_returned"
];

EXPECTED_EVENTS.forEach(name => {
  t(`trackAthlevoEvent("${name}") captures to PostHog`, (() => {
    const { api, captured } = makeAnalytics({ key: "phc_test" });
    api.trackAthlevoEvent(name);
    return captured.length === 1 && captured[0].name === name;
  })());
});

t("obsolete aliases capture only their canonical event name", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("checkout_opened", {
    feature: "trends",
    surface: "upgrade_sheet"
  });
  return captured.length === 1 && captured[0].name === "checkout_started";
})());

t("unknown event names are rejected before PostHog capture", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  return api.trackAthlevoEvent("made_up_conversion") === false &&
    captured.length === 0;
})());

/* ─────────────── duplicate protection ────────────────────────────── */
section("Duplicate protection");

t("same event fires only once per page load", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("landing_viewed");
  api.trackAthlevoEvent("landing_viewed");
  api.trackAthlevoEvent("landing_viewed");
  return captured.length === 1;
})());

t("different events each fire once", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("landing_viewed");
  api.trackAthlevoEvent("upgrade_clicked");
  return captured.length === 2;
})());

t("behavioural CTA clicks are not collapsed into one event", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("signup_cta_clicked", { cta_location: "hero" });
  api.trackAthlevoEvent("signup_cta_clicked", { cta_location: "footer" });
  return captured.length === 2 &&
    captured[0].props.cta_location === "hero" &&
    captured[1].props.cta_location === "footer";
})());

t("reset clears dedup state so events can fire again", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("landing_viewed");
  api.resetAthleteAnalytics();
  api.trackAthlevoEvent("landing_viewed");
  return captured.length === 2;
})());

t("behavioural events may fire again in a new browser session", (() => {
  const first = makeAnalytics({ key: "phc_test" });
  first.api.trackAthlevoEvent("data_connection_started", {
    provider: "strava",
    source_surface: "provider_connection"
  });
  const next = makeAnalytics({
    key: "phc_test",
    localStore: first.win.localStorage._store
  });
  next.api.trackAthlevoEvent("data_connection_started", {
    provider: "strava",
    source_surface: "provider_connection"
  });
  return first.captured.length === 1 && next.captured.length === 1;
})());

/* ─────────────── identity / reset ────────────────────────────────── */
section("Identity and reset");

t("identifyAthlete calls posthog.identify with user.id", (() => {
  const { api, identified } = makeAnalytics({ key: "phc_test" });
  api.identifyAthlete({ id: "uuid-abc-123" });
  return identified.length === 1 && identified[0] === "uuid-abc-123";
})());

t("identifyAthlete is safe with null/undefined user", (() => {
  try {
    const { api, identified } = makeAnalytics({ key: "phc_test" });
    api.identifyAthlete(null);
    api.identifyAthlete(undefined);
    api.identifyAthlete({});
    return identified.length === 0;
  } catch (e) { return false; }
})());

t("resetAthleteAnalytics calls posthog.reset", (() => {
  const { api, resetCount } = makeAnalytics({ key: "phc_test" });
  api.resetAthleteAnalytics();
  return resetCount() === 1;
})());

/* ─────────────── safe properties / sanitization ──────────────────── */
section("Property sanitization");

t("only SAFE_PROPS pass through", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("registration_completed", {
    signup_method: "google",
    user_id: "user-123",
    source: "landing",
    email: "user@test.com",         // prohibited
    token: "secret123",             // prohibited
    password: "abc",                // prohibited
    message: "hello",               // prohibited
    some_random_field: "dropped"    // not in SAFE_PROPS
  });
  const props = captured[0].props;
  return props.signup_method === "google"
    && props.user_id === "user-123"
    && props.source === "landing"
    && !("email" in props)
    && !("token" in props)
    && !("password" in props)
    && !("message" in props)
    && !("some_random_field" in props);
})());

t("boolean and number values pass through for safe keys", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("registration_completed", {
    is_first_time: true,
    source: "test"
  });
  const props = captured[0].props;
  return props.is_first_time === true && props.source === "test";
})());

t("overly long strings are dropped", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("registration_completed", {
    source: "a".repeat(100)   // > 80 chars
  });
  return !("source" in captured[0].props) || captured[0].props.source !== "a".repeat(100);
})());

t("premium events contain only categorical feature and surface", (() => {
  const { api, captured } = makeAnalytics({
    key: "phc_test",
    search: "?utm_source=private-campaign"
  });
  api.trackAthlevoEvent("premium_feature_viewed", {
    feature: "recovery",
    surface: "today",
    source: "feature_gate",
    readiness: 72,
    score: 88
  });
  const props = captured[0].props;
  return JSON.stringify(Object.keys(props).sort()) ===
    JSON.stringify(["feature", "surface"]) &&
    props.feature === "recovery" &&
    props.surface === "today";
})());

t("handoff events contain only allowlisted categorical properties", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("in_app_browser_signup_blocked", {
    browser: "facebook",
    intent: "signup",
    source_surface: "landing",
    page_url: "https://athlevo.org/?code=secret",
    utm_source: "meta",
    email: "athlete@example.com"
  });
  return captured.length === 1 &&
    JSON.stringify(captured[0].props) === JSON.stringify({
      browser: "facebook",
      intent: "signup",
      source_surface: "landing"
    });
})());

t("Coach events contain only access/failure/surface categories", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("coach_request_failed", {
    access_tier: "free",
    failure_category: "timeout",
    source_surface: "coach",
    message: "private Coach question",
    page_url: "https://athlevo.org/?private=1",
    score: 72
  });
  return captured.length === 1 &&
    JSON.stringify(captured[0].props) === JSON.stringify({
      access_tier: "free",
      failure_category: "timeout",
      source_surface: "coach"
    });
})());

t("invalid handoff categories are discarded", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("external_signup_link_copied", {
    browser: "other",
    intent: "https://evil.example",
    source_surface: "unknown"
  });
  return captured.length === 1 &&
    Object.keys(captured[0].props).length === 0;
})());

t("CTA text is limited to the approved public acquisition label", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("signup_cta_clicked", {
    cta_text: "private athlete note",
    cta_location: "hero",
    destination: "screen-welcome"
  });
  return !("cta_text" in captured[0].props) &&
    captured[0].props.cta_location === "hero";
})());

t("caller-supplied analytics URLs cannot carry OAuth or email query data", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("landing_viewed", {
    page_url: "https://athlevo.org/?utm_source=meta&code=secret&email=a@example.com",
    referrer: "https://example.com/path?token=secret"
  });
  const props = captured[0].props;
  return props.page_url === "https://athlevo.org/?utm_source=meta" &&
    props.referrer === "https://example.com/path";
})());

/* ─────────────── UTM capture and persistence ─────────────────────── */
section("UTM parameters");

t("captures UTM from URL and includes in events", (() => {
  const { api, captured } = makeAnalytics({
    key: "phc_test",
    search: "?utm_source=google&utm_medium=cpc&utm_campaign=beta"
  });
  api.trackAthlevoEvent("landing_viewed");
  const props = captured[0].props;
  return props.utm_source === "google"
    && props.utm_medium === "cpc"
    && props.utm_campaign === "beta";
})());

t("captures the complete approved attribution set", (() => {
  const { api, captured } = makeAnalytics({
    key: "phc_test",
    search: "?utm_source=meta&utm_medium=paid_social&utm_campaign=launch" +
      "&utm_content=video_a&utm_term=marathon&fbclid=fb-click-123"
  });
  api.trackAthlevoEvent("registration_completed", {
    signup_method: "google",
    user_id: "user-123"
  });
  const props = captured[0].props;
  return props.utm_source === "meta" &&
    props.utm_medium === "paid_social" &&
    props.utm_campaign === "launch" &&
    props.utm_content === "video_a" &&
    props.utm_term === "marathon" &&
    props.fbclid === "fb-click-123";
})());

t("persists UTM in sessionStorage and restores", (() => {
  // First "page load" — capture UTMs
  const { win } = makeAnalytics({
    key: "phc_test",
    search: "?utm_source=twitter&utm_medium=social&utm_campaign=launch"
  });
  const stored = win.sessionStorage.getItem("athlevo_utm");
  const parsed = JSON.parse(stored);
  return parsed && parsed.utm_source === "twitter" && parsed.utm_medium === "social";
})());

t("UTM and fbclid restore after app close clears sessionStorage", (() => {
  const first = makeAnalytics({
    key: "phc_test",
    search: "?utm_source=meta&utm_medium=paid_social&utm_campaign=launch&fbclid=fb-123"
  });
  const reopened = makeAnalytics({
    key: "phc_test",
    localStore: first.win.localStorage._store
  });
  reopened.api.trackAthlevoEvent("activation_completed", {
    value_type: "training_plan",
    source_surface: "train"
  });
  const props = reopened.captured[0] && reopened.captured[0].props;
  return props &&
    props.utm_source === "meta" &&
    props.utm_medium === "paid_social" &&
    props.utm_campaign === "launch" &&
    props.fbclid === "fb-123";
})());

t("landing context strips non-attribution query values and referrer queries", (() => {
  const { api } = makeAnalytics({
    search: "?utm_source=meta&code=oauth-secret&email=private@example.com",
    pathname: "/campaign",
    referrer: "https://facebook.com/ad?private_id=123#profile"
  });
  const props = api.landingProps();
  return props.page_path === "/campaign" &&
    props.page_url.includes("utm_source=meta") &&
    !props.page_url.includes("oauth-secret") &&
    !props.page_url.includes("private%40example.com") &&
    props.referrer === "https://facebook.com/ad";
})());

/* ─────────────── registration and milestone guards ───────────────── */
section("Registration and milestone guards");

t("registration_completed requires an explicitly confirmed new account", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  const existing = api.completeRegistration(
    { id: "existing-user" }, "email", false
  );
  const created = api.completeRegistration(
    { id: "new-user" }, "email", true
  );
  return existing === false && created === true &&
    captured.length === 1 &&
    captured[0].name === "registration_completed" &&
    captured[0].props.signup_method === "email" &&
    captured[0].props.user_id === "new-user";
})());

t("registration completion is not repeated for the same user", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.completeRegistration({ id: "new-user" }, "email", true);
  api.completeRegistration({ id: "new-user" }, "email", true);
  return captured.filter(event => event.name === "registration_completed").length === 1;
})());

t("registration completion remains deduplicated after a refresh", (() => {
  const first = makeAnalytics({ key: "phc_test" });
  first.api.completeRegistration({ id: "new-user" }, "email", true);
  const refreshed = makeAnalytics({
    key: "phc_test",
    sessionStore: first.win.sessionStorage._store,
    localStore: first.win.localStorage._store
  });
  const repeated = refreshed.api.completeRegistration(
    { id: "new-user" }, "email", true
  );
  return repeated === false &&
    !refreshed.captured.some(event => event.name === "registration_completed");
})());

t("Google completion accepts a recent new account and rejects an existing one", (() => {
  const now = Date.now();
  const freshStore = {
    athlevo_signup_intent_v1: JSON.stringify({
      method: "google",
      started_at: now - 1000
    })
  };
  const fresh = makeAnalytics({
    key: "phc_test",
    sessionStore: freshStore
  });
  const freshResult = fresh.api.completeOAuthRegistration({
    id: "google-new",
    created_at: new Date(now - 900).toISOString(),
    last_sign_in_at: new Date(now - 500).toISOString()
  });

  const old = makeAnalytics({
    key: "phc_test",
    sessionStore: {
      athlevo_signup_intent_v1: JSON.stringify({
        method: "google",
        started_at: now - 1000
      })
    }
  });
  const oldResult = old.api.completeOAuthRegistration({
    id: "google-existing",
    created_at: new Date(now - 86400000).toISOString(),
    last_sign_in_at: new Date(now - 500).toISOString()
  });
  return freshResult === true &&
    fresh.captured.some(event => event.name === "registration_completed") &&
    oldResult === false &&
    !old.captured.some(event => event.name === "registration_completed");
})());

t("user milestones survive rerenders within the signup session", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackUserMilestone("onboarding_started", "user-1");
  api.trackUserMilestone("onboarding_started", "user-1");
  api.trackUserMilestone("onboarding_completed", "user-1");
  api.trackUserMilestone("onboarding_completed", "user-1");
  return captured.filter(event => event.name === "onboarding_started").length === 1 &&
    captured.filter(event => event.name === "onboarding_completed").length === 1;
})());

t("user milestones remain deduplicated after a refresh", (() => {
  const first = makeAnalytics({ key: "phc_test" });
  first.api.trackUserMilestone("data_connection_completed", "user-1", {
    provider: "intervals"
  });
  const refreshed = makeAnalytics({
    key: "phc_test",
    sessionStore: first.win.sessionStorage._store,
    localStore: first.win.localStorage._store
  });
  refreshed.api.trackUserMilestone("data_connection_completed", "user-1", {
    provider: "intervals"
  });
  return !refreshed.captured.some(event =>
    event.name === "data_connection_completed");
})());

t("user milestones remain deduplicated after sessionStorage is cleared", (() => {
  const first = makeAnalytics({ key: "phc_test" });
  first.api.trackUserMilestone("first_plan_generated", "user-1", {
    user_id: "user-1"
  });
  const reopened = makeAnalytics({
    key: "phc_test",
    localStore: first.win.localStorage._store
  });
  const repeated = reopened.api.trackUserMilestone(
    "first_plan_generated",
    "user-1",
    { user_id: "user-1" }
  );
  return repeated === false && reopened.captured.length === 0;
})());

t("milestones use the same anonymous insertion key across simultaneous tabs", (() => {
  const one = makeAnalytics({ key: "phc_test" });
  const two = makeAnalytics({ key: "phc_test" });
  one.api.trackUserMilestone("activation_completed", "user-1", {
    value_type: "training_plan",
    source_surface: "train"
  });
  two.api.trackUserMilestone("activation_completed", "user-1", {
    value_type: "training_plan",
    source_surface: "train"
  });
  const a = one.captured[0] && one.captured[0].props.$insert_id;
  const b = two.captured[0] && two.captured[0].props.$insert_id;
  return typeof a === "string" && a === b && !a.includes("user-1");
})());

t("first value requires an active visible personalized screen", (() => {
  const hidden = makeAnalytics({
    key: "phc_test",
    screenId: "screen-train",
    screenActive: false
  });
  const hiddenResult = hidden.api.trackVisibleUserMilestone(
    "first_value_viewed",
    "user-1",
    "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
  const visible = makeAnalytics({
    key: "phc_test",
    screenId: "screen-train",
    screenActive: true
  });
  const visibleResult = visible.api.trackVisibleUserMilestone(
    "first_value_viewed",
    "user-1",
    "screen-train",
    { value_type: "training_plan", source_surface: "train" }
  );
  return hiddenResult === false && hidden.captured.length === 0 &&
    visibleResult === true &&
    visible.captured.some(event => event.name === "first_value_viewed");
})());

t("boot-hidden and background screens do not emit viewed events", (() => {
  const booting = makeAnalytics({
    key: "phc_test",
    screenId: "screen-landing",
    screenActive: true,
    booting: true
  });
  const background = makeAnalytics({
    key: "phc_test",
    screenId: "screen-landing",
    screenActive: true,
    visibilityState: "hidden"
  });
  return booting.api.trackVisibleScreenView(
    "landing_viewed", "screen-landing", booting.api.landingProps()
  ) === false &&
    background.api.trackVisibleScreenView(
      "landing_viewed", "screen-landing", background.api.landingProps()
    ) === false &&
    booting.captured.length === 0 && background.captured.length === 0;
})());

/* ─────────────── app_returned logic ──────────────────────────────── */
section("app_returned calendar-date guard");

t("checkAppReturned returns false on first visit", (() => {
  const { api } = makeAnalytics({ key: "phc_test" });
  return api.checkAppReturned() === false;
})());

t("checkAppReturned returns false on same-day revisit", (() => {
  const { api } = makeAnalytics({ key: "phc_test" });
  api.checkAppReturned();  // sets today
  return api.checkAppReturned() === false;  // same date
})());

t("checkAppReturned returns true on different date", (() => {
  const { api, win } = makeAnalytics({ key: "phc_test" });
  // Simulate a previous date
  win.localStorage.setItem("athlevo_last_visit_date", "2025-01-01");
  return api.checkAppReturned() === true;
})());

/* ─────────────── device_type auto-detection ──────────────────────── */
section("Device type detection");

t("adds device_type=desktop for desktop user agent", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test", userAgent: "Mozilla/5.0 (Macintosh)" });
  api.trackAthlevoEvent("landing_viewed");
  return captured[0].props.device_type === "desktop";
})());

t("adds device_type=mobile for mobile user agent", (() => {
  const { api, captured } = makeAnalytics({
    key: "phc_test",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Mobile"
  });
  api.trackAthlevoEvent("landing_viewed");
  return captured[0].props.device_type === "mobile";
})());

/* ─────────────── silent failure ──────────────────────────────────── */
section("Silent failure");

t("trackAthlevoEvent does not throw when posthog.capture throws", (() => {
  const win = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    navigator: { userAgent: "test" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: "" },
    document: { querySelector: () => null },
    POSTHOG_KEY: "phc_test",
    posthog: {
      init() {}, __SV: 1, _i: [],
      capture() { throw new Error("PostHog down"); },
      identify() {}, reset() {}
    }
  };
  const code = readFileSync("./js/analytics.js", "utf8");
  new Function("window", "document", "navigator", "localStorage", "sessionStorage",
    code.replace(/\}\)\(typeof window[\s\S]*$/, "})(window);")
  )(win, win.document, win.navigator, win.localStorage, win.sessionStorage);
  try {
    win.AthlevoProductAnalytics.trackAthlevoEvent("landing_viewed");
    return true;
  } catch (e) { return false; }
})());

/* ─────────────── init guard ──────────────────────────────────────── */
section("Init guard");

t("_initDone flag is true after first event, preventing re-init", (() => {
  const { api } = makeAnalytics({ key: "phc_test" });
  // Before any event, _initDone should become true on first trackAthlevoEvent
  api.trackAthlevoEvent("landing_viewed");
  const afterFirst = api._initDone();
  api.trackAthlevoEvent("upgrade_clicked");
  api.identifyAthlete({ id: "x" });
  const afterMore = api._initDone();
  return afterFirst === true && afterMore === true;
})());

/* ─────────────── key from meta tag ───────────────────────────────── */
section("Key resolution");

t("reads PostHog key from meta tag when window.POSTHOG_KEY is absent", (() => {
  const { api } = makeAnalytics({ metaContent: "phc_from_meta" });
  // Should have resolved the key — _initDone stays false until first event
  api.trackAthlevoEvent("landing_viewed");
  return api._initDone() === true;
})());

/* ═════════════════════════════════════════════════════════════════════ */

console.log(`\n${p + f} tests: ${p} passed, ${f} failed`);
process.exit(f > 0 ? 1 : 0);

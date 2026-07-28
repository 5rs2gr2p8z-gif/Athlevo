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
      const store = opts.localStore || {};
      return {
        getItem: k => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _store: store
      };
    })(),
    sessionStorage: (() => {
      const store = {};
      return {
        getItem: k => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _store: store
      };
    })(),
    location: { search: opts.search || "", hash: "" },
    document: {
      querySelector: () => opts.metaContent ? { content: opts.metaContent } : null
    }
  };

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
  "landing_viewed", "trial_cta_clicked", "signup_completed",
  "onboarding_completed", "data_connection_started",
  "data_connection_completed", "plan_generated", "checkout_opened",
  "trial_started", "readiness_check_completed", "coach_message_sent",
  "app_returned", "trial_expired"
];

EXPECTED_EVENTS.forEach(name => {
  t(`trackAthlevoEvent("${name}") captures to PostHog`, (() => {
    const { api, captured } = makeAnalytics({ key: "phc_test" });
    api.trackAthlevoEvent(name);
    return captured.length === 1 && captured[0].name === name;
  })());
});

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
  api.trackAthlevoEvent("trial_cta_clicked");
  return captured.length === 2;
})());

t("created:true trial_started emission path fires once", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("trial_started", { source: "onboarding" });
  api.trackAthlevoEvent("trial_started", { source: "onboarding" });
  return captured.filter(event => event.name === "trial_started").length === 1;
})());

t("repeated expired-banner renders persistently emit one trial_expired", (() => {
  const localStore = {};
  const trialEnd = "2026-07-27T10:00:00.000Z";

  function renderFromFreshLoad() {
    const analytics = makeAnalytics({
      key: "phc_test",
      localStore
    });
    const element = {
      innerHTML: "",
      style: {}
    };
    analytics.win.document.getElementById = id =>
      id === "trialBanner" ? element : null;
    analytics.win.AthlevoPlan = {
      accessState: () => ({
        access_state: "expired_limited",
        trial_ends_at: trialEnd
      })
    };
    const bannerCode = readFileSync("./js/trialBanner.js", "utf8");
    new Function(
      "window",
      "document",
      "AthlevoProductAnalytics",
      bannerCode
    )(
      analytics.win,
      analytics.win.document,
      analytics.api
    );
    analytics.win.AthlevoTrialBanner.render();
    analytics.win.AthlevoTrialBanner.render();
    return analytics.captured;
  }

  const firstLoad = renderFromFreshLoad();
  const secondLoad = renderFromFreshLoad();
  return firstLoad.filter(event => event.name === "trial_expired").length === 1 &&
    secondLoad.filter(event => event.name === "trial_expired").length === 0;
})());

t("reset clears dedup state so events can fire again", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("landing_viewed");
  api.resetAthleteAnalytics();
  api.trackAthlevoEvent("landing_viewed");
  return captured.length === 2;
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
  api.trackAthlevoEvent("signup_completed", {
    auth_method: "google",
    source: "landing",
    email: "user@test.com",         // prohibited
    token: "secret123",             // prohibited
    password: "abc",                // prohibited
    message: "hello",               // prohibited
    some_random_field: "dropped"    // not in SAFE_PROPS
  });
  const props = captured[0].props;
  return props.auth_method === "google"
    && props.source === "landing"
    && !("email" in props)
    && !("token" in props)
    && !("password" in props)
    && !("message" in props)
    && !("some_random_field" in props);
})());

t("boolean and number values pass through for safe keys", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("signup_completed", {
    is_first_time: true,
    source: "test"
  });
  const props = captured[0].props;
  return props.is_first_time === true && props.source === "test";
})());

t("overly long strings are dropped", (() => {
  const { api, captured } = makeAnalytics({ key: "phc_test" });
  api.trackAthlevoEvent("signup_completed", {
    source: "a".repeat(100)   // > 80 chars
  });
  return !("source" in captured[0].props) || captured[0].props.source !== "a".repeat(100);
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
  api.trackAthlevoEvent("trial_cta_clicked");
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

/*
 * Acquisition funnel PostHog instrumentation.
 * Covers /ai → diagnostic → /ai-signup → signup → payment → checkout → paid.
 * Run: node tests/acquisition-funnel-analytics.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CANONICAL_FUNNEL = [
  "ai_landing_viewed",
  "diagnostic_started",
  "diagnostic_completed",
  "ai_signup_viewed",
  "registration_completed",
  "payment_screen_viewed",
  "checkout_started",
  "payment_completed"
];

const ACQUISITION_ROW = {
  data: {
    import_key: "ik-1",
    primary_limiter: "schedule",
    acquisition_stage: "checkout_started"
  },
  error: null
};

let passed = 0;
let failed = 0;
const t = (name, cond, extra) => {
  if (cond) {
    passed += 1;
    console.log("PASS — " + name);
  } else {
    failed += 1;
    console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : ""));
  }
};
const section = name => console.log(`\n──── ${name} ────`);

const html = readFileSync("./index.html", "utf8");
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const acqSrc = readFileSync("./js/diagnosticAcquisition.js", "utf8");
const guardSrc = readFileSync("./js/accessGuard.js", "utf8");
const analyticsSrc = readFileSync("./js/analytics.js", "utf8");
const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");
const featuresSrc = readFileSync("./js/features.js", "utf8");
const diagnosticSrc = readFileSync("./js/diagnostic.js", "utf8");
const salesSrc = readFileSync("./js/diagnosticSalesEngine.js", "utf8");

function memoryStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store
  };
}

function makeAnalytics(opts = {}) {
  const captured = [];
  const identified = [];
  const win = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    navigator: { userAgent: "Mozilla/5.0 (Macintosh)" },
    localStorage: memoryStorage(opts.localStore),
    sessionStorage: memoryStorage(opts.sessionStore),
    location: {
      origin: "https://athlevo.org",
      pathname: opts.pathname || "/ai",
      search: opts.search || "",
      hash: "",
      href: "https://athlevo.org" + (opts.pathname || "/ai") + (opts.search || "")
    },
    document: {
      referrer: opts.referrer || "",
      visibilityState: "visible",
      body: { classList: { contains: () => false } },
      documentElement: { clientWidth: 390, clientHeight: 844 },
      querySelector: () => null,
      getElementById: () => null
    },
    POSTHOG_KEY: "phc_test",
    posthog: {
      init() {},
      capture(name, props) { captured.push({ name, props }); },
      identify(id) { identified.push(id); },
      reset() {},
      _i: [],
      __SV: 1
    }
  };
  win.window = win;
  win.innerWidth = 390;
  win.innerHeight = 844;
  new Function("window", registrySrc)(win);
  new Function("window", "document", "navigator", "localStorage", "sessionStorage",
    analyticsSrc.replace(/\}\)\(typeof window[\s\S]*$/, "})(window);")
  )(win, win.document, win.navigator, win.localStorage, win.sessionStorage);
  return { win, api: win.AthlevoProductAnalytics, captured, identified };
}

function loadDiagnosticUi(analytics) {
  const storage = new Map();
  const captured = analytics.captured;
  const nodes = {
    chatInput: { value: "", style: {}, classList: { add() {}, remove() {} }, setAttribute() {} },
    chatQuickReplies: { innerHTML: "", style: {}, appendChild() {}, classList: { add() {}, remove() {} } },
    chatThread: { children: [], appendChild() {}, classList: { add() {}, remove() {} } }
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Uint8Array, Promise,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    sessionStorage: analytics.win.sessionStorage,
    location: analytics.win.location,
    document: {
      readyState: "complete",
      referrer: "",
      getElementById: id => nodes[id] || null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        appendChild() {},
        setAttribute() {}
      })
    },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: true }),
    AthlevoAnalyticsRegistry: analytics.win.AthlevoAnalyticsRegistry,
    AthlevoProductAnalytics: analytics.api,
    AthlevoAnalytics: {
      track() {}
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(diagnosticSrc, context);
  vm.runInContext(salesSrc, context);
  vm.runInContext(uiSrc, context);
  return {
    context, captured, nodes,
    helpers: context.AthlevoDiagnosticUI._internal,
    Engine: context.AthlevoDiagnostic
  };
}

function finishDiagnostic(engine) {
  const fixtures = {
    goal: { goal_distance: "General fitness" },
    experience: { experience: "new" },
    training_status: { training_status: "starting" },
    current_capacity: { recent_consistency: "occasional", recent_longest_run_km: "4" },
    training_days: { training_days: 4 },
    training_structure: { training_structure: "mostly_easy" },
    perceived_limiter: { perceived_limiter: "aerobic" },
    injury_status: { injury_has: "none" }
  };
  engine.begin();
  while (!engine.canComplete()) {
    const q = engine.nextQuestion();
    engine.recordAnswer(q.key, fixtures[q.key]);
  }
}

function acquisitionWorld(opts = {}) {
  const analytics = makeAnalytics(opts);
  const shown = [];
  const assigned = [];
  const local = analytics.win.localStorage;
  const context = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout: fn => { fn(); return 0; },
    URL, Date, JSON, Math, String, Number, Boolean, Object, Array,
    localStorage: local,
    sessionStorage: analytics.win.sessionStorage,
    document: {
      getElementById: () => ({
        textContent: "",
        classList: { add() {}, remove() {}, toggle() {} }
      })
    },
    location: {
      href: opts.href || "https://athlevo.org/ai-signup",
      origin: "https://athlevo.org",
      pathname: "/ai-signup",
      search: "",
      hash: "",
      assign: url => assigned.push(url)
    },
    history: { replaceState() {} },
    AthlevoPlan: {
      _resolveEntitlement: sub => sub && sub.status === "active"
        ? { accessState: "paid_active", isPerformanceTrial: false }
        : { accessState: "free", isPerformanceTrial: false }
    },
    AthlevoDiagnosticHandoff: {
      loadAcquisition: async () => opts.acquisition || { data: null, error: null },
      setAcquisitionStage: async () => ({ updated: true })
    },
    AthlevoAnalyticsRegistry: analytics.win.AthlevoAnalyticsRegistry,
    AthlevoProductAnalytics: analytics.api,
    AthlevoAnalytics: { track() {} },
    showScreen: id => shown.push(id),
    athlevoSessionUserId: opts.userId || "u1"
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(acqSrc, context);
  let entitlementChecks = 0;
  const subscriptionForCheck = () => {
    entitlementChecks += 1;
    const paidNow = opts.paid === true ||
      (Number.isFinite(opts.paidAfterChecks) && entitlementChecks >= opts.paidAfterChecks);
    return paidNow
      ? { plan_id: "performance", provider: opts.provider || "whop", status: "active" }
      : { plan_id: "free", provider: "whop" };
  };
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: subscriptionForCheck(), error: null }),
                in() {
                  return {
                    order() {
                      return {
                        limit() {
                          return { maybeSingle: async () => ({ data: null, error: null }) };
                        }
                      };
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };
  return {
    api: context.AthlevoDiagnosticAcquisition,
    captured: analytics.captured,
    identified: analytics.identified,
    shown,
    assigned,
    supabase,
    analytics
  };
}

function accessGuardWorld(opts = {}) {
  const analytics = [];
  const assigned = [];
  const mounts = {};
  const sandbox = {
    document: {
      getElementById(id) {
        if (!mounts[id]) {
          mounts[id] = {
            style: {},
            children: [],
            disabled: false,
            textContent: "",
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            querySelector: () => null,
            setAttribute() {},
            getAttribute() { return null; }
          };
        }
        return mounts[id];
      },
      createElement() {
        return { style: {}, className: "", children: [], set innerHTML(value) { this.html = value; } };
      },
      visibilityState: "visible",
      addEventListener() {}
    },
    console: { log() {}, warn() {}, error() {} },
    fetch: opts.fetch || (async () => ({ ok: false, json: async () => ({}) })),
    supabaseClient: {
      auth: {
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        getSession: async () => ({
          data: { session: { access_token: "tok", user: { id: "u1", email: "hidden@example.com" } } }
        })
      },
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) })
        })
      })
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent: (name, props) => analytics.push({ name, props })
    },
    AthlevoAnalytics: { track() {} },
    URL,
    location: {
      origin: "https://athlevo.org",
      pathname: "/app",
      assign: url => assigned.push(url)
    }
  };
  sandbox.window = sandbox;
  new Function(...Object.keys(sandbox), featuresSrc)(...Object.values(sandbox));
  new Function(...Object.keys(sandbox), guardSrc)(...Object.values(sandbox));
  return { sandbox, analytics, assigned };
}

section("1 — /ai viewed");
{
  t("startDiagnostic fires ai_landing_viewed",
    /trackAiLandingViewed\(\)/.test(uiSrc) &&
    /trackEvent\("ai_landing_viewed"/.test(uiSrc));
  const a = makeAnalytics();
  const { helpers, captured } = loadDiagnosticUi(a);
  helpers.trackAiLandingViewed();
  helpers.trackAiLandingViewed();
  const views = captured.filter(e => e.name === "ai_landing_viewed");
  t("/ai view fires ai_landing_viewed once per load",
    views.length === 1 && views[0].props.path === "/ai");
}

section("2 — diagnostic start is interaction, not page view");
{
  t("page load does not emit diagnostic_started from engine.begin",
    /engine\.begin\(\);/.test(uiSrc) &&
    !/engine\.begin\(\);[\s\S]{0,160}diagnostic_started/.test(uiSrc));
  t("in-progress resume primes started from recorded answers, not begun",
    /primeDiagnosticStartedFromEngine\(engine\)/.test(uiSrc) &&
    /function hasRecordedDiagnosticAnswers/.test(uiSrc) &&
    /eng\.history\.length > 0/.test(uiSrc) &&
    !/else \{\s*diagnosticStartedFired = true;/.test(uiSrc));
  const a = makeAnalytics();
  const { helpers, captured, Engine } = loadDiagnosticUi(a);
  helpers.trackAiLandingViewed();
  const engine = Engine.create();
  engine.begin();
  helpers.bindEngine(engine);
  helpers.primeDiagnosticStartedFromEngine(engine);
  t("page view alone does not fire diagnostic_started",
    !captured.some(e => e.name === "diagnostic_started") &&
    helpers.getDiagnosticStartedFired() === false);
}

section("3 — first real diagnostic interaction");
{
  t("chip and composer paths mark diagnostic started",
    /markDiagnosticStarted\("chip"\)/.test(uiSrc) &&
    /markDiagnosticStarted\("text"\)/.test(uiSrc));
  t("silent autofill paths never mark diagnostic started",
    !uiSrc.slice(
      uiSrc.indexOf("function commitFullyKnownPendingQuestions"),
      uiSrc.indexOf("function mergeFactStore")
    ).includes("markDiagnosticStarted"));

  const chipWorld = makeAnalytics();
  const chip = loadDiagnosticUi(chipWorld);
  const chipEngine = chip.Engine.create();
  chipEngine.begin();
  chip.helpers.bindEngine(chipEngine);
  chip.helpers.primeDiagnosticStartedFromEngine(chipEngine);
  const goal = chip.Engine.getQuestion("goal");
  chip.helpers.prepareQuestion(goal);
  try {
    chip.helpers.handleChipSelect(goal.fields[0], goal.fields[0].options[0], goal.fields);
  } catch (e) {}
  const chipStarted = chip.captured.filter(e => e.name === "diagnostic_started");
  t("A. fresh visit → first chip → diagnostic_started once",
    chipStarted.length === 1 &&
    chipStarted[0].props.first_input_type === "chip");

  const textWorld = makeAnalytics();
  const text = loadDiagnosticUi(textWorld);
  const textEngine = text.Engine.create();
  textEngine.begin();
  text.helpers.bindEngine(textEngine);
  text.helpers.primeDiagnosticStartedFromEngine(textEngine);
  text.helpers.prepareQuestion(goal);
  text.nodes.chatInput.value = "5K";
  try { text.helpers.handleComposerSend(); } catch (e) {}
  const textStarted = text.captured.filter(e => e.name === "diagnostic_started");
  t("B. fresh visit → first typed answer → diagnostic_started once",
    textStarted.length === 1 &&
    textStarted[0].props.first_input_type === "text");

  const resumeWorld = makeAnalytics();
  const resumed = loadDiagnosticUi(resumeWorld);
  const begunEmpty = resumed.Engine.create();
  begunEmpty.begin();
  resumed.helpers.bindEngine(begunEmpty);
  resumed.helpers.primeDiagnosticStartedFromEngine(begunEmpty);
  t("reload before any answer does not treat diagnostic as started",
    begunEmpty.begun === true &&
    begunEmpty.history.length === 0 &&
    resumed.helpers.getDiagnosticStartedFired() === false);
  resumed.helpers.prepareQuestion(goal);
  try {
    resumed.helpers.handleChipSelect(goal.fields[0], goal.fields[0].options[1], goal.fields);
  } catch (e) {}
  const resumeStarted = resumed.captured.filter(e => e.name === "diagnostic_started");
  t("C. reload before any answer → first answer after resume → diagnostic_started fires",
    resumeStarted.length === 1 &&
    resumeStarted[0].props.first_input_type === "chip");

  const afterWorld = makeAnalytics();
  const after = loadDiagnosticUi(afterWorld);
  const answered = after.Engine.create();
  answered.begin();
  answered.recordAnswer("goal", { goal_distance: "5K" });
  after.helpers.bindEngine(answered);
  after.helpers.primeDiagnosticStartedFromEngine(answered);
  t("recorded answers before reload count as already started",
    after.helpers.hasRecordedDiagnosticAnswers(answered) === true &&
    after.helpers.getDiagnosticStartedFired() === true);
  after.helpers.markDiagnosticStarted("chip");
  after.helpers.markDiagnosticStarted("text");
  t("D. first answer → reload → second answer → diagnostic_started does NOT fire again",
    after.captured.filter(e => e.name === "diagnostic_started").length === 0);

  const autoWorld = makeAnalytics();
  const auto = loadDiagnosticUi(autoWorld);
  const autoEngine = auto.Engine.create();
  autoEngine.begin();
  auto.helpers.bindEngine(autoEngine);
  auto.helpers.resetFactStore();
  auto.helpers.applyExtractedFacts({ goal_distance: "Marathon" }, null);
  if (typeof autoEngine.setPendingFacts === "function") autoEngine.setPendingFacts({});
  auto.helpers.primeDiagnosticStartedFromEngine(autoEngine);
  auto.helpers.commitFullyKnownPendingQuestions();
  t("E. silent autofill alone does NOT count as diagnostic_started",
    autoEngine.history.length > 0 &&
    !auto.captured.some(e => e.name === "diagnostic_started") &&
    auto.helpers.getDiagnosticStartedFired() === false);
  auto.helpers.markDiagnosticStarted("text");
  t("first real input after autofill-only still fires diagnostic_started once",
    auto.captured.filter(e => e.name === "diagnostic_started").length === 1 &&
    auto.captured.find(e => e.name === "diagnostic_started").props.first_input_type === "text");
}

section("4 — diagnostic completion");
{
  const a = makeAnalytics();
  const { helpers, captured, Engine } = loadDiagnosticUi(a);
  const engine = Engine.create();
  finishDiagnostic(engine);
  helpers.bindEngine(engine);
  try { helpers.completeDiagnostic(); } catch (e) {}
  try { helpers.completeDiagnostic(); } catch (e) {}
  const done = captured.filter(e => e.name === "diagnostic_completed");
  t("diagnostic completion fires once",
    done.length === 1 && helpers.getDiagnosticCompletedFired() === true);
  t("completion payload stays structured, not free-text",
    done[0] &&
    done[0].props.goal_distance === "General fitness" &&
    done[0].props.training_status === "starting" &&
    done[0].props.has_race === false &&
    !("message" in done[0].props) &&
    !("injury_area" in done[0].props) &&
    !Object.values(done[0].props || {}).some(v =>
      typeof v === "string" && /sick|knee|pain/i.test(v)));
}

section("5 — /ai-signup viewed");
{
  t("openAiSignup fires ai_signup_viewed from the diagnostic",
    /function openAiSignup/.test(html) &&
    /trackAthlevoEvent\("ai_signup_viewed"/.test(html) &&
    /from:\s*"ai_diagnostic"/.test(html));
  const { api, captured } = makeAnalytics();
  api.trackAthlevoEvent("ai_signup_viewed", {
    from: "ai_diagnostic",
    diagnostic_completed: true,
    path: "/ai-signup"
  });
  api.trackAthlevoEvent("ai_signup_viewed", {
    from: "ai_diagnostic",
    diagnostic_completed: true,
    path: "/ai-signup"
  });
  const views = captured.filter(e => e.name === "ai_signup_viewed");
  t("/ai-signup view fires ai_signup_viewed once per load",
    views.length === 1 &&
    views[0].props.from === "ai_diagnostic" &&
    views[0].props.diagnostic_completed === true);
}

section("6/7 — signup vs login");
{
  const loginSrc = html.slice(
    html.indexOf("async function doLogin"),
    html.indexOf("async function doLogout")
  );
  t("email signup success uses completeRegistration",
    /completeRegistration\(\s*data\.user,\s*"email"/.test(html));
  t("login identifies without completeRegistration",
    /identifyAthlete\(user\)/.test(loginSrc) &&
    !/completeRegistration\(/.test(loginSrc));
  t("signup_completed is not aliased into this funnel",
    !/trackOnce\("signup_completed"/.test(acqSrc) &&
    !/trackAthlevoEvent\("signup_completed"/.test(html + acqSrc + analyticsSrc));
  const created = makeAnalytics();
  created.api.completeRegistration({ id: "new-user" }, "email", true);
  const login = makeAnalytics();
  login.api.identifyAthlete({ id: "old-user" });
  login.api.completeRegistration({ id: "old-user" }, "email", false);
  t("signup_completed equivalent only fires after genuine new signup",
    created.captured.some(e => e.name === "registration_completed") &&
    created.identified[0] === "new-user" &&
    !created.captured[0].props.email);
  t("login does not count as registration_completed",
    !login.captured.some(e => e.name === "registration_completed") &&
    login.identified[0] === "old-user");
}

section("8 — payment screen");
{
  t("real checkout selector tracks payment_screen_viewed",
    /trackOnce\("payment_screen_viewed"/.test(acqSrc) &&
    /source:\s*"ai_signup"/.test(acqSrc) &&
    /price_php:\s*597/.test(acqSrc));
  t("activating/recheck modes do not track the payment screen",
    !/function showActivation[\s\S]*payment_screen_viewed/.test(acqSrc) &&
    !/function showRecheck[\s\S]*payment_screen_viewed/.test(acqSrc));
  const unpaid = acquisitionWorld();
  unpaid.api.showPaywall({ events: {}, primaryLimiter: "schedule" }, false);
  unpaid.api.showPaywall({ events: {}, primaryLimiter: "schedule" }, false);
  unpaid.api.showPaywall({ events: {}, primaryLimiter: "schedule" }, true);
  const views = unpaid.captured.filter(e => e.name === "payment_screen_viewed");
  t("payment screen fires payment_screen_viewed once",
    views.length === 1 &&
    views[0].props.source === "ai_signup" &&
    views[0].props.price_php === 597);
}

section("9/10 — checkout started");
{
  t("diagnostic checkout no longer double-fires checkout_started",
    /AthlevoAccessGuard\.checkout/.test(acqSrc) &&
    !/trackOnce\("checkout_started"/.test(acqSrc));
  const card = accessGuardWorld();
  await card.sandbox.AthlevoAccessGuard.checkout({
    feature: "trends",
    surface: "diagnostic",
    source: "ai_signup"
  });
  const cardEvent = card.analytics.find(e => e.name === "checkout_started");
  t("clicking card fires checkout_started with provider=whop, method=card",
    cardEvent &&
    cardEvent.props.provider === "whop" &&
    cardEvent.props.method === "card" &&
    cardEvent.props.price_php === 597 &&
    card.assigned.length === 1 &&
    !card.analytics.some(e => e.name === "payment_completed"));

  const local = accessGuardWorld({
    fetch: async () => ({
      ok: true,
      json: async () => ({ checkout_url: "https://checkout.paymongo.com/c/test" })
    })
  });
  await local.sandbox.AthlevoAccessGuard.checkoutLocal({
    feature: "trends",
    surface: "diagnostic",
    source: "ai_signup"
  });
  const localEvent = local.analytics.find(e => e.name === "checkout_started");
  t("clicking local fires checkout_started with provider=paymongo, method=local",
    localEvent &&
    localEvent.props.provider === "paymongo" &&
    localEvent.props.method === "local" &&
    localEvent.props.price_php === 597);
  t("checkout events do not include email, tokens, or checkout URLs",
    card.analytics.concat(local.analytics).every(e =>
      !("email" in (e.props || {})) &&
      !("token" in (e.props || {})) &&
      !("checkout_url" in (e.props || {})) &&
      !Object.values(e.props || {}).some(v =>
        typeof v === "string" && /paymongo\.com|whop\.com|@/.test(v))));
}

section("11/12 — payment completed");
{
  const unpaidReturn = acquisitionWorld({
    href: "https://athlevo.org/ai-signup?checkout_return=1",
    paid: false
  });
  await unpaidReturn.api.resolveAfterAuth(
    "u-unpaid",
    unpaidReturn.supabase,
    null,
    {},
    { fromAiSignup: true }
  );
  t("returning from checkout without paid entitlement does not fire payment_completed",
    !unpaidReturn.captured.some(e => e.name === "payment_completed"));

  const paid = acquisitionWorld({ paid: true, provider: "whop" });
  await paid.api.resolveAfterAuth(
    "u-paid",
    paid.supabase,
    null,
    { onboarding_complete: false },
    { fromAiSignup: true }
  );
  await paid.api.resolveAfterAuth(
    "u-paid",
    paid.supabase,
    null,
    { onboarding_complete: false },
    { fromAiSignup: true }
  );
  const paidEvents = paid.captured.filter(e => e.name === "payment_completed");
  t("canonical paid_active fires payment_completed once",
    paidEvents.length === 1 &&
    paidEvents[0].props.provider === "whop" &&
    paidEvents[0].props.price_php === 597);
}

section("12b — checkout_return_viewed");
{
  t("checkout_return_viewed is registered and not mapped to Meta",
    /checkout_return_viewed:/.test(registrySrc) &&
    /outcome:\s*\{ unpaid: true, activating: true, paid: true \}/.test(registrySrc) &&
    !/checkout_return_viewed/.test(readFileSync("./js/metaPixel.js", "utf8")));
  t("return observation is first settled state for this page load",
    /var checkoutReturnViewedFired = false/.test(acqSrc) &&
    /function trackCheckoutReturnViewed/.test(acqSrc) &&
    /if \(returningFromCheckout\) trackCheckoutReturnViewed\("paid"/.test(acqSrc));

  const unpaidReturn = acquisitionWorld({
    href: "https://athlevo.org/ai-signup?checkout_return=1",
    paid: false
  });
  await unpaidReturn.api.resolveAfterAuth(
    "u-unpaid",
    unpaidReturn.supabase,
    null,
    {},
    { fromAiSignup: true }
  );
  await unpaidReturn.api.resolveAfterAuth(
    "u-unpaid",
    unpaidReturn.supabase,
    null,
    {},
    { fromAiSignup: true }
  );
  const unpaidEvents = unpaidReturn.captured.filter(e => e.name === "checkout_return_viewed");
  t("returned unpaid fires checkout_return_viewed once with outcome=unpaid",
    unpaidEvents.length === 1 &&
    unpaidEvents[0].props.outcome === "unpaid" &&
    !unpaidReturn.captured.some(e => e.name === "payment_completed") &&
    !("checkout_url" in (unpaidEvents[0].props || {})) &&
    !("email" in (unpaidEvents[0].props || {})));

  const activating = acquisitionWorld({
    href: "https://athlevo.org/ai-signup?checkout_return=1",
    paid: false,
    acquisition: ACQUISITION_ROW
  });
  const activatingResult = await activating.api.resolveAfterAuth(
    "u-activating",
    activating.supabase,
    null,
    {},
    { fromAiSignup: true }
  );
  const activatingEvents = activating.captured.filter(e => e.name === "checkout_return_viewed");
  t("returned while entitlement is pending fires outcome=activating",
    activatingResult.route === "activating" &&
    activatingEvents.length === 1 &&
    activatingEvents[0].props.outcome === "activating" &&
    !activating.captured.some(e => e.name === "payment_completed"));

  const paidReturn = acquisitionWorld({
    href: "https://athlevo.org/ai-signup?checkout_return=1",
    paid: true,
    provider: "whop"
  });
  await paidReturn.api.resolveAfterAuth(
    "u-paid-return",
    paidReturn.supabase,
    null,
    { onboarding_complete: false },
    { fromAiSignup: true }
  );
  const paidReturnEvents = paidReturn.captured.filter(e => e.name === "checkout_return_viewed");
  t("returned paid fires outcome=paid without replacing payment_completed",
    paidReturnEvents.length === 1 &&
    paidReturnEvents[0].props.outcome === "paid" &&
    paidReturnEvents[0].props.provider === "whop" &&
    paidReturn.captured.filter(e => e.name === "payment_completed").length === 1);

  const settledPaid = acquisitionWorld({
    href: "https://athlevo.org/ai-signup?checkout_return=1",
    paidAfterChecks: 2,
    provider: "paymongo",
    acquisition: ACQUISITION_ROW
  });
  await settledPaid.api.resolveAfterAuth(
    "u-poll-paid",
    settledPaid.supabase,
    null,
    { onboarding_complete: false },
    { fromAiSignup: true }
  );
  const settledEvents = settledPaid.captured.filter(e => e.name === "checkout_return_viewed");
  t("activating → paid in the same return poll records paid only",
    settledEvents.length === 1 &&
    settledEvents[0].props.outcome === "paid" &&
    settledEvents[0].props.provider === "paymongo" &&
    !settledEvents.some(e => e.props.outcome === "activating"));

  const ordinaryPaywall = acquisitionWorld({ paid: false });
  await ordinaryPaywall.api.resolveAfterAuth(
    "u-paywall",
    ordinaryPaywall.supabase,
    null,
    {},
    { fromAiSignup: true }
  );
  t("unrelated paywall view does not fire checkout_return_viewed",
    !ordinaryPaywall.captured.some(e => e.name === "checkout_return_viewed"));
}

section("12c — diagnostic_ai_fallback_used");
{
  const routeSrc = uiSrc.slice(
    uiSrc.indexOf("function routeViaAi("),
    uiSrc.indexOf("function applyConversationalResult")
  );
  t("router success path no longer always records fallback",
    /trackDiagnosticAiFallback\(result/.test(routeSrc) &&
    !/trackEvent\("diagnostic_ai_fallback_used"/.test(routeSrc) &&
    /result\.usedFallback !== true/.test(uiSrc));

  const successWorld = makeAnalytics();
  const success = loadDiagnosticUi(successWorld);
  success.helpers.trackDiagnosticAiFallback({ usedFallback: false, reply: "ok" }, "goal");
  success.helpers.trackDiagnosticAiFallback({ reply: "ok" }, "goal");
  t("normal router success → no fallback event",
    !success.captured.some(e => e.name === "diagnostic_ai_fallback_used"));

  const fallbackWorld = makeAnalytics();
  const fallback = loadDiagnosticUi(fallbackWorld);
  fallback.helpers.trackDiagnosticAiFallback({ usedFallback: true }, "goal");
  const fallbackEvents = fallback.captured.filter(e => e.name === "diagnostic_ai_fallback_used");
  t("actual fallback → exactly one fallback event",
    fallbackEvents.length === 1 &&
    fallbackEvents[0].props.question_key === "goal" &&
    !("reply" in (fallbackEvents[0].props || {})) &&
    !("message" in (fallbackEvents[0].props || {})));
}

section("12d — canonical eight-step funnel unchanged");
{
  t("canonical PostHog funnel order is unchanged",
    CANONICAL_FUNNEL.join(" → ") ===
    "ai_landing_viewed → diagnostic_started → diagnostic_completed → ai_signup_viewed → registration_completed → payment_screen_viewed → checkout_started → payment_completed");
  t("every canonical funnel event remains registered",
    CANONICAL_FUNNEL.every(name => new RegExp(name + ":").test(registrySrc)));
  t("checkout_return_viewed is not a canonical funnel step",
    !CANONICAL_FUNNEL.includes("checkout_return_viewed"));
  t("subscription_activated remains server-authoritative and unmapped",
    /subscription_activated:/.test(registrySrc) &&
    !/subscription_activated/.test(readFileSync("./js/metaPixel.js", "utf8").match(/CANONICAL_TO_META = \{[\s\S]*?\};/)[0]));
}

section("13 — privacy");
{
  const { api, captured } = makeAnalytics();
  api.trackAthlevoEvent("diagnostic_completed", {
    goal_distance: "Half marathon",
    training_status: "starting",
    email: "runner@example.com",
    token: "sb-access-secret",
    message: "I have a left knee injury and was sick last month",
    injury_notes: "left knee",
    checkout_url: "https://checkout.paymongo.com/c/secret?email=runner@example.com"
  });
  const props = captured[0] && captured[0].props;
  t("no raw diagnostic text, email, or token reaches PostHog",
    props &&
    props.goal_distance === "Half marathon" &&
    !("email" in props) &&
    !("token" in props) &&
    !("message" in props) &&
    !("injury_notes" in props) &&
    !("checkout_url" in props) &&
    !Object.values(props).some(v =>
      typeof v === "string" && /@|injury|sick|secret|token/i.test(v)));
  t("identify uses the internal user id, never email",
    /ph\.identify\(user\.id\)/.test(analyticsSrc) &&
    !/identify\(user\.email/.test(analyticsSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

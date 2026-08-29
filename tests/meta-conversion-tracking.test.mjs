/*
 * Meta conversion adapter: canonical Athlevo events → Pixel standard events.
 * Run: node tests/meta-conversion-tracking.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

const pixelSrc = readFileSync("./js/metaPixel.js", "utf8");
const analyticsSrc = readFileSync("./js/analytics.js", "utf8");
const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const acqSrc = readFileSync("./js/diagnosticAcquisition.js", "utf8");
const guardSrc = readFileSync("./js/accessGuard.js", "utf8");
const diagnosticSrc = readFileSync("./js/diagnostic.js", "utf8");
const salesSrc = readFileSync("./js/diagnosticSalesEngine.js", "utf8");
const html = readFileSync("./index.html", "utf8");

const PROHIBITED_META_KEYS = [
  "user_id",
  "email",
  "name",
  "phone",
  "injury_reported",
  "injury",
  "medical",
  "primary_limiter",
  "diagnostic",
  "diagnostic_summary",
  "goal_distance",
  "goal_time",
  "weekly_mileage",
  "training_status",
  "race",
  "race_time",
  "recent_performance"
];

const POISON_PROPS = {
  user_id: "user-uuid-secret",
  email: "runner@example.com",
  name: "Jordan Runner",
  phone: "+639170000000",
  injury_reported: true,
  injury: "left knee",
  medical: "recent illness",
  primary_limiter: "aerobic_base",
  diagnostic: "raw diagnostic transcript",
  diagnostic_summary: "you are undertrained",
  goal_distance: "Half marathon",
  goal_time: "1:45:00",
  weekly_mileage: 40,
  training_status: "starting",
  race: "Berlin",
  race_time: "1:52:11",
  recent_performance: "5k in 22:00",
  fbclid: "abc.123",
  utm_source: "facebook",
  utm_campaign: "meta_sales",
  checkout_url: "https://checkout.paymongo.com/c/secret",
  provider: "whop"
};

function memoryStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store
  };
}

function metaEvent(call) {
  if (!call || call[0] !== "track") return null;
  return { event: call[1], params: call[2] };
}

function payloadHasProhibited(params) {
  const obj = params && typeof params === "object" ? params : {};
  const keys = Object.keys(obj);
  return PROHIBITED_META_KEYS.some(key => keys.includes(key)) ||
    Object.values(obj).some(v =>
      typeof v === "string" &&
      /@|injury|sick|knee|uuid|transcript|undertrained|berlin|1:45/i.test(v));
}

function makeWorld(opts = {}) {
  const fbqCalls = [];
  const captured = [];
  const identified = [];
  const inserted = [];
  const spy = function () {
    if (opts.fbqThrows) throw new Error("fbq blocked");
    fbqCalls.push(Array.from(arguments));
  };
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
      referrer: "",
      visibilityState: "visible",
      body: { classList: { contains: () => false } },
      documentElement: { clientWidth: 390, clientHeight: 844 },
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({}),
      getElementsByTagName: () => [{
        parentNode: { insertBefore: node => inserted.push(node) }
      }]
    },
    AthlevoRuntime: { isNative: () => opts.native === true },
    META_PIXEL_ID: opts.pixelId === undefined ? "1346950923671883" : opts.pixelId,
    POSTHOG_KEY: opts.key === undefined ? "phc_test" : opts.key,
    posthog: opts.skipPosthog ? undefined : {
      init() {},
      capture(name, props) {
        if (opts.posthogThrows) throw new Error("PostHog down");
        captured.push({ name, props });
      },
      identify(id) { identified.push(id); },
      reset() {},
      _i: [],
      __SV: 1
    },
    innerWidth: 390,
    innerHeight: 844
  };
  if (!opts.missingFbq) win.fbq = spy;
  win.window = win;
  const pixelFn = opts.missingFbq
    ? new Function("window", "document", "sessionStorage", pixelSrc)
    : new Function("window", "document", "sessionStorage", "fbq", pixelSrc);
  if (opts.missingFbq) {
    pixelFn(win, win.document, win.sessionStorage);
  } else {
    pixelFn(win, win.document, win.sessionStorage, spy);
  }
  new Function("window", registrySrc)(win);
  new Function("window", "document", "navigator", "localStorage", "sessionStorage",
    analyticsSrc.replace(/\}\)\(typeof window[\s\S]*$/, "})(window);")
  )(win, win.document, win.navigator, win.localStorage, win.sessionStorage);
  return {
    win,
    api: win.AthlevoProductAnalytics,
    pixel: win.AthlevoMetaPixel,
    fbqCalls,
    captured,
    identified,
    inserted,
    spy
  };
}

function loadDiagnosticUi(world) {
  const storage = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    sessionStorage: world.win.sessionStorage,
    location: world.win.location,
    document: {
      readyState: "complete",
      referrer: "",
      getElementById: () => null,
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
    AthlevoAnalyticsRegistry: world.win.AthlevoAnalyticsRegistry,
    AthlevoProductAnalytics: world.api,
    AthlevoAnalytics: { track() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(diagnosticSrc, context);
  vm.runInContext(salesSrc, context);
  vm.runInContext(uiSrc, context);
  return { context, helpers: context.AthlevoDiagnosticUI._internal, Engine: context.AthlevoDiagnostic };
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

function conversionCalls(fbqCalls) {
  return fbqCalls
    .map(metaEvent)
    .filter(Boolean)
    .filter(e => e.event !== "PageView");
}

/* ═══════════════════════════════════════════════════════════════════ */

section("Pixel init / PageView");
{
  const world = makeWorld();
  t("Pixel initializes only once",
    world.pixel.isReady() === true &&
    fbqInitCount(world.fbqCalls) === 1);
  world.pixel.init();
  world.pixel.init();
  t("existing PageView remains exactly once per script init",
    world.fbqCalls.filter(c => c[0] === "track" && c[1] === "PageView").length === 1 &&
    fbqInitCount(world.fbqCalls) === 1);
  t("init still uses fbq('init') then fbq('track','PageView')",
    /fbq\('init', _pixelId\);\s*fbq\('track', 'PageView'\)/.test(pixelSrc));
  t("no second PageView helper exists",
    !/trackMapped\([^\)]*PageView/.test(pixelSrc) &&
    !/PageView/.test(pixelSrc.match(/CANONICAL_TO_META = \{[\s\S]*?\};/)[0]));
}

function fbqInitCount(calls) {
  return calls.filter(c => c[0] === "init").length;
}

section("Native");
{
  const world = makeWorld({ native: true });
  t("native runtime skips Pixel completely",
    world.pixel.isReady() === false &&
    world.inserted.length === 0 &&
    world.fbqCalls.length === 0);
  world.api.trackAthlevoEvent("ai_landing_viewed");
  world.api.trackAthlevoEvent("diagnostic_completed", POISON_PROPS);
  world.api.trackAthlevoEvent("registration_completed", { user_id: "n1" });
  world.api.trackAthlevoEvent("checkout_started", { price_php: 597 });
  world.api.trackAthlevoEvent("payment_completed", { price_php: 597 });
  t("mapped conversion calls also no-op natively",
    world.fbqCalls.length === 0 &&
    world.pixel.trackMapped("payment_completed") === false);
}

section("Canonical mapping");
{
  const world = makeWorld();
  world.api.trackAthlevoEvent("ai_landing_viewed", POISON_PROPS);
  const view = conversionCalls(world.fbqCalls);
  t("ai_landing_viewed → ViewContent",
    view.length === 1 && view[0].event === "ViewContent");
  t("ViewContent contains no athlete props",
    view[0] && Object.keys(view[0].params || {}).length === 0 &&
    !payloadHasProhibited(view[0].params));
}

{
  const world = makeWorld();
  world.api.trackAthlevoEvent("diagnostic_completed", POISON_PROPS);
  const lead = conversionCalls(world.fbqCalls);
  t("diagnostic_completed → Lead",
    lead.length === 1 && lead[0].event === "Lead");
  t("Lead contains no diagnostic props",
    lead[0] && Object.keys(lead[0].params || {}).length === 0 &&
    !payloadHasProhibited(lead[0].params));
}

{
  const world = makeWorld();
  world.api.completeRegistration({ id: "new-user" }, "email", true);
  const reg = conversionCalls(world.fbqCalls);
  t("registration_completed → CompleteRegistration",
    reg.length === 1 && reg[0].event === "CompleteRegistration");
  t("CompleteRegistration contains no user_id",
    reg[0] && !("user_id" in (reg[0].params || {})) &&
    Object.keys(reg[0].params || {}).length === 0);
}

{
  const world = makeWorld();
  world.api.trackAthlevoEvent("checkout_started", Object.assign({ price_php: 1998 }, POISON_PROPS));
  const checkout = conversionCalls(world.fbqCalls);
  t("checkout_started → InitiateCheckout",
    checkout.length === 1 && checkout[0].event === "InitiateCheckout");
  t("InitiateCheckout payload exactly { value:597, currency:PHP }",
    checkout[0] &&
    checkout[0].params.value === 597 &&
    checkout[0].params.currency === "PHP" &&
    Object.keys(checkout[0].params).length === 2);
}

{
  const world = makeWorld();
  world.api.trackPaymentCompleted("paid-user", Object.assign({ provider: "whop", price_php: 597 }, POISON_PROPS));
  const purchase = conversionCalls(world.fbqCalls);
  t("payment_completed → Purchase",
    purchase.length === 1 && purchase[0].event === "Purchase");
  t("Purchase payload exactly { value:597, currency:PHP }",
    purchase[0] &&
    purchase[0].params.value === 597 &&
    purchase[0].params.currency === "PHP" &&
    Object.keys(purchase[0].params).length === 2);
}

section("Unmapped events");
{
  const world = makeWorld();
  world.api.trackAthlevoEvent("payment_screen_viewed", { price_php: 597, source: "ai_signup" });
  world.api.trackAthlevoEvent("diagnostic_started", { first_input_type: "chip" });
  world.api.trackAthlevoEvent("ai_signup_viewed", { from: "ai_diagnostic", path: "/ai-signup" });
  world.api.trackAthlevoEvent("subscription_activated", { provider: "whop", price_php: "597" });
  t("payment_screen_viewed → no Meta conversion",
    !conversionCalls(world.fbqCalls).some(e => e.event === "InitiateCheckout" || e.event === "Lead"));
  t("diagnostic_started → no Meta conversion",
    conversionCalls(world.fbqCalls).length === 0);
  t("ai_signup_viewed → no Meta conversion",
    conversionCalls(world.fbqCalls).length === 0);
  t("subscription_activated → no browser Meta Purchase",
    !conversionCalls(world.fbqCalls).some(e => e.event === "Purchase"));
}

section("Privacy boundary");
{
  const world = makeWorld();
  [
    "ai_landing_viewed",
    "diagnostic_completed",
    "registration_completed",
    "checkout_started",
    "payment_completed"
  ].forEach(name => world.api.trackAthlevoEvent(name, POISON_PROPS));
  const conversions = conversionCalls(world.fbqCalls);
  t("no prohibited diagnostic/health/identity keys survive into Meta payloads",
    conversions.length === 5 &&
    conversions.every(e => !payloadHasProhibited(e.params)));
  t("adapter constructs Meta payloads from scratch, never spreads caller props",
    /function trackMapped\(canonicalEventName\)/.test(pixelSrc) &&
    !/trackMapped\([^\)]*safe/.test(analyticsSrc) &&
    !/trackMapped\(name,\s*safe\)/.test(analyticsSrc) &&
    /root\.AthlevoMetaPixel\.trackMapped\(name\)/.test(analyticsSrc));
}

section("Failure isolation");
{
  let threw = false;
  try {
    const world = makeWorld({ missingFbq: true });
    world.api.trackAthlevoEvent("diagnostic_completed", POISON_PROPS);
    world.pixel.trackMapped("checkout_started");
  } catch (e) {
    threw = true;
  }
  t("blocked/missing fbq never throws", threw === false);

  const throwing = makeWorld({ fbqThrows: true });
  let metaThrew = false;
  try {
    throwing.api.trackAthlevoEvent("checkout_started", { price_php: 597 });
    throwing.api.trackAthlevoEvent("payment_completed", { price_php: 597 });
  } catch (e) {
    metaThrew = true;
  }
  t("throwing fbq does not escape into product flow",
    metaThrew === false && throwing.captured.some(e => e.name === "checkout_started"));

  const isolated = makeWorld();
  isolated.win.AthlevoMetaPixel.trackMapped = function () {
    throw new Error("Meta adapter exploded");
  };
  const ok = isolated.api.trackAthlevoEvent("diagnostic_completed", POISON_PROPS);
  t("Meta adapter failure does not stop PostHog capture",
    ok === true &&
    isolated.captured.some(e => e.name === "diagnostic_completed") &&
    isolated.captured[0].props.injury_reported === true);
}

section("Dedupe / funnel guards");
{
  const world = makeWorld();
  world.api.trackAthlevoEvent("checkout_started", { price_php: 597, method: "card" });
  world.api.trackAthlevoEvent("checkout_started", { price_php: 597, method: "local" });
  const checkouts = conversionCalls(world.fbqCalls).filter(e => e.event === "InitiateCheckout");
  t("repeated genuine checkout_started may emit repeated InitiateCheckout",
    checkouts.length === 2);

  const login = makeWorld();
  login.api.identifyAthlete({ id: "old-user" });
  const loginResult = login.api.completeRegistration({ id: "old-user" }, "email", false);
  t("canonical registration/login guards remain unchanged",
    loginResult === false &&
    !login.captured.some(e => e.name === "registration_completed") &&
    !conversionCalls(login.fbqCalls).some(e => e.event === "CompleteRegistration"));

  const created = makeWorld();
  created.api.completeRegistration({ id: "new-user" }, "email", true);
  created.api.completeRegistration({ id: "new-user" }, "email", true);
  t("confirmed new account maps to CompleteRegistration once",
    created.captured.filter(e => e.name === "registration_completed").length === 1 &&
    conversionCalls(created.fbqCalls).filter(e => e.event === "CompleteRegistration").length === 1);
}

{
  const world = makeWorld();
  const { helpers, Engine } = loadDiagnosticUi(world);
  const engine = Engine.create();
  finishDiagnostic(engine);
  helpers.bindEngine(engine);
  try { helpers.completeDiagnostic(); } catch (e) {}
  try { helpers.completeDiagnostic(); } catch (e) {}
  const leads = conversionCalls(world.fbqCalls).filter(e => e.event === "Lead");
  t("canonical diagnostic completion produces one Lead",
    world.captured.filter(e => e.name === "diagnostic_completed").length === 1 &&
    leads.length === 1);

  const beforeResume = world.fbqCalls.length;
  try { helpers.trackAiLandingViewed(); } catch (e) {}
  t("completed diagnostic resume does not produce another Lead",
    /diagnosticCompletedFired = true/.test(uiSrc) &&
    /trackEvent\("diagnostic_resumed", \{ state: "completed" \}/.test(uiSrc) &&
    !/pending && pending\.completed[\s\S]{0,400}completeDiagnostic\(/.test(uiSrc) &&
    conversionCalls(world.fbqCalls.slice(beforeResume)).every(e => e.event !== "Lead") &&
    conversionCalls(world.fbqCalls).filter(e => e.event === "Lead").length === 1);
}

{
  const unpaid = makeWorld();
  unpaid.api.trackAthlevoEvent("payment_screen_viewed", { price_php: 597 });
  unpaid.api.trackAthlevoEvent("checkout_started", { price_php: 597, provider: "whop" });
  t("unpaid checkout return does not produce Purchase",
    !conversionCalls(unpaid.fbqCalls).some(e => e.event === "Purchase") &&
    conversionCalls(unpaid.fbqCalls).some(e => e.event === "InitiateCheckout"));

  const paid = makeWorld();
  const first = paid.api.trackPaymentCompleted("u-paid", { provider: "whop", price_php: 597 });
  const second = paid.api.trackPaymentCompleted("u-paid", { provider: "whop", price_php: 597 });
  t("paid_active payment_completed does produce Purchase",
    first === true &&
    second === false &&
    conversionCalls(paid.fbqCalls).filter(e => e.event === "Purchase").length === 1);
}

section("Architecture");
{
  t("adapter hook lives only on the ProductAnalytics path",
    /ph\.capture\(name, safe\);[\s\S]{0,280}AthlevoMetaPixel\.trackMapped\(name\)/.test(analyticsSrc));
  t("AthlevoAnalytics.track is not a Meta hook",
    !/AthlevoAnalytics[\s\S]{0,80}trackMapped/.test(analyticsSrc) &&
    !/fbq\(/.test(acqSrc) &&
    !/fbq\(/.test(guardSrc) &&
    !/fbq\(/.test(uiSrc));
  t("no new Athlevo product event names were added for Meta",
    !/meta_lead|meta_purchase|facebook_purchase/.test(registrySrc) &&
    !/meta_lead|meta_purchase|facebook_purchase/.test(analyticsSrc));
  t("StartTrial is not mapped",
    !/StartTrial/.test(pixelSrc.match(/CANONICAL_TO_META = \{[\s\S]*?\};/)[0]));
  t("pixel remains loaded before analytics in index.html",
    /metaPixel\.js\?v=\d+[\s\S]{0,80}analytics\.js\?v=\d+/.test(html));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

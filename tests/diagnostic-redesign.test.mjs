/**
 * Athlevo diagnostic redesign tests — 18 test cases covering:
 * Social proof rendering, once-per-session, carousel, result quality,
 * CTA flow, mobile layouts, reduced-motion, existing suite compatibility.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

/* ═══════════════════════════ HELPERS ═══════════════════════════════ */

function makeDOMStub() {
  const elements = new Map();
  const appended = [];
  const created = [];

  function makeEl(tag, attrs) {
    const el = {
      tagName: tag || "DIV",
      id: (attrs && attrs.id) || "",
      className: (attrs && attrs.className) || "",
      innerHTML: "",
      textContent: "",
      children: [],
      style: {},
      disabled: false,
      _listeners: {},
      _classes: new Set(),
      setAttribute(k, v) { this["_attr_" + k] = v; },
      getAttribute(k) { return this["_attr_" + k] || null; },
      appendChild(child) { this.children.push(child); appended.push(child); return child; },
      remove() {},
      querySelector(sel) {
        if (sel === ".chat-msg-result") return null;
        if (sel === "#diagProgress .ob2-fill") return null;
        return null;
      },
      querySelectorAll() { return []; },
      addEventListener(ev, fn) {
        if (!this._listeners[ev]) this._listeners[ev] = [];
        this._listeners[ev].push(fn);
      },
      classList: {
        add(c) { el._classes.add(c); },
        remove(c) { el._classes.delete(c); },
        contains(c) { return el._classes.has(c); }
      },
      animate() { return { finished: Promise.resolve() }; },
      scrollTo() {},
      scrollHeight: 1000
    };
    if (el.id) elements.set(el.id, el);
    return el;
  }

  const thread = makeEl("DIV", { id: "diagThread" });
  const body = makeEl("DIV", { id: "diagBody" });

  const document = {
    getElementById(id) {
      if (id === "diagThread") return thread;
      if (id === "diagBody") return body;
      if (id === "chatTyping") return null;
      return elements.get(id) || null;
    },
    querySelector(sel) {
      if (sel === "#diagProgress .ob2-fill") return null;
      return null;
    },
    createElement(tag) {
      const el = makeEl(tag);
      created.push(el);
      return el;
    }
  };

  return { document, thread, body, elements, appended, created, makeEl };
}

function makeSessionStorage() {
  const store = new Map();
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
    _store: store
  };
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

function loadAnalyticsRegistry() {
  const context = { console: { log() {}, warn() {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/analyticsRegistry.js", "utf8"), context);
  return context.AthlevoAnalyticsRegistry;
}

function loadDiagnosticUI(opts) {
  opts = opts || {};
  const localStorage = opts.localStorage || makeLocalStorage();
  const sessionStorage = opts.sessionStorage || makeSessionStorage();
  const dom = opts.dom || makeDOMStub();
  const trackedEvents = [];
  const reducedMotion = !!opts.reducedMotion;

  const context = {
    console: { log() {}, warn() {} },
    Date, Math, Uint8Array, Object, Array, Promise, setTimeout,
    crypto: globalThis.crypto,
    localStorage,
    sessionStorage,
    document: dom.document,
    matchMedia(q) {
      return { matches: q.includes("reduce") ? reducedMotion : false };
    },
    AthlevoAnalytics: {
      track(name, props) { trackedEvents.push({ name, props }); }
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent(name, props) {}
    },
    AthlevoDiagnosticAcquisition: {
      markDiagnosticCompleted() {},
      hasCheckoutReturn() { return false; },
      ANNUAL_CHECKOUT_READY: false
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  // Load engine first
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context);

  // Load UI
  vm.runInContext(readFileSync("./js/diagnosticUI.js", "utf8"), context);

  return {
    context,
    trackedEvents,
    dom,
    Engine: context.AthlevoDiagnostic,
    UI: context.AthlevoDiagnosticUI,
    sessionStorage,
    localStorage
  };
}

const commonAnswers = {
  experience: { experience: "1_2_years" },
  training_status: { training_status: "building_base" },
  weekly_volume: { weekly_mileage: "30", weekly_hours: "4" },
  current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "14" },
  recent_performance: { recent_race_dist: "none" },
  training_days: { training_days: 4 },
  training_structure: { training_structure: "easy_long" },
  perceived_limiter: { perceived_limiter: "endurance" },
  injury_status: { injury_has: "none", injury_area: "" },
  schedule: { train_time: "after_work", schedule_constraints: "" },
  other_training: { other_training: ["none"] },
  goal: { goal_distance: "10K" },
  race_details: { goal_race: "", goal_race_date: "", goal_time: "" }
};

function completeEngine(Engine) {
  const engine = Engine.create();
  engine.begin();
  for (let i = 0; i < 20 && !engine.canComplete(); i++) {
    const q = engine.nextQuestion();
    if (!q) break;
    const ans = commonAnswers[q.key];
    if (!ans) break;
    engine.recordAnswer(q.key, ans);
  }
  if (engine.canComplete()) engine.complete();
  return engine;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  }
}

/* ═══════════════════════════ TESTS ═══════════════════════════════ */

console.log("\n=== Social Proof Tests ===\n");

// Test 1: Social proof HTML contains carousel structure
test("1. Social proof renders horizontal swipeable carousel", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  // Verify carousel structure
  assert.ok(src.includes("chat-social-proof-scroll"), "Missing scroll container class");
  assert.ok(src.includes("chat-social-proof-item"), "Missing item class");
  assert.ok(src.includes("chat-social-proof-img"), "Missing img class");
});

// Test 2: proof imagery does not invent quantitative achievements
test("2. Social proof contains no unsupported numerical achievement claims", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(!src.includes("153+"), "Unverified 153+ claim must not ship");
  assert.ok(!src.includes("54+"), "Unverified 54+ claim must not ship");
  assert.ok(!src.includes("personal bests"), "Unverified PB claim must not ship");
});

// Test 3: Social proof uses real images
test("3. Social proof uses real images from athlevo-assets/diagnostic proof/", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  const manifest = src.match(/var SOCIAL_PROOF_IMAGES = \[([\s\S]*?)\];/);
  assert.ok(manifest, "Missing social-proof image manifest");
  const images = [...manifest[1].matchAll(/"(athlevo-assets\/diagnostic proof\/[^"]+)"/g)]
    .map(match => match[1]);
  assert.equal(images.length, 8, "Should reference exactly the reviewed subset of 8 proof images");
  images.forEach(path => assert.ok(existsSync(path), "Missing proof asset: " + path));
});

// Test 4: Social proof shown once per session via sessionStorage
test("4. Social proof uses sessionStorage for once-per-session flag", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes("athlevo_diagnostic_social_proof_shown"), "Missing session key");
  assert.ok(src.includes("sessionStorage"), "Should use sessionStorage, not localStorage");
});

// Test 5: Social proof NOT shown on initial load with pre-seeded goal
test("5. Social proof requires engine.history.length >= 2 (not pre-seeded)", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes("engine.history.length >= 2"), "Must check history length >= 2");
  assert.ok(src.includes("isSocialProofShownThisSession()"), "Must check shown flag");

  const first10kEngine = loadEngineOnly().create();
  first10kEngine.begin();
  first10kEngine.applyAcquisitionIntent("first10k");
  assert.equal(first10kEngine.history.length, 0, "Seeded 10K context is not a visible answer");
  assert.equal(first10kEngine.nextQuestion().key, "current_running_frequency");
  first10kEngine.recordAnswer("current_running_frequency", { current_running_frequency: "freq_3" });
  assert.equal(first10kEngine.history.length, 1, "Proof remains hidden after first visible answer");
  const second = first10kEngine.nextQuestion();
  assert.ok(second && commonAnswers[second.key], "Second first10k question has a fixture");
  first10kEngine.recordAnswer(second.key, commonAnswers[second.key]);
  assert.equal(first10kEngine.history.length, 2, "Proof becomes eligible after two answered questions");
});

// Test 6: Social proof fires analytics event
test("6. Social proof fires diagnostic_social_proof_viewed event", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes('diagnostic_social_proof_viewed'), "Missing analytics event");
});

test("6b. Social proof bridge is contextual for first10k and general goals", function () {
  const first = loadDiagnosticUI();
  const firstEngine = first.Engine.create();
  firstEngine.begin();
  firstEngine.applyAcquisitionIntent("first10k");
  firstEngine.recordAnswer("current_running_frequency", { current_running_frequency: "freq_3" });
  firstEngine.recordAnswer("current_capacity", {
    recent_consistency: "mostly_consistent",
    recent_longest_run_km: "5"
  });
  first.UI._internal.bindEngine(firstEngine);
  assert.match(first.UI._internal.socialProofBridgeCopy(), /current-capacity baseline for your first 10K/);

  const general = loadDiagnosticUI();
  const generalEngine = general.Engine.create();
  generalEngine.begin();
  generalEngine.applyAcquisitionIntent("general");
  generalEngine.recordAnswer("goal", { goal_distance: "Half marathon" });
  generalEngine.recordAnswer("race_details", {
    goal_race: "City Half",
    goal_race_date: "2027-03-01",
    goal_time: ""
  });
  general.UI._internal.bindEngine(generalEngine);
  assert.match(general.UI._internal.socialProofBridgeCopy(), /context around your Half marathon goal/);
});

test("6c. Desktop pointer drag scrolls only the proof rail", function () {
  const loaded = loadDiagnosticUI();
  const listeners = {};
  const classes = new Set();
  let prevented = false;
  const rail = {
    scrollLeft: 80,
    addEventListener(name, fn) { listeners[name] = fn; },
    setPointerCapture() {},
    releasePointerCapture() {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); }
    }
  };
  loaded.UI._internal.wireSocialProofCarousel({
    querySelector(selector) { return selector === ".chat-social-proof-scroll" ? rail : null; }
  });
  listeners.pointerdown({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 120 });
  listeners.pointermove({ pointerId: 1, clientX: 70, preventDefault() { prevented = true; } });
  assert.equal(rail.scrollLeft, 130, "Mouse drag updates horizontal scroll position");
  assert.equal(prevented, true, "Active desktop drag suppresses text/image drag");
  assert.equal(classes.has("is-dragging"), true, "Rail exposes grabbing state while dragging");
  listeners.pointerup({ pointerId: 1 });
  assert.equal(classes.has("is-dragging"), false, "Grabbing state clears on release");

  const beforeTouch = rail.scrollLeft;
  listeners.pointerdown({ pointerType: "touch", button: 0, pointerId: 2, clientX: 100 });
  listeners.pointermove({ pointerId: 2, clientX: 40, preventDefault() { throw new Error("touch must remain native"); } });
  assert.equal(rail.scrollLeft, beforeTouch, "Touch gestures remain native for momentum and vertical arbitration");
});

test("6d. Restored diagnostics keep context, proof once/session, and normal continuation", function () {
  const localStorage = makeLocalStorage();
  const sessionStorage = makeSessionStorage();
  const loaded = loadDiagnosticUI({ localStorage, sessionStorage });
  const engine = loaded.Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("general");
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  engine.recordAnswer("race_details", {
    goal_race: "City Marathon",
    goal_race_date: "2027-04-01",
    goal_time: ""
  });
  const restored = loaded.Engine.load();
  loaded.UI._internal.bindEngine(restored);
  assert.match(loaded.UI._internal.socialProofBridgeCopy(), /context around your Marathon goal/);
  assert.equal(loaded.UI._internal.isSocialProofShownThisSession(), false);
  loaded.UI._internal.markSocialProofShown();
  assert.equal(loaded.UI._internal.isSocialProofShownThisSession(), true,
    "Proof cannot repeat after a restore or back-navigation rerender");

  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  const advance = src.slice(src.indexOf("async function advanceFlow"), src.indexOf("function recoverContinuationQuestion"));
  assert.ok(advance.indexOf("showSocialProofMoment") < advance.indexOf("presentQuestion(next)"),
    "Diagnostic continues to the existing next question after proof");
});

console.log("\n=== Result Flow Tests ===\n");

// Test 7: Result uses conversational sequence (not monolithic card)
test("7. Result is rendered as conversational sequence", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes("renderConversationalResult"), "Missing conversational result function");
  assert.ok(src.includes("chat-diagnosis-card"), "Missing diagnosis card class");
  assert.ok(src.includes("chat-compact-cta"), "Missing compact CTA class");
});

// Test 8: Result preserves diagnostic reasoning quality
test("8. Result preserves limiter label, explanation, whatWedChange, feasibility", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes("limiter.label"), "Must display limiter label");
  assert.ok(src.includes("limiter.explanation"), "Must display limiter explanation");
  assert.ok(src.includes("whatWedChange"), "Must display whatWedChange items");
  assert.ok(src.includes("result.feasibility.label"), "Must display feasibility label");
  assert.ok(src.includes("result.feasibility.explanation"), "Must display feasibility explanation");
});

// Test 9: Feasibility preserves all dynamic states (not just "realistic")
test("9. Feasibility rendering is dynamic, not hardcoded to 'realistic'", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  // Verify feasibility is rendered from result.feasibility dynamically
  assert.ok(!src.includes('"Your goal is realistic"'), "Must NOT hardcode realistic");
  // Should use the engine's feasibility label/explanation directly
  const feasMatch = src.match(/result\.feasibility\.label.*result\.feasibility\.explanation/s);
  assert.ok(feasMatch, "Must render feasibility label + explanation from engine result");
});

// Test 10: CTA shows correct monthly price without annual
test("10. CTA shows ₱597/month, no annual pricing", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  // Check the conversational result section (renderConversationalResult)
  // Should have monthly price
  assert.ok(src.includes("₱597/month"), "Must show monthly price");
  // The old annual line should NOT appear in the new conversational result
  // (the old renderResult is replaced, so check the new function doesn't have it)
  const convResultStart = src.indexOf("async function renderConversationalResult");
  const convResultEnd = src.indexOf("function renderResult", convResultStart + 1);
  const convResultSection = src.substring(convResultStart, convResultEnd);
  assert.ok(!convResultSection.includes("₱5,498/year"), "Must NOT show annual pricing in conversational result");
  assert.ok(!convResultSection.includes("chat-cta-annual"), "Must NOT include annual pricing class");
});

// Test 11: CTA click handler fires correct events and routes
test("11. CTA handler fires diagnostic_signup_tapped and signup_started", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes('diagnostic_signup_tapped'), "Must fire diagnostic_signup_tapped");
  assert.ok(src.includes('signup_started'), "Must fire signup_started");
  assert.ok(src.includes("markDiagnosticCompleted"), "Must call markDiagnosticCompleted");
  assert.ok(src.includes("openAiSignup"), "Must route to openAiSignup");
});

// Test 12: Safety note rendered conditionally
test("12. Safety note shown only when requiresMedicalClearance is set", function () {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(src.includes("requiresMedicalClearance"), "Must check requiresMedicalClearance");
  assert.ok(src.includes("chat-safety-note"), "Must use safety note class");
});

console.log("\n=== Analytics Tests ===\n");

// Test 13: diagnostic_social_proof_viewed registered in analytics registry
test("13. diagnostic_social_proof_viewed is registered in analytics registry", function () {
  const registry = loadAnalyticsRegistry();
  const events = registry.EVENTS;
  assert.ok(events.diagnostic_social_proof_viewed, "Missing diagnostic_social_proof_viewed in registry");
  assert.equal(events.diagnostic_social_proof_viewed.kind, "behavioural");
});

// Test 14: signup_started registered in analytics registry
test("14. signup_started is registered in analytics registry", function () {
  const registry = loadAnalyticsRegistry();
  const events = registry.EVENTS;
  assert.ok(events.signup_started, "Missing signup_started in registry");
  assert.ok(events.signup_started.props.includes("source_surface"), "signup_started should allow source_surface prop");
});

// Test 15: auth_method_attempted registered in analytics registry
test("15. auth_method_attempted is registered with method, source_surface, acquisition_intent", function () {
  const registry = loadAnalyticsRegistry();
  const events = registry.EVENTS;
  assert.ok(events.auth_method_attempted, "Missing auth_method_attempted in registry");
  assert.equal(events.auth_method_attempted.kind, "behavioural");
  assert.ok(events.auth_method_attempted.props.includes("method"), "Must allow method prop");
  assert.ok(events.auth_method_attempted.props.includes("source_surface"), "Must allow source_surface prop");
  assert.ok(events.auth_method_attempted.props.includes("acquisition_intent"), "Must allow acquisition_intent prop");
});

// Test 16: auth_method_attempted sanitizes correctly (no PII leaks)
test("16. auth_method_attempted sanitizeProps blocks unapproved keys", function () {
  const registry = loadAnalyticsRegistry();
  const clean = registry.sanitizeProps("auth_method_attempted", {
    method: "google",
    source_surface: "auth",
    acquisition_intent: "first10k",
    email: "user@test.com",
    name: "Test User",
    token: "abc123"
  });
  assert.ok(clean, "Should return sanitized props");
  assert.equal(clean.method, "google");
  assert.equal(clean.source_surface, "auth");
  assert.equal(clean.acquisition_intent, "first10k");
  assert.equal(clean.email, undefined, "Must NOT pass email");
  assert.equal(clean.name, undefined, "Must NOT pass name");
  assert.equal(clean.token, undefined, "Must NOT pass token");
});

// Test 17: auth_method_attempted allows apple as method value
test("17. apple is an approved method value in analytics registry", function () {
  const registry = loadAnalyticsRegistry();
  const clean = registry.sanitizeProps("auth_method_attempted", {
    method: "apple",
    source_surface: "auth"
  });
  assert.ok(clean, "Should return sanitized props for apple");
  assert.equal(clean.method, "apple");
});

// Test 18: Google auth fires auth_method_attempted before OAuth redirect
test("18. socialAuth.js fires auth_method_attempted for Google", function () {
  const src = readFileSync("./js/socialAuth.js", "utf8");
  assert.ok(src.includes('auth_method_attempted'), "socialAuth.js must fire auth_method_attempted");
  // Verify it fires before signInWithOAuth
  const authMethodIdx = src.indexOf('auth_method_attempted');
  const oauthIdx = src.indexOf('signInWithOAuth');
  assert.ok(authMethodIdx < oauthIdx, "auth_method_attempted must fire BEFORE signInWithOAuth call");
});

// Test 19: Apple tap fires auth_method_attempted even when disabled
test("19. Apple tap handler fires auth_method_attempted", function () {
  const src = readFileSync("./index.html", "utf8");
  const appleStart = src.indexOf("function continueWithApple");
  const appleEnd = src.indexOf("window.continueWithApple", appleStart);
  const appleSection = src.substring(appleStart, appleEnd);
  assert.ok(appleSection.includes('auth_method_attempted'), "continueWithApple must fire auth_method_attempted");
  assert.ok(appleSection.includes('"apple"'), "Must pass method: apple");
});

// Test 20: Email auth path fires auth_method_attempted
test("20. Email auth path fires auth_method_attempted", function () {
  const src = readFileSync("./index.html", "utf8");
  const signupSection = src.slice(src.indexOf("function openSignup"), src.indexOf("function openLogin"));
  const loginSection = src.slice(src.indexOf("function openLogin"), src.indexOf("function closeAuth"));
  const formSection = src.slice(src.indexOf("function showSignupForm"), src.indexOf("function showForgotForm"));
  assert.ok(signupSection.includes('trackAuthMethodAttempted("email")'), "openSignup must record the email choice");
  assert.ok(loginSection.includes('trackAuthMethodAttempted("email")'), "openLogin must record the email choice");
  assert.equal((signupSection.match(/trackAuthMethodAttempted\("email"\)/g) || []).length, 1,
    "One signup email decision must emit once");
  assert.equal((loginSection.match(/trackAuthMethodAttempted\("email"\)/g) || []).length, 1,
    "One login email decision must emit once");
  assert.ok(signupSection.indexOf("trackAuthMethodAttempted") < signupSection.indexOf("interceptInAppAuthHandoff"),
    "Signup email choice must be recorded before an IAB handoff");
  assert.ok(loginSection.indexOf("trackAuthMethodAttempted") < loginSection.indexOf("interceptInAppAuthHandoff"),
    "Login email choice must be recorded before an IAB handoff");
  assert.ok(!formSection.includes("trackAuthMethodAttempted"), "Switching login/signup forms must not fire another method event");
});

test("20b. Auth method events are not mapped to Meta", function () {
  const metaSrc = readFileSync("./js/metaPixel.js", "utf8");
  const mapping = metaSrc.match(/var CANONICAL_TO_META = \{([\s\S]*?)\};/);
  assert.ok(mapping, "Meta canonical mapping exists");
  assert.ok(!mapping[1].includes("auth_method_attempted"), "Auth method event must not be mapped to Meta");
  assert.ok(!mapping[1].includes("diagnostic_social_proof_viewed"), "Social proof view must not be mapped to Meta");
});

console.log("\n=== CSS Tests ===\n");

// Test 21: Social proof CSS exists with scroll-snap
test("21. Social proof CSS includes scroll-snap and overflow-x", function () {
  const css = readFileSync("./index.html", "utf8");
  assert.ok(css.includes(".chat-social-proof-scroll"), "Missing scroll container CSS");
  assert.ok(css.includes("scroll-snap-type:x mandatory"), "Missing scroll-snap");
  assert.ok(css.includes("overflow-x:auto"), "Missing overflow-x:auto");
  assert.ok(css.includes("touch-action:pan-x pan-y"), "Mobile swipe must preserve horizontal and vertical panning");
  assert.ok(css.includes("-webkit-overflow-scrolling:touch"), "Mobile carousel keeps momentum scrolling");
  assert.ok(css.includes("cursor:grab"), "Desktop carousel advertises drag interaction");
  assert.match(css, /\.chat-social-proof-item\{[^}]*width:140px/, "Approved card width remains 140px");
  assert.match(css, /\.chat-social-proof-img\{[^}]*aspect-ratio:3\/4/, "Approved image crop remains 3:4");
  assert.match(css, /\.chat-msg-social-proof\{[^}]*width:100%;max-width:100%/,
    "Proof rail uses the conversation width without creating page overflow");
  assert.match(css, /\.chat-msg-social-proof>\.chat-bubble\{[^}]*padding-right:4px/,
    "Proof bubble reserves only a small trailing inset for the next-card affordance");

  [390, 430].forEach(function (viewportWidth) {
    const threadWidth = viewportWidth - 44; // .chat-thread inline padding: 22px each side
    const railWidth = threadWidth - 20; // proof bubble: 16px leading + 4px trailing padding
    const thirdCardStart = 2 + 140 + 10 + 140 + 10; // rail inset, two cards, and two gaps
    const thirdCardPeek = railWidth - thirdCardStart;
    assert.ok(thirdCardPeek >= 20 && thirdCardPeek < 140,
      viewportWidth + "px keeps two cards plus a partial third card visible");
  });
});

// Test 22: Diagnosis card CSS exists
test("22. Diagnosis card and compact CTA CSS classes exist", function () {
  const css = readFileSync("./index.html", "utf8");
  assert.ok(css.includes(".chat-diagnosis-card"), "Missing diagnosis card CSS");
  assert.ok(css.includes(".chat-compact-cta"), "Missing compact CTA CSS");
  assert.ok(css.includes(".chat-diagnosis-eyebrow"), "Missing diagnosis eyebrow CSS");
  assert.ok(css.includes(".chat-diagnosis-title"), "Missing diagnosis title CSS");
});

// Test 23: Dark mode overrides for new components
test("23. Dark mode overrides exist for new components", function () {
  const css = readFileSync("./index.html", "utf8");
  assert.ok(css.includes('html[data-theme="dark"] .chat-diagnosis-card'), "Missing dark mode for diagnosis card");
  assert.ok(css.includes('html[data-theme="dark"] .chat-compact-cta'), "Missing dark mode for compact CTA");
  assert.ok(css.includes('html[data-theme="dark"] .chat-social-proof-item'), "Missing dark mode for social proof");
});

console.log("\n=== Compatibility Tests ===\n");

// Test 24: Existing diagnostic engine tests still pass (no engine changes)
test("24. Diagnostic engine unchanged — existing test pattern works", function () {
  const Engine = loadEngineOnly();
  const engine = Engine.create();
  engine.begin();
  assert.ok(engine.nextQuestion(), "Engine should produce first question after begin()");
  assert.ok(!engine.canComplete(), "Engine should not be completable immediately");

  // Complete a full run
  const completed = completeEngine(Engine);
  assert.ok(completed.completed, "Engine should complete");
  assert.ok(completed.result, "Engine should produce result");
  assert.ok(completed.result.primaryLimiter || completed.result.whatWedChange, "Result should have diagnosis data");
  if (completed.result.feasibility) {
    assert.ok(completed.result.feasibility.label, "Feasibility should have label");
    assert.ok(completed.result.feasibility.explanation, "Feasibility should have explanation");
  }
});

console.log("\n=== Summary ===\n");
console.log(`${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);

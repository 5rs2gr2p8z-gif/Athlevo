/*
 * Acquisition-intent diagnostic opening (first-10K ads) + step analytics.
 * Run: node tests/diagnostic-acquisition-intent.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const engineSrc = readFileSync("./js/diagnostic.js", "utf8");
const analyticsSrc = readFileSync("./js/analytics.js", "utf8");
const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");
const authSupportSrc = readFileSync("./js/authSupport.js", "utf8");
const metaSrc = readFileSync("./js/metaPixel.js", "utf8");

function loadEngine(search = "") {
  const values = new Map();
  const context = {
    console: { log() {}, warn() {} }, Date, Math, Uint8Array, URLSearchParams,
    crypto: globalThis.crypto,
    location: { pathname: "/ai", search, href: "https://athlevo.org/ai" + search },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSrc, context);
  return { Engine: context.AthlevoDiagnostic, values, context };
}

function answerUntilComplete(engine, answers) {
  const asked = [];
  for (let guard = 0; guard < 20 && !engine.canComplete(); guard += 1) {
    const question = engine.nextQuestion();
    assert.ok(question, `engine stopped before completion after ${asked.join(", ")}`);
    asked.push(question.key);
    assert.ok(answers[question.key], `missing fixture for ${question.key}`);
    engine.recordAnswer(question.key, answers[question.key]);
  }
  assert.equal(engine.canComplete(), true);
  return asked;
}

const common = {
  experience: { experience: "1_2_years" },
  training_status: { training_status: "building_base" },
  weekly_volume: { weekly_mileage: "30", weekly_hours: "4" },
  current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "5" },
  recent_performance: { recent_race_dist: "none" },
  training_days: { training_days: 4 },
  training_structure: { training_structure: "easy_long" },
  perceived_limiter: { perceived_limiter: "endurance" },
  injury_status: { injury_has: "none", injury_area: "" },
  schedule: { train_time: "after_work", schedule_constraints: "" },
  other_training: { other_training: ["none"] },
  race_details: { goal_race: "", goal_race_date: "2027-06-01", goal_time: "" }
};

/* ── Engine: intent resolution ─────────────────────────────────────── */

{
  const { Engine } = loadEngine();
  assert.equal(Engine.resolveAcquisitionIntent("first10k"), "first10k");
  assert.equal(Engine.resolveAcquisitionIntent("FIRST10K"), "first10k");
  assert.equal(Engine.resolveAcquisitionIntent(null), "general");
  assert.equal(Engine.resolveAcquisitionIntent(""), "general");
  assert.equal(Engine.resolveAcquisitionIntent("unknown"), "general");
  assert.equal(Engine.resolveAcquisitionIntent("marathon"), "general");
  assert.equal(Engine.resolveAcquisitionIntent("sub2hm"), "general");
  assert.equal(Engine.resolveAcquisitionIntent("signup"), "general");
}

{
  const { Engine } = loadEngine("?intent=first10k&utm_source=facebook&fbclid=abc123");
  assert.equal(Engine.readAcquisitionIntentFromLocation(Engine === null ? null : {
    search: "?intent=first10k&utm_source=facebook&fbclid=abc123"
  }), "first10k");
}

{
  const { Engine } = loadEngine();
  assert.equal(Engine.readAcquisitionIntentFromLocation({ search: "" }), "general");
  assert.equal(Engine.readAcquisitionIntentFromLocation({ search: "?utm_source=meta" }), "general");
  assert.equal(Engine.readAcquisitionIntentFromLocation({ search: "?intent=nope" }), "general");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  assert.equal(engine.acquisitionIntent, "first10k");
  assert.equal(engine.answers.goal_distance, "10K");
  assert.equal(engine.known.goal, true);
  const first = engine.nextQuestion();
  assert.equal(first && first.key, "current_running_frequency");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("general");
  assert.equal(engine.acquisitionIntent, "general");
  assert.notEqual(engine.answers.goal_distance, "10K");
  const first = engine.nextQuestion();
  assert.equal(first && first.key, "goal");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("half-marathon-please");
  assert.equal(engine.acquisitionIntent, "general");
  assert.equal(engine.nextQuestion().key, "goal");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.applyAcquisitionIntent("first10k");
  assert.equal(engine.acquisitionIntent, "general", "in-progress diagnostic keeps its original intent");
  assert.equal(engine.answers.goal_distance, "5K");
  assert.notEqual(engine.nextQuestion() && engine.nextQuestion().key, "current_running_frequency");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  engine.recordAnswer("current_running_frequency", { current_running_frequency: "freq_1_2" });
  assert.equal(engine.answers.training_days, 2);
  assert.equal(engine.answers.current_running_frequency, "freq_1_2");
  const fresh = Engine.create();
  fresh.begin();
  fresh.applyAcquisitionIntent("first10k");
  fresh.recordAnswer("current_running_frequency", { current_running_frequency: "just_starting" });
  assert.equal(fresh.answers.training_days, 1);
  assert.equal(fresh.answers.training_status, "starting");
  const mid = Engine.create();
  mid.begin();
  mid.applyAcquisitionIntent("first10k");
  mid.recordAnswer("current_running_frequency", { current_running_frequency: "freq_3" });
  assert.equal(mid.answers.training_days, 3);
  const high = Engine.create();
  high.begin();
  high.applyAcquisitionIntent("first10k");
  high.recordAnswer("current_running_frequency", { current_running_frequency: "freq_4_plus" });
  assert.equal(high.answers.training_days, 4);
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  const asked = answerUntilComplete(engine, {
    ...common,
    current_running_frequency: { current_running_frequency: "freq_1_2" }
  });
  assert.equal(asked[0], "current_running_frequency");
  assert.equal(asked[1], "current_capacity");
  assert.ok(asked.includes("race_details"));
  assert.equal(asked.includes("goal"), false);
  assert.equal(engine.canComplete(), true);
  const result = engine.complete();
  assert.ok(result && result.feasibility);
  assert.equal(engine.answers.goal_distance, "10K");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const asked = answerUntilComplete(engine, {
    ...common,
    goal: { goal_distance: "General fitness" }
  });
  assert.equal(asked[0], "goal");
  assert.equal(asked.includes("current_running_frequency"), false);
}

{
  const { Engine } = loadEngine();
  const q = Engine.getQuestion("current_running_frequency");
  const interp = q.interpret({ current_running_frequency: "freq_1_2" });
  assert.match(interp, /Got it po/);
  assert.match(interp, /First priority natin/);
  assert.doesNotMatch(interp, /What’s your longest run/);
  assert.doesNotMatch(interp, /Free assessment|2-minute|Personalized diagnosis/);
  const cap = Engine.getQuestion("current_capacity");
  const capInterp = cap.interpret(
    { recent_consistency: "mostly_consistent", recent_longest_run_km: 5 },
    { answers: { goal_distance: "10K", training_status: "building_base" } }
  );
  assert.match(capInterp, /nakaka-5K/);
}

/* ── Opening copy + UI source contracts ────────────────────────────── */

assert.match(uiSrc, /Let's get you ready for your first 10K\./);
assert.match(uiSrc, /I'll ask a few things about your current running and schedule para we know exactly where to start\./);
assert.match(engineSrc, /How often are you running right now\?/);
assert.match(engineSrc, /Just starting/);
assert.match(engineSrc, /1–2x a week/);
assert.match(engineSrc, /3x a week/);
assert.match(engineSrc, /4x\+ a week/);
assert.match(uiSrc, /your endurance coach/, "plain /ai keeps the general greeting");
assert.match(uiSrc, /first10k/);
assert.match(uiSrc, /readAcquisitionIntentFromLocation/);
assert.match(uiSrc, /applyAcquisitionIntent/);
assert.doesNotMatch(uiSrc, /Free assessment|2-minute assessment|Personalized diagnosis/);
assert.match(uiSrc, /data-locked/);
assert.match(uiSrc, /chat-qr-sel/);
// Composer remains visible for current_running_frequency (no hideComposer)
assert.doesNotMatch(uiSrc.slice(uiSrc.indexOf("function presentSubStep("), uiSrc.indexOf("function handleChipSelect")), /current_running_frequency[\s\S]{0,30}hideComposer/);
assert.match(indexSrc, /chat-quick-replies\.is-opening\{flex-direction:column/);
assert.match(indexSrc, /flex-shrink:0;display:flex/);
assert.doesNotMatch(
  uiSrc.slice(uiSrc.indexOf("function startDiagnostic"), uiSrc.indexOf("function showScreen")),
  /athlevoSessionUserId\s*=/
);
assert.match(analyticsSrc, /"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"/);
assert.doesNotMatch(
  analyticsSrc.slice(analyticsSrc.indexOf("var ATTRIBUTION_KEYS"), analyticsSrc.indexOf("var AUTH_ENTRY_KEY")),
  /intent/
);
assert.doesNotMatch(
  authSupportSrc.slice(authSupportSrc.indexOf("const ATTRIBUTION_KEYS"), authSupportSrc.indexOf("let handoffRestoreFocus")),
  /intent/
);
assert.match(registrySrc, /diagnostic_step_completed:/);
assert.match(registrySrc, /acquisition_intent: \{ first10k: true, general: true/);
assert.doesNotMatch(
  metaSrc.slice(metaSrc.indexOf("var CANONICAL_TO_META"), metaSrc.indexOf("var META_COMMERCE")),
  /diagnostic_step_completed/
);
assert.match(uiSrc, /What’s your longest run so far\?/);
assert.match(uiSrc, /Do you already have a target date for your 10K\?/);

/* ── UI + analytics runtime ────────────────────────────────────────── */

function memoryStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store
  };
}

function makeNode(tag, registry) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    style: {},
    children: [],
    attributes: {},
    disabled: false,
    innerHTML: "",
    textContent: "",
    parentNode: null,
    content: { firstElementChild: null },
    classList: {
      add(name) {
        const parts = node.className.split(/\s+/).filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        node.className = parts.join(" ");
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter(c => c && c !== name).join(" ");
      },
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      }
    },
    setAttribute(k, v) {
      node.attributes[k] = String(v);
      if (k === "id") {
        node.id = String(v);
        registry.set(node.id, node);
      }
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attributes, k) ? node.attributes[k] : null; },
    removeAttribute(k) { delete node.attributes[k]; },
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
      if (child.id) registry.set(child.id, child);
      return child;
    },
    querySelector(sel) {
      if (sel === ".chat-thread") return registry.get("chatThread") || null;
      if (sel && sel.startsWith("#")) return registry.get(sel.slice(1)) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "button") return node.children.filter(c => c.tagName === "BUTTON");
      return [];
    },
    addEventListener(type, fn) {
      node.listeners = node.listeners || {};
      node.listeners[type] = node.listeners[type] || [];
      node.listeners[type].push(fn);
    },
    click() {
      const fns = (node.listeners && node.listeners.click) || [];
      fns.forEach(fn => fn());
    },
    animate() {}
  };
  Object.defineProperty(node, "firstElementChild", {
    get() { return node.children[0] || node.content.firstElementChild || null; }
  });
  return node;
}

function parseHtml(htmlFrag, registry) {
  const node = makeNode("div", registry);
  const id = (htmlFrag.match(/\sid="([^"]+)"/) || [])[1];
  const cls = (htmlFrag.match(/\sclass="([^"]*)"/) || [])[1];
  if (cls) node.className = cls;
  if (/<button/i.test(htmlFrag)) node.tagName = "BUTTON";
  node.innerHTML = htmlFrag;
  node.textContent = htmlFrag.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return node;
}

function loadWorld(opts = {}) {
  const registry = new Map();
  const captured = [];
  const search = opts.search || "";
  const win = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    navigator: { userAgent: "Mozilla/5.0 (iPhone)" },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    location: {
      origin: "https://athlevo.org",
      pathname: "/ai",
      search,
      hash: "",
      href: "https://athlevo.org/ai" + search
    },
    document: {
      referrer: "",
      visibilityState: "visible",
      body: { classList: { contains: () => false } },
      documentElement: { clientWidth: opts.width || 390, clientHeight: 844 },
      querySelector: () => null,
      getElementById: () => null
    },
    POSTHOG_KEY: "phc_test",
    posthog: {
      init() {},
      capture(name, props) { captured.push({ name, props: Object.assign({}, props) }); },
      identify() {},
      reset() {},
      _i: [],
      __SV: 1
    },
    innerWidth: opts.width || 390,
    innerHeight: 844
  };
  win.window = win;
  new Function("window", registrySrc)(win);
  new Function("window", "document", "navigator", "localStorage", "sessionStorage",
    analyticsSrc.replace(/\}\)\(typeof window[\s\S]*$/, "})(window);")
  )(win, win.document, win.navigator, win.localStorage, win.sessionStorage);

  const document = {
    readyState: "complete",
    body: { classList: { contains() { return false; }, add() {}, remove() {} } },
    getElementById: id => registry.get(id) || null,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) {
      const el = makeNode(tag, registry);
      if (String(tag).toLowerCase() === "template") {
        Object.defineProperty(el, "innerHTML", {
          set(htmlFrag) {
            el._html = htmlFrag;
            el.content = { firstElementChild: parseHtml(htmlFrag, registry) };
          },
          get() { return el._html; }
        });
      }
      return el;
    }
  };
  ["chatQuickReplies", "chatComposer", "chatInput", "chatSend", "diagBody", "screen-diagnostic"].forEach(id => {
    const el = makeNode(id === "chatInput" ? "input" : "div", registry);
    el.id = id;
    registry.set(id, el);
  });

  const context = {
    console: win.console,
    Date, Math, Uint8Array, Promise, URLSearchParams,
    crypto: globalThis.crypto,
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: true }),
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    document,
    location: win.location,
    AthlevoAnalyticsRegistry: win.AthlevoAnalyticsRegistry,
    AthlevoProductAnalytics: win.AthlevoProductAnalytics,
    AthlevoAnalytics: { track() {} },
    AthlevoMetaPixel: { trackMapped() { return false; } }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSrc, context);
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context);
  vm.runInContext(uiSrc, context);
  return {
    captured,
    helpers: context.AthlevoDiagnosticUI._internal,
    Engine: context.AthlevoDiagnostic,
    registry,
    api: win.AthlevoProductAnalytics,
    UI: context.AthlevoDiagnosticUI
  };
}

{
  const world = loadWorld({ search: "?intent=first10k&utm_source=facebook&utm_medium=paid&fbclid=AbC.123" });
  const utm = world.api.attributionProps();
  assert.equal(utm.utm_source, "facebook");
  assert.equal(utm.utm_medium, "paid");
  assert.equal(utm.fbclid, "AbC.123");
  assert.equal(utm.intent, undefined);
  assert.equal(world.Engine.readAcquisitionIntentFromLocation(world.api && null || {
    search: "?intent=first10k&utm_source=facebook&utm_medium=paid&fbclid=AbC.123"
  }), "first10k");
}

{
  const world = loadWorld({ search: "?intent=first10k" });
  const engine = world.Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  world.helpers.bindEngine(engine);
  world.helpers.primeDiagnosticStartedFromEngine(engine);
  world.helpers.trackAiLandingViewed();
  const landing = world.captured.filter(e => e.name === "ai_landing_viewed");
  assert.equal(landing.length, 1);
  assert.equal(landing[0].props.acquisition_intent, "first10k");
  assert.equal(world.captured.some(e => e.name === "diagnostic_started"), false);

  const q = world.Engine.getQuestion("current_running_frequency");
  world.helpers.prepareQuestion(q);
  world.helpers.handleChipSelect(q.fields[0], q.fields[0].options[1], q.fields);
  const started = world.captured.filter(e => e.name === "diagnostic_started");
  assert.equal(started.length, 1);
  assert.equal(started[0].props.first_input_type, "chip");
  assert.equal(started[0].props.acquisition_intent, "first10k");
  const steps = world.captured.filter(e => e.name === "diagnostic_step_completed");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].props.question_id, "current_running_frequency");
  assert.equal(steps[0].props.answer_type, "chip");
  assert.equal(steps[0].props.answer_id, "freq_1_2");
  assert.equal(steps[0].props.diagnostic_stage, "training");
  assert.equal(steps[0].props.acquisition_intent, "first10k");
  assert.equal(engine.answers.training_days, 2);
}

{
  const world = loadWorld({ search: "" });
  const engine = world.Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent(world.Engine.readAcquisitionIntentFromLocation({ search: "" }));
  world.helpers.bindEngine(engine);
  world.helpers.trackAiLandingViewed();
  assert.equal(world.captured.find(e => e.name === "ai_landing_viewed").props.acquisition_intent, "general");
  assert.equal(engine.nextQuestion().key, "goal");
  const goal = world.Engine.getQuestion("goal");
  world.helpers.prepareQuestion(goal);
  world.helpers.handleChipSelect(goal.fields[0], goal.fields[0].options[0], goal.fields);
  const started = world.captured.filter(e => e.name === "diagnostic_started");
  assert.equal(started.length, 1);
  assert.equal(started[0].props.acquisition_intent, "general");
}

{
  const world = loadWorld({ search: "?intent=first10k" });
  const engine = world.Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  world.helpers.bindEngine(engine);
  const q = world.Engine.getQuestion("current_running_frequency");
  world.helpers.prepareQuestion(q);
  let submits = 0;
  const original = world.helpers.handleChipSelect;
  world.helpers.showQuickReplies(q.fields[0].options, function (opt) {
    submits += 1;
    original.call(null, q.fields[0], opt, q.fields);
  });
  const bar = world.registry.get("chatQuickReplies");
  assert.ok(bar.classList.contains("is-opening"));
  const buttons = bar.querySelectorAll("button");
  assert.equal(buttons.length, 4);
  buttons[0].click();
  buttons[0].click();
  buttons[1].click();
  assert.equal(submits, 1);
  assert.equal(bar.getAttribute("data-locked"), "1");
  assert.ok(buttons[0].classList.contains("chat-qr-sel"));
  assert.equal(buttons.every(b => b.disabled), true);
}

{
  const world = loadWorld({ search: "?intent=first10k" });
  const engine = world.Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  world.helpers.bindEngine(engine);
  const q = world.Engine.getQuestion("current_running_frequency");
  world.helpers.prepareQuestion(q);
  world.helpers.handleChipSelect(q.fields[0], q.fields[0].options[1], q.fields);
  world.helpers.handleChipSelect(q.fields[0], q.fields[0].options[2], q.fields);
  assert.equal(engine.history.filter(k => k === "current_running_frequency").length, 1);
  assert.equal(engine.answers.current_running_frequency, "freq_1_2");
  assert.equal(world.captured.filter(e => e.name === "diagnostic_step_completed").length, 1);
}

{
  const world = loadWorld({ search: "" });
  const engine = world.Engine.create();
  engine.begin();
  world.helpers.bindEngine(engine);
  world.helpers.primeDiagnosticStartedFromEngine(engine);
  const goal = world.Engine.getQuestion("goal");
  world.helpers.prepareQuestion(goal);
  world.helpers.handleChipSelect(goal.fields[0], goal.fields[0].options.find(o => o.value === "10K") || goal.fields[0].options[1], goal.fields);
  const firstStep = world.captured.filter(e => e.name === "diagnostic_step_completed");
  assert.equal(firstStep.length, 1);
  const days = world.Engine.getQuestion("training_days");
  if (days) {
    world.helpers.prepareQuestion(days);
    world.helpers.trackDiagnosticStep(days, { answerType: "chip" });
  }
  assert.equal(world.captured.filter(e => e.name === "diagnostic_step_completed").length, 2);
}

{
  const world = loadWorld({ search: "?intent=first10k" });
  const engine = world.Engine.create();
  engine.begin();
  engine.applyAcquisitionIntent("first10k");
  answerUntilComplete(engine, {
    ...common,
    current_running_frequency: { current_running_frequency: "freq_1_2" }
  });
  world.helpers.bindEngine(engine);
  world.helpers.completeDiagnostic();
  const completed = world.captured.filter(e => e.name === "diagnostic_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].props.acquisition_intent, "first10k");
  assert.equal(completed[0].props.goal_distance, "10K");
}

{
  const registryCtx = {};
  registryCtx.globalThis = registryCtx;
  vm.createContext(registryCtx);
  vm.runInContext(registrySrc, registryCtx);
  const R = registryCtx.AthlevoAnalyticsRegistry;
  const step = R.sanitizeProps("diagnostic_step_completed", {
    step: 1,
    question_id: "current_running_frequency",
    answer_type: "chip",
    answer_id: "freq_1_2",
    diagnostic_stage: "training",
    acquisition_intent: "first10k",
    raw_answer: "I run twice a week around the park",
    message: "secret"
  });
  assert.equal(step.question_id, "current_running_frequency");
  assert.equal(step.answer_id, "freq_1_2");
  assert.equal(step.acquisition_intent, "first10k");
  assert.equal(step.raw_answer, undefined);
  assert.equal(step.message, undefined);
  const started = R.sanitizeProps("diagnostic_started", {
    first_input_type: "chip",
    acquisition_intent: "first10k",
    intent: "signup"
  });
  assert.equal(started.acquisition_intent, "first10k");
  assert.equal(started.intent, undefined);
}

{
  const chatCss = indexSrc.slice(
    indexSrc.indexOf("/* ── Quick replies ── */"),
    indexSrc.indexOf("/* ── Composer ── */")
  );
  assert.match(chatCss, /flex-shrink:0/);
  assert.match(chatCss, /is-opening\{flex-direction:column/);
  assert.doesNotMatch(uiSrc, /chat-thread[\s\S]{0,80}chat-quick-replies/);
}

console.log("PASS — diagnostic acquisition intent (first10k opening, mapping, analytics, chips)");

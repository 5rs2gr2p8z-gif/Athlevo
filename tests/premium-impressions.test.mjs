/**
 * Executable premium-feature impression visibility contract.
 * Run: node tests/premium-impressions.test.mjs
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const accessSource = readFileSync("./js/accessGuard.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");
const scoreSource = readFileSync("./js/athlevoScore.js", "utf8");
const trendsSource = readFileSync("./js/trendsAnalytics.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}`);
  }
}

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...items) { items.forEach(item => values.add(item)); },
    remove(...items) { items.forEach(item => values.delete(item)); },
    contains(item) { return values.has(item); }
  };
}

function makeNode(id, initialClasses = []) {
  const attributes = new Map();
  return {
    id,
    hidden: false,
    isConnected: true,
    style: { display: "" },
    classList: makeClassList(initialClasses),
    dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
    closest() { return null; },
    getBoundingClientRect() {
      return { top: 20, left: 20, right: 120, bottom: 100, width: 100, height: 80 };
    }
  };
}

function storageWith(seed) {
  const values = seed || new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function runtime(options = {}) {
  let accessState = options.accessState ?? "free";
  let loaded = options.loaded ?? true;
  let userId = Object.prototype.hasOwnProperty.call(options, "userId")
    ? options.userId
    : "user-123";
  const events = [];
  const nodes = {
    "screen-landing": makeNode("screen-landing"),
    "screen-welcome": makeNode("screen-welcome"),
    "screen-today": makeNode("screen-today"),
    "screen-trends": makeNode("screen-trends"),
    authModal: makeNode("authModal"),
    performanceUpgradeModal: makeNode("performanceUpgradeModal")
  };
  nodes.authModal.style.display = "none";
  nodes.authModal.setAttribute("aria-hidden", "true");
  nodes.performanceUpgradeModal.setAttribute("aria-hidden", "true");
  nodes[options.activeScreen || "screen-today"].classList.add("active");

  const targets = {
    trainingLoad: makeNode("todayLoadSignal"),
    recovery: makeNode("todayRecoverySignal"),
    score: makeNode("athlevoScoreCard"),
    trends: makeNode("trendsPerformancePreview")
  };
  const visibilityListeners = [];
  const document = {
    visibilityState: options.documentVisibility || "visible",
    documentElement: { clientWidth: 390, clientHeight: 844 },
    activeElement: null,
    getElementById(id) { return nodes[id] || null; },
    addEventListener(name, handler) {
      if (name === "visibilitychange") visibilityListeners.push(handler);
    }
  };
  const sessionStorage = storageWith(options.sessionValues);
  const observers = [];
  class MockIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
  }
  const root = {
    document,
    sessionStorage,
    innerWidth: 390,
    innerHeight: 844,
    requestAnimationFrame(callback) { callback(); return 1; },
    setTimeout(callback) { callback(); return 1; },
    IntersectionObserver: MockIntersectionObserver,
    getComputedStyle(target) {
      return target.computedStyle || {
        display: "block",
        visibility: "visible",
        opacity: "1"
      };
    },
    AthlevoPlan: {
      isLoaded: () => loaded,
      entitlement: () => ({ accessState })
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent(name, props) { events.push({ name, props }); }
    },
    location: { origin: "https://athlevo.org", pathname: "/" },
    open() {},
    URL
  };
  root.window = root;
  const supabaseClient = {
    auth: {
      async getUser() {
        return { data: { user: userId ? { id: userId } : null }, error: null };
      }
    }
  };
  vm.runInNewContext(accessSource, {
    window: root,
    document,
    sessionStorage,
    supabaseClient,
    URL,
    Promise,
    console
  });

  return {
    root,
    nodes,
    targets,
    events,
    sessionStorage,
    observers,
    setAccessState(value) { accessState = value; },
    setLoaded(value) { loaded = value; },
    setUserId(value) { userId = value; },
    activate(screenId) {
      Object.values(nodes).forEach(node => node.classList.remove("active"));
      nodes[screenId].classList.add("active");
    },
    openAuth() {
      nodes.authModal.style.display = "flex";
      nodes.authModal.setAttribute("aria-hidden", "false");
    },
    async settle() {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

function premiumEvents(value) {
  return value.events.filter(event => event.name === "premium_feature_viewed");
}

console.log("\n──── Public, auth, and hidden-shell guards ────");
test("all production renderers register the actual locked element",
  /trackPremiumView\(\s*"training_load",\s*"today",\s*loadSignal/.test(indexSource) &&
  /trackPremiumView\(\s*"recovery",\s*"today",\s*recoverySignal/.test(indexSource) &&
  /trackPremiumView\(\s*"athlevo_score",\s*"today",\s*lockedTarget/.test(scoreSource) &&
  /trackPremiumView\(\s*"trends",\s*"trends",\s*preview/.test(trendsSource));
{
  const value = runtime({ activeScreen: "screen-landing" });
  value.root.AthlevoProductAnalytics.trackAthlevoEvent("landing_viewed", {});
  value.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", value.targets.trainingLoad
  );
  await value.settle();
  test("landing load emits landing_viewed but no premium impression",
    value.events.some(event => event.name === "landing_viewed") &&
    premiumEvents(value).length === 0);
  test("landing rendering does not consume a session deduplication key",
    value.sessionStorage.values.size === 0);
  test("production landing routing explicitly emits landing_viewed",
    /id==='screen-landing'[\s\S]{0,180}trackAthlevoEvent\(\s*'landing_viewed'/.test(indexSource));
  test("hidden Today shell is registered but cannot emit",
    value.observers.some(observer => observer.targets.has(value.targets.trainingLoad)) &&
    premiumEvents(value).length === 0);
}
{
  const value = runtime({ userId: null });
  value.root.AthlevoAccessGuard.trackPremiumView(
    "recovery", "today", value.targets.recovery
  );
  await value.settle();
  test("anonymous visitors never emit", premiumEvents(value).length === 0);
}
{
  const value = runtime();
  value.openAuth();
  value.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", value.targets.trainingLoad
  );
  await value.settle();
  test("open auth modal blocks premium impressions", premiumEvents(value).length === 0);
}
{
  const value = runtime({ activeScreen: "screen-welcome" });
  value.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", value.targets.trainingLoad
  );
  await value.settle();
  test("auth entry screen blocks premium impressions", premiumEvents(value).length === 0);
}
{
  const value = runtime({ activeScreen: "screen-today" });
  value.root.AthlevoAccessGuard.trackPremiumView(
    "trends", "trends", value.targets.trends
  );
  await value.settle();
  test("hidden Trends rendering does not emit", premiumEvents(value).length === 0);
}
{
  const value = runtime();
  value.targets.trainingLoad.getBoundingClientRect = () => ({
    top: 900,
    left: 20,
    right: 120,
    bottom: 980,
    width: 100,
    height: 80
  });
  value.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", value.targets.trainingLoad
  );
  await value.settle();
  test("locked markup outside the viewport does not emit",
    premiumEvents(value).length === 0);
  value.targets.trainingLoad.getBoundingClientRect = () => ({
    top: 20,
    left: 20,
    right: 120,
    bottom: 100,
    width: 100,
    height: 80
  });
  value.observers[0].callback([{
    target: value.targets.trainingLoad,
    isIntersecting: true,
    intersectionRatio: 1
  }]);
  await value.settle();
  test("IntersectionObserver emits once when the locked feature enters view",
    premiumEvents(value).length === 1);
}

console.log("\n──── Entitlement and document gates ────");
{
  const unknown = runtime({ loaded: false });
  unknown.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", unknown.targets.trainingLoad
  );
  await unknown.settle();
  test("unknown/loading entitlement does not emit", premiumEvents(unknown).length === 0);

  const paid = runtime({ accessState: "paid_active" });
  paid.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", paid.targets.trainingLoad
  );
  await paid.settle();
  test("paid_active does not emit", premiumEvents(paid).length === 0);

  const hiddenDocument = runtime({ documentVisibility: "hidden" });
  hiddenDocument.root.AthlevoAccessGuard.trackPremiumView(
    "recovery", "today", hiddenDocument.targets.recovery
  );
  await hiddenDocument.settle();
  test("hidden document does not emit", premiumEvents(hiddenDocument).length === 0);
}

console.log("\n──── Real locked-feature visibility ────");
{
  const value = runtime();
  value.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", value.targets.trainingLoad
  );
  value.root.AthlevoAccessGuard.trackPremiumView(
    "recovery", "today", value.targets.recovery
  );
  value.root.AthlevoAccessGuard.trackPremiumView(
    "athlevo_score", "today", value.targets.score
  );
  await value.settle();
  const captured = premiumEvents(value);
  test("authenticated free user sees Training Load once",
    captured.filter(event => event.props.feature === "training_load").length === 1);
  test("authenticated free user sees Recovery once",
    captured.filter(event => event.props.feature === "recovery").length === 1);
  test("authenticated free user sees Athlevo Score once",
    captured.filter(event => event.props.feature === "athlevo_score").length === 1);
  test("only categorical feature and surface properties are captured",
    captured.length === 3 &&
    captured.every(event =>
      JSON.stringify(Object.keys(event.props).sort()) ===
        JSON.stringify(["feature", "surface"])));

  value.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", value.targets.trainingLoad
  );
  value.root.AthlevoAccessGuard.refreshPremiumViews();
  await value.settle();
  test("harmless rerenders do not duplicate impressions",
    premiumEvents(value).filter(event =>
      event.props.feature === "training_load").length === 1);

  value.activate("screen-trends");
  value.root.AthlevoAccessGuard.refreshPremiumViews();
  value.activate("screen-today");
  value.root.AthlevoAccessGuard.refreshPremiumViews();
  await value.settle();
  test("leaving and re-entering Today does not duplicate in one session",
    premiumEvents(value).length === 3);
}
{
  const inactive = runtime({ accessState: "paid_inactive" });
  inactive.root.AthlevoAccessGuard.trackPremiumView(
    "recovery", "today", inactive.targets.recovery
  );
  await inactive.settle();
  test("paid_inactive is treated as a locked entitlement",
    premiumEvents(inactive).length === 1);
}
{
  const value = runtime({ activeScreen: "screen-trends" });
  value.root.AthlevoAccessGuard.trackPremiumView(
    "trends", "trends", value.targets.trends
  );
  await value.settle();
  test("authenticated free user opening Trends emits one Trends impression",
    premiumEvents(value).length === 1 &&
    premiumEvents(value)[0].props.feature === "trends" &&
    premiumEvents(value)[0].props.surface === "trends");
}

console.log("\n──── Browser-session deduplication ────");
{
  const first = runtime();
  first.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", first.targets.trainingLoad
  );
  await first.settle();

  const sameSession = runtime({ sessionValues: first.sessionStorage.values });
  sameSession.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", sameSession.targets.trainingLoad
  );
  await sameSession.settle();
  test("same user/feature/surface remains deduplicated in one browser session",
    premiumEvents(first).length === 1 && premiumEvents(sameSession).length === 0);

  const differentUser = runtime({
    sessionValues: first.sessionStorage.values,
    userId: "user-456"
  });
  differentUser.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", differentUser.targets.trainingLoad
  );
  await differentUser.settle();
  test("a different authenticated user has an independent session key",
    premiumEvents(differentUser).length === 1);

  const newSession = runtime();
  newSession.root.AthlevoAccessGuard.trackPremiumView(
    "training_load", "today", newSession.targets.trainingLoad
  );
  await newSession.settle();
  test("a new browser session may emit again", premiumEvents(newSession).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

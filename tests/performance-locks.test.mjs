/**
 * Executable Athlevo Performance entitlement and locked-preview contract.
 * Run: node tests/performance-locks.test.mjs
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const accessSource = readFileSync("./js/accessGuard.js", "utf8");
const scoreSource = readFileSync("./js/athlevoScore.js", "utf8");
const trendsSource = readFileSync("./js/trendsAnalytics.js", "utf8");
const registrySource = readFileSync("./js/analyticsRegistry.js", "utf8");
const providerSource = readFileSync("./api/providers/index.js", "utf8");

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
const section = name => console.log(`\n──── ${name} ────`);

function classList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); }
  };
}

section("Server authority and fail-closed ordering");
{
  const route = providerSource.slice(
    providerSource.indexOf("async function actionTrends"),
    providerSource.indexOf("ACTION: diagnose")
  );
  test("Trends authenticates and requires paid access before provider lookup",
    route.indexOf("const user = await requireUser(request)") >= 0 &&
    route.indexOf('requirePaidAccess(user.id, "trends_analytics")') >
      route.indexOf("const user = await requireUser(request)") &&
    route.indexOf('requirePaidAccess(user.id, "trends_analytics")') <
      route.indexOf("readProviderAccount(user.id"));
  test("free response is structured and contains no premium series",
    /status\(402\)\.json\(\{[\s\S]*?code:\s*"PERFORMANCE_REQUIRED"[\s\S]*?feature:\s*"trends_analytics"/.test(route) &&
    !/PERFORMANCE_REQUIRED[\s\S]{0,180}\bdays\b/.test(route));
  test("client-provided subscription or checkout state is never consulted",
    !/request\.body\.(?:entitlement|subscription|plan|paid|checkout)/.test(route));
}

section("Today free and paid presentation");
{
  const today = html.slice(
    html.indexOf('<section class="screen" id="screen-today">'),
    html.indexOf('<section class="screen"', html.indexOf('<section class="screen" id="screen-today">') + 1)
  );
  const status = today.slice(
    today.indexOf('<section class="today-status-card"'),
    today.indexOf('<details class="direction-why"')
  );
  test("Readiness remains a normal visible signal",
    /id="todayReadinessSignal"/.test(status) &&
    !/id="todayReadinessSignal"[^>]*data-premium-state/.test(status));
  test("Training Load and Recovery fail closed while entitlement loads",
    /id="todayLoadSignal" data-premium-state="loading"/.test(status) &&
    /id="todayRecoverySignal" data-premium-state="loading"/.test(status));
  test("locked signals contain only a mask, Performance copy, and safe aria text",
    /function setLockedSignal[\s\S]*?valueNode\.textContent = "••"[\s\S]*?noteNode\.textContent = "Performance"/.test(html) &&
    /name \+ ", available with Athlevo Performance"/.test(html) &&
    !/function setLockedSignal[\s\S]{0,900}signal\.(?:value|score|progress)/.test(html));
  test("paid branch alone renders real Training Load and Recovery",
    /if \(paid\)\{[\s\S]*?setSignal\(loadSignal[\s\S]*?renderTodayRecoverySignal\(/.test(html) &&
    /paid &&[\s\S]*?AthlevoRecovery\.calculateRecovery/.test(html) &&
    /premiumTeaser\.hidden = paid/.test(html));
  test("free users retain the recommendation and get one insight teaser",
    /id="todayDirectionLabel"/.test(today) &&
    /See how recovery and recent training load shaped today’s recommendation\./.test(status) &&
    /Unlock insights/.test(status));
  test("locked metrics have neutral preview arcs and restrained lock icons",
    /\.direction-signal\[data-premium-state="locked"\][\s\S]*?stroke-dasharray:38 100/.test(html) &&
    (status.match(/class="direction-signal-lock"/g) || []).length === 2);
}

section("Athlevo Score preview");
{
  const mount = { innerHTML: "" };
  const detail = { innerHTML: "old score", classList: classList() };
  const document = {
    getElementById(id) {
      if (id === "athlevoScoreCard") return mount;
      if (id === "scoreDetailModal") return detail;
      return null;
    }
  };
  const root = {
    AthlevoAccessGuard: {
      accessState: async () => "free",
      trackPremiumView() {}
    }
  };
  root.window = root;
  vm.runInNewContext(scoreSource, { window: root, document, console });
  await root.AthlevoScore.refresh([], {});

  test("free Athlevo Score renders no personalized number or component values",
    /Athlevo Score/.test(mount.innerHTML) &&
    /••/.test(mount.innerHTML) &&
    !/\/100|asc-cval|overall_score|score_date/.test(mount.innerHTML));
  test("locked score uses the compact Performance summary and explicit sheet action",
    /asc-radar-summary--locked/.test(mount.innerHTML) &&
    /asc-mini-grid/.test(mount.innerHTML) &&
    !/asc-mini-area/.test(mount.innerHTML) &&
    /Performance/.test(mount.innerHTML) &&
    /Unlock Athlevo Score with Athlevo Performance/.test(mount.innerHTML) &&
    /showUpgradeSheet\('athlevo_score','today'\)/.test(mount.innerHTML));
  test("free transition clears previously rendered score details",
    detail.innerHTML === "" && !detail.classList.contains("show"));
  const refreshBody = scoreSource.slice(
    scoreSource.indexOf("async function refresh"),
    scoreSource.indexOf("async function loadExecutions")
  );
  test("entitlement resolves before score data or history is loaded",
    refreshBody.indexOf("accessState()") >= 0 &&
    refreshBody.indexOf("accessState()") < refreshBody.indexOf("AthleteModel.getFitness") &&
    refreshBody.indexOf("accessState()") < refreshBody.indexOf("loadPriorScore"));
}

function trendsRuntime(accessState) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        hidden: false,
        innerHTML: "",
        textContent: "",
        classList: classList(),
        setAttribute() {}
      });
    }
    return nodes.get(id);
  };
  const document = {
    getElementById: node,
    addEventListener() {},
    querySelectorAll() { return []; }
  };
  let providerCalls = 0;
  let views = 0;
  const root = {
    AthlevoAccessGuard: {
      accessState,
      trackPremiumView() { views += 1; }
    },
    AthlevoBrain: {
      async loadProviderTrends() {
        providerCalls += 1;
        return null;
      }
    }
  };
  root.window = root;
  vm.runInNewContext(trendsSource, { window: root, document, console });
  return {
    root,
    node,
    providerCalls: () => providerCalls,
    views: () => views
  };
}

section("Trends premium preview");
{
  let resolveAccess;
  const runtime = trendsRuntime(() => new Promise(resolve => {
    resolveAccess = resolve;
  }));
  const pending = runtime.root.AthlevoTrendsAnalytics.refresh();
  test("unknown/loading hides charts, previews, and range controls",
    runtime.node("trendsContent").hidden === true &&
    runtime.node("trendsPerformancePreview").hidden === true &&
    runtime.node("trendRangeControls").hidden === true &&
    runtime.providerCalls() === 0);
  resolveAccess("free");
  await pending;
  test("free renders preview without requesting personalized Trends",
    runtime.node("trendsPerformancePreview").hidden === false &&
    runtime.node("trendsContent").hidden === true &&
    runtime.providerCalls() === 0 &&
    runtime.views() === 1);

  const preview = html.slice(
    html.indexOf('id="trendsPerformancePreview"'),
    html.indexOf('id="trendsContent"')
  );
  test("free preview contains exactly three generic chart shells",
    (preview.match(/class="trends-preview-chart"/g) || []).length === 3 &&
    /not personal training data/.test(preview));
  test("preview names all three premium analytics surfaces without exact values",
    /Training Status/.test(preview) &&
    /Fitness vs Fatigue/.test(preview) &&
    /Training Load/.test(preview) &&
    !/Fitness \d|Fatigue \d|Form [+\-]?\d|7-day load \d/.test(preview));
  test("entering Trends never opens checkout automatically",
    /showUpgradeSheet\('trends','trends'\)/.test(preview) &&
    !/checkout(?:FromUpgrade)?\(/.test(preview));
  test("paid Trends rendering removes previews and restores real range controls",
    /function renderData[\s\S]*?preview\.hidden = true[\s\S]*?ranges\.hidden = false/.test(trendsSource));
}

section("Reusable upgrade sheet, focus, and checkout");
{
  const primary = { hidden: false, focus() { document.activeElement = primary; } };
  const secondary = { hidden: false, focus() { document.activeElement = secondary; } };
  const trigger = { focused: false, focus() { this.focused = true; document.activeElement = trigger; } };
  const modal = {
    dataset: {},
    attrs: {},
    classList: classList(),
    handlers: {},
    hidden: false,
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key] ?? null; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    querySelectorAll() { return [primary, secondary]; }
  };
  const document = {
    activeElement: trigger,
    visibilityState: "visible",
    getElementById(id) {
      return id === "performanceUpgradeModal" ? modal : null;
    }
  };
  const events = [];
  const opened = [];
  const root = {
    document,
    AthlevoAnalytics: {
      track(name, props) { events.push({ name, props }); }
    },
    AthlevoPlan: {
      isLoaded: () => true,
      entitlement: () => ({ accessState: "free", tier: 0 })
    },
    location: { origin: "https://preview.vercel.app", pathname: "/app" },
    open(url) { opened.push(url); return { closed: false }; },
    URL
  };
  root.window = root;
  const supabaseClient = {
    auth: {
      async getUser() {
        return { data: { user: { id: "verified-user" } }, error: null };
      }
    }
  };
  vm.runInNewContext(accessSource, {
    window: root, document, supabaseClient, URL, console
  });

  root.AthlevoAccessGuard.showUpgradeSheet("recovery", "today");
  await new Promise(resolve => setTimeout(resolve, 0));
  test("feature click opens only the sheet and focuses its first action",
    modal.classList.contains("show") &&
    modal.attrs["aria-hidden"] === "false" &&
    document.activeElement === primary &&
    opened.length === 0);
  test("opening the sheet does not synthesize a premium feature impression",
    !events.some(event => event.name === "premium_feature_viewed"));
  test("authenticated visible sheet emits the canonical categorical impression",
    events.some(event =>
      event.name === "upgrade_sheet_viewed" &&
      event.props.feature === "recovery" &&
      event.props.surface === "upgrade_sheet" &&
      event.props.access_tier === "free"));

  let tabPrevented = false;
  modal.handlers.keydown({
    key: "Tab",
    shiftKey: true,
    preventDefault() { tabPrevented = true; }
  });
  const wrapsBackward = tabPrevented && document.activeElement === secondary;
  tabPrevented = false;
  modal.handlers.keydown({
    key: "Tab",
    shiftKey: false,
    preventDefault() { tabPrevented = true; }
  });
  test("Tab and Shift+Tab remain trapped inside the sheet",
    wrapsBackward && tabPrevented && document.activeElement === primary);

  modal.handlers.keydown({ key: "Escape", preventDefault() {} });
  test("Escape closes the sheet and restores focus",
    !modal.classList.contains("show") &&
    modal.attrs["aria-hidden"] === "true" &&
    trigger.focused === true);

  document.activeElement = trigger;
  root.AthlevoAccessGuard.showUpgradeSheet("trends", "trends");
  root.AthlevoAccessGuard.checkoutFromUpgrade();
  test("only the sheet primary action opens Whop",
    opened.length === 1 && /whop\.com/.test(opened[0]));
  test("checkout records only categorical upgrade and checkout events",
    events.some(event =>
      event.name === "upgrade_clicked" &&
      event.props.feature === "trends" &&
      event.props.surface === "upgrade_sheet") &&
    events.some(event =>
      event.name === "checkout_started" &&
      event.props.feature === "trends" &&
      event.props.surface === "upgrade_sheet"));
  test("checkout opening does not alter entitlement",
    root.AthlevoPlan.entitlement().accessState === "free");

  const sheetCount = (html.match(/id="performanceUpgradeModal"/g) || []).length;
  test("one reusable accessible upgrade sheet exists",
    sheetCount === 1 &&
    /role="dialog"[\s\S]*?aria-modal="true"/.test(html) &&
    /Upgrade to Athlevo Performance/.test(html) &&
    /Not now/.test(html));
}

section("Analytics privacy and responsive styling");
{
  const module = { exports: {} };
  vm.runInNewContext(registrySource, { module, console });
  const registry = module.exports;
  const safe = registry.sanitizeProps("premium_feature_viewed", {
    feature: "recovery",
    surface: "today",
    score: 88,
    readiness: 72,
    pain: "reported",
    email: "athlete@example.com"
  });
  test("premium analytics registry allows only feature and surface",
    registry.isKnown("premium_feature_viewed") &&
    JSON.stringify(safe) === JSON.stringify({
      feature: "recovery",
      surface: "today"
    }));
  test("locked UI supports dark theme tokens and narrow mobile layout",
    /\.performance-upgrade-sheet[\s\S]*?background:var\(--paper\)/.test(html) &&
    /\.trends-preview-chart[\s\S]*?background:var\(--paper\)/.test(html) &&
    /@media \(max-width:360px\)[\s\S]*?\.trends-performance-preview/.test(html));
  test("global reduced-motion protection remains active",
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important/.test(html));
  const newUi = [
    html.slice(html.indexOf("performance-upgrade-back"), html.indexOf("/* Real-only seven-day context")),
    html.slice(html.indexOf('id="trendsPerformancePreview"'), html.indexOf('id="trendsContent"')),
    scoreSource.slice(scoreSource.indexOf("function renderLockedScoreCard"), scoreSource.indexOf("function renderScoreCard"))
  ].join("\n");
  test("new Performance UI contains no timed-trial language",
    !/free trial|start trial|no card|required after trial|₱0 today|trial ends/i.test(newUi));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

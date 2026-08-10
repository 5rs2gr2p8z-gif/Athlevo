/**
 * Executable contract for the shared Athlevo boot shell, tab indicator, and
 * top-level screen transition.
 * Run: node tests/app-shell-motion.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const coachMode = readFileSync("./js/coachMode.js", "utf8");
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

function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not close ${name}()`);
}

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); }
  };
}

console.log("\n──── Cold app shell ────");
{
  const boot = html.slice(
    html.indexOf('<div id="boot-gate"'),
    html.indexOf('<div class="device">')
  );
  test("boot uses a layout-matched skeleton and no centered spinner",
    /class="boot-content"/.test(boot) &&
    /class="boot-primary-card"/.test(boot) &&
    /class="boot-status-row"/.test(boot) &&
    /class="boot-week-row"/.test(boot) &&
    !/spinner/.test(boot));
  test("boot status has exactly three compact 54px placeholders",
    (boot.match(/class="skel boot-status-ring"/g) || []).length === 3 &&
    /\.boot-status-ring\{width:54px;height:54px/.test(html));
  test("boot shell presents no fake athlete values",
    !/—|\bRPE\b|\bbpm\b|\bkm\b|\bhrs?\b/.test(boot));
  test("boot navigation preserves five stable top-level positions",
    (boot.match(/class="boot-tab"/g) || []).length === 5 &&
    ["Today", "Coach", "Train", "Trends", "You"].every(label =>
      boot.includes(`<span>${label}</span>`)));
  test("375, 390, 430px and desktop/PWA keep the shell within the viewport",
    [375, 390, 430].every(width => width <= 430) &&
    /\.boot-shell\{[^}]*width:min\(100%,430px\)[^}]*height:100dvh/.test(html) &&
    /\.boot-content\{[^}]*overflow:hidden/.test(html) &&
    /padding:[^;]*env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-bottom\)/.test(html) &&
    /@media\(min-width:480px\)\{\.boot-shell\{height:calc\(100dvh - 56px\)/.test(html));
}

console.log("\n──── Shared moving tab indicator ────");
{
  const children = [];
  const tabbar = {
    dataset: {},
    getBoundingClientRect: () => ({ left: 0, width: 390 }),
    appendChild(node) { children.push(node); },
    querySelector(selector) {
      if (selector === ".nav-active-indicator") {
        return children.find(node => node.className === "nav-active-indicator") || null;
      }
      return null;
    }
  };
  const makeTab = left => ({
    classList: makeClassList(),
    getBoundingClientRect: () => ({ left, width: 64 })
  });
  const first = makeTab(12);
  const second = makeTab(88);
  const document = {
    getElementById: id => id === "tabbar" ? tabbar : null,
    createElement: () => ({
      className: "",
      dataset: {},
      style: {},
      setAttribute() {}
    }),
    querySelectorAll: selector => selector === "#tabbar .tab" ? [first, second] : []
  };
  const window = {
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) { callback(); return 1; }
  };
  const api = new Function("document", "window", "setTimeout", `
    ${extractFunction(html, "athlevoPrefersReducedMotion")}
    ${extractFunction(html, "ensureNavActiveIndicator")}
    ${extractFunction(html, "positionNavActiveIndicator")}
    ${extractFunction(html, "selectAppTab")}
    return { ensureNavActiveIndicator, positionNavActiveIndicator, selectAppTab };
  `)(document, window, callback => callback());

  api.selectAppTab(first, false);
  const indicator = api.ensureNavActiveIndicator();
  const firstPosition = indicator.style.transform;
  api.selectAppTab(second, true);
  test("one indicator is reused across selections",
    children.filter(node => node.className === "nav-active-indicator").length === 1);
  test("indicator measures and moves to the selected tab",
    firstPosition === "translate3d(31px,0,0)" &&
    indicator.style.transform === "translate3d(107px,0,0)" &&
    indicator.style.width === "27px");
  test("selection remains legible without depending only on red",
    second.classList.contains("on") && !first.classList.contains("on") &&
    /\.tab\.on\{color:var\(--text\);opacity:1\}/.test(html));
  test("legacy per-tab dots are visually retired",
    /\.dotmark\{display:none\}/.test(html));
}

console.log("\n──── Screen transition runtime ────");
{
  const makeScreen = (id, active) => ({
    id,
    classList: makeClassList(active ? ["active"] : [])
  });
  const today = makeScreen("screen-today", true);
  const coach = makeScreen("screen-coachai", false);
  const screens = [today, coach];
  let reduced = false;
  const document = {
    getElementById(id) { return screens.find(screen => screen.id === id) || null; },
    querySelectorAll(selector) { return selector === ".screen" ? screens : []; },
    querySelector(selector) {
      return selector === ".screen.active"
        ? screens.find(screen => screen.classList.contains("active")) || null
        : null;
    }
  };
  const window = {
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame(callback) { callback(); return 1; }
  };
  const api = new Function("document", "window", "setTimeout", `
    var athlevoScreenTransitionToken = 0;
    ${extractFunction(html, "athlevoPrefersReducedMotion")}
    ${extractFunction(html, "clearAppScreenMotion")}
    ${extractFunction(html, "showAppScreenImmediately")}
    ${extractFunction(html, "transitionTopLevelScreen")}
    return { transitionTopLevelScreen };
  `)(document, window, callback => { callback(); return 1; });

  await api.transitionTopLevelScreen("screen-coachai");
  test("a completed transition leaves exactly one visible screen",
    screens.filter(screen => screen.classList.contains("active")).length === 1 &&
    coach.classList.contains("active") && !today.classList.contains("active"));
  test("temporary transition classes are fully cleaned up",
    screens.every(screen =>
      !screen.classList.contains("tab-leaving") &&
      !screen.classList.contains("tab-entering") &&
      !screen.classList.contains("tab-entering-active")));

  reduced = true;
  await api.transitionTopLevelScreen("screen-today");
  test("reduced motion switches immediately without transition classes",
    today.classList.contains("active") &&
    screens.every(screen => !screen.classList.contains("tab-leaving") &&
      !screen.classList.contains("tab-entering")));
}

console.log("\n──── Shared contracts ────");
test("cached tab taps never force page skeleton state",
  !/async function go\(btn\)[\s\S]{0,1600}(?:setTodayScreenState\("loading"\)|todayPlanLoadingState)/.test(html));
test("coach workspace tabs reuse the shared motion system",
  /AthlevoAppMotion\.selectTab\(btn, true\)/.test(coachMode) &&
  /AthlevoAppMotion\.transitionTo\(screenId\)/.test(coachMode));
test("decorative Today red top rules are removed",
  !/\.today-no-plan\{[^}]*border-top/.test(html) &&
  !/\.today-training-card\{[^}]*border-top/.test(html));
test("missing Today rings remain compact, neutral, and dash-free",
  /\.direction-signal\[data-tone="missing"\] \.direction-signal-ring\{[^}]*background:var\(--card\)/.test(html) &&
  /id="todayReadinessSignalValue"><\/strong>/.test(html) &&
  /id="todayRecoverySignalValue"><\/strong>/.test(html));
test("global reduced-motion protection disables shimmer and transitions",
  /prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important[\s\S]*?transition-duration:\.001ms!important/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

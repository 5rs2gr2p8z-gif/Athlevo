/**
 * Phase 2 navigation contract: immediate directional peer transitions,
 * cancellation safety, synchronized indicators, and reduced-motion fallback.
 * Run: node tests/fluid-interactions-phase2.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const coach = readFileSync("./js/coachMode.js", "utf8");

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

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); }
  };
}

function makeScreen(id, active, scrollTop) {
  const attrs = new Map();
  const styles = new Map();
  return {
    id,
    inert: false,
    scrollTop,
    classList: classList(active ? ["active"] : []),
    style: {
      setProperty(name, value) { styles.set(name, value); },
      removeProperty(name) { styles.delete(name); },
      getPropertyValue(name) { return styles.get(name) || ""; }
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) || null; },
    removeAttribute(name) { attrs.delete(name); }
  };
}

function createHarness() {
  const screens = [
    makeScreen("screen-today", true, 146),
    makeScreen("screen-train", false, 82),
    makeScreen("screen-trends", false, 219)
  ];
  const tabs = screens.map(screen => ({
    getAttribute(name) { return name === "data-screen" ? screen.id : null; }
  }));
  const animationFrames = [];
  const timers = new Map();
  const timerDelays = [];
  let nextTimer = 1;
  let reduced = false;
  const document = {
    getElementById(id) { return screens.find(screen => screen.id === id) || null; },
    querySelectorAll(selector) {
      if (selector === ".screen") return screens;
      if (selector === "#tabbar .tab") return tabs;
      return [];
    },
    querySelector(selector) {
      return selector === ".screen.active"
        ? screens.find(screen => screen.classList.contains("active")) || null
        : null;
    }
  };
  const window = {
    matchMedia() { return { matches: reduced }; },
    requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; }
  };
  function setTimeoutFake(callback, delay) {
    const id = nextTimer++;
    timers.set(id, callback);
    timerDelays.push(delay);
    return id;
  }
  function clearTimeoutFake(id) { timers.delete(id); }
  const api = new Function("document", "window", "setTimeout", "clearTimeout", `
    var athlevoScreenTransitionToken = 0;
    var athlevoScreenTransitionTimer = null;
    var athlevoScreenTransitionResolve = null;
    var athlevoScreenTransitionTargetId = null;
    var ATHLEVO_SCREEN_MOTION_MS = 240;
    ${extractFunction(html, "athlevoPrefersReducedMotion")}
    ${extractFunction(html, "appTabIndexForScreen")}
    ${extractFunction(html, "appScreenDirection")}
    ${extractFunction(html, "clearAppScreenMotion")}
    ${extractFunction(html, "cancelAppScreenTransition")}
    ${extractFunction(html, "showAppScreenImmediately")}
    ${extractFunction(html, "transitionTopLevelScreen")}
    return { appScreenDirection, transitionTopLevelScreen, showAppScreenImmediately };
  `)(document, window, setTimeoutFake, clearTimeoutFake);
  return {
    api,
    screens,
    timerDelays,
    setReduced(value) { reduced = value; },
    flushFrames() {
      while (animationFrames.length) animationFrames.shift()();
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    }
  };
}

console.log("\n──── Immediate directional top-level navigation ────");
{
  const harness = createHarness();
  const [today, train] = harness.screens;
  test("direction derives from live tab order with exact left/right symmetry",
    harness.api.appScreenDirection("screen-today", "screen-train") === 1 &&
    harness.api.appScreenDirection("screen-train", "screen-today") === -1);
  const transition = harness.api.transitionTopLevelScreen("screen-train");
  test("incoming screen activates before the first animation frame",
    train.classList.contains("active") && train.classList.contains("tab-entering"));
  test("rightward destination enters right while outgoing screen moves left",
    train.style.getPropertyValue("--screen-enter-x") === "14px" &&
    today.style.getPropertyValue("--screen-exit-x") === "-8px");
  test("outgoing screen is immediately removed from interaction and accessibility",
    today.inert && today.getAttribute("aria-hidden") === "true" &&
    today.classList.contains("tab-leaving"));
  test("screen scroll positions are untouched during activation",
    today.scrollTop === 146 && train.scrollTop === 82);
  harness.flushFrames();
  test("the old 140ms leave gate is gone and cleanup matches screen motion",
    !harness.timerDelays.includes(140) && harness.timerDelays.includes(240));
  harness.flushTimers();
  await transition;
  test("completion leaves exactly one active, interactive target",
    harness.screens.filter(screen => screen.classList.contains("active")).length === 1 &&
    train.classList.contains("active") && !train.inert);
}

console.log("\n──── Cancellation, same-tab, and reduced motion ────");
{
  const harness = createHarness();
  harness.api.showAppScreenImmediately("screen-train");
  const first = harness.api.transitionTopLevelScreen("screen-today");
  const second = harness.api.transitionTopLevelScreen("screen-trends");
  harness.flushFrames();
  harness.flushTimers();
  test("rapid taps replace rather than queue the stale target", (await first) === null);
  await second;
  test("rapid taps finish on one latest target without stale classes",
    harness.screens.filter(screen => screen.classList.contains("active")).length === 1 &&
    harness.screens[2].classList.contains("active") &&
    harness.screens.every(screen => !screen.classList.contains("tab-entering") &&
      !screen.classList.contains("tab-leaving")));
  const framesBeforeSameTab = harness.timerDelays.length;
  await harness.api.transitionTopLevelScreen("screen-trends");
  test("same-tab selection does not replay screen motion",
    harness.timerDelays.length === framesBeforeSameTab);
  harness.setReduced(true);
  await harness.api.transitionTopLevelScreen("screen-today");
  test("reduced motion swaps immediately with no translation classes",
    harness.screens[0].classList.contains("active") &&
    harness.screens.every(screen => !screen.classList.contains("tab-entering") &&
      !screen.classList.contains("tab-leaving")));
}

console.log("\n──── Indicator, secondary tabs, and phase boundaries ────");
test("nav indicator and screen content share one duration and easing",
  /--motion-screen:240ms/.test(html) &&
  /\.nav-active-indicator\{[\s\S]*?transform var\(--motion-screen\) var\(--ease-standard\)/.test(html) &&
  /\.screen\.tab-leaving,[^}]*var\(--motion-screen\) var\(--ease-standard\)/.test(html));
test("athlete and coach navigation select the indicator target before content",
  /async function go\(btn\)\{[\s\S]*?selectAppTab\(btn, true\);[\s\S]*?transitionTopLevelScreen\(screenId\)/.test(html) &&
  /AthlevoAppMotion\.selectTab\(btn, true\);[\s\S]*?AthlevoAppMotion\.transitionTo\(screenId\)/.test(coach));
test("Athlete Detail tabs use smaller mirrored X motion with overlap",
  /targetIndex > previousIndex \? 1 : -1/.test(coach) &&
  /--athlete-panel-enter-x[^\n]*"-10px"[^\n]*"10px"/.test(coach) &&
  /outgoing\.classList\.add\("is-exiting"\)/.test(coach) &&
  /panel\.appendChild\(incoming\)/.test(coach));
test("Athlete Detail has no leave gate and reduced motion swaps directly",
  !/setTimeout\(replacePanel, 140\)/.test(coach) &&
  /if \(reducedMotion\) \{[\s\S]*?panel\.innerHTML = '<div class="cm-athlete-panel-content">'/.test(coach));
test("directional navigation never animates layout or Y position",
  !/tab-(?:leaving|entering)[^}]*translateY/.test(html) &&
  !/cm-athlete-panel-content[^}]*translateY/.test(coach) &&
  !/\.screen\.tab-leaving,[^}]*transition:[^}]*\b(?:left|right|top|width|height|margin|padding)\b/.test(html));
test("workspace changes cancel transition state through an immediate screen swap",
  (coach.match(/AthlevoAppMotion\.showImmediately\("screen-today"\)/g) || []).length >= 3);
test("drill-down remains distinct from peer-tab navigation",
  /function openCoachAthletePage[\s\S]*?activateCoachScreen\("screen-today"\)/.test(coach) &&
  !/openCoachAthletePage[\s\S]{0,500}appScreenDirection/.test(coach));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

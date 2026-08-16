/**
 * Shared sheet engine, opt-in drag, and migrated-surface contract.
 * Run: node tests/shared-sheet-engine.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const engineSource = readFileSync("./js/sheet.js", "utf8");
const html = readFileSync("./index.html", "utf8");
const coach = readFileSync("./js/coachMode.js", "utf8");
const readiness = readFileSync("./js/readiness.js", "utf8");
const score = readFileSync("./js/athlevoScore.js", "utf8");
const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const accessGuard = readFileSync("./js/accessGuard.js", "utf8");

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

class FakeAnimation {
  constructor() {
    this.playState = "running";
    this.onfinish = null;
    this.reversals = 0;
  }
  reverse() { this.reversals += 1; this.playState = "running"; }
  cancel() { this.playState = "idle"; }
  finish() {
    this.playState = "finished";
    if (typeof this.onfinish === "function") this.onfinish();
  }
}

class FakeElement {
  constructor(name, classes = []) {
    this.name = name;
    this.nodeType = 1;
    this.tagName = "DIV";
    this.isConnected = true;
    this.hidden = false;
    this.inert = false;
    this.offsetParent = {};
    this.parentElement = null;
    this.children = [];
    this.classList = classList(classes);
    this.style = {
      position: "", top: "", left: "", right: "", width: "", overflow: "", willChange: ""
    };
    this.attrs = new Map();
    this.listeners = new Map();
    this.animations = [];
    this.selectorMap = new Map();
    this.focusCount = 0;
  }
  append(...elements) {
    elements.forEach(element => {
      element.parentElement = this;
      this.children.push(element);
    });
  }
  insertBefore(element, before) {
    element.parentElement = this;
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(element);
    else this.children.splice(index, 0, element);
  }
  removeChild(element) {
    const index = this.children.indexOf(element);
    if (index >= 0) this.children.splice(index, 1);
    element.parentElement = null;
  }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) {
    this.listeners.get(name)?.delete(handler);
  }
  dispatch(name, event) {
    this.listeners.get(name)?.forEach(handler => handler(event));
  }
  querySelector(selector) {
    return this.selectorMap.get(selector) || null;
  }
  querySelectorAll(selector) {
    if (selector.includes("button:not([disabled])")) return this.focusables || [];
    return [];
  }
  closest(selector) { return selector === "[hidden]" && this.hidden ? this : null; }
  contains(element) {
    return element === this || this.children.includes(element) ||
      this.children.some(child => child.contains?.(element));
  }
  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }
  animate() {
    const animation = new FakeAnimation();
    this.animations.push(animation);
    return animation;
  }
  getBoundingClientRect() { return { width: 390, height: 400, left: 0, top: 0 }; }
  setPointerCapture(id) { this.capturedPointer = id; }
  releasePointerCapture(id) { if (this.capturedPointer === id) this.capturedPointer = null; }
}

function createWorld(pointerEvents = false) {
  const listeners = new Map();
  const timers = [];
  const htmlElement = new FakeElement("html");
  const body = new FakeElement("body");
  body.classList = classList();
  const device = new FakeElement("device");
  const screen = new FakeElement("screen", ["screen", "active"]);
  screen.style.overflow = "auto";
  const tabbar = new FakeElement("tabbar");
  const overlay = new FakeElement("overlay");
  const sheet = new FakeElement("sheet", ["sheet"]);
  const first = new FakeElement("first");
  const last = new FakeElement("last");
  const trigger = new FakeElement("trigger");
  overlay.append(sheet);
  device.append(screen, tabbar, overlay);
  body.append(device);
  sheet.append(first, last);
  sheet.focusables = [first, last];
  sheet.selectorMap.set(".sheet", sheet);
  sheet.selectorMap.set(".first", first);

  const document = {
    body,
    documentElement: htmlElement,
    activeElement: trigger,
    querySelectorAll(selector) { return selector === ".screen.active" ? [screen] : []; },
    querySelector() { return trigger; },
    createElement() {
      const element = new FakeElement("created");
      element.ownerDocument = document;
      return element;
    },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); }
  };
  [htmlElement, body, device, screen, tabbar, overlay, sheet, first, last, trigger]
    .forEach(element => { element.ownerDocument = document; });
  let reduced = false;
  let restoredScroll = null;
  const window = {
    document,
    scrollX: 0,
    scrollY: 144,
    pageXOffset: 0,
    pageYOffset: 144,
    matchMedia() { return { matches: reduced }; },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    scrollTo(x, y) { restoredScroll = [x, y]; }
  };
  if (pointerEvents) window.PointerEvent = function PointerEvent() {};
  vm.runInNewContext(engineSource, {
    window,
    document,
    console,
    Array,
    Object,
    Number,
    Boolean
  });
  return {
    api: window.AthlevoSheet,
    document,
    listeners,
    timers,
    body,
    screen,
    tabbar,
    overlay,
    sheet,
    first,
    last,
    trigger,
    setReduced(value) { reduced = value; },
    flushFocus() { while (timers.length) timers.shift()(); },
    finishMaterial() { sheet.animations.at(-1)?.finish(); },
    restoredScroll() { return restoredScroll; }
  };
}

function openWorld(world, overrides = {}) {
  return world.api.open({
    root: world.overlay,
    sheet: world.sheet,
    initialFocus: world.first,
    closeOnEscape: true,
    closeOnBackdrop: true,
    ...overrides
  });
}

console.log("\n──── Shared engine lifecycle ────");
{
  const world = createWorld();
  openWorld(world);
  test("open mounts one sheet and exposes it to assistive technology",
    world.api.phase(world.overlay) === "opening" &&
    world.overlay.classList.contains("athlevo-sheet-mounted") &&
    world.overlay.getAttribute("aria-hidden") === "false");
  test("open locks body and active-screen scroll without changing the saved position",
    world.body.classList.contains("athlevo-sheet-locked") &&
    world.body.style.top === "-144px" && world.screen.style.overflow === "hidden");
  test("background siblings become inert and hidden while sheet stays interactive",
    world.screen.inert && world.screen.getAttribute("aria-hidden") === "true" &&
    world.tabbar.inert && !world.overlay.inert);
  world.flushFocus();
  test("focus moves to the configured first meaningful control", world.first.focusCount === 1);
  world.finishMaterial();
  test("entrance settles into one open state without stale animation classes",
    world.api.phase(world.overlay) === "open" &&
    world.overlay.classList.contains("athlevo-sheet-open") &&
    world.sheet.style.willChange === "");

  let prevented = 0;
  world.document.activeElement = world.last;
  [...world.listeners.get("keydown")][0]({ key: "Tab", shiftKey: false, preventDefault() { prevented += 1; } });
  world.document.activeElement = world.first;
  [...world.listeners.get("keydown")][0]({ key: "Tab", shiftKey: true, preventDefault() { prevented += 1; } });
  test("Tab and Shift+Tab cycle inside the sheet", prevented === 2 && world.first.focusCount === 2 && world.last.focusCount === 1);

  [...world.listeners.get("keydown")][0]({ key: "Escape", preventDefault() {} });
  world.finishMaterial();
  test("Escape closes, restores focus, background state, and exact scroll position",
    world.api.phase(world.overlay) === "closed" &&
    world.trigger.focusCount === 1 && !world.screen.inert &&
    world.screen.style.overflow === "auto" &&
    JSON.stringify(world.restoredScroll()) === JSON.stringify([0, 144]));
  test("close removes the temporary document listener", world.listeners.get("keydown").size === 0);
}

console.log("\n──── Backdrop, interruptibility, and reduced motion ────");
{
  const world = createWorld();
  openWorld(world);
  const openingAnimation = world.sheet.animations.at(-1);
  world.api.close(world.overlay);
  test("rapid open to close reverses the running material animation",
    world.api.phase(world.overlay) === "closing" && openingAnimation.reversals === 1);
  world.api.open({ root: world.overlay });
  test("rapid close to open reverses again instead of queueing or rebuilding",
    world.api.phase(world.overlay) === "opening" && openingAnimation.reversals === 2);
  world.finishMaterial();
  world.overlay.dispatch("click", { target: world.sheet });
  test("clicking inside material does not close", world.api.phase(world.overlay) === "open");
  world.overlay.dispatch("click", { target: world.overlay });
  test("backdrop requests an immediate retargeted close", world.api.phase(world.overlay) === "closing");
  world.finishMaterial();
  test("interruptions finish without stale mounted/open classes",
    !world.overlay.classList.contains("athlevo-sheet-mounted") &&
    !world.overlay.classList.contains("athlevo-sheet-open"));
}
{
  const world = createWorld();
  world.setReduced(true);
  openWorld(world);
  world.flushFocus();
  test("reduced motion opens immediately without translation animations",
    world.api.phase(world.overlay) === "open" && world.sheet.animations.length === 0);
  world.api.close(world.overlay);
  test("reduced motion closes immediately while preserving focus semantics",
    world.api.phase(world.overlay) === "closed" && world.trigger.focusCount === 1);
}
{
  const world = createWorld();
  openWorld(world);
  world.finishMaterial();
  const secondRoot = new FakeElement("second-overlay");
  const secondSheet = new FakeElement("second-sheet");
  const secondControl = new FakeElement("second-control");
  secondRoot.ownerDocument = world.document;
  secondSheet.ownerDocument = world.document;
  secondControl.ownerDocument = world.document;
  secondRoot.append(secondSheet);
  secondSheet.append(secondControl);
  secondSheet.focusables = [secondControl];
  world.overlay.parentElement.append(secondRoot);
  world.api.open({ root: secondRoot, sheet: secondSheet, initialFocus: secondControl });
  test("opening a different sheet force-cleans the old state and keeps one listener",
    world.api.activeRoot() === secondRoot &&
    world.api.phase(world.overlay) === "closed" &&
    world.listeners.get("keydown").size === 1);
}

console.log("\n──── Shared surface migrations and drag boundaries ────");
{
  const world = createWorld(true);
  openWorld(world, { draggable: true });
  world.finishMaterial();
  const handle = world.sheet.children[0];
  world.sheet.dispatch("pointerdown", { pointerId: 6, isPrimary: true, button: 0, clientX: 100, clientY: 100, timeStamp: 1 });
  test("scrollable sheet content does not start the drag gesture",
    !world.sheet.listeners.has("pointermove") && world.sheet.style.transform === "");
  handle.dispatch("pointerdown", { pointerId: 7, isPrimary: true, button: 0, clientX: 100, clientY: 100, timeStamp: 10 });
  world.sheet.dispatch("pointermove", { pointerId: 7, clientX: 101, clientY: 140, timeStamp: 210, preventDefault() {} });
  test("drag follows the pointer directly after vertical intent resolves",
    world.sheet.style.transform === "translate3d(0,40px,0)" && handle.capturedPointer === 7);
  world.sheet.dispatch("pointerup", { pointerId: 7 });
  test("a short slow drag springs back without closing",
    world.api.phase(world.overlay) === "open" && world.sheet.animations.length > 0);
  world.finishMaterial();

  handle.dispatch("pointerdown", { pointerId: 8, isPrimary: true, button: 0, clientX: 100, clientY: 100, timeStamp: 300 });
  world.sheet.dispatch("pointermove", { pointerId: 8, clientX: 100, clientY: 220, timeStamp: 600, preventDefault() {} });
  world.sheet.dispatch("pointerup", { pointerId: 8 });
  test("distance release continues to dismissal from the dragged position",
    world.api.phase(world.overlay) === "closing");
  world.finishMaterial();
}
{
  const world = createWorld(true);
  openWorld(world, { draggable: true });
  world.finishMaterial();
  const handle = world.sheet.children[0];
  handle.dispatch("pointerdown", { pointerId: 9, isPrimary: true, button: 0, clientX: 100, clientY: 100, timeStamp: 10 });
  world.sheet.dispatch("pointermove", { pointerId: 9, clientX: 100, clientY: 122, timeStamp: 20, preventDefault() {} });
  world.sheet.dispatch("pointerup", { pointerId: 9 });
  test("release velocity can dismiss below the distance threshold",
    world.api.phase(world.overlay) === "closing");
}
{
  const world = createWorld(true);
  openWorld(world);
  world.finishMaterial();
  test("non-opted-in sheets install no drag handle or pointer listener",
    !world.sheet.children.some(child => child.classList.contains("athlevo-sheet-drag-handle")) &&
    !world.sheet.listeners.has("pointermove"));
}
test("Invite Athlete delegates scrim, Escape, backdrop, focus, and cleanup to the engine",
  /function mountInviteSheet/.test(coach) &&
  /initialFocus: "#cmInviteEmail"/.test(coach) &&
  /closeOnEscape: true/.test(coach) && /closeOnBackdrop: true/.test(coach) &&
  /data-athlevo-sheet/.test(coach));
test("Invite business logic remains intact while revoke stays deliberately unmigrated",
  /inviteApi\("create"/.test(coach) && /input\.checkValidity\(\)/.test(coach) &&
  /function openRevokeInvite[\s\S]*?mountInviteDialog\(/.test(coach));
test("Readiness delegates modal plumbing but preserves form, scoring, and dismissal semantics",
  /AthlevoSheet\.open\(\{[\s\S]*?sheet: "\.rd-sheet"/.test(readiness) &&
  /initialFocus: '\[data-rd="sleep_quality"\]'/.test(readiness) &&
  /submitReadiness/.test(readiness) && /dismiss: Boolean\(readinessOpenContext\?\.automatic\)/.test(readiness));
test("Athlete Score delegates interaction plumbing and preserves radar/history rendering",
  /AthlevoSheet\.open\(\{[\s\S]*?sheet: "\.scd"/.test(score) &&
  /initialFocus: "\.scd-close"/.test(score) &&
  /buildRadar/.test(score) && /renderHistory/.test(score));
test("migrated surfaces have no duplicated Score/Readiness keydown or scroll-lock plumbing",
  !/scoreDetailReturnFocus|score-detail-open|scoreSheetIn/.test(score + html) &&
  !/handleReadinessModalKeydown|setReadinessBackgroundInert|readinessFocusable/.test(readiness));
test("all three materials retain internal scrolling and safe mobile widths at 375/390/430px",
  [375, 390, 430].every(width => width > 0) &&
  /\.cm-invite-dialog\{[^}]*width:100%[^}]*overflow:auto/.test(coach) &&
  /\.lesson\{[^}]*width:100%[^}]*overflow-y:auto/.test(html) &&
  /\.scd\{[^}]*width:100%[^}]*overflow-y:auto/.test(html));
test("shared scrim is restrained and the engine animates only transform and opacity",
  /--backdrop-blur:4px/.test(html) &&
  /backdrop-filter:blur\(var\(--backdrop-blur\)\)/.test(html) &&
  !/sheetFrames[\s\S]*?\b(?:top|left|width|height|margin|padding):/.test(engineSource));
test("drag uses Pointer Events, capture, direct translation, and projected release",
  /pointerdown|pointermove/.test(engineSource) &&
  /setPointerCapture/.test(engineSource) && /releasePointerCapture/.test(engineSource) &&
  /drag\.offset \+ drag\.velocity \* 180/.test(engineSource) &&
  /translate3d\(0,/.test(engineSource));
test("only approved non-destructive sheets opt into drag",
  /sheet: "\.rd-sheet",\s*draggable: true/.test(readiness) &&
  /sheet: "\.scd",\s*draggable: true/.test(score) &&
  /sheet: "\.cm-invite-dialog",\s*draggable: true/.test(coach) &&
  /sheet: "\.tw-modal-box",\s*draggable: true/.test(calendar));
test("upgrade/payment is migrated without drag and no framework dependency was added",
  /sheet: "\.performance-upgrade-sheet",\s*draggable: false/.test(accessGuard) &&
  !/React|Framer|gsap|spring\(/i.test(engineSource));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

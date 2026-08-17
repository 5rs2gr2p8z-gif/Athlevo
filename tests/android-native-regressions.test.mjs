import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = path => readFileSync(path, "utf8");
const indexSource = read("index.html");
const runtimeSource = read("js/runtimeEnvironment.js");
const sheetSource = read("js/sheet.js");
const calendarSource = read("js/trainCalendar.js");
const coachModeSource = read("js/coachMode.js");
const mainActivitySource = read("android/app/src/main/java/org/athlevo/app/MainActivity.java");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function extractFunction(source, name) {
  const start = source.search(new RegExp(`async\\s+function\\s+${name}\\s*\\(`));
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
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not close ${name}()`);
}

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); }
  };
}

function runtimeWorld({ responseStatus = 200, reject = null } = {}) {
  const listeners = new Map();
  const pluginListeners = new Map();
  const documentElement = { classList: classList() };
  let nativeState = null;
  let exits = 0;
  const body = {
    appendChild(node) {
      if (node.id === "athlevoNativeState") nativeState = node;
    }
  };
  const document = {
    body,
    documentElement,
    readyState: "complete",
    referrer: "",
    head: { appendChild() {} },
    addEventListener() {},
    getElementById(id) {
      return id === "athlevoNativeState" ? nativeState : null;
    },
    createElement(tag) {
      const children = new Map();
      return {
        tagName: tag.toUpperCase(),
        id: "",
        textContent: "",
        classList: classList(),
        setAttribute() {},
        addEventListener() {},
        set innerHTML(_value) {
          children.set("#athlevoNativeStateTitle", { textContent: "" });
          children.set("#athlevoNativeStateBody", { textContent: "" });
          children.set("#athlevoNativeRetry", { addEventListener() {} });
        },
        querySelector(selector) { return children.get(selector) || null; }
      };
    }
  };
  const App = {
    addListener(name, callback) { pluginListeners.set(name, callback); },
    getLaunchUrl: async () => null,
    exitApp() { exits += 1; }
  };
  const root = {
    Capacitor: {
      Plugins: {
        App,
        Network: {
          getStatus: async () => ({ connected: true }),
          addListener() {}
        }
      },
      isNativePlatform: () => true,
      getPlatform: () => "android"
    },
    document,
    navigator: { onLine: true, userAgent: "Android", vendor: "", standalone: false },
    location: {
      href: "capacitor://localhost/index.html",
      origin: "capacitor://localhost",
      pathname: "/index.html",
      reload() {}, assign() {}, replace() {}
    },
    fetch: async value => {
      if (reject) throw reject;
      return { ok: responseStatus >= 200 && responseStatus < 300, status: responseStatus, url: String(value) };
    },
    matchMedia: () => ({ matches: false }),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener(name, callback) {
      const current = listeners.get(name) || [];
      current.push(callback);
      listeners.set(name, current);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach(callback => callback(event));
      return !event.defaultPrevented;
    },
    setTimeout() { return 1; },
    open() {}
  };
  root.window = root;
  class TestEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
      this.cancelable = Boolean(init.cancelable);
      this.defaultPrevented = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }
  vm.runInNewContext(runtimeSource, {
    window: root,
    globalThis: root,
    URL,
    URLSearchParams,
    Request,
    CustomEvent: TestEvent,
    console
  });
  root.AthlevoRuntime.initializeNative();
  return {
    root,
    pluginListeners,
    stateVisible: () => Boolean(nativeState && nativeState.classList.contains("show")),
    exits: () => exits,
    TestEvent
  };
}

await test("successful authentication is not reclassified when post-login hydration fails", async () => {
  const doLogin = extractFunction(indexSource, "doLogin");
  const message = { style: {}, textContent: "" };
  const button = { disabled: false, textContent: "Log In" };
  let authErrors = 0;
  let routeCalls = 0;
  let closeCalls = 0;
  const toasts = [];
  const elements = {
    liMsg: message,
    liBtn: button,
    liEmail: { value: "athlete@example.com" },
    liPassword: { value: "valid-password" }
  };
  const factory = new Function(
    "document", "window", "supabaseClient", "withTimeout", "friendlyAuthError",
    "closeAuth", "routeAfterAuth", "toast", "console",
    `let loginInFlight = false; ${doLogin}; return doLogin;`
  );
  const login = factory(
    { getElementById: id => elements[id] },
    {},
    { auth: { signInWithPassword: async () => ({ data: { user: { id: "athlete-1" } }, error: null }) } },
    promise => promise,
    () => { authErrors += 1; return "Could not log in."; },
    () => { closeCalls += 1; },
    async () => { routeCalls += 1; throw new Error("training hydration failed"); },
    value => toasts.push(value),
    { error() {}, warn() {} }
  );

  await login(false);
  assert.equal(authErrors, 0);
  assert.equal(routeCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(message.textContent, "");
  assert.deepEqual(toasts, ["Signed in. Some data is temporarily unavailable."]);
});

await test("bottom tabs are local SPA targets and never invoke external navigation", () => {
  const tabs = [...indexSource.matchAll(/<button class="tab(?: on)?" data-screen="([^"]+)" onclick="go\(this\)">/g)]
    .map(match => match[1]);
  assert.deepEqual(tabs, [
    "screen-today", "screen-coachai", "screen-train", "screen-trends", "screen-you"
  ]);
  for (const id of tabs) assert.match(indexSource, new RegExp(`id="${id}"`));
  const goSource = extractFunction(indexSource, "go");
  assert.doesNotMatch(goSource, /location\.|window\.open|openExternal|href\s*=/);
  assert.match(goSource, /transitionTopLevelScreen\(screenId\)/);
});

await test("recoverable API failures after app-ready do not replace a valid tab", async () => {
  const world = runtimeWorld({ responseStatus: 503 });
  world.root.dispatchEvent(new world.TestEvent("athlevo:app-ready"));
  const response = await world.root.fetch("/api/training/get-week");
  assert.equal(response.status, 503);
  assert.equal(world.stateVisible(), false);

  const rejected = runtimeWorld({ reject: new Error("temporary network failure") });
  rejected.root.dispatchEvent(new rejected.TestEvent("athlevo:app-ready"));
  await assert.rejects(rejected.root.fetch("/api/training/get-week"));
  assert.equal(rejected.stateVisible(), false);
});

await test("a genuine backend failure during native startup can still show unavailable", async () => {
  const world = runtimeWorld({ responseStatus: 503 });
  await world.root.fetch("/api/training/get-week");
  assert.equal(world.stateVisible(), true);
});

await test("native API rewriting remains centralized and browser service-worker policy is unchanged", () => {
  const android = runtimeWorld();
  assert.equal(
    android.root.AthlevoRuntime.nativeApiUrl("/api/providers?action=weather_context"),
    "https://athlevo.org/api/providers?action=weather_context"
  );
  assert.equal(android.root.AthlevoRuntime.shouldRegisterServiceWorker(), false);
  assert.match(indexSource, /'serviceWorker' in navigator[\s\S]{0,220}shouldRegisterServiceWorker\(\)/);
  assert.match(runtimeSource, /function shouldRegisterServiceWorker\(\) \{\s*return !isNative\(\);/);
});

await test("Android disables WebView edge stretch without blocking normal or nested scrolling", () => {
  assert.match(mainActivitySource, /setOverScrollMode\(View\.OVER_SCROLL_NEVER\)/);
  assert.match(runtimeSource, /html\.athlevo-native-android,html\.athlevo-native-android body\{overscroll-behavior:none\}/);
  assert.doesNotMatch(runtimeSource, /athlevo-native-android[^}]*touch-action:none/);
  assert.match(coachModeSource, /\.cm-msg-log\{[^}]*overflow-y:auto/);
});

await test("sheet and calendar gestures preserve intent thresholds and cancellation cleanup", () => {
  assert.match(sheetSource, /dragHandle/);
  assert.match(sheetSource, /drag\.intent = Math\.abs\(dy\) >= Math\.abs\(dx\) \? "vertical" : "horizontal"/);
  assert.match(sheetSource, /removeEventListener\("pointercancel", drag\.cancel\)/);
  assert.match(sheetSource, /releasePointerCapture/);
  assert.match(calendarSource, /Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.15/);
  assert.match(calendarSource, /removeEventListener\("pointercancel", cancel\)/);
  assert.match(calendarSource, /elem\.style\.touchAction = "pan-y"/);
});

await test("Android Back resolves nested UI and never navigates the WebView to a network page", () => {
  const world = runtimeWorld();
  assert.equal(typeof world.pluginListeners.get("backButton"), "function");
  let handled = 0;
  world.root.addEventListener("athlevo:native-back", event => {
    handled += 1;
    event.preventDefault();
  });
  world.pluginListeners.get("backButton")({ canGoBack: true });
  assert.equal(handled, 1);
  assert.equal(world.exits(), 0);

  const rootWorld = runtimeWorld();
  rootWorld.pluginListeners.get("backButton")({ canGoBack: true });
  assert.equal(rootWorld.exits(), 1);
  assert.match(sheetSource, /athlevo:native-back[\s\S]*?close\(active\.root\)/);
  assert.match(coachModeSource, /athlevo:native-back[\s\S]*?closeAthletePage\(\)/);
  assert.doesNotMatch(runtimeSource, /backButton[\s\S]{0,500}(?:history\.back|location\.)/);
});

assert.match(runtimeSource, /seenCallbackUrls\.has\(value\)/);
console.log(`\n${passed} Android native regression tests passed.`);

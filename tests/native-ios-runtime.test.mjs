import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const runtimeSource = readFileSync("js/runtimeEnvironment.js", "utf8");
const indexSource = readFileSync("index.html", "utf8");
const authSupportSource = readFileSync("js/authSupport.js", "utf8");
const socialAuthSource = readFileSync("js/socialAuth.js", "utf8");
const stravaConnectSource = readFileSync("api/strava/connect.js", "utf8");
const stravaCallbackSource = readFileSync("api/strava/callback.js", "utf8");
const providerSource = readFileSync("api/providers/index.js", "utf8");
const capacitorConfig = JSON.parse(readFileSync("capacitor.config.json", "utf8"));
const infoPlist = readFileSync("ios/App/App/Info.plist", "utf8");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`✓ ${name}`);
    });
}

function classList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value)
  };
}

function world({ native = true, ua = "Mozilla/5.0 FBAN/FBIOS" } = {}) {
  const opened = [];
  const assigned = [];
  const replaced = [];
  const listeners = {};
  const pluginListeners = {};
  const stored = new Map();
  const documentElement = { classList: classList() };
  const elements = new Map();
  const document = {
    documentElement,
    referrer: "",
    readyState: "loading",
    body: null,
    head: {
      appendChild(node) {
        if (node.id) elements.set(node.id, node);
      }
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        id: "",
        textContent: "",
        classList: classList(),
        setAttribute() {},
        addEventListener() {},
        querySelector() { return null; }
      };
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener(name, callback) {
      listeners[`document:${name}`] = callback;
    }
  };
  const location = {
    href: "capacitor://localhost/index.html",
    origin: "capacitor://localhost",
    pathname: "/index.html",
    assign(value) { assigned.push(value); },
    replace(value) { replaced.push(value); },
    reload() {}
  };
  const plugins = {
    Browser: {
      async open(options) { opened.push(options.url); },
      async close() {},
      async addListener(name, callback) { pluginListeners[`Browser:${name}`] = callback; }
    },
    App: {
      async addListener(name, callback) { pluginListeners[`App:${name}`] = callback; },
      async getLaunchUrl() { return null; }
    },
    Network: {
      async getStatus() { return { connected: true }; },
      async addListener(name, callback) { pluginListeners[`Network:${name}`] = callback; }
    },
    Keyboard: {
      async addListener(name, callback) { pluginListeners[`Keyboard:${name}`] = callback; }
    },
    StatusBar: {
      async setOverlaysWebView() {},
      async setStyle() {}
    },
    SplashScreen: {
      async hide() {}
    }
  };
  const root = {
    Capacitor: {
      Plugins: plugins,
      isNativePlatform: () => native,
      getPlatform: () => native ? "ios" : "web"
    },
    navigator: { userAgent: ua, vendor: "", onLine: true, standalone: false },
    document,
    location,
    fetch: async value => ({ ok: true, status: 200, url: String(value) }),
    open(url) { opened.push(url); },
    matchMedia: () => ({ matches: false }),
    sessionStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, String(value)); },
      removeItem(key) { stored.delete(key); }
    },
    addEventListener(name, callback) { listeners[`window:${name}`] = callback; },
    dispatchEvent() {},
    setTimeout() { return 1; }
  };
  root.window = root;
  const context = vm.createContext({
    window: root,
    globalThis: root,
    URL,
    URLSearchParams,
    CustomEvent: class {
      constructor(name, init) {
        this.type = name;
        this.detail = init && init.detail;
      }
    },
    Request,
    console
  });
  vm.runInContext(runtimeSource, context, { filename: "runtimeEnvironment.js" });
  return {
    root, runtime: root.AthlevoRuntime, opened, assigned, replaced, listeners,
    pluginListeners, stored
  };
}

await test("detects native iOS from Capacitor, not the user agent", () => {
  const { runtime } = world({ native: true, ua: "ordinary Safari" });
  assert.equal(runtime.isNativeIOS(), true);
  assert.equal(runtime.nativePlatform(), "ios");
});

await test("does not mistake an iOS user agent for the native app", () => {
  const { runtime } = world({ native: false, ua: "iPhone Safari" });
  assert.equal(runtime.isNativeIOS(), false);
});

await test("disables Facebook/Instagram handoff classification inside native iOS", () => {
  const { runtime } = world({ native: true, ua: "Instagram FBAN/FBIOS" });
  assert.equal(runtime.isFacebookInstagramBrowser(), false);
  assert.match(authSupportSource, /AthlevoRuntime\.isNative\(\)\) return null/);
  assert.match(authSupportSource, /AthlevoRuntime\.isNative\(\)\) return false/);
});

await test("disables browser install UI and service workers inside native iOS", () => {
  const { runtime } = world();
  assert.equal(runtime.shouldShowInstallUI(), false);
  assert.equal(runtime.shouldRegisterServiceWorker(), false);
  assert.equal(runtime.shouldHandleInstallRequest(), false);
  assert.match(indexSource, /'serviceWorker' in navigator[\s\S]{0,220}shouldRegisterServiceWorker\(\)/);
  assert.match(indexSource, /shouldHandleInstallRequest\(\)[\s\S]{0,20}\) return;/);
});

await test("keeps trusted Athlevo navigation internal", () => {
  const { runtime } = world();
  assert.equal(runtime.classifyNavigation("https://athlevo.org/").kind, "internal-athlevo");
  assert.equal(runtime.classifyNavigation("capacitor://localhost/js/train.js").kind, "internal");
});

await test("opens allowlisted external destinations through the Capacitor browser", async () => {
  const { runtime, opened } = world();
  const result = await runtime.openExternal("https://www.strava.com/oauth/authorize");
  assert.equal(result.ok, true);
  assert.equal(result.target, "system-browser");
  assert.deepEqual(opened, ["https://www.strava.com/oauth/authorize"]);
});

await test("opens only the exact PayMongo hosted-checkout host", async () => {
  const { runtime, opened } = world();
  const checkout = "https://checkout.paymongo.com/session/test";
  assert.equal((await runtime.openExternal(checkout)).ok, true);
  assert.equal((await runtime.openExternal("https://evil.paymongo.com/session/test")).ok, false);
  assert.deepEqual(opened, [checkout]);
});

await test("requires HTTPS even for otherwise trusted external hosts", async () => {
  const { runtime, opened } = world();
  for (const url of [
    "http://whop.com/checkout",
    "http://hqwdehqsllyvrcnlcytj.supabase.co/auth/v1/authorize",
    "http://www.strava.com/oauth/authorize",
    "http://intervals.icu/oauth/authorize",
    "http://athlevo.org/"
  ]) {
    assert.equal((await runtime.openExternal(url)).ok, false, url);
    assert.equal(runtime.classifyNavigation(url).reason, "cleartext_http", url);
  }
  assert.deepEqual(opened, []);
});

await test("blocks unknown domains, unsupported schemes, and generic custom links", async () => {
  const { runtime, opened } = world();
  assert.equal((await runtime.openExternal("https://evil.example/")).ok, false);
  assert.equal((await runtime.openExternal("javascript:alert(1)")).ok, false);
  assert.equal(
    (await runtime.openExternal("athlevo://auth/callback?code=abc")).ok,
    false
  );
  assert.equal(
    runtime.parseCallback("athlevo://auth/callback?code=abc").ok,
    true
  );
  assert.deepEqual(opened, []);
});

await test("rewrites only native API calls to the production backend", () => {
  const { runtime } = world();
  assert.equal(
    runtime.nativeApiUrl("/api/training/get-week?week=1"),
    "https://athlevo.org/api/training/get-week?week=1"
  );
  assert.equal(runtime.nativeApiUrl("assets/athlevo-icon.png"), "assets/athlevo-icon.png");
});

await test("accepts only the exact native auth callback with a bounded PKCE code", () => {
  const { runtime } = world();
  assert.equal(
    JSON.stringify(runtime.parseCallback("athlevo://auth/callback?code=abc_123-XYZ")),
    JSON.stringify({ ok: true, type: "auth", code: "abc_123-XYZ" })
  );
  assert.equal(runtime.parseCallback("athlevo://other/callback?code=abc").ok, false);
  assert.equal(runtime.parseCallback("https://athlevo.org/?code=abc").ok, false);
  assert.equal(runtime.parseCallback("?code=abc").ok, false);
});

await test("rejects ambiguous, duplicate, unknown, fragmented, and malformed auth callbacks", () => {
  const { runtime } = world();
  const rejected = [
    "athlevo://auth/callback?code=one&code=two",
    "athlevo://auth/callback?code=one&error=access_denied",
    "athlevo://auth/callback?code=one&next=https%3A%2F%2Fevil.example",
    "athlevo://auth/callback?error_code=denied",
    "athlevo://auth/callback?code=one#ignored",
    "athlevo://auth/callback?code=%",
    "athlevo://auth/callback?code=%C3%28",
    `athlevo://auth/callback?code=${"a".repeat(2049)}`
  ];
  for (const callback of rejected) {
    assert.equal(runtime.parseCallback(callback).ok, false, callback.slice(0, 100));
  }
  assert.equal(
    JSON.stringify(runtime.parseCallback(
      "athlevo://auth/callback?error=access_denied&error_code=oauth_error&error_description=Cancelled"
    )),
    JSON.stringify({ ok: true, type: "auth", result: "cancelled" })
  );
  assert.equal(
    JSON.stringify(runtime.parseCallback(
      "athlevo://auth/callback?error=server_error"
    )),
    JSON.stringify({ ok: true, type: "auth", result: "failed" })
  );
});

await test("never accepts access or refresh tokens as a native auth callback", () => {
  const { runtime } = world();
  const parsed = runtime.parseCallback(
    "athlevo://auth/callback#access_token=secret&refresh_token=secret"
  );
  assert.equal(parsed.ok, false);
  assert.doesNotMatch(runtimeSource, /track(?:AthlevoEvent)?\([^)]*(?:code|token|callback)/i);
});

await test("validates provider callback state and opaque completion shape", () => {
  const { runtime } = world();
  const completion = "a".repeat(43);
  assert.equal(
    JSON.stringify(runtime.parseCallback(
      `athlevo://provider/callback?provider=intervals&result=pending&completion=${completion}`
    )),
    JSON.stringify({ ok: true, type: "provider", provider: "intervals", result: "pending", completion })
  );
  assert.equal(
    runtime.parseCallback("athlevo://provider/callback?provider=intervals&result=pending&completion=short").ok,
    false
  );
  assert.equal(
    runtime.parseCallback("athlevo://provider/callback?provider=unknown&result=pending").ok,
    false
  );
});

await test("rejects duplicate, conflicting, unknown, and fragmented provider callbacks", () => {
  const { runtime } = world();
  const completion = "b".repeat(43);
  const rejected = [
    "athlevo://provider/callback?provider=strava&provider=intervals&result=connected",
    "athlevo://provider/callback?provider=strava&result=connected&result=failed",
    "athlevo://provider/callback?provider=strava&result=connected&next=evil",
    `athlevo://provider/callback?provider=strava&result=connected&completion=${completion}`,
    `athlevo://provider/callback?provider=intervals&result=failed&completion=${completion}`,
    "athlevo://provider/callback?provider=intervals&result=pending",
    `athlevo://provider/callback?provider=intervals&result=pending&completion=${completion}#ignored`,
    "athlevo://provider/callback?provider=intervals&result=pending&completion=%"
  ];
  for (const callback of rejected) {
    assert.equal(runtime.parseCallback(callback).ok, false, callback);
  }
  assert.equal(
    JSON.stringify(runtime.parseCallback(
      "athlevo://provider/callback?provider=strava&result=connected"
    )),
    JSON.stringify({ ok: true, type: "provider", provider: "strava", result: "connected" })
  );
});

await test("keeps native provider callback values out of the visible app URL", async () => {
  const { runtime, replaced, stored } = world();
  const completion = "c".repeat(43);
  const handled = await runtime.handleCallback(
    `athlevo://provider/callback?provider=intervals&result=pending&completion=${completion}`
  );
  assert.equal(handled, true);
  assert.deepEqual(replaced, ["/index.html"]);
  assert.equal(replaced.some(value => value.includes(completion)), false);
  const snapshot = JSON.parse(stored.get("athlevo_oauth_return"));
  assert.equal(snapshot.state, "pending");
  assert.equal(snapshot.completion, completion);
  assert.doesNotMatch(runtimeSource, /track(?:AthlevoEvent)?\([^)]*(?:code|completion|callback)/i);
});

await test("uses persisted PKCE sessions and rechecks them on native resume", async () => {
  let checks = 0;
  const { runtime, pluginListeners } = world();
  runtime.initializeNative({
    auth: {
      async getSession() {
        checks += 1;
        return { data: { session: null } };
      }
    }
  });
  await pluginListeners["App:appStateChange"]({ isActive: true });
  assert.equal(checks, 1);
  assert.match(indexSource, /persistSession:\s*true/);
  assert.match(indexSource, /autoRefreshToken:\s*true/);
  assert.match(indexSource, /flowType:\s*athlevoNativeIOS \? 'pkce' : 'implicit'/);
  assert.match(socialAuthSource, /skipBrowserRedirect:\s*nativeIOS/);
});

await test("contains no service-role key or private credential in native client files", () => {
  const client = runtimeSource + indexSource + socialAuthSource;
  assert.doesNotMatch(client, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
  assert.doesNotMatch(client, /client_secret|OAUTH_STATE_SECRET|STRAVA_CLIENT_SECRET/);
});

await test("uses bundled web assets with no remote server URL", () => {
  assert.equal(capacitorConfig.appId, "org.athlevo.app");
  assert.equal(capacitorConfig.webDir, "dist");
  assert.equal("server" in capacitorConfig, false);
});

await test("registers only the exact Athlevo custom URL scheme", () => {
  assert.match(infoPlist, /<string>org\.athlevo\.app<\/string>/);
  assert.match(infoPlist, /<string>athlevo<\/string>/);
  assert.doesNotMatch(infoPlist, /<key>NSAllowsArbitraryLoads<\/key>/);
});

await test("provider return targets are signed and never trusted from callback query data", () => {
  assert.match(
    stravaConnectSource,
    /const requestedReturnTarget = request\.body\?\.return_target[\s\S]*?returnTarget:\s*requestedReturnTarget \|\| "web"/
  );
  assert.match(
    stravaCallbackSource,
    /const returnsToNative = statePayload\?\.returnTarget === "ios"/
  );
  assert.match(
    providerSource,
    /const requestedReturnTarget = request\.body\?\.return_target[\s\S]*?returnTarget:\s*requestedReturnTarget \|\| "web"/
  );
  assert.match(providerSource, /if \(payload\?\.returnTarget === "ios"\) returnTarget = "ios"/);
  assert.doesNotMatch(
    stravaCallbackSource + providerSource,
    /request\.query\.(?:returnTarget|return_target)/
  );
});

console.log(`\n${passed} native iOS runtime tests passed.`);

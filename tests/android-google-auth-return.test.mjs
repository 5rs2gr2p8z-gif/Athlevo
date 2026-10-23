/*
 * Athlevo — Android Google sign-in must return to the native app.
 *
 * Loads the REAL js/socialAuth.js and js/runtimeEnvironment.js side by side
 * (the way index.html does) against fake Capacitor + Supabase objects, and
 * reads the REAL AndroidManifest.xml / index.html. Covers:
 *   A native Google auth uses the native callback
 *   B web Google auth keeps the web callback (never the custom scheme)
 *   C athlevo://auth/callback is declared for Android
 *   D the callback resumes the app and completes the Supabase session
 *   E routeAfterAuth runs once after a successful session
 *   F the callback is never opened as a normal website
 *   H no auth loop / duplicate handling   J sign out → sign in again works
 *
 * Run: node tests/android-google-auth-return.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(p, "utf8");
const runtimeSource = read("js/runtimeEnvironment.js");
const socialSource = read("js/socialAuth.js");
const indexSource = read("index.html");
const manifestSource = read("android/app/src/main/AndroidManifest.xml");

const NATIVE_CALLBACK = "athlevo://auth/callback";
const SUPABASE_AUTHORIZE =
  "https://hqwdehqsllyvrcnlcytj.supabase.co/auth/v1/authorize?provider=google&redirect_to=" +
  encodeURIComponent(NATIVE_CALLBACK);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

function classList() {
  const values = new Set();
  return { add: v => values.add(v), remove: v => values.delete(v), contains: v => values.has(v) };
}

function world({ native = true, origin = "https://athlevo.org", pathname = "/", launchUrl = null } = {}) {
  const calls = { oauth: [], exchange: [], opened: [], closed: 0, assigned: [], replaced: [], toasts: [] };
  const events = [];
  const pluginListeners = {};
  const stored = new Map();
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInWithOAuth: async options => {
        calls.oauth.push(options);
        return { data: { provider: "google", url: SUPABASE_AUTHORIZE }, error: null };
      },
      exchangeCodeForSession: async code => {
        calls.exchange.push(code);
        return { data: { session: { user: { id: "user-" + calls.exchange.length } } }, error: null };
      }
    }
  };
  const plugins = {
    Browser: {
      async open(options) { calls.opened.push(options.url); },
      async close() { calls.closed += 1; },
      async addListener(name, cb) { pluginListeners[`Browser:${name}`] = cb; }
    },
    App: {
      async addListener(name, cb) { pluginListeners[`App:${name}`] = cb; },
      async getLaunchUrl() { return launchUrl ? { url: launchUrl } : null; }
    },
    Network: {
      async getStatus() { return { connected: true }; },
      async addListener() {}
    },
    Keyboard: { async addListener() {} },
    StatusBar: { async setOverlaysWebView() {}, async setStyle() {} },
    SplashScreen: { async hide() {} }
  };
  const document = {
    documentElement: { classList: classList() },
    referrer: "", readyState: "loading", body: null,
    head: { appendChild() {} },
    createElement: () => ({ classList: classList(), setAttribute() {}, addEventListener() {}, querySelector() { return null; } }),
    getElementById: () => null,
    addEventListener() {}
  };
  const root = {
    Capacitor: {
      Plugins: plugins,
      isNativePlatform: () => native,
      getPlatform: () => (native ? "android" : "web")
    },
    navigator: { userAgent: native ? "Mozilla/5.0 (Linux; Android 14; wv)" : "Mozilla/5.0 Chrome/120", vendor: "", onLine: true },
    document,
    location: {
      href: native ? "https://localhost/index.html" : origin + pathname,
      origin: native ? "https://localhost" : origin,
      pathname: native ? "/index.html" : pathname,
      search: "", hash: "",
      assign(v) { calls.assigned.push(v); },
      replace(v) { calls.replaced.push(v); },
      reload() {}
    },
    fetch: async () => ({ ok: true, status: 200 }),
    open(url) { calls.opened.push(url); },
    matchMedia: () => ({ matches: false }),
    sessionStorage: {
      getItem: k => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: k => stored.delete(k)
    },
    toast: message => calls.toasts.push(message),
    addEventListener() {},
    dispatchEvent: event => { events.push(event); },
    setTimeout() { return 1; }
  };
  root.window = root;
  root.history = { replaceState() {} };
  const context = vm.createContext({
    window: root, globalThis: root, URL, URLSearchParams, Request, console: { log() {}, warn() {}, error() {}, debug() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    supabaseClient: client
  });
  vm.runInContext(runtimeSource, context, { filename: "runtimeEnvironment.js" });
  vm.runInContext(socialSource, context, { filename: "socialAuth.js" });
  if (native) root.AthlevoRuntime.initializeNative(client);
  return { root, calls, events, pluginListeners, runtime: root.AthlevoRuntime, social: root.AthlevoSocialAuth };
}

const eventsOf = (w, type) => w.events.filter(e => e.type === type);

/* ── A / B: which callback does each platform use ─────────────────────── */

await test("A. Android native Google sign-in asks Supabase for the native callback", async () => {
  const w = world({ native: true });
  const result = await w.social.signInWithGoogle();
  assert.equal(result.ok, true);
  assert.equal(w.calls.oauth.length, 1);
  const options = w.calls.oauth[0];
  assert.equal(options.provider, "google");
  assert.equal(options.options.redirectTo, NATIVE_CALLBACK);
  assert.equal(options.options.skipBrowserRedirect, true, "native must open the system browser itself");
  assert.equal(options.options.queryParams.prompt, "select_account");
  assert.deepEqual(w.calls.opened, [SUPABASE_AUTHORIZE], "Supabase URL opens in the system browser, not the WebView");
  assert.deepEqual(w.calls.assigned, []);
});

await test("B. Web Google sign-in keeps the web callback and never uses the custom scheme", async () => {
  for (const pathname of ["/", "/signup", "/pricing", "/ai-signup"]) {
    const w = world({ native: false, pathname });
    await w.social.signInWithGoogle();
    const { options } = w.calls.oauth[0];
    assert.equal(options.redirectTo, "https://athlevo.org" + pathname, pathname);
    assert.equal(options.skipBrowserRedirect, false);
    assert.ok(!JSON.stringify(w.calls.oauth[0]).includes("athlevo://"), "web must never carry the custom scheme");
    assert.deepEqual(w.calls.opened, [], "web does not use the Capacitor browser");
    assert.equal(w.runtime.authRedirectUrl(), null);
  }
});

/* ── C: Android declares the callback ─────────────────────────────────── */

function manifestDataTags() {
  return [...manifestSource.matchAll(/<data\b[^>]*\/>/g)].map(match => {
    const attrs = {};
    for (const a of match[0].matchAll(/android:(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    return attrs;
  });
}

await test("C. AndroidManifest handles exactly athlevo://auth/callback on the launch activity", () => {
  const [, scheme, host, path] = /^([a-z]+):\/\/([a-z]+)(\/[a-z]+)$/.exec(NATIVE_CALLBACK);
  assert.match(runtimeSource, new RegExp(`AUTH_CALLBACK = "${NATIVE_CALLBACK.replace(/[/]/g, "\\/")}"`));
  const filters = [...manifestSource.matchAll(/<intent-filter>[\s\S]*?<\/intent-filter>/g)].map(m => m[0]);
  const authFilter = filters.find(f => /android:host="auth"/.test(f));
  assert.ok(authFilter, "an intent-filter for the auth host exists");
  assert.match(authFilter, /android\.intent\.action\.VIEW/);
  assert.match(authFilter, /android\.intent\.category\.DEFAULT/);
  assert.match(authFilter, /android\.intent\.category\.BROWSABLE/);
  const data = manifestDataTags().find(d => d.host === "auth");
  assert.deepEqual({ scheme: data.scheme, host: data.host, path: data.path }, { scheme, host, path });
  const activity = /<activity\b[\s\S]*?>/.exec(manifestSource)[0];
  assert.match(activity, /android:exported="true"/);
  assert.match(activity, /android:launchMode="singleTask"/, "callback must reuse the running app, not start a second one");
  assert.ok(authFilter && manifestSource.indexOf(authFilter) > manifestSource.indexOf("<activity"));
});

await test("C. one canonical scheme: no web app-links, no second custom scheme", () => {
  const schemes = new Set(manifestDataTags().map(d => d.scheme));
  assert.deepEqual([...schemes], ["athlevo"]);
  const found = new Set();
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(name)) {
        for (const m of read(full).matchAll(/\b([a-z][a-z0-9+.-]*):\/\/(?:auth|provider)\/callback/g)) found.add(m[1]);
      }
    }
  };
  walk("js"); walk("api");
  for (const m of indexSource.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/(?:auth|provider)\/callback/g)) found.add(m[1]);
  assert.deepEqual([...found], ["athlevo"]);
});

/* ── D / E / H / I / J: the callback completes the session once ───────── */

await test("D. appUrlOpen with the callback exchanges the code and signals auth-complete", async () => {
  const w = world();
  assert.equal(typeof w.pluginListeners["App:appUrlOpen"], "function", "appUrlOpen listener is installed");
  w.pluginListeners["App:appUrlOpen"]({ url: `${NATIVE_CALLBACK}?code=abc_123-XYZ` });
  await settle();
  assert.deepEqual(w.calls.exchange, ["abc_123-XYZ"]);
  assert.ok(w.calls.closed >= 1, "system browser is dismissed");
  const complete = eventsOf(w, "athlevo:native-auth-complete");
  assert.equal(complete.length, 1);
  assert.equal(complete[0].detail.userId, "user-1");
  assert.deepEqual(eventsOf(w, "athlevo:native-link-failed"), []);
  assert.deepEqual(w.calls.assigned.concat(w.calls.replaced), [], "nothing navigates the WebView to a website");
});

await test("D. cold start: a callback delivered as the launch URL also completes sign-in", async () => {
  const w = world({ launchUrl: `${NATIVE_CALLBACK}?code=cold_start_code` });
  await settle();
  assert.deepEqual(w.calls.exchange, ["cold_start_code"]);
  assert.equal(eventsOf(w, "athlevo:native-auth-complete").length, 1);
});

await test("H/I. the same callback delivered twice exchanges and completes only once", async () => {
  const w = world({ launchUrl: `${NATIVE_CALLBACK}?code=dup_code` });
  await settle();
  w.pluginListeners["App:appUrlOpen"]({ url: `${NATIVE_CALLBACK}?code=dup_code` });
  await settle();
  assert.deepEqual(w.calls.exchange, ["dup_code"]);
  assert.equal(eventsOf(w, "athlevo:native-auth-complete").length, 1);
});

await test("J. sign out then sign in again (new code) completes a second time", async () => {
  const w = world();
  await w.runtime.handleCallback(`${NATIVE_CALLBACK}?code=first_login`);
  await w.runtime.handleCallback(`${NATIVE_CALLBACK}?code=second_login`);
  assert.deepEqual(w.calls.exchange, ["first_login", "second_login"]);
  assert.equal(eventsOf(w, "athlevo:native-auth-complete").length, 2);
});

await test("H. cancelled or failed Google return never exchanges a code or loops", async () => {
  const w = world();
  assert.equal(await w.runtime.handleCallback(`${NATIVE_CALLBACK}?error=access_denied`), true);
  assert.deepEqual(w.calls.toasts, ["Sign-in cancelled."]);
  assert.equal(await w.runtime.handleCallback(`${NATIVE_CALLBACK}?error=server_error`), false);
  assert.deepEqual(w.calls.exchange, []);
  assert.equal(eventsOf(w, "athlevo:native-auth-complete").length, 0);
  assert.equal(eventsOf(w, "athlevo:native-link-failed")[0].detail.reason, "auth_provider_failed");
});

/* ── F: never opened as a normal website ──────────────────────────────── */

await test("F. the callback is never treated as a website and web URLs are not accepted as callbacks", async () => {
  const w = world();
  const open = await w.runtime.openExternal(`${NATIVE_CALLBACK}?code=x`);
  assert.equal(open.ok, false);
  assert.deepEqual(w.calls.opened, []);
  for (const url of ["https://athlevo.org/?code=abc", "https://athlevo.org/auth/callback?code=abc", "athlevo://evil/callback?code=abc", `${NATIVE_CALLBACK}#access_token=t`]) {
    assert.equal(await w.runtime.handleCallback(url), false, url);
  }
  assert.deepEqual(w.calls.exchange, []);
  assert.deepEqual(w.calls.assigned, []);
});

/* ── E / G: routing after the session exists ──────────────────────────── */

await test("E/G. auth-complete restores the session through the single routeAfterAuth path", () => {
  assert.match(indexSource, /addEventListener\("athlevo:native-auth-complete",[\s\S]{0,200}restoreSession\(\{ nativeCallback: true \}\)/);
  assert.match(indexSource, /var nativeAuthReturn = !!opts\.nativeCallback;/);
  // restoreSession guards against routing the same user twice (no duplicate onboarding).
  assert.match(indexSource, /if \(window\.__athlevoRoutingFor === session\.user\.id\) \{\s*return true;\s*\}\s*window\.__athlevoRoutingFor = session\.user\.id;/);
  // The guard is released on sign-out so signing in again routes again.
  const resets = indexSource.match(/window\.__athlevoRoutingFor = null/g) || [];
  assert.ok(resets.length >= 2, "routing guard reset on sign-out paths");
  // Native client is PKCE with URL detection off, so the callback is only ever consumed by handleCallback.
  assert.match(indexSource, /detectSessionInUrl: !athlevoNative,\s*flowType: athlevoNative \? 'pkce' : 'implicit'/);
  assert.match(indexSource, /athlevoNative && window\.AthlevoRuntime\) \{\s*window\.AthlevoRuntime\.initializeNative\(supabaseClient\)/);
  assert.ok(indexSource.indexOf('src="js/runtimeEnvironment.js') < indexSource.indexOf("supabase.createClient("),
    "runtime loads before the Supabase client is configured");
});

console.log(`\n${passed} tests passed`);

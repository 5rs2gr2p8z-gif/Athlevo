/*
 * Athlevo — signup conversion screen (/signup web + bundled Android app).
 *
 * Loads the REAL js/runtimeEnvironment.js, js/analytics.js and
 * js/analyticsRegistry.js, and runs the REAL signup helper functions
 * extracted from index.html against a minimal fake DOM. Covers:
 *   A value-proposition copy      B Email CTA       C Google CTA
 *   D Meta in-app → Email first   E normal browser keeps default order
 *   F Capacitor is never "Meta"   G native callback unchanged
 *   H web callback unchanged      I legal links     J small-screen CSS
 *   K analytics: once per action, categorical only
 * (Rendered at 320x568, 360x640, 390x844, 412x915 + desktop during QA.)
 *
 * Run: node tests/signup-conversion.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(p, "utf8");
const html = read("index.html");
const runtimeSource = read("js/runtimeEnvironment.js");
const analyticsSource = read("js/analytics.js");
const registrySource = read("js/analyticsRegistry.js");
const socialSource = read("js/socialAuth.js");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

const UA = {
  chrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
  facebook: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.40.109;]",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/21F90 Instagram 340.0.0.28.109"
};

/* ── brace-matched function extraction from index.html ─────────────────── */
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in index.html`);
  let i = html.indexOf("{", start), depth = 0;
  for (; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return html.slice(start, i);
}

/* ── minimal fake DOM (just what the signup helpers touch) ─────────────── */
class El {
  constructor(id, cls = []) {
    this.id = id; this.children = []; this.parent = null; this.hidden = false;
    this._cls = new Set(cls); this.attrs = {}; this.innerHTML = "";
    this.classList = {
      add: c => this._cls.add(c),
      remove: c => this._cls.delete(c),
      contains: c => this._cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._cls.has(c) : !!force;
        on ? this._cls.add(c) : this._cls.delete(c);
        return on;
      }
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  _detach() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  insertBefore(node, ref) {
    node._detach();
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(at, 0, node); node.parent = this; return node;
  }
  after(node) {
    node._detach();
    const p = this.parent; p.children.splice(p.children.indexOf(this) + 1, 0, node); node.parent = p;
  }
  get nextElementSibling() { return this.parent ? this.parent.children[this.parent.children.indexOf(this) + 1] || null : null; }
  get previousElementSibling() { return this.parent ? this.parent.children[this.parent.children.indexOf(this) - 1] || null : null; }
}

function welcomeDom() {
  const ids = {};
  const mk = (id, cls) => (ids[id] = new El(id, cls));
  const screen = mk("screen-welcome", ["screen", "welcome"]);
  const wrap = new El("", ["w-btns"]);
  ["authBtnApple", "authBtnGoogle", "wGoogleNote", "authBtnEmail", "wSignupLink", "wAiSignupLegal"]
    .forEach(id => wrap.insertBefore(mk(id), null));
  ["wAiSignupTitle", "wAiSignupSub", "wAiSignupTrust", "wCheckoutContinue", "wWelcomeBack"].forEach(id => {
    const el = mk(id); el.hidden = true;
  });
  ids.authBtnEmail.setAttribute("onclick", "openLogin(true)");
  ids.wGoogleNote.hidden = true; ids.wAiSignupLegal.hidden = true;
  const document = {
    getElementById: id => ids[id] || null,
    querySelector: sel => (sel === "#screen-welcome .w-btns" ? wrap : null)
  };
  return { ids, wrap, document };
}

function runtimeFor({ ua, native = false }) {
  const root = {
    navigator: { userAgent: ua, vendor: "", onLine: true },
    document: { referrer: "", querySelector: () => null, getElementById: () => null, body: {}, documentElement: { classList: { add() {}, remove() {} } } },
    location: { href: "https://athlevo.org/signup", origin: "https://athlevo.org", pathname: "/signup", search: "", hash: "" },
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, dispatchEvent() {}, setTimeout() { return 1; },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  if (native) {
    root.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {} };
  }
  root.window = root;
  const ctx = vm.createContext({
    window: root, globalThis: root, URL, URLSearchParams, console: { log() {}, warn() {}, error() {}, debug() {} },
    CustomEvent: class {}
  });
  vm.runInContext(runtimeSource, ctx, { filename: "runtimeEnvironment.js" });
  return root.AthlevoRuntime;
}

/* Run the real welcome helpers against a fake DOM + a given runtime. */
function welcomeWorld(runtimeOpts) {
  const dom = welcomeDom();
  const sandbox = vm.createContext({
    document: dom.document,
    window: { AthlevoRuntime: runtimeFor(runtimeOpts) },
    AthlevoRuntime: undefined
  });
  sandbox.AthlevoRuntime = sandbox.window.AthlevoRuntime;
  const code = [
    "setSignupValuePropVisible", "isMetaInAppSignupContext", "syncSignupCtaOrder",
    "applyAiSignupWelcomeCopy", "resetAiSignupWelcome"
  ].map(extractFunction).join("\n");
  vm.runInContext(code, sandbox);
  const order = () => dom.wrap.children.map(c => c.id);
  return { dom, sandbox, order, visible: id => !dom.ids[id].hidden };
}

/* ═══════════ A. value-proposition copy ═══════════ */

test("A. headline, supporting line and trust line are in the signup markup", () => {
  assert.match(html, /<h1 class="w-ai-title" id="wAiSignupTitle" hidden>Your running, understood\.<\/h1>/);
  assert.match(html, /id="wAiSignupSub" hidden>Get training guidance built around your schedule, recent training, and goals\.<\/p>/);
  assert.match(html, /id="wAiSignupTrust" hidden>Create your account in about a minute\.<\/p>/);
});

test("A. applying signup mode reveals the copy; resetting hides it again", () => {
  const w = welcomeWorld({ ua: UA.chrome });
  w.sandbox.applyAiSignupWelcomeCopy();
  for (const id of ["wAiSignupTitle", "wAiSignupSub", "wAiSignupTrust", "wAiSignupLegal"]) {
    assert.equal(w.visible(id), true, `${id} visible in signup mode`);
  }
  w.sandbox.resetAiSignupWelcome();
  for (const id of ["wAiSignupTitle", "wAiSignupSub", "wAiSignupTrust", "wAiSignupLegal"]) {
    assert.equal(w.visible(id), false, `${id} hidden after reset`);
  }
});

test("A. no unverified or risky claims on the signup screen", () => {
  const block = html.slice(html.indexOf('id="screen-welcome"'), html.indexOf('id="screen-onboard"'));
  assert.doesNotMatch(block, /free to get started/i, "payment is required after signup for unpaid athletes, so 'free' is not verified");
  assert.doesNotMatch(block, /\bfree\b/i);
  assert.doesNotMatch(block, /guarantee|faster race|human coach|medical|testimonial|\d+\s*(athletes|runners|users)|★|stars?\b/i);
});

/* ═══════════ B / C. CTAs stay functional ═══════════ */

test("B. Email CTA: legacy login handler by default, signup handler in signup mode", () => {
  assert.match(html, /<button class="w-btn primary btn-premium-red" id="authBtnEmail" onclick="openLogin\(true\)">/);
  const w = welcomeWorld({ ua: UA.chrome });
  w.sandbox.applyAiSignupWelcomeCopy();
  assert.equal(w.dom.ids.authBtnEmail.getAttribute("onclick"), "openSignup(true)");
  w.sandbox.resetAiSignupWelcome();
  assert.equal(w.dom.ids.authBtnEmail.getAttribute("onclick"), "openLogin(true)");
});

test("B. openSignup(true) records email_signup_clicked exactly once and opens the existing form", () => {
  const fn = extractFunction("openSignup");
  assert.equal((fn.match(/trackAuthChoice\("email_signup_clicked"\)/g) || []).length, 1);
  assert.match(fn, /showSignupForm\(false\)/, "reuses the existing email form — no second implementation");
  assert.doesNotMatch(fn, /signUp\(|auth\./, "no new auth implementation in the CTA");
});

test("C. Google CTA is untouched: same handler, not disabled, still present in every mode", () => {
  assert.match(html, /<button class="w-btn google" id="authBtnGoogle" onclick="continueWithGoogle\(\)">/);
  for (const ua of [UA.chrome, UA.facebook]) {
    const w = welcomeWorld({ ua });
    w.sandbox.applyAiSignupWelcomeCopy();
    assert.ok(w.order().includes("authBtnGoogle"));
    assert.equal(w.dom.ids.authBtnGoogle.getAttribute("disabled"), null);
  }
});

/* ═══════════ D / E / F. CTA order ═══════════ */

test("D. Facebook and Instagram in-app browsers: Email first, Google second with a short note", () => {
  for (const ua of [UA.facebook, UA.instagram]) {
    const w = welcomeWorld({ ua });
    w.sandbox.applyAiSignupWelcomeCopy();
    const o = w.order();
    assert.ok(o.indexOf("authBtnEmail") < o.indexOf("authBtnGoogle"), `email before google: ${o}`);
    assert.equal(o[o.indexOf("authBtnGoogle") + 1], "wGoogleNote", "note sits directly under Google");
    assert.equal(w.visible("wGoogleNote"), true);
  }
  assert.match(html, /id="wGoogleNote" hidden>Google sign-in may open in your browser\.<\/p>/);
});

test("E. regular Chrome/Safari keep the default order and show no Google note", () => {
  for (const ua of [UA.chrome, UA.safari]) {
    const w = welcomeWorld({ ua });
    w.sandbox.applyAiSignupWelcomeCopy();
    const o = w.order();
    assert.ok(o.indexOf("authBtnGoogle") < o.indexOf("authBtnEmail"), `google before email: ${o}`);
    assert.equal(w.visible("wGoogleNote"), false);
  }
});

test("E. leaving signup mode restores the default order in a Meta browser", () => {
  const w = welcomeWorld({ ua: UA.facebook });
  w.sandbox.applyAiSignupWelcomeCopy();
  w.sandbox.resetAiSignupWelcome();
  const o = w.order();
  assert.ok(o.indexOf("authBtnGoogle") < o.indexOf("authBtnEmail"));
  assert.equal(w.visible("wGoogleNote"), false);
});

test("F. the Capacitor app is never classified as a Meta in-app browser", () => {
  for (const ua of [UA.chrome, UA.facebook, UA.instagram]) {
    const rt = runtimeFor({ ua, native: true });
    assert.equal(rt.isNative(), true);
    assert.equal(rt.isMetaInAppBrowser(), false, `native + ${ua.slice(0, 30)}`);
    const w = welcomeWorld({ ua, native: true });
    w.sandbox.applyAiSignupWelcomeCopy();
    const o = w.order();
    assert.ok(o.indexOf("authBtnGoogle") < o.indexOf("authBtnEmail"), "native keeps default order");
  }
  assert.equal(runtimeFor({ ua: UA.facebook }).isMetaInAppBrowser(), true);
  assert.equal(runtimeFor({ ua: UA.chrome }).isMetaInAppBrowser(), false);
});

test("F. the Meta helper only adjusts signup presentation — it never touches routing or auth", () => {
  const uses = (src, label) => assert.equal((src.match(/isMetaInAppBrowser/g) || []).length, 0, `${label} must not use it`);
  uses(socialSource, "socialAuth.js");
  uses(read("js/authSupport.js"), "authSupport.js");
  assert.equal((runtimeSource.match(/isMetaInAppBrowser/g) || []).length, 2, "runtimeEnvironment.js: definition + export only");
});

/* ═══════════ G / H. callbacks preserved ═══════════ */

test("G. native Google callback is still athlevo://auth/callback", () => {
  assert.match(runtimeSource, /AUTH_CALLBACK = "athlevo:\/\/auth\/callback"/);
  assert.match(read("android/app/src/main/AndroidManifest.xml"), /android:scheme="athlevo"/);
  assert.doesNotMatch(read("index.html"), /athlevo:\/\/auth\/callback/, "no second callback string leaked into the signup UI");
});

test("H. web Google auth still redirects to the web origin (never the custom scheme)", () => {
  assert.match(socialSource, /redirectTo: redirectTarget\(\)/);
  assert.match(socialSource, /skipBrowserRedirect: nativeApp/);
  assert.doesNotMatch(socialSource, /athlevo:\/\//);
});

/* ═══════════ I. legal ═══════════ */

test("I. Terms and Privacy links are on the signup screen and open the existing legal sheets", () => {
  const legal = /id="wAiSignupLegal"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(legal, "legal paragraph present");
  assert.match(legal[1], /openLegal\('terms'\)[^>]*>Terms of Service<\/a>/);
  assert.match(legal[1], /openLegal\('privacy'\)[^>]*>Privacy Policy<\/a>/);
  const w = welcomeWorld({ ua: UA.facebook });
  w.sandbox.applyAiSignupWelcomeCopy();
  assert.equal(w.visible("wAiSignupLegal"), true);
});

/* ═══════════ J. small screens ═══════════ */

test("J. short-screen rules keep the signup copy + buttons on screen (no clipping)", () => {
  assert.match(html, /@media\(max-height:720px\)\{#screen-welcome\.is-ai-signup \.w-top\{padding-top:44px\}/);
  assert.match(html, /@media\(max-height:600px\)\{#screen-welcome\.is-ai-signup \.w-top\{padding-top:28px\}/);
  assert.match(html, /\.w-ai-sub\{font-size:var\(--fs-body\);color:var\(--ink2\);max-width:300px\}/);
  assert.match(html, /#screen-welcome\.is-ai-signup \.w-top\{overflow-wrap:anywhere/);
  assert.match(html, /\.welcome\{justify-content:space-between;padding:0!important\}/);
});

/* ═══════════ K. analytics ═══════════ */

function analyticsFor({ ua, native = false, search = "", referrer = "" }) {
  const captured = [];
  const stores = () => { const s = {}; return { getItem: k => s[k] ?? null, setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; } }; };
  const win = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    navigator: { userAgent: ua },
    localStorage: stores(), sessionStorage: stores(),
    location: { origin: "https://athlevo.org", pathname: "/signup", search, hash: "", href: "https://athlevo.org/signup" + search },
    document: { referrer, visibilityState: "visible", body: { classList: { contains: () => false } }, documentElement: {}, querySelector: () => null, getElementById: () => null },
    POSTHOG_KEY: "phc_test",
    posthog: { init() {}, capture: (name, props) => captured.push({ name, props }), identify() {}, reset() {}, _i: [], __SV: 1 }
  };
  win.window = win;
  win.AthlevoRuntime = runtimeFor({ ua, native });
  new Function("window", registrySource)(win);
  new Function("window", "document", "navigator", "localStorage", "sessionStorage",
    analyticsSource.replace(/\}\)\(typeof window[\s\S]*$/, "})(window);"))(win, win.document, win.navigator, win.localStorage, win.sessionStorage);
  return { api: win.AthlevoProductAnalytics, captured };
}
const SIGNUP_EVENTS = ["auth_screen_viewed", "ai_signup_viewed", "google_signup_clicked", "email_signup_clicked"];
const ctxOf = e => ({ s: e.props.signup_surface, b: e.props.browser_type, t: e.props.traffic_source });

test("K. signup events carry categorical surface / browser / source context", () => {
  const web = analyticsFor({ ua: UA.chrome, search: "?utm_source=facebook&utm_medium=paid&fbclid=abc" });
  web.api.trackAthlevoEvent("google_signup_clicked");
  assert.deepEqual(ctxOf(web.captured[0]), { s: "web", b: "standard", t: "paid_social" });

  const meta = analyticsFor({ ua: UA.facebook, search: "?utm_source=instagram&utm_medium=paid" });
  meta.api.trackAthlevoEvent("email_signup_clicked");
  assert.deepEqual(ctxOf(meta.captured[0]), { s: "web", b: "meta_in_app", t: "paid_social" });

  const android = analyticsFor({ ua: UA.facebook, native: true });
  android.api.trackAthlevoEvent("auth_screen_viewed");
  assert.deepEqual(ctxOf(android.captured[0]), { s: "android", b: "standard", t: "unknown" });

  const organic = analyticsFor({ ua: UA.chrome, search: "?utm_medium=organic" });
  organic.api.trackAthlevoEvent("ai_signup_viewed", { from: "ai_diagnostic" });
  assert.equal(organic.captured[0].props.traffic_source, "organic");
});

test("K. view events fire once per load; click events fire once per call", () => {
  const { api, captured } = analyticsFor({ ua: UA.chrome });
  api.trackAthlevoEvent("auth_screen_viewed"); api.trackAthlevoEvent("auth_screen_viewed");
  api.trackAthlevoEvent("ai_signup_viewed"); api.trackAthlevoEvent("ai_signup_viewed");
  assert.equal(captured.filter(e => e.name === "auth_screen_viewed").length, 1);
  assert.equal(captured.filter(e => e.name === "ai_signup_viewed").length, 1);
  api.trackAthlevoEvent("google_signup_clicked");
  api.trackAthlevoEvent("email_signup_clicked");
  assert.equal(captured.filter(e => e.name === "google_signup_clicked").length, 1);
  assert.equal(captured.filter(e => e.name === "email_signup_clicked").length, 1);
  // each UI action maps to exactly one tracking call site
  assert.equal((socialSource.match(/trackAthlevoEvent\("google_signup_clicked"\)/g) || []).length, 1);
});

test("K. only closed-vocabulary values and no PII reach analytics", () => {
  const { api, captured } = analyticsFor({ ua: UA.facebook, search: "?utm_source=facebook&utm_medium=paid&fbclid=abc&email=a@b.co&name=Dean&token=secret" });
  api.trackAthlevoEvent("email_signup_clicked", { email: "a@b.co", name: "Dean", token: "secret", signup_surface: "<script>", browser_type: "evil", traffic_source: "evil" });
  const props = captured[0].props;
  assert.ok(["web", "android", "ios"].includes(props.signup_surface));
  assert.ok(["standard", "meta_in_app"].includes(props.browser_type));
  assert.ok(["paid_social", "organic", "unknown"].includes(props.traffic_source));
  const flat = JSON.stringify(props);
  assert.doesNotMatch(flat, /a@b\.co|Dean|secret|<script>/);
  assert.equal(props.email, undefined); assert.equal(props.name, undefined); assert.equal(props.token, undefined);
});

test("K. the registry allows the three context keys on the four signup events", () => {
  const sandbox = { }; new Function("window", registrySource)(sandbox);
  const reg = sandbox.AthlevoAnalyticsRegistry;
  for (const ev of SIGNUP_EVENTS) {
    const props = reg.EVENTS[ev].props;
    for (const k of ["signup_surface", "browser_type", "traffic_source"]) assert.ok(props.includes(k), `${ev} allows ${k}`);
  }
});

test("K. campaign parameters are still persisted for the whole session", () => {
  const { api, captured } = analyticsFor({ ua: UA.chrome, search: "?utm_source=facebook&utm_campaign=c1&fbclid=abc" });
  api.trackAthlevoEvent("google_signup_clicked");
  assert.equal(captured[0].props.utm_source, "facebook");
  assert.equal(captured[0].props.utm_campaign, "c1");
  assert.equal(captured[0].props.fbclid, "abc");
});

console.log(`\n${passed} tests passed`);

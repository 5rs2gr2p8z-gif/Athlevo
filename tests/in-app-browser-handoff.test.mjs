/**
 * Facebook/Instagram external-browser signup handoff contract.
 * Run: node tests/in-app-browser-handoff.test.mjs
 */

import { readFileSync } from "node:fs";

const authSupportSource = readFileSync("./js/authSupport.js", "utf8");
const socialSource = readFileSync("./js/socialAuth.js", "utf8");
const analyticsSource = readFileSync("./js/analytics.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");

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

const FACEBOOK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/520.0.0.0]";
const INSTAGRAM_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 Mobile/15E148 Instagram 382.0.0";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 CriOS/138.0.0.0 Mobile/15E148 Safari/604.1";

function memoryStorage(seed = {}) {
  const store = { ...seed };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    _store: store
  };
}

function buttonNode(id, document) {
  return {
    id,
    textContent: "",
    listeners: {},
    hidden: false,
    addEventListener(name, handler) { this.listeners[name] = handler; },
    focus() { document.activeElement = this; }
  };
}

function makeDom() {
  const elements = new Map();
  const document = {
    activeElement: null,
    referrer: "",
    execCommand: () => true,
    querySelector: () => null,
    getElementById(id) { return elements.get(id) || null; },
    createElement(tag) {
      if (tag === "textarea") {
        return {
          value: "",
          style: {},
          setAttribute() {},
          select() {}
        };
      }
      if (tag === "style") {
        return { id: "", textContent: "" };
      }
      const copy = buttonNode("athlevoEnvCopy", document);
      const close = buttonNode("athlevoEnvClose", document);
      const feedback = { id: "athlevoEnvFeedback", textContent: "" };
      const attributes = {};
      const node = {
        id: "",
        html: "",
        listeners: {},
        removed: false,
        childrenBySelector: {
          "#athlevoEnvCopy": copy,
          "#athlevoEnvClose": close,
          "#athlevoEnvFeedback": feedback
        },
        set innerHTML(value) { this.html = value; },
        get innerHTML() { return this.html; },
        setAttribute(name, value) { attributes[name] = String(value); },
        getAttribute(name) { return attributes[name] || null; },
        querySelector(selector) { return this.childrenBySelector[selector] || null; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        remove() {
          this.removed = true;
          if (this.id) elements.delete(this.id);
        }
      };
      return node;
    }
  };
  document.head = {
    appendChild(node) {
      if (node.id) elements.set(node.id, node);
    }
  };
  document.body = {
    appendChild(node) {
      if (node.id) elements.set(node.id, node);
    },
    removeChild() {}
  };
  const trigger = buttonNode("trigger", document);
  trigger.focus();
  return { document, elements, trigger };
}

function executeAuthSupport(window, document, navigator) {
  const fn = new Function(
    "window", "document", "navigator", "URL", "URLSearchParams",
    authSupportSource
  );
  fn(window, document, navigator, URL, URLSearchParams);
}

function environment({
  userAgent,
  search = "",
  attribution = null,
  realAnalytics = false
}) {
  const { document, elements, trigger } = makeDom();
  const copied = [];
  const events = [];
  const oauth = [];
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  const navigator = {
    userAgent,
    vendor: "Apple Computer, Inc.",
    standalone: false,
    clipboard: {
      async writeText(value) { copied.push(value); }
    }
  };
  const window = {
    document,
    navigator,
    sessionStorage,
    localStorage,
    location: {
      origin: "https://athlevo.org",
      pathname: "/",
      search,
      hash: "",
      href: "https://athlevo.org/" + search
    },
    matchMedia: () => ({ matches: false }),
    history: { replaceState() {} },
    console,
    AthlevoProductAnalytics: realAnalytics ? undefined : {
      attributionProps: () => attribution || {},
      trackAthlevoEvent(name, props) { events.push({ name, props }); },
      beginSignupIntent() {},
      clearSignupIntent() {}
    }
  };
  window.window = window;

  if (realAnalytics) {
    window.POSTHOG_KEY = "phc_test";
    window.posthog = {
      init() {},
      capture(name, props) { events.push({ name, props }); },
      _i: [],
      __SV: 1
    };
    const analyticsFn = new Function(
      "window", "document", "navigator", "localStorage", "sessionStorage",
      analyticsSource
    );
    analyticsFn(window, document, navigator, localStorage, sessionStorage);
  }

  executeAuthSupport(window, document, navigator);

  const supabaseClient = {
    auth: {
      async getSession() { return { data: { session: null } }; },
      async signInWithOAuth(options) {
        oauth.push(options);
        return { data: {}, error: null };
      }
    }
  };
  const socialFn = new Function(
    "window", "document", "supabaseClient", "URL", "URLSearchParams", "console",
    socialSource
  );
  socialFn(window, document, supabaseClient, URL, URLSearchParams, console);

  return {
    window,
    document,
    elements,
    trigger,
    copied,
    events,
    oauth,
    sessionStorage
  };
}

console.log("\n──── Detection and OAuth interception ────");
{
  const facebook = environment({ userAgent: FACEBOOK_IOS });
  const result = await facebook.window.AthlevoSocialAuth.signInWithGoogle();
  test("Facebook iOS is detected", facebook.window.AthlevoEnv.handoffBrowser() === "facebook");
  test("Facebook iOS intercepts before Google OAuth",
    result.handled === true && facebook.oauth.length === 0);
}
{
  const instagram = environment({ userAgent: INSTAGRAM_IOS });
  const result = await instagram.window.AthlevoSocialAuth.signInWithGoogle();
  test("Instagram iOS is detected", instagram.window.AthlevoEnv.handoffBrowser() === "instagram");
  test("Instagram iOS intercepts before Google OAuth",
    result.handled === true && instagram.oauth.length === 0);
}
{
  const safari = environment({ userAgent: SAFARI_IOS });
  await safari.window.AthlevoSocialAuth.signInWithGoogle();
  test("normal Safari starts Google OAuth normally", safari.oauth.length === 1);

  const chrome = environment({ userAgent: CHROME_IOS });
  await chrome.window.AthlevoSocialAuth.signInWithGoogle();
  test("normal Chrome starts Google OAuth normally", chrome.oauth.length === 1);
}

console.log("\n──── Copy-only handoff and safe URL ────");
{
  const value = environment({
    userAgent: FACEBOOK_IOS,
    search: "?utm_source=meta&utm_medium=paid_social&utm_campaign=launch" +
      "&utm_content=video_a&utm_term=marathon&fbclid=fb-123" +
      "&code=oauth-secret&access_token=token-secret&email=athlete@example.com" +
      "&next=https%3A%2F%2Fevil.example#access_token=hash-secret"
  });
  value.window.AthlevoEnv.guardSignupHandoff("signup", "landing");
  const overlay = value.elements.get("athlevoEnvNotice");
  const copy = overlay.querySelector("#athlevoEnvCopy");
  const close = overlay.querySelector("#athlevoEnvClose");

  test("handoff uses the required copy-only actions",
    /Continue in Safari or Chrome/.test(overlay.innerHTML) &&
    /Copy signup link/.test(overlay.innerHTML) &&
    />Close</.test(overlay.innerHTML));
  test("broken ordinary-navigation Open in browser action is removed",
    !/athlevoEnvOpen|target="_blank"|>Open in browser</.test(authSupportSource));
  test("dialog has accessible naming and initial focus",
    overlay.getAttribute("role") === "dialog" &&
    overlay.getAttribute("aria-modal") === "true" &&
    overlay.getAttribute("aria-labelledby") === "athlevoEnvTitle" &&
    value.document.activeElement === copy);

  await copy.listeners.click();
  const copiedUrl = new URL(value.copied[0]);
  const handoffEvents = value.events.filter(event =>
    event.name === "in_app_browser_signup_blocked" ||
    event.name === "external_signup_link_copied"
  );
  test("blocked and copied events use categorical properties only",
    handoffEvents.length === 2 &&
    handoffEvents.every(event =>
      JSON.stringify(Object.keys(event.props).sort()) ===
        JSON.stringify(["browser", "intent", "source_surface"])));
  test("copied URL contains an allowlisted signup continuation",
    copiedUrl.origin === "https://athlevo.org" &&
    copiedUrl.searchParams.get("continue") === "signup");
  test("copied URL preserves approved UTM and fbclid values",
    copiedUrl.searchParams.get("utm_source") === "meta" &&
    copiedUrl.searchParams.get("utm_medium") === "paid_social" &&
    copiedUrl.searchParams.get("utm_campaign") === "launch" &&
    copiedUrl.searchParams.get("utm_content") === "video_a" &&
    copiedUrl.searchParams.get("utm_term") === "marathon" &&
    copiedUrl.searchParams.get("fbclid") === "fb-123");
  test("copied URL strips OAuth data, email, arbitrary parameters, and hashes",
    !copiedUrl.searchParams.has("code") &&
    !copiedUrl.searchParams.has("access_token") &&
    !copiedUrl.searchParams.has("email") &&
    !copiedUrl.searchParams.has("next") &&
    copiedUrl.hash === "");
  test("copy success gives truthful manual instructions",
    /Link copied\. Tap ••• above/.test(
      overlay.querySelector("#athlevoEnvFeedback").textContent
    ));

  close.focus();
  let tabPrevented = false;
  overlay.listeners.keydown({
    key: "Tab",
    shiftKey: false,
    preventDefault() { tabPrevented = true; }
  });
  test("focus remains trapped within the handoff sheet",
    tabPrevented && value.document.activeElement === copy);
  let escapePrevented = false;
  overlay.listeners.keydown({
    key: "Escape",
    preventDefault() { escapePrevented = true; }
  });
  test("Escape closes the sheet and restores focus",
    escapePrevented && overlay.removed && value.document.activeElement === value.trigger);

  const style = value.elements.get("athlevoEnvNoticeStyles");
  test("dark-mode tokens, narrow mobile layout, and reduced motion are preserved",
    /var\(--paper/.test(style.textContent) &&
    /var\(--text/.test(style.textContent) &&
    /@media\(max-width:360px\)/.test(style.textContent) &&
    /prefers-reduced-motion:reduce/.test(style.textContent));
}

console.log("\n──── Continuation routing and attribution restore ────");
{
  const invalid = environment({
    userAgent: SAFARI_IOS,
    search: "?continue=https%3A%2F%2Fevil.example"
  });
  test("invalid continuation values are rejected",
    invalid.window.AthlevoEnv.readContinuation() === null);

  const validSearch =
    "?continue=signup&handoff_browser=instagram&source_surface=auth" +
    "&utm_source=meta&utm_medium=paid_social&utm_campaign=handoff" +
    "&utm_content=story&utm_term=runner&fbclid=click-789";
  const external = environment({
    userAgent: SAFARI_IOS,
    search: validSearch,
    realAnalytics: true
  });
  const continuation = external.window.AthlevoEnv.consumeContinuation();
  test("external browser accepts only the categorical continuation",
    continuation &&
    continuation.intent === "signup" &&
    continuation.browser === "instagram" &&
    continuation.sourceSurface === "auth");
  const stored = JSON.parse(
    external.sessionStorage.getItem("athlevo_utm") || "null"
  );
  test("external load restores attribution into athlevo_utm",
    stored &&
    stored.utm_source === "meta" &&
    stored.utm_medium === "paid_social" &&
    stored.utm_campaign === "handoff" &&
    stored.utm_content === "story" &&
    stored.utm_term === "runner" &&
    stored.fbclid === "click-789");
  const continuationEvent = external.events.find(
    event => event.name === "external_signup_continuation_viewed"
  );
  test("handoff analytics contain categorical properties only",
    continuationEvent &&
    JSON.stringify(Object.keys(continuationEvent.props).sort()) ===
      JSON.stringify(["browser", "intent", "source_surface"]));
}

{
  const restore = indexSource.slice(
    indexSource.indexOf("async function restoreSession"),
    indexSource.indexOf("function endBootGate")
  );
  test("valid continuation routes to the normal auth entry screen",
    /consumeContinuation\(\)[\s\S]*?showScreen\("screen-welcome"\)/.test(restore));
  test("continuation never automatically starts Google OAuth",
    !/signInWithOAuth|signInWithGoogle|continueWithGoogle/.test(restore));
  test("landing, Create account, and Google all have pre-auth intercepts",
    /landingStartFree[\s\S]*?interceptInAppAuthHandoff\("signup", "landing"\)/.test(indexSource) &&
    /function openSignup[\s\S]*?interceptInAppAuthHandoff\("signup", "auth"\)/.test(indexSource) &&
    /guardSignupHandoff\("signup", "auth"\)/.test(socialSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

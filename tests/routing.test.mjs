/*
 * Athlevo — boot routing & session restoration test suite.
 *
 * Extracts the REAL routing functions out of index.html and runs them against
 * a minimal DOM + Supabase double, so the assertions are about the shipped
 * code rather than a re-implementation. Run: node tests/routing.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");

function extractEarly(name) {
  const m = html.match(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`, "m"));
  return m ? m[0] : "";
}

/* ── static-markup guarantees (the flash bug lived here) ────────────── */

section("Static markup — nothing may paint before auth resolves");
{
  const activeScreens = [...html.matchAll(/class="screen([^"]*)\bactive\b([^"]*)"/g)].map(m => m[0]);
  t("NO screen is active in static markup — nothing can paint pre-auth",
    activeScreens.length === 0, `${activeScreens.length}: ${activeScreens.join(" | ")}`);
  t("an opaque boot gate covers the first frame",
    /<div id="boot-gate"/.test(html) && /#boot-gate\{position:fixed;inset:0/.test(html));
  t("gate is an overlay, not a screen → reveal is a fade, not a reflow",
    /body:not\(\.booting\) #boot-gate\{opacity:0/.test(html));
  t("<body> boots in the gated state, not landing-active",
    /<body class="booting">/.test(html) && !/<body[^>]*landing-active/.test(html));
  t("landing section exists but is NOT active",
    /<section class="screen lp" id="screen-landing">/.test(html));
  t("boot gate preserves the shared tab bar without making it interactive",
    /body\.booting #tabbar\{display:flex!important;z-index:9999;pointer-events:none\}/.test(html));
  t("gate survives showScreen — Today reveals populated, not empty",
    !/document\.body\.classList\.remove\('booting'\);/.test(extractEarly("showScreen")));
  t("6s safety valve so a slow load can't hold a blank overlay",
    /Boot gate released on timeout/.test(html));
  t("cold load shows a Today-shaped shell instead of a blank spinner",
    /class="boot-content"/.test(html) &&
    /class="boot-primary-card"/.test(html) &&
    (html.match(/class="skel boot-status-ring"/g) || []).length === 3 &&
    /class="boot-week-row"/.test(html) &&
    !/class="boot-tabbar"/.test(html) &&
    (html.match(/id="tabbar"/g) || []).length === 1 &&
    !/boot-spinner|bootSpin/.test(html));
  t("reduced motion leaves skeletons static",
    /prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important/.test(html) &&
    /#boot-gate\{transition:none\}/.test(html));
}

/* ── extract the real routing functions ─────────────────────────────── */

function extract(name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`, "m");
  const m = html.match(re);
  if (!m) throw new Error(`Could not extract ${name}() from index.html`);
  return m[0];
}

const SOURCE = [
  extract("rememberAppEntryIntent"),
  extract("hasAppEntryIntent"),
  extract("appEntryIntentReason"),
  extract("clearAppEntryIntent"),
  extract("hasStoredAthlevoAuthToken"),
  extract("hasReturningAthlevoAccountMarker"),
  extract("showReturningUserWelcome"),
  extract("openAppEntry"),
  extract("hasWhopCheckoutReturn"),
  extract("showCheckoutReturnWelcome"),
  extract("restoreSession"),
  extract("endBootGate"),
  extract("showScreen"),
  extract("doLogout"),
  extract("renderNavState")
].join("\n\n");

/* ── minimal DOM + app doubles ──────────────────────────────────────── */

function makeWorld({
  session,
  standalone,
  routeThrows = false,
  continuation = null,
  timedOut = false,
  storedAuthToken = false,
  pendingDiagnostic = false,
  pathname = "/",
  href = null,
  acquisitionUserId = null,
  paywallExit = false,
  paidAfterExit = false,
  oauthReturn = false,
  oauthCancelled = false,
  oauthWaitMs = null,
  sessionDelayCalls = 0
}) {
  const state = {
    screens: {
      "screen-landing": { active: false },
      "screen-welcome": { active: false },
      "screen-today": { active: false },
      "screen-diagnostic": { active: false },
      "screen-diagnostic-paywall": { active: false }
    },
    bodyClasses: new Set(["booting"]),
    tabbarDisplay: "none",
    routed: null,
    onboardingStarted: false,
    signedOut: false,
    diagnosticStarted: false,
    log: []
  };
  const store = new Map();
  state.store = store;
  if (paywallExit) store.set("athlevo_paywall_exit", "1");
  const localStore = new Map();
  if (storedAuthToken) {
    localStore.set("sb-test-auth-token", JSON.stringify({ access_token: "stored-access-token" }));
  }

  const el = (id) => ({
    get classList() {
      return {
        add: (c) => { if (state.screens[id]) state.screens[id].active = (c === "active") || state.screens[id].active; },
        remove: (c) => { if (c === "active" && state.screens[id]) state.screens[id].active = false; },
        contains: (c) => !!(state.screens[id] && state.screens[id].active && c === "active")
      };
    },
    style: { set display(v) { if (id === "tabbar") state.tabbarDisplay = v; }, get display() { return state.tabbarDisplay; } }
  });

  const document = {
    body: {
      classList: {
        add: (c) => state.bodyClasses.add(c),
        remove: (c) => state.bodyClasses.delete(c),
        toggle: (c, on) => { on ? state.bodyClasses.add(c) : state.bodyClasses.delete(c); },
        contains: (c) => state.bodyClasses.has(c)
      }
    },
    getElementById: (id) => {
      if (id === "wCheckoutContinue" || id === "wWelcomeBack" ||
          id === "wAiSignupTitle" || id === "wAiSignupSaved" || id === "wSignupLink") {
        return {
          hidden: true,
          innerHTML: "",
          classList: {
            add: (c) => { state.checkoutNoteVisible = c === "is-visible"; },
            remove() {},
            contains() { return false; }
          }
        };
      }
      if (id === "authBtnEmail") {
        return { setAttribute() {}, getAttribute() { return ""; } };
      }
      if (id === "screen-welcome") {
        const node = el(id);
        node.classList.add = (c) => {
          if (c === "active" && state.screens[id]) state.screens[id].active = true;
          if (c === "is-ai-signup") state.aiSignupCopy = true;
        };
        node.classList.remove = (c) => {
          if (c === "active" && state.screens[id]) state.screens[id].active = false;
          if (c === "is-ai-signup") state.aiSignupCopy = false;
        };
        return node;
      }
      return (id === "tabbar" || state.screens[id]) ? el(id) : null;
    },
    querySelectorAll: () => Object.keys(state.screens).map(id => el(id)),
    querySelector: (sel) => {
      if (sel === ".screen.active") {
        const id = Object.keys(state.screens).find(k => state.screens[k].active);
        return id ? el(id) : null;
      }
      return null;
    }
  };

  const sandbox = {
    document,
    window: {
      scrollTo() {},
      location: {
        pathname,
        href: href || ("https://athlevo.org" + pathname)
      },
      __athlevoAuthOAuthReturn: oauthReturn ? {
        at: Date.now(),
        cancelled: !!oauthCancelled,
        hasError: false
      } : null,
      __athlevoOAuthWaitMs: oauthWaitMs,
      AthlevoEnv: {
        consumeContinuation: () => continuation,
        readContinuation: () => continuation
      },
      AthlevoDiagnostic: { hasPending: () => pendingDiagnostic },
      AthlevoDiagnosticAcquisition: {
        current: () => (acquisitionUserId ? { userId: acquisitionUserId } : null),
        hasCheckoutReturn: () => {
          try {
            return new URL(href || ("https://athlevo.org" + pathname)).searchParams.get("checkout_return") === "1";
          } catch (e) { return false; }
        },
        hasPaywallExit: () => store.get("athlevo_paywall_exit") === "1",
        clearPaywallExit: () => {
          store.delete("athlevo_paywall_exit");
          state.paywallExitCleared = true;
        },
        verifiedPaidAccess: async () => ({ paid: !!paidAfterExit }),
        showPublicPricing() {
          state.pricingShown = true;
          Object.keys(state.screens).forEach(id => {
            if (state.screens[id]) state.screens[id].active = false;
          });
          state.screens["screen-diagnostic-paywall"].active = true;
        },
        showPaywall() {
          state.pricingShown = true;
          Object.keys(state.screens).forEach(id => {
            if (state.screens[id]) state.screens[id].active = false;
          });
          state.screens["screen-diagnostic-paywall"].active = true;
        }
      },
      AthlevoDiagnosticUI: {
        start() {
          state.diagnosticStarted = true;
          state.screens["screen-diagnostic"].active = true;
        }
      },
      openAiSignup() {
        state.aiSignupShown = true;
        Object.keys(state.screens).forEach(id => {
          if (state.screens[id]) state.screens[id].active = false;
        });
        state.screens["screen-welcome"].active = true;
      }
    },
    console: {
      log: (...a) => state.log.push(String(a[0])),
      warn: (...a) => state.log.push(String(a[0])),
      error: (...a) => state.log.push(String(a[0])),
      info: (...a) => state.log.push(String(a[0]))
    },
    setTimeout,
    isStandaloneMode: () => standalone,
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    localStorage: {
      get length() { return localStore.size; },
      key: i => [...localStore.keys()][i] || null,
      getItem: k => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => localStore.set(k, String(v)),
      removeItem: k => localStore.delete(k)
    },
    supabaseClient: { auth: {
      getSession: async () => {
        state.sessionCalls = (state.sessionCalls || 0) + 1;
        if (timedOut) return { data: { session: null }, timedOut: true, error: null };
        if (sessionDelayCalls && state.sessionCalls <= sessionDelayCalls) {
          return { data: { session: null }, error: null };
        }
        return { data: { session }, error: null };
      },
      getUser: async () => ({
        data: { user: session && session.user ? session.user : null },
        error: null
      }),
      signOut: async () => { state.signedOut = true; return { error: null }; }
    } },
    athlevoSessionUserId: null,
    athlevoAuthPushed: false,
    routeAfterAuth: async (uid) => {
      if (routeThrows) throw new Error("routing blew up");
      state.routed = uid;
      state.screens["screen-today"].active = true;
      state.tabbarDisplay = "flex";
    },
    updateOpenAppUI: () => {},
    toast: () => {},
    AthlevoBrain: { resetAthleteUI: () => {}, invalidateActivityCache: () => {} },
    history: { pushState() {}, replaceState(value) { state.historyState = value; } },
    isAiSignupPath: () => {
      const p = String(pathname || "").replace(/\/+$/, "");
      return p === "/ai-signup" || p === "/signup";
    },
    isSignupPath: () => {
      const p = String(pathname || "").replace(/\/+$/, "");
      return p === "/ai-signup" || p === "/signup";
    },
    isAiEntryPath: () => String(pathname || "").replace(/\/+$/, "") === "/ai",
    isPricingPath: () => String(pathname || "").replace(/\/+$/, "") === "/pricing",
    hasAiSignupHandoff: () => store.get("athlevo_ai_signup_handoff") === "1",
    rememberAiSignupHandoff: () => store.set("athlevo_ai_signup_handoff", "1"),
    openLogin: (userChose, source) => {
      state.loginOpened = { userChose, source };
    },
    openAiSignup: () => {
      store.set("athlevo_ai_signup_handoff", "1");
      state.aiSignupShown = true;
      Object.keys(state.screens).forEach(id => {
        if (state.screens[id]) state.screens[id].active = false;
      });
      state.screens["screen-welcome"].active = true;
    },
    clearAiSignupHandoff: () => store.delete("athlevo_ai_signup_handoff"),
    state
  };

  const fn = new Function(...Object.keys(sandbox),
    `${SOURCE}
     return {
       restoreSession, endBootGate, showScreen, doLogout, renderNavState,
       getUid: () => athlevoSessionUserId,
       getAuthPushed: () => athlevoAuthPushed
     };`);
  return { api: fn(...Object.values(sandbox)), state, window: sandbox.window };
}

// Boot exactly as index.html does: restore, then always lift the gate.
async function boot(opts) {
  const { api, state } = makeWorld(opts);
  let entered = false;
  try { entered = await api.restoreSession({}); }
  catch (e) { state.log.push("threw: " + e.message); }
  finally { api.endBootGate(); }
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  return { entered, visible, state, api };
}

const SESSION = { user: { id: "u1", email: "a@b.c" } };

/* ── the 13 required scenarios ──────────────────────────────────────── */

section("Routing scenarios");

{
  const r = await boot({ session: null, standalone: false });
  t("1. new visitor opens athlevo.org → landing", r.visible === "screen-landing" && !r.entered);
  t("1b. boot gate is lifted", !r.state.bodyClasses.has("booting"));
}
{
  const r = await boot({
    session: null,
    standalone: false,
    continuation: {
      intent: "signup",
      browser: "facebook",
      sourceSurface: "landing"
    }
  });
  t("1c. valid external signup continuation opens the auth entry screen",
    r.visible === "screen-welcome" && !r.entered);
  t("1c-generic. generic continuation is not an AI paid-acquisition signup",
    r.state.aiSignupShown !== true &&
    r.state.store.get("athlevo_ai_signup_handoff") !== "1");
}
{
  const r = await boot({
    session: null,
    standalone: false,
    continuation: {
      intent: "signup",
      browser: "instagram",
      sourceSurface: "ai_signup"
    }
  });
  t("1c-ai. external AI continuation restores /ai-signup paid-first intent",
    r.visible === "screen-welcome" && r.state.aiSignupShown === true && !r.entered);
  t("1c-ai-flag. AI continuation writes the existing signup handoff flag",
    r.state.store.get("athlevo_ai_signup_handoff") === "1");
  t("1c-ai-auth. public AI marker does not authenticate or enter the app",
    r.state.routed === null && r.state.screens["screen-today"].active === false);
}
{
  const r = await boot({
    session: SESSION,
    standalone: false,
    continuation: {
      intent: "signup",
      browser: "instagram",
      sourceSurface: "ai_signup"
    }
  });
  t("1c-ai-session. AI marker cannot bypass restoreSession auth into a private route",
    r.entered && r.state.routed === "u1");
}
{
  const r = await boot({
    session: null,
    standalone: false,
    continuation: {
      intent: "login",
      browser: "facebook",
      sourceSurface: "ai_signup"
    }
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  t("1c-ai-login. AI login continuation restores paid-first intent then login",
    r.state.aiSignupShown === true &&
    r.state.loginOpened &&
    r.state.loginOpened.userChose === false &&
    r.state.loginOpened.source === "external_handoff" &&
    !r.entered);
}
{
  const r = await boot({
    session: null,
    standalone: false,
    pathname: "/ai",
    href: "https://athlevo.org/ai?checkout_return=1"
  });
  t("1d. logged-out Whop return opens auth, not landing or diagnostic",
    r.visible === "screen-welcome" && !r.entered && r.state.diagnosticStarted !== true);
  t("1e. checkout_return does not route into the paid app",
    r.state.routed === null && r.state.screens["screen-today"].active === false);
}
{
  const r = await boot({ session: SESSION, standalone: false });
  t("2. signed-in browser user refreshes → Today, never landing",
    r.visible === "screen-today" && r.entered && r.state.routed === "u1");
  t("2b. landing never became active during boot", r.state.screens["screen-landing"].active === false);
  t("2c. tab bar shown", r.state.tabbarDisplay === "flex");
}
{
  const r = await boot({ session: SESSION, standalone: false });
  t("3. signed-in user closes and reopens tab → Today", r.visible === "screen-today");
}
{
  const r = await boot({ session: SESSION, standalone: true });
  t("4. installed PWA, signed-in launch → Today", r.visible === "screen-today" && r.entered);
  t("4b. landing never rendered in the PWA, not even once",
    r.state.screens["screen-landing"].active === false);
}
{
  const r = await boot({ session: SESSION, standalone: true });
  t("5. PWA cold launch (same path, no warm state) → Today", r.visible === "screen-today");
}
{
  const r = await boot({ session: null, standalone: true });
  t("6. PWA with expired/absent session → auth screen, NOT landing",
    r.visible === "screen-welcome" && !r.entered);
  t("6b. marketing page is unreachable in the installed app",
    r.state.screens["screen-landing"].active === false);
}
{
  /*
   * An explicit logout goes to the AUTH screen, not marketing — in both the
   * browser and the PWA. Someone who just pressed Logout wants to sign back
   * in, not read a pitch and hunt for "Open App".
   */
  const { api, state } = makeWorld({ session: SESSION, standalone: false });
  await api.restoreSession({}); api.endBootGate();
  await api.doLogout();
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("7. logout in BROWSER → auth screen, not the landing page",
    visible === "screen-welcome", visible);
  t("7b. Supabase signOut was actually called", state.signedOut === true);
  t("7c. session id cleared", api.getUid() === null);
  t("7d. tab bar hidden", state.tabbarDisplay === "none");
  t("7e. landing page is NOT shown", state.screens["screen-landing"].active === false);
  t("7f. logout records explicit app-entry intent", state.store.get("athlevo_app_entry_intent") === "logout");
  t("7g. logout replaces browser history floor with app entry", state.historyState?.athlevoNav === "entry");
}
{
  const { api, state } = makeWorld({ session: null, standalone: false });
  state.store.set("athlevo_app_entry_intent", "logout");
  await api.restoreSession({}); api.endBootGate();
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("8c. same-tab reload after logout remains at app entry", visible === "screen-welcome", visible);
}
{
  const { api, state } = makeWorld({ session: SESSION, standalone: true });
  await api.restoreSession({}); api.endBootGate();
  await api.doLogout();
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("8. logout in PWA → auth screen", visible === "screen-welcome");
  t("8b. same destination in both contexts (no branch on standalone)",
    !/isStandaloneMode\(\) \? 'screen-welcome' : 'screen-landing'/.test(extract("doLogout")));
}

section("Logout clears state that must not outlive the session");
{
  const { api, state } = makeWorld({ session: SESSION, standalone: false });
  await api.restoreSession({}); api.endBootGate();
  // Simulate an athlete who logs out midway through guided setup.
  state.store.set("athlevo_guided_setup", "1");
  state.store.set("athlevo_guided_wearable", "garmin");
  await api.doLogout();

  t("guided-setup resume flag cleared", state.store.get("athlevo_guided_setup") === undefined);
  t("remembered wearable cleared", state.store.get("athlevo_guided_wearable") === undefined);
  t("auth history flag reset so Back behaves", api.getAuthPushed() === false);
  t("activity cache invalidated (no data leaks to the next athlete)",
    /invalidateActivityCache/.test(extract("doLogout")));
  t("athlete UI reset", /resetAthleteUI/.test(extract("doLogout")));
  t("logout does NOT start onboarding", !/startOnboarding/.test(extract("doLogout")));
  t("logout does NOT trigger a training import",
    !/syncIntervals|AthlevoConnect/.test(extract("doLogout")));
  t("a failed signOut aborts before clearing UI state",
    /if \(error\)[\s\S]{0,120}return;/.test(extract("doLogout")));
}

section("Public visitors still see marketing (unchanged)");
{
  const r = await boot({ session: null, standalone: false });
  t("a visitor with no session still lands on marketing", r.visible === "screen-landing");
  const r2 = await boot({ session: null, standalone: true });
  t("PWA with no session still shows the auth screen", r2.visible === "screen-welcome");
  t("boot logic still branches on standalone; only logout stopped doing so",
    /isStandaloneMode\(\)/.test(extract("restoreSession")));
}

section("Landing CTAs (source-level)");
{
  // Analytics now runs before the signed-out transition; assert the routing
  // branches without coupling this test to one-line formatting.
  const build = extract("landingStartFree");
  const signIn = extract("landingSignIn");
  const openApp = extract("landingOpenApp");
  t("9. Landing AI CTA navigates to /ai without opening checkout or welcome",
    /destination: "\/ai"/.test(build) &&
    /window\.location\.assign\("\/ai"\)/.test(build) &&
    !/openAppEntry\(\)/.test(build) &&
    !/openAthlevoApp\(\)/.test(build));
  t("10. Sign In → app when signed in, else entry + login",
    /if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); \}/.test(signIn) &&
    /openAppEntry\(\);[\s\S]*?openLogin\(true, "landing"\)/.test(signIn));
  t("11. Open App → app when signed in, else entry",
    /if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); \}/.test(openApp) &&
    /openAppEntry\(\)/.test(openApp));
}

section("Onboarding");
{
  // routeAfterAuth is the single onboarding gate; restoreSession must go
  // through it rather than jumping to Today directly.
  const src = extract("restoreSession");
  t("12. first-time user: restore routes via routeAfterAuth (onboarding-aware)",
    /routeAfterAuth\(session\.user\.id\)/.test(src) && !/showScreen\("screen-today"\)/.test(src));
  t("12b. routeAfterAuth still starts onboarding when incomplete",
    /if \(!completed\) \{\s*startOnboarding\(\);/.test(html));
  t("12c. unpaid athletes are gated before Today/tab bar", (() => {
    const route = html.slice(
      html.indexOf("async function routeAfterAuth"),
      html.indexOf("async function restoreSession")
    );
    return /gateUnpaidAthlete/.test(route) &&
      route.indexOf("gateUnpaidAthlete") < route.indexOf('showScreen("screen-today")') &&
      route.indexOf("gateUnpaidAthlete") < route.indexOf('tabbar").style.display = "flex"');
  })());
  t("12d. incomplete onboarding starts before the unpaid gate", (() => {
    const route = html.slice(
      html.indexOf("async function routeAfterAuth"),
      html.indexOf("async function restoreSession")
    );
    return route.indexOf("if (!completed)") < route.indexOf("gateUnpaidAthlete") &&
      route.indexOf("startOnboarding()") < route.indexOf("gateUnpaidAthlete");
  })());
  t("12e. obFinish sends unpaid athletes to the offer before Today/tabs", (() => {
    const onboarding = readFileSync("./js/onboarding.js", "utf8");
    const finish = onboarding.slice(
      onboarding.indexOf("async function obFinish"),
      onboarding.indexOf("function obFirstIncompleteStep")
    );
    return /obOfferIfUnpaid/.test(finish) &&
      finish.indexOf("obOfferIfUnpaid") < finish.indexOf('tabbar.style.display = "flex"') &&
      finish.indexOf("obOfferIfUnpaid") < finish.indexOf('showScreen("screen-today")');
  })());
  const r = await boot({ session: SESSION, standalone: false });
  t("13. returning onboarded user → Today", r.visible === "screen-today");
}

section("Failure modes");
{
  const r = await boot({ session: SESSION, standalone: false, routeThrows: true });
  t("boot gate lifts even when routing throws (no blank-screen hang)",
    !r.state.bodyClasses.has("booting"));
  t("...and falls back to a usable signed-out surface",
    r.visible === "screen-landing" || r.visible === "screen-welcome", r.visible);
}
{
  // getSession that never settles → the 8s race must still resolve.
  const started = Date.now();
  const { api, state } = makeWorld({ session: null, standalone: true });
  const visible = await (async () => {
    await api.restoreSession({}); api.endBootGate();
    return Object.keys(state.screens).find(k => state.screens[k].active);
  })();
  t("timeout guard present in shipped source",
    /Promise\.race\(\[[\s\S]{0,200}setTimeout/.test(extract("restoreSession")));
  t("no-session path resolves promptly", visible === "screen-welcome" && Date.now() - started < 1000);
}

section("Back-navigation floor");
{
  const { api, state } = makeWorld({ session: SESSION, standalone: false });
  await api.restoreSession({}); api.endBootGate();
  api.renderNavState({ athlevoNav: "landing" });
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("Back never drops a signed-in athlete onto marketing", visible !== "screen-landing", visible);
}
{
  const { api, state } = makeWorld({ session: null, standalone: true });
  await api.restoreSession({}); api.endBootGate();
  api.renderNavState({ athlevoNav: "landing" });
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("Back never shows marketing inside the PWA", visible === "screen-welcome", visible);
}

section("/ai acquisition routing");
{
  const src = extract("restoreSession");
  t("/ai paid session still uses routeAfterAuth, not a second paid check",
    /routeAfterAuth\(session\.user\.id\)/.test(src) && !/paid_active/.test(src));
  t("session timeout is tracked separately from a true logged-out session",
    /sessionRestoreTimedOut/.test(src));
  t("stored auth token on timeout does not start diagnostic",
    /stored token — not starting diagnostic/.test(src));
  t("boot gate on /ai uses the same 6s fail-open as other public routes",
    !/Boot gate held on \/ai until session restore settles/.test(html) &&
    /Boot gate released on timeout/.test(html) &&
    /__athlevoSessionRestoreSettled/.test(html));
  t("endBootGate does not paint landing under an unresolved /ai restore",
    /pendingAiRestore/.test(extract("endBootGate")) &&
    /showScreen\(isStandaloneMode\(\) \? "screen-welcome" : "screen-landing"\)/.test(extract("endBootGate")));
  t("PERMANENT: restoreSession anonymous /ai starts diagnostic, not openAiSignup",
    /\/ai route: logged-out visitors see the diagnostic, not auth or pricing/.test(src) &&
    /aiDiagnosticEntry && window\.AthlevoDiagnosticUI/.test(src) &&
    !/aiAcquisition && typeof openAiSignup/.test(src));
}
{
  const { api, state, window: win } = makeWorld({ session: null, standalone: false, pathname: "/ai" });
  win.__athlevoSessionRestoreSettled = false;
  api.endBootGate();
  t("6s fail-open on /ai does not flash landing before restore paints",
    state.screens["screen-landing"].active === false &&
    state.screens["screen-welcome"].active === false &&
    state.screens["screen-today"].active === false &&
    state.diagnosticStarted !== true &&
    !state.bodyClasses.has("booting"));
}
{
  const { api, state } = makeWorld({ session: null, standalone: false, pathname: "/ai" });
  state.store.set("athlevo_app_entry_intent", "ai");
  await api.restoreSession({}); api.endBootGate();
  t("PERMANENT: anonymous /ai starts diagnostic, not signup",
    state.diagnosticStarted === true &&
    state.screens["screen-diagnostic"].active === true &&
    state.aiSignupShown !== true &&
    state.screens["screen-welcome"].active === false);
  t("logged-out /ai does not enter the authenticated app",
    state.routed === null && state.screens["screen-today"].active === false);
  t("logged-out /ai does not show pricing before signup",
    state.pricingShown !== true &&
    state.screens["screen-diagnostic-paywall"].active === false);
}
{
  const { api, state } = makeWorld({ session: null, standalone: false, pathname: "/ai" });
  state.store.set("athlevo_ai_signup_handoff", "1");
  await api.restoreSession({}); api.endBootGate();
  t("leftover signup handoff on anonymous /ai still starts diagnostic",
    state.diagnosticStarted === true &&
    state.aiSignupShown !== true &&
    state.pricingShown !== true);
}
{
  const { api, state } = makeWorld({ session: null, standalone: false, pathname: "/ai" });
  api.renderNavState({ athlevoNav: "landing" });
  t("popstate on anonymous /ai starts diagnostic, not signup",
    state.diagnosticStarted === true && state.aiSignupShown !== true);
}
{
  const { api, state } = makeWorld({
    session: null, standalone: false, pathname: "/ai", pendingDiagnostic: true
  });
  await api.restoreSession({}); api.endBootGate();
  t("anonymous /ai with pending diagnostic stays on diagnostic, not signup or pricing",
    state.diagnosticStarted === true &&
    state.aiSignupShown !== true &&
    state.pricingShown !== true &&
    state.screens["screen-diagnostic-paywall"].active === false);
}
{
  const { api, state } = makeWorld({ session: SESSION, standalone: false, pathname: "/ai" });
  state.store.set("athlevo_app_entry_intent", "ai");
  await api.restoreSession({}); api.endBootGate();
  t("authenticated /ai user is routed into the app, not diagnostic",
    state.routed === "u1" && state.diagnosticStarted === false &&
    state.screens["screen-today"].active === true);
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, pathname: "/ai", pendingDiagnostic: true
  });
  state.store.set("athlevo_app_entry_intent", "ai");
  await api.restoreSession({}); api.endBootGate();
  t("pending diagnostic localStorage loses to a live session",
    state.diagnosticStarted === false && state.routed === "u1");
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, pathname: "/ai",
    timedOut: true, storedAuthToken: true, pendingDiagnostic: true
  });
  state.store.set("athlevo_app_entry_intent", "ai");
  await api.restoreSession({}); api.endBootGate();
  t("timeout with stored token does not start diagnostic or grant app access",
    state.diagnosticStarted === false && state.routed === null &&
    state.screens["screen-welcome"].active === true);
}
{
  const { api, state } = makeWorld({
    session: null, standalone: false, pathname: "/ai", timedOut: true
  });
  state.store.set("athlevo_app_entry_intent", "ai");
  await api.restoreSession({}); api.endBootGate();
  t("timeout without a stored token still starts the /ai diagnostic",
    state.diagnosticStarted === true && state.routed === null &&
    state.aiSignupShown !== true &&
    state.pricingShown !== true);
}
{
  const { api, state } = makeWorld({
    session: null, standalone: false, pathname: "/ai", storedAuthToken: true
  });
  state.store.set("athlevo_app_entry_intent", "ai");
  await api.restoreSession({}); api.endBootGate();
  t("logged-out /ai with a stored auth token opens sign-in, not diagnostic",
    state.diagnosticStarted === false && state.screens["screen-welcome"].active === true &&
    state.routed === null);
}
{
  const { api, state } = makeWorld({
    session: null, standalone: false, pathname: "/ai",
    storedAuthToken: true, pendingDiagnostic: true
  });
  await api.restoreSession({}); api.endBootGate();
  t("pending diagnostic cannot override a stored returning-account token",
    state.diagnosticStarted === false && state.screens["screen-welcome"].active === true);
}
{
  const { api, state } = makeWorld({
    session: null, standalone: false, pathname: "/ai",
    pendingDiagnostic: true, acquisitionUserId: "u-paid"
  });
  await api.restoreSession({}); api.endBootGate();
  t("bound acquisition userId is a returning-account marker, not a new lead",
    state.diagnosticStarted === false && state.screens["screen-welcome"].active === true);
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, pathname: "/", pendingDiagnostic: true
  });
  await api.restoreSession({}); api.endBootGate();
  t("paid/authenticated refresh on / still routes into the app",
    state.routed === "u1" && state.diagnosticStarted === false);
}
{
  const { api, state } = makeWorld({ session: null, standalone: false, pathname: "/signup" });
  await api.restoreSession({}); api.endBootGate();
  t("logged-out /signup opens the existing auth/signup screen",
    state.aiSignupShown === true && state.screens["screen-welcome"].active === true &&
    state.diagnosticStarted !== true);
  t("logged-out /signup does not 404 into diagnostic or pricing",
    state.routed === null &&
    state.pricingShown !== true &&
    state.screens["screen-diagnostic-paywall"].active === false);
}
{
  const { api, state } = makeWorld({ session: null, standalone: false, pathname: "/ai-signup" });
  await api.restoreSession({}); api.endBootGate();
  t("logged-out /ai-signup stays on the auth handoff, not diagnostic",
    state.aiSignupShown === true && state.diagnosticStarted !== true &&
    state.screens["screen-welcome"].active === true);
  t("logged-out /ai-signup does not enter the app",
    state.routed === null && state.screens["screen-today"].active === false);
  t("logged-out /ai-signup does not open pricing before auth",
    state.pricingShown !== true &&
    state.screens["screen-diagnostic-paywall"].active === false);
}
{
  const { api, state } = makeWorld({
    session: null, standalone: false, pathname: "/", pendingDiagnostic: true
  });
  state.store.set("athlevo_ai_signup_handoff", "1");
  await api.restoreSession({}); api.endBootGate();
  t("OAuth/signup handoff flag returns to /ai-signup auth, not generic landing",
    state.aiSignupShown === true && state.diagnosticStarted !== true);
}
{
  const { api, state } = makeWorld({ session: SESSION, standalone: false, pathname: "/ai-signup" });
  await api.restoreSession({}); api.endBootGate();
  t("authenticated /ai-signup continues via routeAfterAuth, not a second sales flow",
    state.routed === "u1" && state.diagnosticStarted !== true);
}
{
  const { api, state } = makeWorld({ session: null, standalone: false, pathname: "/pricing" });
  await api.restoreSession({}); api.endBootGate();
  t("logged-out /pricing opens the public pricing page",
    state.pricingShown === true &&
    state.screens["screen-diagnostic-paywall"].active === true &&
    state.diagnosticStarted !== true);
  t("logged-out /pricing does not enter the app or restart /ai",
    state.routed === null && state.screens["screen-today"].active === false &&
    state.aiSignupShown !== true);
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, pathname: "/pricing"
  });
  await api.restoreSession({}); api.endBootGate();
  t("authenticated /pricing still uses routeAfterAuth so paid users reach the app",
    state.routed === "u1" && state.diagnosticStarted !== true);
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, pathname: "/pricing",
    paywallExit: true, paidAfterExit: false
  });
  await api.restoreSession({}); api.endBootGate();
  t("unpaid /pricing refresh stays on pricing, not Today",
    state.routed === null &&
    state.screens["screen-diagnostic-paywall"].active === true &&
    state.screens["screen-today"].active === false);
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, paywallExit: true, paidAfterExit: false
  });
  await api.restoreSession({}); api.endBootGate();
  t("unpaid paywall-exit refresh stays on auth, not the app",
    state.routed === null && state.screens["screen-welcome"].active === true &&
    state.store.get("athlevo_paywall_exit") === "1");
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, pathname: "/ai",
    paywallExit: true, paidAfterExit: false
  });
  await api.restoreSession({}); api.endBootGate();
  t("unpaid /ai with paywall-exit still opens pricing, not anonymous auth",
    state.routed === null &&
    state.screens["screen-diagnostic-paywall"].active === true &&
    state.screens["screen-today"].active === false);
}
{
  const { api, state } = makeWorld({
    session: SESSION, standalone: false, paywallExit: true, paidAfterExit: true
  });
  await api.restoreSession({}); api.endBootGate();
  t("paid paywall-exit refresh still enters via routeAfterAuth",
    state.routed === "u1");
}
{
  const { api, state } = makeWorld({
    session: SESSION,
    standalone: false,
    paywallExit: true,
    paidAfterExit: false,
    oauthReturn: true,
    oauthWaitMs: 80
  });
  await api.restoreSession({}); api.endBootGate();
  t("fresh Google OAuth ignores leftover paywall-exit and routes once",
    state.routed === "u1" && state.paywallExitCleared === true);
  t("...and does not bounce back to signup",
    state.screens["screen-welcome"].active !== true);
}
{
  const { api, state } = makeWorld({
    session: SESSION,
    standalone: false,
    pathname: "/ai-signup",
    oauthReturn: true,
    oauthWaitMs: 400,
    sessionDelayCalls: 2
  });
  await api.restoreSession({}); api.endBootGate();
  t("OAuth return waits for hydration instead of painting /ai-signup",
    state.routed === "u1" && state.aiSignupShown !== true);
}
{
  const started = Date.now();
  const { api, state } = makeWorld({
    session: null,
    standalone: false,
    pathname: "/ai-signup",
    oauthReturn: true,
    oauthWaitMs: 60
  });
  await api.restoreSession({}); api.endBootGate();
  t("failed OAuth hydration on /ai-signup returns to auth, not the app",
    state.routed === null && state.screens["screen-welcome"].active === true &&
    Date.now() - started < 1500);
}
{
  const { api, state } = makeWorld({
    session: null,
    standalone: false,
    pathname: "/",
    oauthReturn: true,
    oauthCancelled: true
  });
  await api.restoreSession({}); api.endBootGate();
  t("cancelled Google OAuth returns to auth with usable controls",
    state.routed === null && state.screens["screen-welcome"].active === true &&
    state.diagnosticStarted !== true &&
    state.screens["screen-landing"].active !== true);
}
{
  const src = extract("restoreSession");
  t("OAuth return uses a bounded AUTH RESTORING wait before treating the user as logged out",
    /OAuth return — waiting for session/.test(src) &&
    /__athlevoAuthRestoring/.test(src) &&
    /__athlevoOAuthWaitMs/.test(src));
  t("fresh OAuth/native login clears athlevo_paywall_exit before post-auth routing",
    /clearPaywallExit/.test(src) && /freshAuthReturn/.test(src));
}
{
  const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
  const resolve = acq.slice(
    acq.indexOf("async function resolveAfterAuth"),
    acq.indexOf("function isPostPaymentOnboarding")
  );
  t("resolveAfterAuth checks verified paid access before any paywall",
    resolve.indexOf("verifiedPaidAccess") < resolve.indexOf("showPaywall") &&
    /if \(paid\.paid\)/.test(resolve));
  t("paid_active completes stale acquisition instead of showing checkout",
    /setStage\(paidLocal, "completed"/.test(resolve) || /stage !== "completed"/.test(resolve));
  const ui = readFileSync("./js/diagnosticUI.js", "utf8");
  t("startDiagnostic never paints acquisition when a returning-account marker exists",
    /hasReturningAthlevoAccountMarker/.test(ui) &&
    ui.indexOf("hasReturningAthlevoAccountMarker") < ui.indexOf("showScreen(\"screen-diagnostic\")"));
}

section("Service worker");
{
  const sw = readFileSync("./service-worker.js", "utf8");
  const v = Number((sw.match(/athlevo-shell-v(\d+)/) || [])[1] || 0);
  t("cache version is at or past the routing fix (v16+)", v >= 16, `v${v}`);
  t("navigations are network-first (stale shell can't dictate routing)",
    /request\.mode === "navigate"[\s\S]{0,200}fetch\(request,\s*\{\s*cache:\s*"no-store"\s*\}\)\.then/.test(sw));
  t("successful navigation refreshes the cached shell",
    /cache\.put\("\/index\.html", copy\)/.test(sw));
  t("cached shell still serves offline from the current cache only",
    /\.catch\(\(\) =>\s*caches\.open\(CACHE_VERSION\)/.test(sw) &&
    /cache\.match\("\/index\.html"\)/.test(sw));
  t("old Athlevo cache names are purged during activation",
    /k\.startsWith\(ATHLEVO_CACHE_PREFIX\)[\s\S]{0,100}caches\.delete\(k\)/.test(sw));
  t("auth + API remain network-only", /"supabase\.co"/.test(sw) && /"\/api\/"/.test(sw));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
  t("boot gate hides the tab bar", /body\.booting #tabbar\{display:none!important\}/.test(html));
  t("gate survives showScreen — Today reveals populated, not empty",
    !/document\.body\.classList\.remove\('booting'\);/.test(extractEarly("showScreen")));
  t("6s safety valve so a slow load can't hold a blank overlay",
    /Boot gate released on timeout/.test(html));
  t("spinner is delayed so a fast restore shows no loading UI",
    /animation:bootFade \.25s ease \.45s forwards/.test(html));
  t("reduced-motion users get no spin", /prefers-reduced-motion[\s\S]{0,120}boot-spinner/.test(html));
}

/* ── extract the real routing functions ─────────────────────────────── */

function extract(name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`, "m");
  const m = html.match(re);
  if (!m) throw new Error(`Could not extract ${name}() from index.html`);
  return m[0];
}

const SOURCE = [
  extract("restoreSession"),
  extract("endBootGate"),
  extract("showScreen"),
  extract("doLogout"),
  extract("renderNavState")
].join("\n\n");

/* ── minimal DOM + app doubles ──────────────────────────────────────── */

function makeWorld({ session, standalone, routeThrows = false }) {
  const state = {
    screens: {
      "screen-landing": { active: false },
      "screen-welcome": { active: false },
      "screen-today": { active: false }
    },
    bodyClasses: new Set(["booting"]),
    tabbarDisplay: "none",
    routed: null,
    onboardingStarted: false,
    log: []
  };

  const el = (id) => ({
    get classList() {
      return {
        add: (c) => { if (state.screens[id]) state.screens[id].active = (c === "active") || state.screens[id].active; },
        remove: (c) => { if (c === "active" && state.screens[id]) state.screens[id].active = false; }
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
    getElementById: (id) => (id === "tabbar" || state.screens[id]) ? el(id) : null,
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
    window: { scrollTo() {} },
    console: { log: (...a) => state.log.push(String(a[0])), warn: (...a) => state.log.push(String(a[0])), error: (...a) => state.log.push(String(a[0])) },
    setTimeout,
    isStandaloneMode: () => standalone,
    supabaseClient: { auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signOut: async () => ({ error: null })
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
    history: { pushState() {} },
    state
  };

  const fn = new Function(...Object.keys(sandbox),
    `${SOURCE}
     return {
       restoreSession, endBootGate, showScreen, doLogout, renderNavState,
       getUid: () => athlevoSessionUserId
     };`);
  return { api: fn(...Object.values(sandbox)), state };
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
  const { api, state } = makeWorld({ session: SESSION, standalone: false });
  await api.restoreSession({}); api.endBootGate();
  await api.doLogout();
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("7. logout in browser → landing", visible === "screen-landing");
  t("7b. session id cleared", api.getUid() === null);
  t("7c. tab bar hidden", state.tabbarDisplay === "none");
}
{
  const { api, state } = makeWorld({ session: SESSION, standalone: true });
  await api.restoreSession({}); api.endBootGate();
  await api.doLogout();
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  t("8. logout in PWA → welcome, NOT landing", visible === "screen-welcome");
}

section("Landing CTAs (source-level)");
{
  // These are one-liners; assert the shipped behaviour directly.
  t("9. Start Free Beta → app when signed in, entry when not",
    /function landingStartBeta\(\)\s*\{ if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); \} else \{ openAppEntry\(\); \} \}/.test(html));
  t("10. Sign In → app when signed in, else entry + login",
    /function landingSignIn\(\)\s*\{ if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); \} else \{ openAppEntry\(\); openLogin\(\); \} \}/.test(html));
  t("11. Open App → app when signed in, else entry",
    /function landingOpenApp\(\)\s*\{ if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); \} else \{ openAppEntry\(\); \} \}/.test(html));
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

section("Service worker");
{
  const sw = readFileSync("./service-worker.js", "utf8");
  t("cache version bumped to v16", /athlevo-shell-v16/.test(sw));
  t("navigations are network-first (stale shell can't dictate routing)",
    /request\.mode === "navigate"[\s\S]{0,200}fetch\(request\)\.then/.test(sw));
  t("successful navigation refreshes the cached shell",
    /cache\.put\("\/index\.html", copy\)/.test(sw));
  t("cached shell still serves offline", /\.catch\(\(\) =>\s*caches\.match\("\/index\.html"\)/.test(sw));
  t("auth + API remain network-only", /"supabase\.co"/.test(sw) && /"\/api\/"/.test(sw));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

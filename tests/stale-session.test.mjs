/*
 * Athlevo — stale / deleted-user session handling.
 *
 * Proves that a browser retaining a session for a UID that no longer exists
 * in auth.users is detected at boot and cleanly signed out, and that a
 * stale user cannot begin or finalize a provider connection.
 *
 * Run: node tests/stale-session.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const brainSrc = readFileSync("./js/brain.js", "utf8");

/* ── extract restoreSession and helpers from index.html ─────────────── */

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
].join("\n\n");

/* ── extract providerRequest from brain.js ──────────────────────────── */

function extractFromBrain(name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`, "m");
  const m = brainSrc.match(re);
  if (!m) throw new Error(`Could not extract ${name}() from brain.js`);
  return m[0];
}

const PROVIDER_REQUEST_SRC = extractFromBrain("providerRequest");

/* ── world builder ─────────────────────────────────────────────────── */

function makeBootWorld({ session, userExists, getUserThrows = false, standalone = false }) {
  const state = {
    screens: {
      "screen-landing": { active: false },
      "screen-welcome": { active: false },
      "screen-today": { active: false }
    },
    bodyClasses: new Set(["booting"]),
    tabbarDisplay: "none",
    routed: null,
    signedOut: false,
    toasts: [],
    sessionStorageCleared: [],
    log: []
  };
  const store = new Map();

  const el = (id) => ({
    get classList() {
      return {
        add: (c) => {
          if (state.screens[id]) state.screens[id].active = (c === "active") || state.screens[id].active;
        },
        remove: (c) => {
          if (c === "active" && state.screens[id]) state.screens[id].active = false;
        }
      };
    },
    style: {
      set display(v) { if (id === "tabbar") state.tabbarDisplay = v; },
      get display() { return state.tabbarDisplay; }
    }
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

  // Track sessionStorage.removeItem calls.
  const sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => { store.delete(k); state.sessionStorageCleared.push(k); }
  };

  // Supabase double: getSession always returns the session, but getUser
  // either returns the user or an error depending on `userExists`.
  const supabaseClient = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => {
        if (getUserThrows) throw new Error("network failure");
        if (userExists) {
          return { data: { user: session.user }, error: null };
        }
        return { data: { user: null }, error: { message: "User not found" } };
      },
      signOut: async () => { state.signedOut = true; return { error: null }; }
    }
  };

  const sandbox = {
    document,
    window: {
      scrollTo() {},
      __athlevoStaleSessionCleared: false,
      __athlevoOAuthReturn: session && !userExists ? { completion: "tok_abc" } : undefined,
      matchMedia: () => ({ matches: standalone })
    },
    console: {
      log: (...a) => state.log.push(String(a[0])),
      warn: (...a) => state.log.push(String(a[0])),
      error: (...a) => state.log.push(String(a[0]))
    },
    Promise,
    setTimeout,
    supabaseClient,
    athlevoSessionUserId: null,
    sessionStorage,
    isStandaloneMode: () => standalone,
    routeAfterAuth: async (uid) => {
      state.routed = uid;
      state.screens["screen-today"].active = true;
      state.tabbarDisplay = "flex";
    },
    updateOpenAppUI: () => {},
    toast: (msg) => { state.toasts.push(msg); },
    AthlevoBrain: { resetAthleteUI: () => {}, invalidateActivityCache: () => {} },
    history: { pushState() {} },
    state
  };

  const fn = new Function(...Object.keys(sandbox),
    `${SOURCE}
     return {
       restoreSession, endBootGate, showScreen,
       getUid: () => athlevoSessionUserId,
       getStaleFlag: () => window.__athlevoStaleSessionCleared
     };`);
  return { api: fn(...Object.values(sandbox)), state, sandbox };
}

async function boot(opts) {
  const { api, state, sandbox } = makeBootWorld(opts);
  let entered = false;
  try { entered = await api.restoreSession({}); }
  catch (e) { state.log.push("threw: " + e.message); }
  finally { api.endBootGate(); }
  const visible = Object.keys(state.screens).find(k => state.screens[k].active);
  return { entered, visible, state, api, sandbox };
}

const SESSION = { user: { id: "u1", email: "a@b.c" } };

/* ═══════════════════ 1 · valid user stays signed in ═══════════════════ */

section("Valid user remains signed in");

{
  const r = await boot({ session: SESSION, userExists: true });
  t("valid user → routed to Today",
    r.visible === "screen-today" && r.state.routed === "u1");
  t("valid user → athlevoSessionUserId set",
    r.api.getUid() === "u1");
  t("valid user → NOT signed out",
    r.state.signedOut === false);
  t("valid user → stale flag NOT set",
    r.api.getStaleFlag() === false);
  t("valid user → no toast shown",
    r.state.toasts.length === 0);
  t("valid user → boot gate lifted",
    !r.state.bodyClasses.has("booting"));
}

/* ═══════════════════ 2 · deleted user is signed out ═══════════════════ */

section("Deleted / nonexistent user is signed out");

{
  const r = await boot({ session: SESSION, userExists: false });
  t("deleted user → NOT routed to Today",
    r.visible !== "screen-today" && r.state.routed === null);
  t("deleted user → shown welcome (sign-in) screen",
    r.visible === "screen-welcome");
  t("deleted user → signOut() called",
    r.state.signedOut === true);
  t("deleted user → athlevoSessionUserId is null",
    r.api.getUid() === null);
  t("deleted user → stale flag set",
    r.api.getStaleFlag() === true);
  t("deleted user → toast tells user to sign in again",
    r.state.toasts.length === 1 && /session expired/i.test(r.state.toasts[0]));
  t("deleted user → OAuth return snapshot cleared",
    r.state.sessionStorageCleared.includes("athlevo_oauth_return"));
  t("deleted user → guided setup flags cleared",
    r.state.sessionStorageCleared.includes("athlevo_guided_setup") &&
    r.state.sessionStorageCleared.includes("athlevo_guided_wearable"));
  t("deleted user → tab bar hidden",
    r.state.tabbarDisplay === "none");
  t("deleted user → boot gate lifted (never stranded)",
    !r.state.bodyClasses.has("booting"));
  t("deleted user → restoreSession returns false",
    r.entered === false);
}

/* ═══════════════ 3 · network error during validation ════════════════ */

section("Network error during user validation — graceful fallthrough");

{
  const r = await boot({ session: SESSION, userExists: true, getUserThrows: true });
  t("network error → user proceeds to Today (not locked out)",
    r.visible === "screen-today" && r.state.routed === "u1");
  t("network error → NOT signed out",
    r.state.signedOut === false);
}

/* ═══════════ 4 · stale user cannot begin provider connection ═════════ */

section("Stale user cannot begin or finalize provider connection");

{
  /*
   * Build a minimal sandbox for providerRequest. The function needs
   * supabaseClient.auth.getSession (returns a session) and
   * supabaseClient.auth.getUser (returns error for stale user).
   */
  const fetchCalls = [];
  const staleSession = { access_token: "tok_stale", user: { id: "gone" } };

  const prSandbox = {
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: staleSession } }),
        getUser: async () => ({ data: { user: null }, error: { message: "User not found" } })
      }
    },
    fetch: async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, json: async () => ({}) }; },
    window: { __athlevoOAuthStage: null },
    INTERVALS_ENDPOINT: "https://example.com/api?x=1",
    console: { warn() {} }
  };

  // Compile providerRequest in the sandbox.
  const prFn = new Function(...Object.keys(prSandbox),
    `${PROVIDER_REQUEST_SRC}
     return providerRequest;`);
  const providerRequest = prFn(...Object.values(prSandbox));

  // connect action → should throw STALE_SESSION before fetch.
  let connectErr = null;
  try { await providerRequest("connect", {}); } catch (e) { connectErr = e; }
  t("stale user connect → throws STALE_SESSION",
    connectErr && connectErr.code === "STALE_SESSION");
  t("stale user connect → no fetch issued",
    fetchCalls.length === 0);

  // finalize action → same guard.
  let finalizeErr = null;
  try { await providerRequest("finalize", { completion: "tok" }); } catch (e) { finalizeErr = e; }
  t("stale user finalize → throws STALE_SESSION",
    finalizeErr && finalizeErr.code === "STALE_SESSION");
  t("stale user finalize → no fetch issued",
    fetchCalls.length === 0);

  // disconnect action → same guard.
  let disconnectErr = null;
  try { await providerRequest("disconnect", {}); } catch (e) { disconnectErr = e; }
  t("stale user disconnect → throws STALE_SESSION",
    disconnectErr && disconnectErr.code === "STALE_SESSION");
  t("stale user disconnect → no fetch issued",
    fetchCalls.length === 0);
}

/* ═══════ 5 · valid user CAN begin provider connection ═════════════── */

section("Valid user can begin provider connection");

{
  const fetchCalls = [];
  const validSession = { access_token: "tok_valid", user: { id: "u1" } };

  const prSandbox = {
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: validSession } }),
        getUser: async () => ({ data: { user: validSession.user }, error: null })
      }
    },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({ authorizationUrl: "https://intervals.icu/auth" }) };
    },
    window: { __athlevoOAuthStage: null },
    INTERVALS_ENDPOINT: "https://example.com/api?x=1",
    console: { warn() {} }
  };

  const prFn = new Function(...Object.keys(prSandbox),
    `${PROVIDER_REQUEST_SRC}
     return providerRequest;`);
  const providerRequest = prFn(...Object.values(prSandbox));

  let connectErr = null;
  let result = null;
  try { result = await providerRequest("connect", {}); } catch (e) { connectErr = e; }
  t("valid user connect → succeeds (no error)",
    connectErr === null && result !== null);
  t("valid user connect → fetch was called",
    fetchCalls.length === 1);
}

/* ═══════════════════════════════════════════════════════════════════ */

console.log(`\n${"═".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

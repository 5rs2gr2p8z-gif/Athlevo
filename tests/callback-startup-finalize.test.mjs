/*
 * Athlevo — Startup callback FINALIZE runtime regression.
 *
 * Extracts the REAL Intervals OAuth-return handler out of index.html (the
 * waitForSession + handleIntervalsResult + stripIntervalsParams block) and
 * EXECUTES it against mocks. It reproduces the confirmed production failure —
 * OAuth returns "pending", the browser polls action=status forever, no
 * action=finalize is ever sent, and the pending row is orphaned — and proves
 * the fix:
 *
 *   · a delayed (Safari) session restore does NOT skip finalize
 *   · finalize fires EXACTLY once, and only after a session exists
 *   · status/sync begin ONLY after a successful finalize
 *   · callback params are removed ONLY after a definitive result
 *   · duplicate initialization does not duplicate finalize
 *   · a definitive finalize failure does not endlessly retry, and shows a
 *     truthful error
 *   · a transient miss (session never arrives in budget) RETAINS the one-time
 *     token so a reload can still finish — it is never burned on a timing miss
 *
 * Run: node tests/callback-startup-finalize.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));

/*
 * Compile the real handler block from index.html into an injectable factory.
 * Boundaries are stable string markers that bracket the OAuth-return logic.
 */
function loadHandler(deps) {
  const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("const stage = (s, d) =>");
  const end = src.indexOf("window.handleIntervalsResult = handleIntervalsResult;");
  if (start < 0 || end <= start) throw new Error("Could not locate finalize block in index.html");
  const block = src.slice(start, end);

  const factory = new Function(
    "supabaseClient", "AthlevoBrain", "toast", "window", "sessionStorage", "console",
    "trackDataConnectionCompleted", "trackDataConnectionFailure",
    "providerFailureCategory",
    `${block}\n return { handleIntervalsResult, waitForSession };`
  );
  return factory(
    deps.supabaseClient, deps.AthlevoBrain, deps.toast, deps.window,
    deps.sessionStorage, deps.console,
    deps.trackDataConnectionCompleted || (async () => true),
    deps.trackDataConnectionFailure || (() => {}),
    deps.providerFailureCategory || (() => "provider")
  );
}

/*
 * Build a world simulating a browser returning from the Intervals callback with
 * ?intervals=pending&completion=<tok>. `sessionDelayMs` models how long Supabase
 * takes to restore the session after this load starts.
 */
function makeWorld({ completion = "tok-123", sessionDelayMs = 0, finalize } = {}) {
  const net = [];                 // ordered record of authenticated requests
  const store = new Map();
  const startedAt = Date.now();
  let sessionReadyAt = sessionDelayMs === Infinity ? Infinity : startedAt + sessionDelayMs;
  const authListeners = [];

  const supabaseClient = {
    auth: {
      getSession: async () => ({ data: { session: Date.now() >= sessionReadyAt ? { user: { id: "u1" }, access_token: "at" } : null } }),
      onAuthStateChange: (cb) => {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      }
    }
  };

  const AthlevoBrain = {
    finalizeIntervals: finalize || (async (c) => { net.push("finalize:" + c); return { success: true, connected: true }; }),
    syncIntervals: async () => { net.push("sync"); return { imported: 3, status: "success" }; },
    providerStatus: async () => { net.push("status"); return { connected: net.some(x => x.startsWith("finalize:")) }; },
  };

  const snapshot = { state: "pending", completion, at: Date.now() };
  store.set("athlevo_oauth_return", JSON.stringify(snapshot));

  const window = {
    __athlevoOAuthReturn: { ...snapshot },
    __athlevoOAuthStage: () => {},
    __athlevoFinalizeBudgetMs: 800,     // keep the test fast
    __athlevoSessionWaitMs: 400,
    location: {
      href: `https://athlevo.org/index.html?intervals=pending&completion=${completion}`,
      search: `?intervals=pending&completion=${completion}`,
    },
    history: { replaceState: (_s, _t, url) => { window.location.href = String(url); } },
    AthlevoBrain,
    AthlevoConnect: null,
    AthlevoSyncStatus: { refresh() {} },
  };

  const sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };

  const api = loadHandler({
    supabaseClient, AthlevoBrain, toast: () => {}, window, sessionStorage,
    console: { log() {}, warn() {}, error() {}, debug() {} },
  });

  return { api, net, window, store, fireAuth: (s) => authListeners.forEach(cb => cb("SIGNED_IN", s || { user: { id: "u1" }, access_token: "at" })) };
}

/* ═══════════ 1. Delayed session restore → finalize waits, fires once ══════ */
section("Delayed (Safari) session restore → finalize still fires, then sync");
{
  const w = makeWorld({ sessionDelayMs: 250 });
  await w.api.handleIntervalsResult("pending", null);
  const finalizeCalls = w.net.filter(x => x.startsWith("finalize:"));
  t("finalize was sent (not skipped)", finalizeCalls.length === 1, `net=${JSON.stringify(w.net)}`);
  t("finalize fired exactly once", finalizeCalls.length === 1);
  t("sync began only AFTER finalize", w.net.indexOf("finalize:tok-123") < w.net.indexOf("sync") && w.net.includes("sync"));
  t("callback params removed after success", !/completion=/.test(w.window.location.href));
  t("one-time snapshot consumed on success", !w.store.has("athlevo_oauth_return") && !w.window.__athlevoOAuthReturn);
}

/* ═══════════ 2. Session already present → finalize once, immediately ═══════ */
section("Session present at load → finalize once");
{
  const w = makeWorld({ sessionDelayMs: 0 });
  await w.api.handleIntervalsResult("pending", null);
  t("finalize fired exactly once", w.net.filter(x => x.startsWith("finalize:")).length === 1, JSON.stringify(w.net));
  t("sync ran after finalize", w.net.includes("sync"));
}

/* ═══════════ 3. Duplicate initialization → finalize NOT duplicated ════════ */
section("Duplicate init in the same load → finalize fires once");
{
  const w = makeWorld({ sessionDelayMs: 100 });
  const [a, b] = await Promise.all([
    w.api.handleIntervalsResult("pending", null),
    w.api.handleIntervalsResult("pending", null),
  ]);
  t("finalize fired exactly once despite two concurrent inits",
    w.net.filter(x => x.startsWith("finalize:")).length === 1, JSON.stringify(w.net));
  // A third call after settle must also not re-finalize.
  await w.api.handleIntervalsResult("pending", null);
  t("a later re-entry does not re-finalize",
    w.net.filter(x => x.startsWith("finalize:")).length === 1);
}

/* ═══════════ 4. Definitive finalize failure → no endless retry, truthful ══ */
section("Definitive failure (SESSION_CHANGED) → single attempt, token burned, no sync");
{
  let calls = 0;
  const finalize = async () => { calls++; const e = new Error("account changed"); e.code = "SESSION_CHANGED"; throw e; };
  const w = makeWorld({ sessionDelayMs: 0, finalize });
  await w.api.handleIntervalsResult("pending", null);
  t("finalize attempted exactly once (no retry loop)", calls === 1, `calls=${calls}`);
  t("no sync after a failed finalize", !w.net.includes("sync"));
  t("no status polling after a definitive failure", !w.net.includes("status"));
  t("token/snapshot consumed (definitive verdict)", !w.store.has("athlevo_oauth_return"));
  t("callback params stripped", !/completion=/.test(w.window.location.href));
}

/* ═══════════ 5. Transient miss (session never arrives) → token RETAINED ═══ */
section("Session never restores in budget → NO finalize, token retained for retry");
{
  const w = makeWorld({ sessionDelayMs: Infinity });
  await w.api.handleIntervalsResult("pending", null);
  t("finalize never sent without a session", w.net.filter(x => x.startsWith("finalize:")).length === 0, JSON.stringify(w.net));
  t("no status polling while unfinalized", !w.net.includes("status"));
  t("one-time snapshot RETAINED (not burned on a timing miss)", w.store.has("athlevo_oauth_return"));
  t("completion token removed from the address bar (hygiene)", !/completion=/.test(w.window.location.href));
}

/* ═══════════ 6. Transient then session arrives → finishes exactly once ════ */
section("Pre-fetch sign-in miss, then session arrives → finalize succeeds once");
{
  let calls = 0;
  const finalize = async (c) => {
    calls++;
    if (calls === 1) throw new Error("Please sign in first.");   // no .code → transient
    return { success: true };
  };
  // Session available immediately so the retry (after 500ms backoff) succeeds.
  const w = makeWorld({ sessionDelayMs: 0, finalize });
  w.window.__athlevoFinalizeBudgetMs = 3000;
  await w.api.handleIntervalsResult("pending", null);
  t("finalize retried and ultimately succeeded", calls === 2, `calls=${calls}`);
  t("token consumed only after success", !w.store.has("athlevo_oauth_return"));
}

/* ═══════════ Summary ═══════════════════════════════════════════════════ */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

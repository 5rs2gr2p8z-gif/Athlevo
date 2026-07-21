/*
 * Athlevo — secure two-step OAuth completion.
 *
 * Drives the REAL api/providers/index.js handler through connect → callback →
 * finalize against an in-memory PostgREST double, and asserts the product rule
 * that motivated the refactor:
 *
 *   An Intervals connection is NEVER saved to, moved to, or relinked between
 *   Athlevo accounts. Only the account that started the flow can finish it.
 *
 * Run: node tests/oauth-persistence.test.mjs
 */

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.INTERVALS_CLIENT_ID = "cid";
process.env.INTERVALS_CLIENT_SECRET = "sec";
process.env.OAUTH_STATE_SECRET = "state-secret";
process.env.APP_URL = "https://app.test";

const handler = (await import("../api/providers/index.js")).default;

let p = 0, f = 0;
const real = console.log;
const t = (n, c, e) => { c ? (p++, real("PASS — " + n))
  : (f++, real("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => real(`\n──── ${s} ────`);

const TOKEN = "tok-SUPER-SECRET-do-not-leak";

/* ── PostgREST double ────────────────────────────────────────────────── */

function world({ accounts = [], meUser = "A", writeStatus = 201, tokenStatus = 200 } = {}) {
  const db = { accounts: [...accounts], pending: [] };

  globalThis.fetch = async (u, i = {}) => {
    const s = String(u), m = (i.method || "GET").toUpperCase();
    const J = (c, b, h = {}) => ({ ok: c >= 200 && c < 300, status: c,
      headers: { get: k => h[k.toLowerCase()] ?? null },
      json: async () => b, text: async () => JSON.stringify(b) });

    if (s.includes("/auth/v1/user")) {
      const who = String((i.headers && i.headers.Authorization) || "").replace("Bearer ", "");
      return who === "none" ? J(401, {}) : J(200, { id: who || meUser });
    }
    if (s.includes("intervals.icu/api/oauth/token")) {
      if (tokenStatus !== 200) return J(tokenStatus, { error: "bad" });
      return J(200, { access_token: TOKEN, athlete: { id: "i123" }, scope: "ACTIVITY:READ" });
    }

    if (s.includes("/rest/v1/pending_provider_connections")) {
      if (m === "POST") { db.pending.push(JSON.parse(i.body)[0]); return J(201, {}); }
      if (m === "DELETE") return J(204, {});
      if (m === "PATCH") {
        // Emulate PostgREST filters: token_hash=eq.X AND consumed_at=is.null.
        const hash = decodeURIComponent((s.match(/token_hash=eq\.([^&]+)/) || [])[1] || "");
        const wantsUnconsumed = s.includes("consumed_at=is.null");
        const row = db.pending.find(r => r.token_hash === hash && (!wantsUnconsumed || !r.consumed_at));
        if (!row) return J(200, []);          // no match → single use enforced
        Object.assign(row, JSON.parse(i.body));
        return J(200, [row]);
      }
      return J(200, db.pending);
    }

    if (s.includes("/rest/v1/provider_accounts")) {
      if (m === "POST") {
        if (writeStatus >= 300) return J(writeStatus, { code: "42P10", details: TOKEN });
        const row = JSON.parse(i.body)[0];
        const idx = db.accounts.findIndex(a => a.user_id === row.user_id && a.provider === row.provider);
        if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...row }; else db.accounts.push(row);
        return J(201, {});
      }
      if (s.includes("provider_athlete_id=eq.")) {
        const aid = decodeURIComponent((s.match(/provider_athlete_id=eq\.([^&]+)/) || [])[1] || "");
        return J(200, db.accounts.filter(a => a.provider_athlete_id === aid).map(a => ({ user_id: a.user_id })));
      }
      const uid = decodeURIComponent((s.match(/user_id=eq\.([^&]+)/) || [])[1] || "");
      return J(200, db.accounts.filter(a => a.user_id === uid));
    }
    return J(200, []);
  };
  return { db };
}

const res = () => { const r = { code: null, body: null, hdrs: {} };
  r.status = c => (r.code = c, r); r.json = b => (r.body = b, r);
  r.setHeader = (k, v) => { r.hdrs[k] = v; }; r.end = () => r; return r; };

const call = async (q, { as = "A", body = {}, method } = {}) => {
  const r = res();
  await handler({
    method: method || (q.action === "callback" ? "GET" : "POST"),
    headers: as === null ? {} : { authorization: `Bearer ${as}` },
    query: q, body
  }, r);
  return r;
};

/* Capture structured logs so we can prove no credential ever reaches them. */
const logs = [];
console.log = (...a) => { const s = String(a[0] ?? "");
  if (s.startsWith("{")) { logs.push(s); return; } real(...a); };

// Runs connect → callback, returning the opaque completion token.
async function startAndCallback(starter = "A") {
  const c = await call({ provider: "intervals", action: "connect" }, { as: starter });
  const state = new URL(c.body.authorizationUrl).searchParams.get("state");
  const cb = await call({ provider: "intervals", action: "callback", code: "authcode", state }, { as: null });
  const loc = String(cb.hdrs.Location || "");
  return { cb, loc, completion: new URL(loc).searchParams.get("completion") };
}

/* ══════ 1. A starts, A returns → saved under A ══════════════════════ */

section("1. Same account throughout");
{
  const w = world({ meUser: "A" });
  const { loc, completion } = await startAndCallback("A");
  t("the callback saves NOTHING to provider_accounts", w.db.accounts.length === 0);
  t("it parks an encrypted pending connection instead", w.db.pending.length === 1);
  t("the redirect says pending, not connected", loc.includes("intervals=pending"));
  t("a completion token is issued", Boolean(completion) && completion.length >= 40);

  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });
  t("finalize succeeds", fin.code === 200 && fin.body.success === true, `${fin.code} ${JSON.stringify(fin.body)}`);
  t("the row is written under A", w.db.accounts.length === 1 && w.db.accounts[0].user_id === "A");
  t("the real provider token was stored", w.db.accounts[0].access_token === TOKEN);
  t("status now reads connected",
    (await call({ provider: "intervals", action: "status" }, { as: "A" })).body.connected === true);
}

/* ══════ 2. A starts, B returns → rejected, NO row anywhere ══════════ */

section("2. Session changed mid-flow — the bug this refactor exists for");
{
  const w = world({ meUser: "A" });
  const { completion } = await startAndCallback("A");

  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "B", body: { completion } });
  t("finalize is REJECTED", fin.code === 409);
  t("...with SESSION_CHANGED", fin.body.code === "SESSION_CHANGED");
  t("...and the athlete is told to restart from the right account",
    /restart the connection from the account you want to use/i.test(fin.body.error));
  t("NO row written for B", !w.db.accounts.some(a => a.user_id === "B"));
  t("NO row written for A either — ownership was not transferred",
    !w.db.accounts.some(a => a.user_id === "A"));
  t("the database is completely untouched", w.db.accounts.length === 0);
  t("the pending connection was invalidated", Boolean(w.db.pending[0].consumed_at));

  const retry = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });
  t("even the correct account cannot reuse the burned token", retry.code === 400);
}

/* ══════ 3. single use ═══════════════════════════════════════════════ */

section("3. Completion tokens are single-use");
{
  const w = world({ meUser: "A" });
  const { completion } = await startAndCallback("A");
  const first = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });
  const second = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });
  t("first use succeeds", first.code === 200);
  t("second use is rejected", second.code === 400 && second.body.code === "COMPLETION_INVALID");
  t("no duplicate row was created", w.db.accounts.length === 1);
}

/* ══════ 4. expiry ═══════════════════════════════════════════════════ */

section("4. Expired completions are rejected");
{
  const w = world({ meUser: "A" });
  const { completion } = await startAndCallback("A");
  w.db.pending[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });
  t("rejected as expired", fin.body.code === "COMPLETION_EXPIRED", JSON.stringify(fin.body));
  t("no row written", w.db.accounts.length === 0);
  t("the message tells them to connect again", /connect again/i.test(fin.body.error));
}

/* ══════ 5. tampering ════════════════════════════════════════════════ */

section("5. Tampered / forged completion tokens are rejected");
{
  const w = world({ meUser: "A" });
  const { completion } = await startAndCallback("A");

  for (const [label, bad] of [
    ["a flipped character", completion.slice(0, -1) + (completion.slice(-1) === "a" ? "b" : "a")],
    ["a truncated token", completion.slice(0, 20)],
    ["an invented token", "totally-made-up-value-aaaaaaaaaaaaaaaaaaaaaa"]
  ]) {
    const r = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion: bad } });
    t(`${label} is rejected`, r.code === 400 && r.body.code === "COMPLETION_INVALID");
  }
  t("no row written by any forgery", w.db.accounts.length === 0);
  t("the genuine token still works afterwards",
    (await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } })).code === 200);

  // A forged token must not reveal whether it ever existed.
  const forged = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion: "nope-nope" } });
  const used = await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });
  t("a forged token is indistinguishable from a used one", forged.body.code === used.body.code);
}

/* ══════ 6. ownership guard ══════════════════════════════════════════ */

section("6. An Intervals athlete already owned elsewhere stays blocked");
{
  const w = world({ meUser: "B",
    accounts: [{ user_id: "OWNER", provider: "intervals", provider_athlete_id: "i123", access_token: "x" }] });
  const c = await call({ provider: "intervals", action: "connect" }, { as: "B" });
  const state = new URL(c.body.authorizationUrl).searchParams.get("state");
  const cb = await call({ provider: "intervals", action: "callback", code: "a", state }, { as: null });
  t("blocked at the callback, before anything is parked",
    String(cb.hdrs.Location || "").includes("reason=already_linked"));
  t("no pending connection created", w.db.pending.length === 0);
  t("the original owner still owns it", w.db.accounts.length === 1 && w.db.accounts[0].user_id === "OWNER");
}

section("6b. Ownership taken DURING the flow is caught at finalize");
{
  const w = world({ meUser: "B" });
  const { completion } = await startAndCallback("B");
  // Someone else claims the athlete while B is still finishing.
  w.db.accounts.push({ user_id: "OWNER", provider: "intervals", provider_athlete_id: "i123", access_token: "x" });
  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "B", body: { completion } });
  t("finalize re-checks ownership and refuses", fin.code === 409 && fin.body.code === "ALREADY_LINKED");
  t("ownership was NOT transferred",
    w.db.accounts.filter(a => a.provider_athlete_id === "i123").length === 1);
}

/* ══════ 7. no credential ever leaks ═════════════════════════════════ */

section("7. Provider tokens never reach URLs or logs");
{
  logs.length = 0;
  const w = world({ meUser: "A" });
  const { loc, completion } = await startAndCallback("A");
  await call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } });

  t("the access token is not in the redirect URL", !loc.includes(TOKEN));
  t("no athlete id in the redirect URL", !loc.includes("i123"));
  t("the ONLY params are the state and the opaque token",
    [...new URL(loc).searchParams.keys()].every(k => ["intervals", "completion"].includes(k)),
    [...new URL(loc).searchParams.keys()].join(","));
  t("the access token appears in NO log line", !logs.join("\n").includes(TOKEN));
  t("the completion token appears in no log line", !logs.join("\n").includes(completion));
  t("logs still record the outcome", logs.some(l => l.includes("intervals_finalize_success")));

  const parked = w.db.pending[0].payload_encrypted;
  t("the parked credential is encrypted at rest", !String(parked).includes(TOKEN));
  t("...as iv.tag.ciphertext", String(parked).split(".").length === 3);
  t("the raw completion token is NOT stored — only its hash",
    w.db.pending[0].token_hash !== completion && /^[0-9a-f]{64}$/.test(w.db.pending[0].token_hash));
}

/* ══════ 8. unauthenticated finalize ═════════════════════════════════ */

section("8. Finalize requires authentication");
{
  const w = world({ meUser: "A" });
  const { completion } = await startAndCallback("A");

  const anon = await call({ provider: "intervals", action: "finalize" }, { as: "none", body: { completion } });
  t("rejected with 401", anon.code === 401 && anon.body.code === "UNAUTHENTICATED");
  t("no row written", w.db.accounts.length === 0);
  t("the pending connection was NOT consumed by the anonymous attempt", !w.db.pending[0].consumed_at);

  // A client-supplied user_id must be ignored entirely.
  const spoof = await call({ provider: "intervals", action: "finalize" },
    { as: "B", body: { completion, user_id: "A", userId: "A" } });
  t("a client-supplied user_id is ignored", spoof.body.code === "SESSION_CHANGED");
  t("...and grants nothing", w.db.accounts.length === 0);
}

/* ══════ 9 & 10. what the client does next ═══════════════════════════ */

section("9/10. The client finalizes BEFORE detection, and routes failure truthfully");
{
  const { readFileSync } = await import("node:fs");
  const html = readFileSync("./index.html", "utf8");
  const conn = readFileSync("./js/onboardingConnect.js", "utf8");
  const brain = readFileSync("./js/brain.js", "utf8");

  t("the client has a finalize call", /async function finalizeIntervals/.test(brain));
  t("...that posts to the finalize action", /providerRequest\("finalize", \{ completion \}\)/.test(brain));
  t("...and is exported", /\n  finalizeIntervals,/.test(brain));

  const pending = html.slice(html.indexOf('if (state === "pending")'),
                             html.indexOf('if (state === "connected")'));
  t("the return handler detects the pending state", pending.length > 0);
  t("it finalizes with the current session", /AthlevoBrain\.finalizeIntervals\(completion\)/.test(pending));
  t("detection only runs AFTER finalization succeeds",
    /if \(outcome\.ok\) return handleIntervalsResult\("connected"/.test(pending));
  t("a failed finalization never reaches detection",
    pending.indexOf("showConnectFailure") > pending.indexOf("if (outcome.ok)"));
  t("the completion token is stripped from the URL immediately",
    /stripIntervalsParams\(\);/.test(pending) &&
    /"completion"\]\.forEach\(k => url\.searchParams\.delete\(k\)\)/.test(html));

  t("SESSION_CHANGED has its own truthful screen", /reason === "SESSION_CHANGED"/.test(conn));
  t("...with the exact required copy",
    /Your Athlevo account changed while connecting your training data\./.test(conn) &&
    /please restart the connection from the account you/.test(conn));
  t("...and a Restart connection action", /Restart connection/.test(conn));
  t("expired and already-used completions are routed",
    /COMPLETION_EXPIRED/.test(conn) && /COMPLETION_INVALID/.test(conn));
  t("the already-linked state is preserved", /ALREADY_LINKED|already_linked/.test(conn));
  t("the athlete NEVER sees 'no workouts' on a failed finalize",
    !/no workouts/i.test(conn.slice(conn.indexOf('reason === "SESSION_CHANGED"'),
                                    conn.indexOf('already_linked'))));
}

/* ══════ 11. existing connections keep working ═══════════════════════ */

section("11. Existing working connections remain readable");
{
  const w = world({ meUser: "LEGACY",
    accounts: [{ user_id: "LEGACY", provider: "intervals", provider_athlete_id: "i999",
                 access_token: "legacy-token", status: "connected" }] });
  const st = await call({ provider: "intervals", action: "status" }, { as: "LEGACY" });
  t("an account connected before this change still reads connected", st.body.connected === true);
  t("...and its row was not migrated or rewritten", w.db.accounts.length === 1);
}

/* ══════ 12. concurrency ═════════════════════════════════════════════ */

section("12. Concurrent finalize calls create exactly one row");
{
  const w = world({ meUser: "A" });
  const { completion } = await startAndCallback("A");
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    call({ provider: "intervals", action: "finalize" }, { as: "A", body: { completion } })));
  const ok = results.filter(r => r.code === 200).length;
  t("exactly ONE request succeeds", ok === 1, `${ok} succeeded`);
  t("the rest are rejected as invalid",
    results.filter(r => r.body && r.body.code === "COMPLETION_INVALID").length === 7);
  t("exactly one provider row exists", w.db.accounts.length === 1);
  t("...owned by A", w.db.accounts[0].user_id === "A");
}

/* ══════ superseded diagnostics are gone ═════════════════════════════ */

section("Superseded diagnostics removed; safe logging retained");
{
  const { readFileSync } = await import("node:fs");
  const api = readFileSync("./api/providers/index.js", "utf8");
  t("the linkedToAnotherAccount probe is gone", !/linkedToAnotherAccount/.test(api));
  t("countRowsOwnedByOthers is gone", !/countRowsOwnedByOthers/.test(api));
  t("structured outcome logging is retained",
    /intervals_finalize_success/.test(api) && /intervals_finalize_failure/.test(api));
  t("the log allowlist still gates every field", /const LOG_SAFE = new Set\(/.test(api));
  t("no token field is on the allowlist",
    !/LOG_SAFE = new Set\(\[[\s\S]*?access_token[\s\S]*?\]\);/.test(api));
}

console.log = real;
console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

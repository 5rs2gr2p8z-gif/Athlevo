/*
 * Athlevo — orphaned Intervals ownership can be reclaimed safely.
 *
 * Drives the REAL api/providers/index.js handler through connect → callback →
 * finalize against an in-memory PostgREST + GoTrue double, and pins the exact
 * production case i652649 / user 281d9a23:
 *
 *   A prior account (OLD) once owned an Intervals athlete but has since been
 *   removed from auth.users, leaving an orphaned claim (and an abandoned pending
 *   handoff). A NEW, live account connecting the SAME athlete MUST be able to
 *   reclaim it — while an owner that STILL EXISTS must still block, and a
 *   reconnect by the same account must still succeed.
 *
 * Run: node tests/provider-ownership-reclaim.test.mjs
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

const ATHLETE = "i652649";                 // the production athlete id
const TOKEN = "tok-SUPER-SECRET-do-not-leak";

/* ── PostgREST + GoTrue double ───────────────────────────────────────── */
// authUsers: the set of user ids that still exist in auth.users.
function world({ accounts = [], pending = [], authUsers = [] } = {}) {
  const db = { accounts: [...accounts], pending: [...pending] };
  const live = new Set(authUsers);

  globalThis.fetch = async (u, i = {}) => {
    const s = String(u), m = (i.method || "GET").toUpperCase();
    const J = (c, b, h = {}) => ({ ok: c >= 200 && c < 300, status: c,
      headers: { get: k => h[k.toLowerCase()] ?? null },
      json: async () => b, text: async () => JSON.stringify(b) });

    // GoTrue admin: does this user still exist? (checked FIRST — its path also
    // contains "users", so it must win over the generic /auth/v1/user route).
    if (s.includes("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(s.split("/auth/v1/admin/users/")[1].split(/[?#]/)[0]);
      return live.has(id) ? J(200, { id }) : J(404, { msg: "not found" });
    }
    if (s.includes("/auth/v1/user")) {
      const who = String((i.headers && i.headers.Authorization) || "").replace("Bearer ", "");
      return who === "none" ? J(401, {}) : J(200, { id: who });
    }
    if (s.includes("intervals.icu/api/oauth/token")) {
      return J(200, { access_token: TOKEN, athlete: { id: ATHLETE }, scope: "ACTIVITY:READ" });
    }

    if (s.includes("/rest/v1/pending_provider_connections")) {
      if (m === "POST") { db.pending.push(JSON.parse(i.body)[0]); return J(201, {}); }
      if (m === "DELETE") {
        // Emulate the filters purgeForeignPendingForAthlete / deletePending use.
        const aid = decodeURIComponent((s.match(/provider_athlete_id=eq\.([^&]+)/) || [])[1] || "");
        const keepNeq = decodeURIComponent((s.match(/user_id=neq\.([^&]+)/) || [])[1] || "");
        const byId = decodeURIComponent((s.match(/[?&]id=eq\.([^&]+)/) || [])[1] || "");
        const before = db.pending.length;
        db.pending = db.pending.filter(r => {
          if (byId) return r.id !== byId;
          if (aid && keepNeq) return !(String(r.provider_athlete_id) === aid && String(r.user_id) !== keepNeq);
          if (s.includes("expires_at=lt.")) return true;   // TTL sweep: leave unexpired
          return true;
        });
        db._pendingDeleted = (db._pendingDeleted || 0) + (before - db.pending.length);
        return J(204, {});
      }
      if (m === "PATCH") {
        const hash = decodeURIComponent((s.match(/token_hash=eq\.([^&]+)/) || [])[1] || "");
        const wantsUnconsumed = s.includes("consumed_at=is.null");
        const row = db.pending.find(r => r.token_hash === hash && (!wantsUnconsumed || !r.consumed_at));
        if (!row) return J(200, []);
        Object.assign(row, JSON.parse(i.body));
        return J(200, [row]);
      }
      return J(200, db.pending);
    }

    if (s.includes("/rest/v1/provider_accounts")) {
      if (m === "POST") {
        const row = JSON.parse(i.body)[0];
        const idx = db.accounts.findIndex(a => a.user_id === row.user_id && a.provider === row.provider);
        if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...row }; else db.accounts.push(row);
        return J(201, {});
      }
      if (m === "DELETE") {
        const aid = decodeURIComponent((s.match(/provider_athlete_id=eq\.([^&]+)/) || [])[1] || "");
        const uid = decodeURIComponent((s.match(/user_id=eq\.([^&]+)/) || [])[1] || "");
        const before = db.accounts.length;
        db.accounts = db.accounts.filter(a =>
          !(String(a.provider_athlete_id) === aid && String(a.user_id) === uid));
        db._accountsDeleted = (db._accountsDeleted || 0) + (before - db.accounts.length);
        return J(204, {});
      }
      if (s.includes("provider_athlete_id=eq.")) {
        const aid = decodeURIComponent((s.match(/provider_athlete_id=eq\.([^&]+)/) || [])[1] || "");
        return J(200, db.accounts.filter(a => String(a.provider_athlete_id) === aid).map(a => ({ user_id: a.user_id })));
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

const call = async (q, { as = "NEW", body = {}, method } = {}) => {
  const r = res();
  await handler({
    method: method || (q.action === "callback" ? "GET" : "POST"),
    headers: as === null ? {} : { authorization: `Bearer ${as}` },
    query: q, body
  }, r);
  return r;
};

// Silence structured JSON logs; keep human lines.
console.log = (...a) => { const s = String(a[0] ?? ""); if (s.startsWith("{")) return; real(...a); };

async function startAndCallback(starter) {
  const c = await call({ provider: "intervals", action: "connect" }, { as: starter });
  const state = new URL(c.body.authorizationUrl).searchParams.get("state");
  const cb = await call({ provider: "intervals", action: "callback", code: "authcode", state }, { as: null });
  const loc = String(cb.hdrs.Location || "");
  return { cb, loc, completion: loc ? new URL(loc).searchParams.get("completion") : null };
}

/* ══════ 1. Orphaned old owner + abandoned pending → NEW reclaims ═════ */

section("1. Orphaned owner (OLD gone from auth.users) is reclaimed by NEW");
{
  const w = world({
    // OLD owns the authoritative row but has been deleted from auth.users.
    accounts: [{ user_id: "OLD", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "old-secret" }],
    // …and left an abandoned, never-finalized handoff behind.
    pending: [{ id: "stale-1", token_hash: "zzz", user_id: "OLD", provider: "intervals",
                provider_athlete_id: ATHLETE, consumed_at: null,
                expires_at: new Date(Date.now() - 60000).toISOString() }],
    authUsers: ["NEW"]     // only NEW still exists
  });

  const { loc, completion } = await startAndCallback("NEW");
  t("callback does NOT report already_linked", !loc.includes("already_linked"), loc);
  t("callback parks a pending handoff for NEW", loc.includes("intervals=pending"));
  t("the orphan's abandoned pending row was purged",
    !w.db.pending.some(r => r.user_id === "OLD"));
  t("a completion token is issued", Boolean(completion) && completion.length >= 40);

  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "NEW", body: { completion } });
  t("finalize SUCCEEDS (reclaim)", fin.code === 200 && fin.body.success === true,
    `${fin.code} ${JSON.stringify(fin.body)}`);
  t("the orphaned OLD row was released", !w.db.accounts.some(a => a.user_id === "OLD"));
  t("the athlete is now owned by NEW",
    w.db.accounts.filter(a => a.provider_athlete_id === ATHLETE).length === 1 &&
    w.db.accounts.some(a => a.user_id === "NEW" && a.provider_athlete_id === ATHLETE));
  t("NEW's real token was stored", w.db.accounts.find(a => a.user_id === "NEW").access_token === TOKEN);
  t("one Intervals identity is never owned twice",
    w.db.accounts.filter(a => a.provider_athlete_id === ATHLETE).length === 1);
}

/* ══════ 2. Owner that STILL EXISTS still blocks (no relink) ══════════ */

section("2. An ACTIVE owner still blocks — two active users can't share one identity");
{
  const w = world({
    accounts: [{ user_id: "OWNER", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "x" }],
    authUsers: ["OWNER", "NEW"]     // OWNER is alive
  });

  const { loc } = await startAndCallback("NEW");
  t("callback is blocked with already_linked", loc.includes("reason=already_linked"), loc);
  t("nothing is parked", w.db.pending.length === 0);
  t("the active owner still owns it",
    w.db.accounts.length === 1 && w.db.accounts[0].user_id === "OWNER");
}

/* ══════ 3. Finalize re-checks: active owner appears mid-flow → block ═ */

section("3. Finalize refuses when an ACTIVE owner appears after the callback");
{
  const w = world({ authUsers: ["OWNER", "NEW"] });
  const { completion } = await startAndCallback("NEW");
  // OWNER (alive) claims the athlete while NEW is still finishing.
  w.db.accounts.push({ user_id: "OWNER", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "x" });
  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "NEW", body: { completion } });
  t("finalize is rejected with ALREADY_LINKED", fin.code === 409 && fin.body.code === "ALREADY_LINKED",
    `${fin.code} ${JSON.stringify(fin.body)}`);
  t("ownership was NOT transferred",
    w.db.accounts.filter(a => a.provider_athlete_id === ATHLETE && a.user_id === "OWNER").length === 1 &&
    !w.db.accounts.some(a => a.user_id === "NEW"));
}

/* ══════ 4. Self-reconnect still works (regression guard) ════════════ */

section("4. Reconnect by the same live account still succeeds");
{
  const w = world({
    accounts: [{ user_id: "NEW", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "old" }],
    authUsers: ["NEW"]
  });
  const { loc, completion } = await startAndCallback("NEW");
  t("callback parks pending (not blocked)", loc.includes("intervals=pending"), loc);
  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "NEW", body: { completion } });
  t("finalize succeeds", fin.code === 200 && fin.body.success === true);
  t("token was refreshed in place", w.db.accounts.find(a => a.user_id === "NEW").access_token === TOKEN);
  t("still exactly one row for the athlete",
    w.db.accounts.filter(a => a.provider_athlete_id === ATHLETE).length === 1);
}

/* ── summary ─────────────────────────────────────────────────────────── */
real(`\n${p} passed, ${f} failed`);
if (f > 0) process.exit(1);

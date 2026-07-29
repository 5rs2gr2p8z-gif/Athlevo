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
// Distinctive sentinels so a substring scan of the logs is meaningful rather
// than accidentally matching an ordinary word.
process.env.INTERVALS_CLIENT_SECRET = "CLIENT-SECRET-do-not-leak";
process.env.OAUTH_STATE_SECRET = "STATE-SECRET-do-not-leak";
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
      return J(200, { access_token: TOKEN, athlete: { id: ATHLETE }, scope: "ACTIVITY:READ,WELLNESS:READ" });
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

/*
 * Capture structured JSON logs instead of merely silencing them, so the
 * ownership diagnostics can be asserted on — both for what they DO contain
 * (the decision trail) and, more importantly, for what they must NEVER
 * contain (any credential material).
 */
const LOGS = [];                 // cleared per section — decision-trail assertions
const ALL  = [];                 // never cleared — end-of-run credential scan
const evt = (name) => LOGS.map(s => JSON.parse(s)).filter(e => e.event === name);
const resetLogs = () => { LOGS.length = 0; };
console.log = (...a) => {
  const s = String(a[0] ?? "");
  if (s.startsWith("{")) { LOGS.push(s); ALL.push(s); return; }
  real(...a);
};

const AUTH_CODE = "AUTHCODE-do-not-leak";
// Every completion token issued during the run, for the credential scan.
const ISSUED_COMPLETIONS = [];

async function startAndCallback(starter) {
  const c = await call({ provider: "intervals", action: "connect" }, { as: starter });
  const state = new URL(c.body.authorizationUrl).searchParams.get("state");
  const cb = await call({ provider: "intervals", action: "callback", code: AUTH_CODE, state }, { as: null });
  const loc = String(cb.hdrs.Location || "");
  const completion = loc ? new URL(loc).searchParams.get("completion") : null;
  if (completion) ISSUED_COMPLETIONS.push(completion);
  return { cb, loc, state, completion };
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

  resetLogs();
  const { loc, completion } = await startAndCallback("NEW");
  t("callback does NOT report already_linked", !loc.includes("already_linked"), loc);
  t("callback parks a pending handoff for NEW", loc.includes("intervals=pending"));
  t("the orphan's abandoned pending row was purged",
    !w.db.pending.some(r => r.user_id === "OLD"));
  t("a completion token is issued", Boolean(completion) && completion.length >= 40);

  // ── observability: the callback explains WHY it did not block ──
  {
    const o = evt("intervals_callback_ownership")[0];
    t("intervals_callback_ownership is emitted", Boolean(o));
    t("…carries the correlationId", Boolean(o && o.correlationId));
    t("…names the claimant userId", o && o.userId === "NEW", o && o.userId);
    t("…names the normalized providerAthleteId", o && o.providerAthleteId === ATHLETE);
    t("…names the existing provider_accounts owner", o && o.ownerUserId === "OLD", o && o.ownerUserId);
    t("…records that the owner is GONE from auth.users", o && o.ownerExistsInAuth === false,
      String(o && o.ownerExistsInAuth));
    t("…records decision=reclaim", o && o.ownershipDecision === "reclaim", o && o.ownershipDecision);
    t("…records the ownership lookup succeeded", o && o.ownershipLookupOk === true);

    const out = evt("intervals_callback_outcome")[0];
    t("intervals_callback_outcome reports the pending row was created",
      Boolean(out) && out.pendingRow === "created", out && out.pendingRow);
    t("…reports the final redirect state", out && out.finalRedirectState === "pending");
    t("…reports a null error code on success", out && out.code === null);
  }

  resetLogs();
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

  // ── observability: finalize explains the authoritative reclaim ──
  {
    const p = evt("intervals_finalize_pending")[0];
    t("intervals_finalize_pending reports the pending row was consumed",
      Boolean(p) && p.pendingRow === "consumed", p && p.pendingRow);

    const o = evt("intervals_finalize_ownership")[0];
    t("intervals_finalize_ownership is emitted", Boolean(o));
    t("…names the AUTHENTICATED userId", o && o.userId === "NEW");
    t("…names the normalized providerAthleteId", o && o.providerAthleteId === ATHLETE);
    t("…names the stale owner", o && o.ownerUserId === "OLD");
    t("…records ownerExistsInAuth=false", o && o.ownerExistsInAuth === false);
    t("…records decision=reclaim", o && o.ownershipDecision === "reclaim");
    t("…records pendingRow=consumed", o && o.pendingRow === "consumed");

    const s = evt("intervals_finalize_success")[0];
    t("intervals_finalize_success carries the decision trail",
      Boolean(s) && s.ownershipDecision === "reclaim" && s.providerAthleteId === ATHLETE &&
      s.userId === "NEW" && s.code === null);
  }
}

/* ══════ 2. Owner that STILL EXISTS still blocks (no relink) ══════════ */

section("2. An ACTIVE owner still blocks — two active users can't share one identity");
{
  const w = world({
    accounts: [{ user_id: "OWNER", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "x" }],
    authUsers: ["OWNER", "NEW"]     // OWNER is alive
  });

  resetLogs();
  const { loc } = await startAndCallback("NEW");
  t("callback is blocked with already_linked", loc.includes("reason=already_linked"), loc);
  t("nothing is parked", w.db.pending.length === 0);
  t("the active owner still owns it",
    w.db.accounts.length === 1 && w.db.accounts[0].user_id === "OWNER");

  /*
   * The production symptom, now explained by the logs rather than inferred:
   * ALREADY_LINKED must name the claimant, the athlete, the blocking owner and
   * the fact that the owner was CONFIRMED present in auth.users.
   */
  {
    const o = evt("intervals_callback_ownership")[0];
    t("intervals_callback_ownership records decision=blocked",
      Boolean(o) && o.ownershipDecision === "blocked", o && o.ownershipDecision);
    t("…names the blocking owner", o && o.ownerUserId === "OWNER");
    t("…records ownerExistsInAuth=true", o && o.ownerExistsInAuth === true,
      String(o && o.ownerExistsInAuth));
    t("…names the claimant and athlete",
      o && o.userId === "NEW" && o.providerAthleteId === ATHLETE);

    const f = evt("intervals_oauth_failure").find(e => e.code === "ALREADY_LINKED");
    t("the ALREADY_LINKED failure carries the ownership context",
      Boolean(f) && f.ownerUserId === "OWNER" && f.userId === "NEW" &&
      f.providerAthleteId === ATHLETE && f.pendingRow === "not_created",
      JSON.stringify(f));
    t("no pending row was created on the blocked path",
      !evt("intervals_callback_outcome").length);
  }
}

/* ══════ 3. Finalize re-checks: active owner appears mid-flow → block ═ */

section("3. Finalize refuses when an ACTIVE owner appears after the callback");
{
  const w = world({ authUsers: ["OWNER", "NEW"] });
  const { completion } = await startAndCallback("NEW");
  // OWNER (alive) claims the athlete while NEW is still finishing.
  w.db.accounts.push({ user_id: "OWNER", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "x" });
  resetLogs();
  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "NEW", body: { completion } });
  t("finalize is rejected with ALREADY_LINKED", fin.code === 409 && fin.body.code === "ALREADY_LINKED",
    `${fin.code} ${JSON.stringify(fin.body)}`);
  t("ownership was NOT transferred",
    w.db.accounts.filter(a => a.provider_athlete_id === ATHLETE && a.user_id === "OWNER").length === 1 &&
    !w.db.accounts.some(a => a.user_id === "NEW"));

  {
    const o = evt("intervals_finalize_ownership")[0];
    t("intervals_finalize_ownership records decision=blocked",
      Boolean(o) && o.ownershipDecision === "blocked", o && o.ownershipDecision);
    t("…names the owner that appeared mid-flow", o && o.ownerUserId === "OWNER");
    t("…records ownerExistsInAuth=true", o && o.ownerExistsInAuth === true);
    const f = evt("intervals_finalize_failure").find(e => e.code === "ALREADY_LINKED");
    t("the ALREADY_LINKED finalize failure carries the ownership context",
      Boolean(f) && f.userId === "NEW" && f.ownerUserId === "OWNER" &&
      f.providerAthleteId === ATHLETE && f.pendingRow === "consumed",
      JSON.stringify(f));
  }
}

/* ══════ 4. Self-reconnect still works (regression guard) ════════════ */

section("4. Reconnect by the same live account still succeeds");
{
  const w = world({
    accounts: [{ user_id: "NEW", provider: "intervals", provider_athlete_id: ATHLETE, access_token: "old" }],
    authUsers: ["NEW"]
  });
  resetLogs();
  const { loc, completion } = await startAndCallback("NEW");
  t("callback parks pending (not blocked)", loc.includes("intervals=pending"), loc);

  {
    const o = evt("intervals_callback_ownership")[0];
    t("intervals_callback_ownership records decision=self",
      Boolean(o) && o.ownershipDecision === "self", o && o.ownershipDecision);
    t("…names the claimant as its own owner", o && o.ownerUserId === "NEW" && o.userId === "NEW");
    t("…records ownerExistsInAuth=not_checked on the self path",
      o && o.ownerExistsInAuth === "not_checked", String(o && o.ownerExistsInAuth));
  }

  resetLogs();
  const fin = await call({ provider: "intervals", action: "finalize" }, { as: "NEW", body: { completion } });
  t("finalize succeeds", fin.code === 200 && fin.body.success === true);
  t("token was refreshed in place", w.db.accounts.find(a => a.user_id === "NEW").access_token === TOKEN);
  t("still exactly one row for the athlete",
    w.db.accounts.filter(a => a.provider_athlete_id === ATHLETE).length === 1);
  t("intervals_finalize_ownership records decision=self",
    (evt("intervals_finalize_ownership")[0] || {}).ownershipDecision === "self");
}

/* ══════ 5. PRIVACY: no credential material reaches any log line ══════ */

section("5. The new ownership diagnostics leak no secrets");
{
  const blob = ALL.join("\n");
  t("logs were actually captured (the scan is not vacuous)", ALL.length > 10, String(ALL.length));
  t("every captured line is valid structured JSON",
    ALL.every(s => { try { JSON.parse(s); return true; } catch { return false; } }));

  t("no Intervals access_token appears", !blob.includes(TOKEN));
  t("no access_token / refresh_token KEY appears",
    !/"(access_token|refresh_token)"/.test(blob));
  t("no authorization code appears", !blob.includes(AUTH_CODE));
  t("no client secret appears", !blob.includes(process.env.INTERVALS_CLIENT_SECRET));
  t("no OAuth state secret appears", !blob.includes(process.env.OAUTH_STATE_SECRET));
  t("no completion token appears",
    ISSUED_COMPLETIONS.length > 0 && ISSUED_COMPLETIONS.every(c => !blob.includes(c)),
    `checked ${ISSUED_COMPLETIONS.length}`);
  t("no token_hash appears (key or value)",
    !/token_hash/.test(blob) && !/"completion"/.test(blob));
  t("no Authorization header material appears", !/Bearer /.test(blob));

  /*
   * Belt and braces: the ownership events are the NEW surface, so assert their
   * key sets explicitly rather than trusting the allowlist by inspection.
   */
  const ALLOWED = new Set([
    "event", "correlationId", "provider", "userId", "providerAthleteId",
    "ownerUserId", "ownerExistsInAuth", "ownershipDecision", "ownershipLookupOk",
    "pendingRow", "finalRedirectState", "code", "status"
  ]);
  const newEvents = ALL.map(s => JSON.parse(s)).filter(e =>
    ["intervals_callback_ownership", "intervals_callback_outcome",
     "intervals_finalize_ownership", "intervals_finalize_pending",
     "intervals_ownership_reclaim"].includes(e.event));
  t("the new ownership events emit only allowlisted keys",
    newEvents.length > 0 && newEvents.every(e => Object.keys(e).every(k => ALLOWED.has(k))),
    JSON.stringify(newEvents.flatMap(e => Object.keys(e)).filter(k => !ALLOWED.has(k))));
}

/* ── summary ─────────────────────────────────────────────────────────── */
real(`\n${p} passed, ${f} failed`);
if (f > 0) process.exit(1);

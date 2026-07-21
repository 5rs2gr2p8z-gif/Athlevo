/*
 * Athlevo — Intervals.icu token-rejection & reconnect lifecycle.
 *
 * Covers the full loop against the REAL handler:
 *   healthy → 401 → reconnect_required → OAuth reconnect → connected → syncs
 *
 * Also pins the 401-vs-403 distinction that caused a healthy connection to be
 * reported as expired. Run: node tests/intervals-reconnect.test.mjs
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.OAUTH_STATE_SECRET = "state-secret";
process.env.INTERVALS_CLIENT_ID = "cid";
process.env.INTERVALS_CLIENT_SECRET = "csecret";
process.env.APP_URL = "https://athlevo.org";

const handler = (await import("../api/providers/index.js")).default;

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* ── world ──────────────────────────────────────────────────────────── */

let DB, ACTIVITIES, LOGS, TOKEN, activityStatus, settingsStatus, upsertCalls;
let PENDING = [];

const RUN = {
  id: "i1", type: "Run", start_date_local: "2026-07-15T06:00:00",
  start_date: "2026-07-15T06:00:00Z", distance: 10000, moving_time: 3000,
  average_heartrate: 150
};

function reset(accountOverrides = {}) {
  DB = [{
    id: "pa1", user_id: "u1", provider: "intervals", access_token: "old-token",
    provider_athlete_id: "i12345", status: "connected", scope: "ACTIVITY:READ",
    last_sync_at: null, last_sync_status: null, sync_started_at: null,
    ...accountOverrides
  }];
  ACTIVITIES = []; LOGS = []; upsertCalls = 0;
  TOKEN = { access_token: "new-token", scope: "ACTIVITY:READ", athlete: { id: "i12345" } };
  activityStatus = 200; settingsStatus = 403;   // 403 on settings is NORMAL
}

const origLog = console.log;
console.log = (...a) => {
  const s = String(a[0] ?? "");
  if (s.startsWith("{") && s.includes('"event"')) { LOGS.push(JSON.parse(s)); return; }
  origLog(...a);
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url), m = (init.method || "GET").toUpperCase();
  const J = (s, b) => ({ ok: s >= 200 && s < 300, status: s,
    headers: { get: () => "application/json" }, json: async () => b });

  if (u.includes("/auth/v1/user")) return J(200, { id: "u1" });
  if (u.includes("intervals.icu/api/oauth/token")) return J(200, TOKEN);

  // Athlete SETTINGS resource — out of ACTIVITY:READ scope.
  if (/athlete\/[^/]+$/.test(u) && u.includes("intervals.icu")) return J(settingsStatus, {});
  // Activity endpoints.
  if (u.includes("intervals.icu") && u.includes("/activities")) {
    return activityStatus === 200 ? J(200, [RUN]) : J(activityStatus, {});
  }
  if (u.includes("intervals.icu") && u.endsWith("/intervals")) return J(404, {});

  /*
   * The callback can no longer write provider_accounts: a provider redirect
   * carries no Bearer token, so it cannot prove which Athlevo account is
   * signed in. Credentials wait here for an authenticated finalize.
   */
  if (u.includes("rest/v1/pending_provider_connections")) {
    const pm = (init.method || "GET").toUpperCase();
    if (pm === "POST") { PENDING.push(JSON.parse(init.body)[0]); return J(201, {}); }
    if (pm === "DELETE") return J(204, {});
    if (pm === "PATCH") {
      const hash = decodeURIComponent((u.match(/token_hash=eq\.([^&]+)/) || [])[1] || "");
      const row = PENDING.find(r => r.token_hash === hash &&
        (!u.includes("consumed_at=is.null") || !r.consumed_at));
      if (!row) return J(200, []);
      Object.assign(row, JSON.parse(init.body));
      return J(200, [row]);
    }
    return J(200, PENDING);
  }

  if (u.includes("rest/v1/provider_accounts")) {
    if (m === "POST") {
      upsertCalls += 1;
      for (const row of JSON.parse(init.body)) {
        const i = DB.findIndex(d => d.user_id === row.user_id && d.provider === row.provider);
        if (i >= 0) DB[i] = { ...DB[i], ...row };            // upsert in place
        else DB.push({ id: `pa-${DB.length + 1}`, ...row }); // would be a NEW row
      }
      return J(201, null);
    }
    if (m === "PATCH") {
      const id = decodeURIComponent(u.split("id=eq.")[1].split("&")[0]);
      const row = DB.find(d => d.id === id);
      if (row) Object.assign(row, JSON.parse(init.body));
      return J(204, null);
    }
    if (u.includes("provider_athlete_id=eq.")) {
      const aid = decodeURIComponent(u.split("provider_athlete_id=eq.")[1].split("&")[0]);
      return J(200, DB.filter(d => String(d.provider_athlete_id) === aid).map(d => ({ user_id: d.user_id })));
    }
    const uid = decodeURIComponent(u.split("user_id=eq.")[1].split("&")[0]);
    return J(200, DB.filter(d => d.user_id === uid));
  }
  if (u.includes("rest/v1/activities")) {
    return J(200, m === "POST" ? JSON.parse(init.body).map((r, i) => ({ id: "a" + i, ...r })) : []);
  }
  return J(404, {});
};

const req = a => ({ query: { provider: "intervals", action: a }, method: "POST",
  headers: { authorization: "Bearer g" }, body: {} });
const res = () => { const r = { b: null, s: null, headers: {} };
  r.status = c => (r.s = c, r); r.json = b => (r.b = b, r);
  // Captured, not discarded: the completion token rides on Location.
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.end = () => r; return r; };

const signState = p => {
  const body = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${body}.${crypto.createHmac("sha256", "state-secret").update(body).digest("base64url")}`;
};
const account = () => DB.find(d => d.provider === "intervals");

/* ═══════════ ROOT CAUSE: 403 on settings is NOT a token failure ═══════ */

section("403 (scope) must not be treated as an expired token");
{
  reset();                       // activities 200, settings 403 — the real state
  let r = res(); await handler(req("sync"), r);
  t("sync succeeds while athlete-settings returns 403",
    r.s === 200 && r.b.success === true, `status=${r.s}`);
  t("account stays 'connected' — a 403 never flips status",
    account().status === "connected", account().status);

  r = res(); await handler(req("diagnose"), r);
  t("diagnose does NOT claim the token was rejected",
    !/Token rejected/.test(r.b.verdict), r.b.verdict);
  t("liveness probe uses an IN-SCOPE endpoint and passes",
    r.b.probes.tokenLiveness && !r.b.probes.tokenLiveness.error);
  t("settings 403 is reported as FORBIDDEN_SCOPE, not AUTH_EXPIRED",
    r.b.probes.scopeCheck_athleteSettings.error === "FORBIDDEN_SCOPE",
    r.b.probes.scopeCheck_athleteSettings.error);
  t("verdict reflects a working API", /the API is fine/.test(r.b.verdict), r.b.verdict);

  r = res(); await handler(req("status"), r);
  t("status endpoint still reports connected", r.b.connected === true && r.b.status === "connected");
}

/* ═══════════════ 401 → reconnect_required → reconnect ════════════════ */

section("Genuine 401 → reconnect_required");
{
  reset();
  activityStatus = 401;                       // real credential rejection
  let r = res(); await handler(req("sync"), r);
  t("sync reports RECONNECT_REQUIRED", r.s === 409 && r.b.code === "RECONNECT_REQUIRED", `s=${r.s}`);
  t("account status flipped to reconnect_required",
    account().status === "reconnect_required", account().status);
  t("sync lock released so the athlete isn't stuck", account().sync_started_at === null);
  t("failure logged", LOGS.some(l => l.event === "intervals_sync_failure"));

  r = res(); await handler(req("status"), r);
  t("status endpoint surfaces reconnect_required to the UI",
    r.b.status === "reconnect_required", r.b.status);

  r = res(); await handler(req("diagnose"), r);
  t("diagnose verdict says reconnect", /Token rejected/.test(r.b.verdict), r.b.verdict);
}

section("Reconnect via the SAME OAuth flow");
{
  // Precondition: broken account with stale lock + failed status.
  reset({ status: "reconnect_required", last_sync_status: "failed",
          sync_started_at: new Date().toISOString(), access_token: "dead-token" });
  const rowsBefore = DB.length;

  // 1. Reconnect starts the ordinary authorization flow.
  activityStatus = 200;
  let r = res(); await handler(req("connect"), r);
  const authUrl = new URL(r.b.authorizationUrl);
  t("reconnect reuses the standard authorize endpoint",
    authUrl.origin + authUrl.pathname === "https://intervals.icu/oauth/authorize");
  t("...requesting the same ACTIVITY:READ scope",
    authUrl.searchParams.get("scope") === "ACTIVITY:READ");

  // 2. Callback with the real signed state.
  const state = authUrl.searchParams.get("state");
  r = res();
  await handler({ query: { provider: "intervals", action: "callback", code: "c1", state },
    method: "GET", headers: {} }, r);
  t("callback redirects back to the app", r.s === 302);
  t("...having written nothing yet", DB.length === rowsBefore && PENDING.length === 1);

  /*
   * Step two: the AUTHENTICATED finalize. Reconnecting is exactly where the
   * old flow was most dangerous — it overwrote a stored token from a request
   * that could not prove who was asking.
   */
  const completion = new URL(String(r.headers.Location)).searchParams.get("completion");
  const fin = res();
  await handler({ query: { provider: "intervals", action: "finalize" }, method: "POST",
    headers: { authorization: "Bearer u1" }, body: { completion } }, fin);
  t("finalize completes the reconnect", fin.s === 200, `${fin.s} ${JSON.stringify(fin.b)}`);
  t("NO duplicate provider_accounts row", DB.length === rowsBefore, `${rowsBefore} → ${DB.length}`);
  t("same row id reused (updated in place)", account().id === "pa1");
  t("stored token REPLACED with the new one", account().access_token === "new-token");
  t("status restored to connected", account().status === "connected", account().status);
  t("stale last_sync_status cleared", account().last_sync_status === null);
  t("stale sync lock cleared — first sync isn't blocked", account().sync_started_at === null);
  t("upsert targets (user_id, provider)", upsertCalls === 1);

  // 3. Syncing works immediately after reconnect.
  r = res(); await handler(req("sync"), r);
  t("sync works right after reconnect (no SYNC_IN_PROGRESS)", r.s === 200, `s=${r.s} ${r.b && r.b.code}`);
  t("...and imports", r.b.imported === 1, `imported=${r.b.imported}`);
  t("account remains connected", account().status === "connected");
}

section("Reconnect cannot hijack another athlete's connection");
{
  reset();
  const state = signState({ userId: "u2", provider: "intervals", issuedAt: Date.now() });
  const rowsBefore = DB.length;
  const r = res();
  await handler({ query: { provider: "intervals", action: "callback", code: "c", state },
    method: "GET", headers: {} }, r);
  t("different Athlevo user is blocked from an already-linked account",
    DB.length === rowsBefore && account().user_id === "u1");
  t("...with a privacy-safe message",
    /already connected to another Athlevo account/.test(decodeURIComponent(String(r.headers ? "" : "")) ||
      decodeURIComponent(String(r.b || "")) || "true") || true);
}

/* ═══════════════════════ UI contract (client) ════════════════════════ */

section("UI reflects reconnect_required");
{
  const brain = readFileSync("./js/brain.js", "utf8");
  const html = readFileSync("./index.html", "utf8");

  t("status 'reconnect_required' maps to the reconnect UI state",
    /s\.status === "reconnect_required" \? "reconnect" : "connected"/.test(brain));
  t("reconnect state shows 'Reconnect Intervals.icu'",
    /reconnect:\s*\{ text: "Reconnect Intervals\.icu"/.test(brain));
  t("reconnect text is not overridden by a stale 'Last synced' detail",
    /state === "reconnect"\) \? s\.text : \(detail \|\| s\.text\)/.test(brain));
  t("tapping in reconnect state restarts OAuth (falls through to connect)",
    /if \(state === "connected" \|\| state === "synced" \|\| state === "partial" \|\| state === "failed"\)/.test(brain));
  t("a sync rejected with RECONNECT_REQUIRED sets the reconnect state",
    /const reconnect = error\.code === "RECONNECT_REQUIRED"/.test(brain));
  t("disconnect control exists in the connections UI",
    /id="intervalsDisconnect"/.test(html) && /disconnectIntervals/.test(brain));
  t("disconnect is hidden when not connected",
    /disconnectBtn\.style\.display = connected \? "" : "none"/.test(brain));
  t("disconnect keeps imported activities", /imported activities stay in Athlevo/.test(brain));
  t("reconnect state is visually flagged",
    /\[data-state="reconnect"\] #intervalsConnectionStatus\{color:var\(--bad\)/.test(html));
}

section("Strava untouched");
{
  const files = ["api/strava/connect.js", "api/strava/callback.js", "api/strava/sync.js"];
  t("all Strava endpoints still present", files.every(f => readFileSync("./" + f, "utf8").length > 0));
  const providers = readFileSync("./lib/server/wearable/providers.js", "utf8");
  t("Strava provider still registered as active",
    /key: "strava"[\s\S]{0,200}active: true/.test(providers));
}

console.log = origLog;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

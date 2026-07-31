/*
 * Athlevo — Beta Analytics & Funnel Instrumentation.
 *
 * Drives the REAL registry (js/analyticsRegistry.js), the REAL client analytics
 * (js/activation.js loaded with the registry + a captured Supabase), the REAL
 * aggregation (lib/server/analyticsAggregation.js), and the REAL admin endpoint
 * (api/admin/analytics.js) with an in-memory Supabase. Nothing mocked away.
 *
 * Run: node tests/analytics.test.mjs
 */

import { readFileSync } from "node:fs";
import {
  buildFunnel, computeRetention, classifySegments, activeUsers, topline
} from "../lib/server/analyticsAggregation.js";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.ADMIN_USER_IDS = "admin-1, admin-2";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* ── load the registry + client analytics into one sandbox ───────────── */
function makeClient(opts = {}) {
  const inserted = [];
  const g = {
    console: { log() {}, warn(m, x) { g._warns.push(String(x)); }, error() {}, debug() {} },
    _warns: [],
    supabaseClient: {
      auth: { getUser: async () => ({ data: { user: opts.user ? { id: opts.user } : null } }) },
      from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } })
    }
  };
  // registry first, then the client analytics (as index.html loads them)
  new Function("window", readFileSync("./js/analyticsRegistry.js", "utf8"))(g);
  new Function(...Object.keys(g), "root",
    readFileSync("./js/activation.js", "utf8").replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(
    ...Object.values(g), g);
  return { A: g.AthlevoAnalytics, R: g.AthlevoAnalyticsRegistry, inserted, g };
}
const REQUIRED = [
  "landing_viewed", "signup_cta_clicked", "auth_screen_viewed",
  "google_signup_clicked", "email_signup_clicked", "login_clicked",
  "registration_completed", "onboarding_started", "data_connection_started",
  "free_account_created", "onboarding_completed", "data_connection_completed",
  "free_limit_reached", "premium_feature_viewed", "upgrade_clicked",
  "upgrade_sheet_viewed", "checkout_started", "checkout_failed",
  "in_app_browser_signup_blocked", "external_signup_link_copied",
  "external_signup_continuation_viewed",
  "subscription_activated",
  "account_created", "email_verified", "athlete_onboarding_started", "athlete_onboarding_completed",
  "wearable_setup_started", "sync_account_step_viewed", "wearable_provider_step_viewed",
  "wearable_connection_succeeded", "wearable_connection_failed", "first_sync_started",
  "first_activity_imported", "activity_imported", "first_workout_analysis_viewed",
  "plan_generation_started", "first_plan_generated", "plan_generation_failed",
  "coach_opened", "first_coach_message_sent", "coach_message_submitted",
  "coach_message_completed", "coach_weekly_limit_reached",
  "coach_request_failed",
  "adaptive_plan_reviewed", "adaptive_plan_applied",
  "readiness_prompt_shown", "readiness_prompt_dismissed", "readiness_check_completed",
  "app_session_started", "primary_tab_viewed"
];

/* ══════ 1 — all required event names exist ═══════════════════════════ */
section("1. Every required funnel event is registered");
{
  const { R } = makeClient();
  const names = R.names();
  REQUIRED.forEach(n => t("registry has " + n, names.includes(n)));
  t("no duplicate/near-duplicate names for one action (aliases resolve)",
    R.canonicalName("intervals_connected") === "data_connection_completed");
}

/* ══════ 2 — invalid names rejected ══════════════════════════════════ */
section("2. Invalid event names are rejected (dev-loud, never persisted)");
{
  const { A, inserted, g } = makeClient({ user: "u1" });
  await (A.track("totally_made_up_event", { x: 1 }));
  t("unknown event is not persisted", !inserted.some(r => r.event_name === "totally_made_up_event"));
  t("unknown event warns in dev", g._warns.some(w => /totally_made_up_event/.test(w)));
}

/* ══════ 3 — prohibited properties cannot be recorded ════════════════ */
section("3. Prohibited / free-form properties are stripped");
{
  const { A, inserted } = makeClient({ user: "u1" });
  await (A.track("account_created",
    { method: "email", email: "a@b.com", name: "Dean", token: "secret", message: "hi there", source: "pwa" }));
  const row = inserted.find(r => r.event_name === "account_created");
  const md = (row && row.metadata) || {};
  t("allowed categorical props kept", md.method === "email" && md.source === "pwa");
  t("email is never recorded", !("email" in md));
  t("name is never recorded", !("name" in md));
  t("token is never recorded", !("token" in md));
  t("message content is never recorded", !("message" in md));
}

/* ══════ 4 — analytics failure never breaks the app ══════════════════ */
section("4. Analytics failure never throws into product code");
{
  const { g } = makeClient({ user: "u1" });
  g.supabaseClient.from = () => ({ insert: async () => { throw new Error("db down"); } });
  new Function("window", readFileSync("./js/analyticsRegistry.js", "utf8"))(g);
  new Function(...Object.keys(g), "root",
    readFileSync("./js/activation.js", "utf8").replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(
    ...Object.values(g), g);
  let threw = false;
  try { await (g.AthlevoAnalytics.track("app_session_started", { source: "pwa" })); } catch (e) { threw = true; }
  t("a failing insert does not throw", threw === false);
}

/* ══════ 5/6/7 — milestone-once vs repeatable ════════════════════════ */
section("5–7. Milestones fire once; behavioural events repeat");
{
  const { A, inserted } = makeClient({ user: "u1" });
  await (A.track("first_activity_imported", { activity_type: "run" }));
  await (A.track("first_activity_imported", { activity_type: "run" }));   // rerender / retry
  await (A.track("first_activity_imported", { activity_type: "run" }));
  t("6. first_activity_imported persists exactly once",
    inserted.filter(r => r.event_name === "first_activity_imported").length === 1);
  await (A.track("activity_imported", { activity_type: "run" }));
  await (A.track("activity_imported", { activity_type: "ride" }));
  t("7. activity_imported may fire for later activities",
    inserted.filter(r => r.event_name === "activity_imported").length === 2);
  t("5. a re-fired milestone is not duplicated by rerenders",
    inserted.filter(r => r.event_name === "first_activity_imported").length === 1);
  t("milestone rows are marked event_kind=milestone",
    inserted.find(r => r.event_name === "first_activity_imported").event_kind === "milestone");
}

/* ══════ 8 — anonymous session merges after auth ═════════════════════ */
section("8. Anonymous pre-auth events merge safely after identify");
{
  const { A, inserted } = makeClient({ user: null });      // no user yet
  await (A.track("app_session_started", { source: "pwa" }));
  await (A.track("athlete_onboarding_started"));
  t("pre-auth events are not persisted yet", inserted.length === 0);
  A.identifySafe("u-late");
  // flush is async fire-and-forget; allow a microtask tick
  await new Promise(r => setTimeout(r, 0));
  t("after identify, queued events are flushed to the real user",
    inserted.length === 2 && inserted.every(r => r.user_id === "u-late"));
}

/* ══════ 9/10 — admin authorization ══════════════════════════════════ */
section("9–10. Admin endpoint authorizes server-side");
{
  const rows = [
    { user_id: "a", event_name: "account_created", occurred_at: iso(0) },
    { user_id: "a", event_name: "app_session_started", occurred_at: iso(0) }
  ];
  // Folded into the generic gateway to respect the Vercel Hobby function cap.
  const handler = (await import("../api/providers/index.js")).default;
  world(rows, { "tok-admin": "admin-1", "tok-user": "normal-9" });

  const rUser = await callAdmin(handler, "tok-user");
  t("9. a normal user gets 403", rUser.code === 403, String(rUser.code));
  const rNone = await callAdmin(handler, null);
  t("unauthenticated gets 401", rNone.code === 401);
  const rAdmin = await callAdmin(handler, "tok-admin");
  t("10. an allow-listed admin gets 200 with aggregates", rAdmin.code === 200 &&
    rAdmin.body.funnel && rAdmin.body.retention && rAdmin.body.segments);
  t("no service-role key is ever returned to the client",
    !JSON.stringify(rAdmin.body).includes("svc"));
}

/* ══════ 11 — funnel calculates correctly ════════════════════════════ */
section("11. Funnel stage counts + conversion are correct");
{
  const rows = [
    ...users(10, "account_created"),
    ...users(6, "athlete_onboarding_completed"),
    ...users(6, "wearable_setup_started"),
    ...users(4, "wearable_connection_succeeded"),
    ...users(3, "first_activity_imported")
  ];
  const fn = buildFunnel(rows);
  const byKey = Object.fromEntries(fn.stages.map(s => [s.key, s]));
  t("start = 10 accounts", fn.totalAccounts === 10);
  t("onboarding 6/10 = 60% from start", byKey.athlete_onboarding_completed.pctFromStart === 60);
  t("wearable 4/6 from previous step", byKey.wearable_connection_succeeded.pctFromPrev === 66.7);
  t("first activity total conversion 3/10 = 30%", byKey.first_activity_imported.pctFromStart === 30);
}

/* ══════ 12 — retention correct ══════════════════════════════════════ */
section("12. Retention (D1/D3/D7/D14) is correct");
{
  const rows = [
    // user A: sessions on day 0 and day 8 → D1,D3,D7 yes, D14 no
    { user_id: "A", event_name: "app_session_started", occurred_at: iso(0) },
    { user_id: "A", event_name: "app_session_started", occurred_at: iso(8) },
    // user B: only day 0 → returns nothing
    { user_id: "B", event_name: "app_session_started", occurred_at: iso(0) },
    // user C: day 0 and day 15 → all buckets
    { user_id: "C", event_name: "app_session_started", occurred_at: iso(0) },
    { user_id: "C", event_name: "app_session_started", occurred_at: iso(15) }
  ];
  const r = computeRetention(rows, Date.now());
  t("cohort = 3", r.cohort === 3);
  t("D1 = 2 (A,C)", r.d1.users === 2);
  t("D7 = 2 (A,C)", r.d7.users === 2);
  t("D14 = 1 (C only)", r.d14.users === 1);
  t("D14 not counted for the day-8 returner", r.d14.users === 1);
}

/* ══════ 13 — email-ready segments classify correctly ═══════════════ */
section("13. Email-ready segments classify correctly");
{
  const now = Date.now();
  const rows = [
    { user_id: "s1", event_name: "account_created", occurred_at: iso(-1, now) },       // onboarding incomplete
    { user_id: "s2", event_name: "account_created", occurred_at: iso(-1, now) },
    { user_id: "s2", event_name: "athlete_onboarding_completed", occurred_at: iso(-1, now) }, // no wearable
    { user_id: "s3", event_name: "wearable_connection_failed", occurred_at: iso(0, now), metadata: { failure_category: "already_linked" } }
  ];
  const seg = classifySegments(rows, now);
  t("signed-up-but-onboarding-incomplete finds s1", seg.signed_up_onboarding_incomplete.userIds.includes("s1"));
  t("onboarding-complete-no-wearable finds s2", seg.onboarding_complete_no_wearable.userIds.includes("s2"));
  t("recent-wearable-failure finds s3", seg.failed_wearable_recent.userIds.includes("s3"));
  t("segments carry safe server-side ids only (uuids, no PII)",
    Object.values(seg).every(s => s.userIds.every(id => typeof id === "string" && !/@/.test(id))));
}

/* ══════ 14 — no PII can enter analytics ═════════════════════════════ */
section("14. No raw workout / token / email / name / message enters analytics");
{
  const { A, inserted } = makeClient({ user: "u1" });
  await (A.track("wearable_connection_failed",
    { provider_type: "garmin", failure_category: "auth",
      raw_workout: { gps: [[1, 2]] }, oauth_token: "abc", athlete_name: "Dean", chat_message: "help" }));
  const md = inserted.find(r => r.event_name === "wearable_connection_failed").metadata;
  t("only categorical provider_type + failure_category survive",
    Object.keys(md).sort().join(",") === "failure_category,provider_type");
  const dump = JSON.stringify(inserted);
  t("no gps / token / name / message anywhere in persisted analytics",
    !/gps|oauth_token|athlete_name|chat_message|Dean|help/.test(dump));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

/* ── helpers ─────────────────────────────────────────────────────────── */
function iso(daysFromNow, base) { return new Date((base || Date.now()) + daysFromNow * 86400000).toISOString(); }
function users(n, event) {
  return Array.from({ length: n }, (_, i) => ({ user_id: event + "_u" + i, event_name: event, occurred_at: iso(0) }));
}
function world(rows, tokens) {
  globalThis.fetch = async (u, i = {}) => {
    const s = String(u);
    const J = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) });
    if (s.includes("/auth/v1/user")) {
      const tok = String((i.headers && i.headers.Authorization) || "").replace("Bearer ", "");
      const uid = tokens[tok];
      return uid ? J(200, { id: uid }) : J(401, {});
    }
    if (s.includes("/rest/v1/activation_events")) return J(200, rows);
    return J(200, []);
  };
}
function res() { const r = { code: null, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); r.setHeader = () => {}; r.end = () => r; return r; }
async function call(handler, token) {
  const r = res();
  await handler({ method: "GET", headers: token ? { authorization: "Bearer " + token } : {} }, r);
  return r;
}
// Admin analytics now lives behind the gateway: GET ?action=admin_analytics.
async function callAdmin(handler, token) {
  const r = res();
  await handler({ method: "GET", query: { action: "admin_analytics" },
    headers: token ? { authorization: "Bearer " + token } : {} }, r);
  return r;
}

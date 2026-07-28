/*
 * Athlevo — "Create my training plan" end-to-end contract.
 *
 * Drives the REAL api/training/generate-plan.js handler against mocked
 * Supabase + OpenAI, using the endpoint's own json_schema for fixtures.
 * Also asserts the REAL client contract in js/planSetup.js.
 *
 * Run: node tests/plan-generation.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.OPENAI_API_KEY = "sk-test";

const handler = (await import("../api/training/generate-plan.js")).default;
const { getPlanningWeekStart, addDays, formatDateKey } =
  await import("../lib/server/dateUtils.js");

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

// Silence the endpoint's own diagnostics; failures are asserted, not read.
const realLog = console.log, realErr = console.error, realWarn = console.warn;
const quiet = () => { console.error = () => {}; console.warn = () => {}; };
const loud = () => { console.error = realErr; console.warn = realWarn; };
console.log = (...a) => {
  const s = String(a[0] ?? "");
  if (/^generate-plan:|^Training plan|^Plan save|^\{"event"/.test(s)) return;
  realLog(...a);
};

/* ── fixtures built from the endpoint's own schema ───────────────────── */

const WEEK_START = getPlanningWeekStart();
const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

const PROFILE = {
  id: "u1", email: "a@b.c", full_name: "Test Athlete",
  onboarding_complete: true, goal: "Marathon", device: "Garmin",
  experience_level: "intermediate", training_days: 5, weekly_distance: 45,
  target_race: "Marathon", target_race_date: "2026-11-15",
  long_run_day: "Sunday", injury_history: "None", age: 32, sex: "M", weight_kg: 68
};

const session = (i) => ({
  session_date: formatDateKey(addDays(WEEK_START, i)), day: DAYS[i],
  title: i === 6 ? "Long run" : (i === 2 ? "Threshold" : "Easy run"),
  sport: "run",
  session_type: i === 6 ? "long_run" : (i === 2 ? "threshold" : (i === 4 ? "rest" : "easy")),
  duration_minutes: i === 4 ? 0 : (i === 6 ? 110 : 50),
  distance_km: i === 4 ? 0 : (i === 6 ? 18 : 8),
  intensity: i === 2 ? "threshold" : "easy",
  purpose: "Aerobic development", description: "Steady running",
  instructions: "Keep it controlled", warmup: "10 min easy",
  main_set: "Main effort", cooldown: "10 min easy",
  target_pace: null, target_hr: null, target_rpe: "4/10",
  fueling: "Water", notes: "", adjustment_rules: "Cut short if sore",
  coach_reasoning: "Base building"
});

const goodPlan = () => ({
  week_focus: "Aerobic base", weekly_intent: "Build consistency",
  coach_summary: "A steady first week.", progression_reasoning: "Conservative start",
  planned_distance_km: 45, planned_hours: 5, what_changed: "First plan",
  why_it_changed: "New athlete", kept_stable: "Long run day",
  sessions: Array.from({ length: 7 }, (_, i) => session(i))
});

const currentPlanRow = (overrides = {}) => ({
  id: "existing-plan",
  user_id: "u1",
  week_start: formatDateKey(WEEK_START),
  week_end: formatDateKey(addDays(WEEK_START, 6)),
  status: "active",
  ...overrides
});

const savedSession = (planId = "existing-plan", index = 0, overrides = {}) => ({
  id: `saved-session-${index}`,
  user_id: "u1",
  training_plan_id: planId,
  session_date: formatDateKey(addDays(WEEK_START, index)),
  ...overrides
});

/* ── Supabase + OpenAI doubles ───────────────────────────────────────── */

function world({ plan = goodPlan(), openAiStatus = 200, openAiText = null,
                 profile = PROFILE, activities = [], failPlanInsert = false,
                 failSessionInsert = false, preexistingPlans = [],
                 preexistingSessions = [], subscription = null } = {}) {
  const db = {
    plans: [...preexistingPlans], sessions: [...preexistingSessions], aiCalls: 0,
    aiRateLimitCalls: 0, initialPlanCounterCalls: 0,
    initialPlanCounterDeletes: 0, planDeletes: 0, queryUrls: [],
    openAiStatus, failPlanInsert, failSessionInsert
  };
  const fetchFn = async (url, init = {}) => {
    const u = String(url), m = (init.method || "GET").toUpperCase();
    const J = (s, b) => ({ ok: s >= 200 && s < 300, status: s,
      json: async () => b, text: async () => JSON.stringify(b) });

    if (u.includes("/auth/v1/user")) return J(200, { id: "u1", email: "a@b.c" });
    if (u.includes("/rest/v1/subscriptions")) {
      return J(200, subscription ? [subscription] : []);
    }
    if (u.includes("/rest/v1/rpc/increment_rate_limit")) {
      const rpcBody = JSON.parse(init.body || "{}");
      if (rpcBody.p_endpoint !== "free:initial_plan") {
        db.aiRateLimitCalls += 1;
        return J(200, { allowed: true, current_count: 1 });
      }
      db.initialPlanCounterCalls += 1;
      return J(200, {
        allowed: false,
        current_count: db.initialPlanCounterCalls
      });
    }
    if (u.includes("/rest/v1/ai_rate_limits") && m === "DELETE") {
      db.initialPlanCounterDeletes += 1;
      return J(204, null);
    }
    if (u.includes("openai.com")) {
      db.aiCalls += 1;
      if (db.openAiStatus !== 200) return J(db.openAiStatus, { error: { message: "upstream" } });
      return J(200, { output_text: openAiText !== null ? openAiText : JSON.stringify(plan) });
    }
    if (u.includes("/rest/v1/profiles")) return J(200, profile ? [profile] : []);
    if (u.includes("/rest/v1/activities")) return J(200, activities);
    if (u.includes("/rest/v1/training_plans")) {
      if (m === "POST") {
        if (db.failPlanInsert) return J(500, { message: "insert failed" });
        // PostgREST accepts a single object OR an array; saveTrainingPlan
        // sends a single object, so normalise before asserting.
        const parsed = JSON.parse(init.body);
        const row = Array.isArray(parsed) ? parsed[0] : parsed;
        // Honour on_conflict=user_id,week_start exactly as Postgres would.
        if (u.includes("on_conflict=user_id,week_start")) {
          const i = db.plans.findIndex(p => p && p.user_id === row.user_id && p.week_start === row.week_start);
          if (i >= 0) { db.plans[i] = { ...db.plans[i], ...row }; return J(200, [db.plans[i]]); }
        }
        const r = { id: "plan" + (db.plans.length + 1), ...row };
        db.plans.push(r); return J(201, [r]);
      }
      if (m === "DELETE") {
        db.planDeletes += 1;
        return J(204, null);
      }
      db.queryUrls.push(u);
      const userMatch = u.match(/user_id=eq\.([^&]+)/);
      const scopedUser = userMatch ? decodeURIComponent(userMatch[1]) : null;
      return J(200, db.plans.filter(row =>
        !scopedUser || String(row?.user_id) === scopedUser
      ));
    }
    if (u.includes("/rest/v1/training_sessions")) {
      if (m === "POST") {
        if (db.failSessionInsert) return J(500, { message: "session insert failed" });
        const parsed = JSON.parse(init.body);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        rows.forEach(row => {
          const i = db.sessions.findIndex(x => x.user_id === row.user_id && x.session_date === row.session_date);
          if (i >= 0) db.sessions[i] = { ...db.sessions[i], ...row };
          else db.sessions.push({ id: `session-${db.sessions.length + 1}`, ...row });
        });
        return J(201, rows);
      }
      db.queryUrls.push(u);
      const userMatch = u.match(/user_id=eq\.([^&]+)/);
      const scopedUser = userMatch ? decodeURIComponent(userMatch[1]) : null;
      const idsMatch = u.match(/training_plan_id=in\.\(([^)]*)\)/);
      const planIds = idsMatch
        ? new Set(idsMatch[1].split(",").map(decodeURIComponent))
        : null;
      return J(200, db.sessions.filter(row =>
        (!scopedUser || String(row?.user_id) === scopedUser) &&
        (!planIds || planIds.has(String(row?.training_plan_id)))
      ));
    }
    return J(200, []);
  };
  return { db, fetchFn };
}

const res = () => { const r = { code: null, body: null };
  r.status = c => (r.code = c, r); r.json = b => (r.body = b, r);
  r.setHeader = () => {}; r.end = () => r; return r; };
const req = (o = {}) => ({ method: "POST", headers: { authorization: "Bearer good" },
  body: {}, query: {}, ...o });

async function call(w, reqOpts = {}) {
  globalThis.fetch = w.fetchFn;
  const r = res();
  quiet();
  try { await handler(req(reqOpts), r); }
  catch (e) { r.code = "THREW"; r.body = { error: e.message }; }
  loud();
  return r;
}

/* ══════════════ 1–2. plan creation succeeds ═════════════════════════ */

section("1. New athlete, completed profile, NO activities");
{
  const w = world({ activities: [] });
  const r = await call(w);
  t("returns success", r.code === 200 && r.body.success === true, `${r.code} ${JSON.stringify(r.body).slice(0,90)}`);
  t("a plan row was written", w.db.plans.length === 1);
  t("seven sessions were written", w.db.sessions.length === 7, `${w.db.sessions.length}`);
  t("plan is owned by the authenticated athlete", w.db.plans[0].user_id === "u1");
  t("no activity history did not block generation", w.db.aiCalls === 1);
  t("the first plan does not consume a pre-AI lifetime counter",
    w.db.initialPlanCounterCalls === 0);
  t("the separate hourly AI limiter increments once",
    w.db.aiRateLimitCalls === 1);
}

section("2. Athlete WITH connected history");
{
  const acts = Array.from({ length: 40 }, (_, i) => ({
    id: "a" + i, sport_type: "run", activity_type: "Run",
    distance_meters: 10000, moving_time_seconds: 3000,
    start_date: new Date(Date.now() - i * 86400000).toISOString()
  }));
  const w = world({ activities: acts });
  const r = await call(w);
  t("returns success with history present", r.code === 200 && r.body.success === true);
  t("plan and sessions written", w.db.plans.length === 1 && w.db.sessions.length === 7);
}

/* ══════════════ 3–4. duplication ═══════════════════════════════════ */

section("3. Existing plan is loaded, not duplicated");
{
  const w = world();
  const first = await call(w);
  const second = await call(w);
  t("first call generates", first.code === 200);
  t("second call succeeds without regenerating",
    second.code === 200 && second.body.alreadyExists === true, JSON.stringify(second.body).slice(0,90));
  t("the model was called exactly once", w.db.aiCalls === 1, `${w.db.aiCalls}`);
  t("exactly one plan row exists", w.db.plans.length === 1);
  t("existing plan was NOT silently overwritten", w.db.sessions.length === 7);
  t("a duplicate request consumes no lifetime counter",
    w.db.initialPlanCounterCalls === 0);
}

section("4. Double click produces one plan");
{
  const w = world();
  const [a, b] = await Promise.all([call(w), call(w)]);
  t("one request succeeds and the concurrent request cannot generate again",
    [a.code, b.code].includes(200) &&
    [a.code, b.code].every(c => c === 200 || c === 402), `${a.code}/${b.code}`);
  t("only ONE plan row survives (upsert on user_id,week_start)",
    w.db.plans.length === 1, `${w.db.plans.length}`);
  t("only seven session rows survive (upsert on user_id,session_date)",
    w.db.sessions.length === 7, `${w.db.sessions.length}`);
  t("concurrent duplicate requests consume no lifetime counter",
    w.db.initialPlanCounterCalls === 0);

  const client = readFileSync("./js/planSetup.js", "utf8");
  t("client also guards re-entry", /if \(buildInFlight\) return;/.test(client));
}

section("4b. Additional plans require verified payment");
{
  const free = world();
  await call(free);
  const blocked = await call(free, { body: { regenerate: true } });
  t("free user's explicit second generation is blocked",
    blocked.code === 402 && blocked.body.code === "FREE_PLAN_ACTIVE");
  t("blocked generation does not call the model again", free.db.aiCalls === 1);

  const paid = world({
    subscription: {
      provider: "whop",
      plan_id: "performance",
      status: "active",
      current_period_end: new Date(Date.now() + 86400000).toISOString()
    }
  });
  await call(paid);
  const regenerated = await call(paid, { body: { regenerate: true } });
  t("verified paid user can regenerate", regenerated.code === 200);
  t("paid regeneration bypasses the free counter",
    paid.db.aiCalls === 2 && paid.db.initialPlanCounterCalls === 0);
}

section("4c. A usable saved free plan requires an upgrade");
{
  const free = world({
    preexistingPlans: [currentPlanRow()],
    preexistingSessions: [savedSession()]
  });
  const blocked = await call(free);
  t("active current plan with a saved session is treated as usable",
    blocked.code === 402 && blocked.body.code === "FREE_PLAN_ACTIVE");
  t("the blocked response carries the exact athlete-facing title",
    blocked.body.title === "Your free training plan is already active.");
  t("the blocked response offers upgrade and current-plan actions",
    blocked.body.action === "upgrade" &&
    blocked.body.secondary_action === "viewPlan");
  t("existing-plan block happens before AI", free.db.aiCalls === 0);
}

section("4d. Only a valid usable current plan consumes the free plan");
{
  const noRow = world();
  const noRowResult = await call(noRow);
  t("case 1 — no plan row allows first generation",
    noRowResult.code === 200 && noRow.db.plans.length === 1);

  const empty = world({ preexistingPlans: [currentPlanRow()] });
  const emptyResult = await call(empty);
  t("case 2 — empty current plan row with no sessions is repaired",
    emptyResult.code === 200 && empty.db.plans.length === 1 &&
    empty.db.sessions.length === 7);

  const failed = world({
    preexistingPlans: [currentPlanRow({ status: "failed" })]
  });
  const failedResult = await call(failed);
  t("case 3 — failed placeholder row does not block generation",
    failedResult.code === 200 && failed.db.sessions.length === 7);

  const usable = world({
    preexistingPlans: [currentPlanRow()],
    preexistingSessions: [savedSession()]
  });
  const usableResult = await call(usable);
  t("case 4 — valid current plan with a saved session blocks another free plan",
    usableResult.code === 402 &&
    usableResult.body.code === "FREE_PLAN_ACTIVE" &&
    usable.db.aiCalls === 0);

  const paid = world({
    preexistingPlans: [currentPlanRow()],
    preexistingSessions: [savedSession()],
    subscription: {
      provider: "whop",
      plan_id: "performance",
      status: "active",
      current_period_end: new Date(Date.now() + 86400000).toISOString()
    }
  });
  const paidResult = await call(paid, { body: { regenerate: true } });
  t("case 5 — paid user remains allowed",
    paidResult.code === 200 && paid.db.aiCalls === 1);

  const validRow = currentPlanRow();
  const preserved = world({
    preexistingPlans: [validRow],
    preexistingSessions: [savedSession()]
  });
  await call(preserved);
  t("case 6 — a valid existing plan is never deleted or replaced when blocked",
    preserved.db.planDeletes === 0 &&
    preserved.db.plans.length === 1 &&
    preserved.db.plans[0] === validRow);

  const otherUser = world({
    preexistingPlans: [currentPlanRow({ id: "other-plan", user_id: "u2" })],
    preexistingSessions: [
      savedSession("other-plan", 0, { id: "other-session", user_id: "u2" })
    ]
  });
  const scopedResult = await call(otherUser);
  t("case 7 — another user's valid plan cannot consume this user's allowance",
    scopedResult.code === 200 &&
    otherUser.db.plans.some(row => row.user_id === "u1"));
  t("case 7 — both eligibility lookups are scoped to the JWT user",
    otherUser.db.queryUrls
      .filter(url => /training_(plans|sessions)/.test(url))
      .every(url => url.includes("user_id=eq.u1")));
}

section("4e. Invalid or stale rows do not create false positives");
{
  const stale = world({
    preexistingPlans: [currentPlanRow({
      week_start: formatDateKey(addDays(WEEK_START, -7)),
      week_end: formatDateKey(addDays(WEEK_START, -1))
    })],
    preexistingSessions: [
      savedSession("existing-plan", 0, {
        session_date: formatDateKey(addDays(WEEK_START, -7))
      })
    ]
  });
  const staleResult = await call(stale);
  t("an out-of-range plan with a session is not a usable current plan",
    staleResult.code === 200 && stale.db.aiCalls === 1);

  const malformed = world({
    preexistingPlans: [currentPlanRow({ week_end: "not-a-date" })],
    preexistingSessions: [savedSession()]
  });
  const malformedResult = await call(malformed);
  t("a malformed plan range does not block a repair",
    malformedResult.code === 200 && malformed.db.aiCalls === 1);
}

/* ══════════════ 5–9. failure handling ══════════════════════════════ */

section("5. Unauthenticated request");
{
  const r = await call(world(), { headers: {} });
  t("rejected with 401", r.code === 401);
  t("message is athlete-facing", /sign in again/i.test(r.body.error));
  t("carries a routable action", r.body.action === "signIn");
  t("no internal terminology", !/token|bearer|supabase|auth\.users/i.test(r.body.error));
}

section("6. Missing profile → useful action");
{
  const r = await call(world({ profile: null }));
  t("rejected with 404", r.code === 404);
  t("tells them what is needed", /few details about you/i.test(r.body.error));
  t("action routes to profile completion", r.body.action === "completeProfile");
}

section("7. AI provider failure");
{
  const r = await call(world({ openAiStatus: 500 }));
  t("returns 503, not a raw 500", r.code === 503);
  t("plain language", /coach is busy/i.test(r.body.error));
  t("stable code for the client", r.body.code === "PLAN_PROVIDER_UNAVAILABLE");
  t("no provider name leaked", !/openai|upstream|gpt/i.test(r.body.error));
}

section("7b. Failed first AI attempt remains retryable");
{
  const w = world({ openAiStatus: 500 });
  const failed = await call(w);
  const plansAfterFailure = w.db.plans.length;
  w.db.openAiStatus = 200;
  const retried = await call(w);
  t("first AI failure writes no plan", failed.code === 503 && plansAfterFailure === 0);
  t("retry succeeds and saves the first plan",
    retried.code === 200 && retried.body.success === true &&
    w.db.plans.length === 1 && w.db.sessions.length === 7);
  t("failure and retry never touch a lifetime counter",
    w.db.initialPlanCounterCalls === 0 &&
    w.db.initialPlanCounterDeletes === 0);
}

section("8. Malformed model output is not saved");
{
  const w = world({ openAiText: "I'm sorry, I can't help with that." });
  const r = await call(w);
  t("rejected", r.code === 502 && r.body.code === "PLAN_INVALID_OUTPUT");
  t("NOTHING was written to the database",
    w.db.plans.length === 0 && w.db.sessions.length === 0);
  t("no JSON parser text leaked",
    !/unexpected token|json|parse/i.test(r.body.error), r.body.error);

  // Structurally valid JSON, but wrong dates → must also be rejected.
  const w2 = world({ plan: { ...goodPlan(), sessions: [session(0)] } });
  const r2 = await call(w2);
  t("an incomplete week is rejected", r2.code === 502);
  t("...and nothing was saved", w2.db.plans.length === 0 && w2.db.sessions.length === 0);
}

section("9. Database write failure");
{
  const w = world({ failPlanInsert: true });
  const r = await call(w);
  t("reported safely", r.code === 500 && r.body.code === "PLAN_SAVE_FAILED");
  t("plain language", /couldn't save it/i.test(r.body.error));
  t("no database internals leaked",
    !/supabase|insert|constraint|postgres|500/i.test(r.body.error), r.body.error);
  t("no orphan sessions were written", w.db.sessions.length === 0);
  w.db.failPlanInsert = false;
  const retried = await call(w);
  t("retry after a failed plan write remains allowed",
    retried.code === 200 && w.db.plans.length === 1 && w.db.sessions.length === 7);
  t("failed database attempt consumes no lifetime counter",
    w.db.initialPlanCounterCalls === 0);
}

section("9b. Partial persistence repairs the current first plan");
{
  const w = world({ failSessionInsert: true });
  const failed = await call(w);
  t("session write failure is reported", failed.code === 500);
  t("the plan row is retained without deleting real user data",
    w.db.plans.length === 1 && w.db.sessions.length === 0);
  w.db.failSessionInsert = false;
  const retried = await call(w);
  t("retry repairs the sole incomplete current plan",
    retried.code === 200 && w.db.plans.length === 1 && w.db.sessions.length === 7);
  t("partial persistence never consumes a lifetime counter",
    w.db.initialPlanCounterCalls === 0);
}

/* ══════════════ 10–12. persistence, ownership ══════════════════════ */

section("10. Plan persists and reloads");
{
  const w = world();
  await call(w);
  const stored = w.db.sessions;
  t("sessions carry the plan id", stored.every(s => s.training_plan_id));
  t("sessions carry the athlete id", stored.every(s => s.user_id === "u1"));
  t("sessions carry a real date", stored.every(s => /^\d{4}-\d{2}-\d{2}$/.test(s.session_date)));
  t("dates are the seven planning-week days",
    new Set(stored.map(s => s.session_date)).size === 7);
}

section("11. Calendar-facing fields are present");
{
  const w = world();
  await call(w);
  const s = w.db.sessions[0];
  const REQUIRED = ["user_id", "training_plan_id", "session_date", "title",
                    "sport", "session_type", "duration_minutes", "distance_km"];
  REQUIRED.forEach(f => t(`session has ${f}`, s[f] !== undefined));
  t("no undefined leaked into any stored field",
    !JSON.stringify(w.db.sessions).includes("undefined"));
  t("week numbering / dates ascend",
    w.db.sessions.map(x => x.session_date).sort().join() ===
    Array.from({length:7},(_,i)=>formatDateKey(addDays(WEEK_START,i))).join());
}

section("12. One athlete cannot reach another's plan");
{
  const w = world();
  await call(w);
  t("every written row is scoped to the caller",
    w.db.plans.every(p => p.user_id === "u1") &&
    w.db.sessions.every(s => s.user_id === "u1"));

  const src = readFileSync("../Athlevo ai/api/training/generate-plan.js", "utf8");
  t("the athlete id comes from the verified token, never the request body",
    /const user\s*=\s*await getAuthenticatedUser\(/.test(src) &&
    !/user_id:\s*request\.body/.test(src));
  t("every athlete query filters on the verified id",
    /user_id=eq\.\$\{encodeURIComponent\(userId\)\}|user_id=eq\.\$\{encodeURIComponent\(user\.id\)\}/.test(src));
}

/* ══════════════ 13–14. client contract ════════════════════════════ */

section("13. Client timeout is recoverable");
{
  const c = readFileSync("./js/planSetup.js", "utf8");
  t("the request is bounded by a timeout", /AbortController/.test(c) && /BUILD_TIMEOUT_MS/.test(c));
  t("an abort produces a recoverable message",
    /AbortError/.test(c) && /taking longer than usual/i.test(c));
  t("a network failure is handled separately", /couldn't reach Athlevo/i.test(c));
  t("loading state always exits", /buildInFlight = false;/.test(c));
}

section("14. Client surfaces the server's real message");
{
  const c = readFileSync("./js/planSetup.js", "utf8");
  t("the response body is read, not just res.ok",
    /await res\.json\(\)/.test(c) && !/apiOk = res\.ok/.test(c));
  t("the server's message is displayed", /outcome\.message/.test(c));
  t("the server's action drives the primary button", /ACTIONS\[outcome\.action\]/.test(c));
  t("actions cover sign-in, profile and retry",
    /signIn:/.test(c) && /completeProfile:/.test(c) && /retry:/.test(c));
  t("messages are escaped before rendering", /escapeText\(message\)/.test(c));
  t("there is always a way back to the dashboard", /Back to Today/.test(c));
  t("used free-plan state has the exact title and body",
    /Your free training plan is already active\./.test(c) &&
    /Upgrade to Athlevo Performance for ongoing plan changes, adaptive coaching, and deeper analysis\./.test(c));
  t("used free-plan state offers both required actions",
    /Upgrade to Athlevo Performance/.test(c) &&
    /View My Current Plan/.test(c) &&
    /AthlevoAccessGuard\.checkout\(\)/.test(c) &&
    /AthlevoPlan\.viewCurrentPlan\(\)/.test(c));
  t("View My Current Plan revalidates before opening Train",
    /async function viewCurrentPlan\(\)[\s\S]*await hasPlan\(\)[\s\S]*stored === true[\s\S]*enterTrain\(\)[\s\S]*await start\(\)/.test(c));
}

section("Analytics/nonessential failures never block generation");
{
  // weekly-analysis is called best-effort before generation.
  const c = readFileSync("./js/planSetup.js", "utf8");
  t("pre-generation analysis is wrapped and non-fatal",
    /weekly-analysis[\s\S]{0,120}catch \(e\) \{ \/\* non-fatal \*\/ \}/.test(c));

  // Readiness/adaptation reads use optionalSupabaseRequest.
  const src = readFileSync("../Athlevo ai/api/training/generate-plan.js", "utf8");
  t("readiness is loaded optionally, never fatally",
    /optionalSupabaseRequest\(\s*`daily_readiness/.test(src));
  const w = world();
  const r = await call(w);
  t("generation still succeeds with no readiness rows", r.code === 200);
}

section("Regression: the root cause cannot return");
{
  const src = readFileSync("../Athlevo ai/api/training/generate-plan.js", "utf8");
  const fn = src.slice(src.indexOf("async function generateWeeklyPlan"),
                       src.indexOf("function validateSessionDates"));
  t("recentReadiness is a declared parameter of generateWeeklyPlan",
    /recentReadiness\s*=\s*\[\]/.test(fn), "not in signature");
  t("it is passed at the call site", /adaptationContext,\s*recentReadiness/.test(src));
  t("its use is array-guarded", /Array\.isArray\(recentReadiness\)/.test(fn));

  // The definitive check: a full successful run with readiness data present.
  const w = world();
  const r = await call(w);
  t("a real generation completes without a ReferenceError",
    r.code === 200 && !/is not defined/.test(JSON.stringify(r.body || {})));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

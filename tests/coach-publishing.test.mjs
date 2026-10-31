/**
 * Coach workout publishing: drafts are hidden until published; publish one / a week /
 * discard; and it all degrades safely on a database without the publishing columns.
 * Run: node tests/coach-publishing.test.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const read = f => readFileSync(resolve(import.meta.dirname, "..", f), "utf-8");

let passed = 0, failed = 0;
const test = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name + (detail ? `  [${detail}]` : "")); }
};
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.APP_URL = "https://athlevo.org";

function makeDb(hasColumns) {
  const state = { plans: [], sessions: [] };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const colError = () => json({ message: 'column training_sessions.coach_draft does not exist' }, 400);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname; const q = u.searchParams; const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === "/auth/v1/user") return (init.headers.Authorization === "Bearer tok-coach") ? json({ id: "c1" }) : json({}, 401);
    if (path === "/rest/v1/profiles") return json([{ id: "c1", role: "coach", full_name: "Coach" }]);
    if (path === "/rest/v1/coach_athlete_assignments") return json([{ id: "as1", coach_id: "c1", athlete_id: "a1", status: "active", permission_level: "read_write" }]);
    if (path === "/rest/v1/training_plans") {
      if (method === "GET") return json(state.plans);
      const row = { id: "plan1", ...body }; state.plans.push(row); return json([row], 201);
    }
    if (path === "/rest/v1/training_sessions") {
      const hasDraftFilter = (q.get("coach_draft") || "") !== "";
      if (!hasColumns && (hasDraftFilter || (body && ("coach_draft" in body || "published_at" in body)))) return colError();
      if (method === "GET") {
        let rows = state.sessions.slice();
        const sd = q.get("session_date"); if (sd && sd.startsWith("eq.")) rows = rows.filter(r => r.session_date === sd.slice(3));
        const id = q.get("id"); if (id && id.startsWith("eq.")) rows = rows.filter(r => r.id === id.slice(3));
        if (hasDraftFilter) rows = rows.filter(r => r.coach_draft === false);
        return json(rows);
      }
      if (method === "POST") { const row = { id: "s" + (state.sessions.length + 1), ...body }; state.sessions.push(row); return json([row], 201); }
      if (method === "PATCH") {
        const idEq = (q.get("id") || "").replace("eq.", "");
        const draftEq = q.get("coach_draft");
        let hit = state.sessions.filter(r => (!idEq || r.id === idEq) && (draftEq !== "is.true" || r.coach_draft === true));
        hit.forEach(r => Object.assign(r, body));
        return json(hit, 200);
      }
      if (method === "DELETE") {
        const draftEq = q.get("coach_draft");
        const before = state.sessions.length;
        const removed = state.sessions.filter(r => draftEq !== "is.true" || r.coach_draft === true);
        state.sessions = state.sessions.filter(r => !(draftEq !== "is.true" || r.coach_draft === true));
        return json(removed, 200);
      }
    }
    if (path.startsWith("/rest/v1/workout_execution_records")) return json([]);
    return json([], 200);
  };
  return state;
}

const handler = (await import("../api/providers/index.js")).default;
function call(action, method, body) {
  return new Promise(resolve => {
    const res = { code: 0, body: null, headers: {}, setHeader(k, v){res.headers[k]=v;}, status(c){res.code=c;return res;}, json(b){res.body=b;resolve(res);return res;}, end(){resolve(res);} };
    handler({ method, query: { action }, headers: { authorization: "Bearer tok-coach", origin: "https://athlevo.org" }, body }, res);
  });
}
const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const future2 = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
const w = d => ({ session_date: d, title: "Easy run", session_type: "Easy run", sport: "run", distance_km: 7 });

// ── With the publishing columns ──
let db = makeDb(true);
let r = await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future) });
test("a new workout is saved as a draft (hidden from the athlete)", r.code === 201 && db.sessions[0].coach_draft === true && db.sessions[0].published_at == null && r.body.published === false, JSON.stringify(r.body));

db = makeDb(true);
r = await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future), publish: true });
test("saving with Publish makes it visible at once", r.code === 201 && db.sessions[0].coach_draft === false && db.sessions[0].published_at != null && r.body.published === true, JSON.stringify(r.body));

db = makeDb(true);
await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future) });
await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future2) });
r = await call("coaching_dashboard_publish", "POST", { athlete_id: "a1", week_start: future.slice(0, 8) + "01" });
// week_start may not cover; use a wide window instead:
const monday = (() => { const d = new Date(future + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0,10); })();
db = makeDb(true);
await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future) });
await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future2) });
r = await call("coaching_dashboard_publish", "POST", { athlete_id: "a1", week_start: monday });
test("Publish week releases every draft in the week", r.code === 200 && r.body.published === 2 && db.sessions.every(s => s.coach_draft === false), JSON.stringify(r.body));

db = makeDb(true);
await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future) });
r = await call("coaching_dashboard_publish", "POST", { athlete_id: "a1", session_id: "s1" });
test("a single draft can be published by id", r.code === 200 && r.body.published === 1 && db.sessions[0].coach_draft === false, JSON.stringify(r.body));

db = makeDb(true);
await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future) });
r = await call("coaching_dashboard_publish", "POST", { athlete_id: "a1", week_start: monday, discard: true });
test("Discard drafts deletes the unpublished workouts", r.code === 200 && r.body.discarded === 1 && db.sessions.length === 0, JSON.stringify(r.body));

// ── Without the columns (migration not run): nothing breaks ──
db = makeDb(false);
r = await call("coaching_dashboard_workout", "POST", { athlete_id: "a1", workout: w(future) });
test("on an un-migrated database the workout still saves (and is reported visible)", r.code === 201 && db.sessions.length === 1 && !("coach_draft" in db.sessions[0]) && r.body.published === true, JSON.stringify(r.body));

db = makeDb(false);
r = await call("coaching_dashboard_publish", "POST", { athlete_id: "a1", week_start: monday });
test("publishing on an un-migrated database is a safe no-op", r.code === 200 && r.body.already_visible === true, JSON.stringify(r.body));

// ── The athlete's own reads hide drafts, with a safe fallback if the migration is not run ──
const getWeek = read("api/training/get-week.js");
test("the athlete week read filters to published workouts", /coach_draft=is\.false/.test(getWeek));
test("...and falls back to the unfiltered read if the column is missing", /requestVisibleSessions/.test(getWeek) && /coach_draft/.test(getWeek) && /catch/.test(getWeek));
const athleteModel = read("js/athleteModel.js");
test("today's session type ignores drafts, with a fallback", /\.eq\("coach_draft", false\)/.test(athleteModel) && /coach_draft/.test(athleteModel));
const fuel = read("js/fuel.js");
test("fuel planning ignores drafts, with a fallback", /coach_draft/.test(fuel) && /planQuery/.test(fuel));
const migration = read("migrations/2026-10-31_coach_workout_publishing.sql");
test("the migration is additive and backfills existing rows as visible", /add column if not exists coach_draft/.test(migration) && /default false/.test(migration) && /update public\.training_sessions/.test(migration));
const coachTraining = read("lib/server/coachTraining.js");
test("the coach week marks each workout published or draft", /published: session\.coach_draft === true \? false : true/.test(coachTraining));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

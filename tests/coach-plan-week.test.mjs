/**
 * A coach can add a workout for an athlete who has no training week yet, even when the
 * training_plans table insists on columns the AI planner normally fills in.
 * Run: node tests/coach-plan-week.test.mjs
 */
let passed = 0, failed = 0;
const test = (name, condition, detail = "") => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name + (detail ? `  [${detail}]` : "")); }
};

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.APP_URL = "https://athlevo.org";

function makeDatabase(mode) {
  const state = { plans: [], sessions: [], planAttempts: [] };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname; const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === "/auth/v1/user") return (init.headers.Authorization || "") === "Bearer tok-coach" ? json({ id: "c1", email: "coach@x.com" }) : json({}, 401);
    if (path === "/rest/v1/profiles") return json([{ id: "c1", role: "coach", full_name: "Coach" }]);
    if (path === "/rest/v1/coach_athlete_assignments") return json([{ id: "as1", coach_id: "c1", athlete_id: "a1", status: "active", permission_level: "read_write" }]);
    if (path === "/rest/v1/training_plans") {
      if (method === "GET") return json(state.plans);
      state.planAttempts.push(body);
      if (mode === "always-fails") return json({ message: "permission denied for table training_plans" }, 403);
      // Older schema: the adaptation column has not been added yet.
      if (mode === "rejects-adaptation" && "adaptation" in body) {
        return json({ message: 'column "adaptation" of relation "training_plans" does not exist' }, 400);
      }
      // Stricter schema: a NOT NULL column the AI planner fills but our base does not carry.
      if (mode === "needs-extra" && body.intensity_focus == null) {
        return json({ message: 'null value in column "intensity_focus" of relation "training_plans" violates not-null constraint' }, 400);
      }
      const row = { id: "plan" + (state.plans.length + 1), ...body };
      state.plans.push(row);
      return json([row], 201);
    }
    if (path === "/rest/v1/training_sessions") {
      if (method === "GET") return json(state.sessions);
      const row = { id: "s" + (state.sessions.length + 1), ...body };
      state.sessions.push(row);
      return json([row], 201);
    }
    return json([], 200);
  };
  return state;
}

const handler = (await import("../api/providers/index.js")).default;
function call(body) {
  return new Promise(resolve => {
    const res = { code: 0, body: null, headers: {}, setHeader(k, v) { res.headers[k] = v; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; resolve(res); return res; }, end() { resolve(res); } };
    handler({ method: "POST", query: { action: "coaching_dashboard_workout" }, headers: { authorization: "Bearer tok-coach", origin: "https://athlevo.org" }, body }, res);
  });
}
const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const workout = { session_date: future, title: "Easy run", session_type: "Easy run", sport: "run", distance_km: 8, pace_guidance: "5:38–6:14 /km" };

let db = makeDatabase("plain");
let r = await call({ athlete_id: "a1", workout });
test("a plain insert opens the week and saves the workout", r.code === 201 && db.sessions.length === 1 && db.plans.length === 1 && db.planAttempts.length === 1, JSON.stringify(r.body));
test("only the chosen target is stored (distance, no time)", db.sessions[0].distance_km === 8 && db.sessions[0].duration_minutes == null, JSON.stringify(db.sessions[0]));

db = makeDatabase("rejects-adaptation");
r = await call({ athlete_id: "a1", workout });
test("when the adaptation column is missing, it is dropped and the week still opens", r.code === 201 && db.plans.length === 1 && !("adaptation" in db.plans[0]) && db.planAttempts.length === 2, JSON.stringify(r.body));

db = makeDatabase("needs-extra");
r = await call({ athlete_id: "a1", workout });
test("a NOT NULL column our base doesn't carry is read from the error and filled in", r.code === 201 && db.plans.length === 1 && db.plans[0].intensity_focus != null && db.planAttempts.length === 2, JSON.stringify(r.body));

db = makeDatabase("always-fails");
r = await call({ athlete_id: "a1", workout });
test("a real database refusal returns the reason and detail, not a blank error", r.code === 409 && r.body.reason === "create_plan_failed" && /permission denied/.test(r.body.detail || "") && db.sessions.length === 0, JSON.stringify(r.body));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

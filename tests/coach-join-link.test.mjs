/**
 * Coach join links + in-app coach grants (no email service needed).
 * Run: node tests/coach-join-link.test.mjs
 */
import { readFileSync } from "node:fs";
import {
  generateJoinCode, normalizeJoinCode, validateJoinCode, JOIN_CODE_LENGTH
} from "../lib/server/coachInvites.js";

let passed = 0, failed = 0;
const test = (name, condition, detail = "") => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name + (detail ? `  [${detail}]` : "")); }
};
const section = n => console.log(`\n──── ${n} ────`);
const read = f => readFileSync(f, "utf8");

section("Join codes");
const codes = new Set(Array.from({ length: 500 }, generateJoinCode));
test("codes are 8 chars from the unambiguous alphabet", [...codes].every(c => c.length === JOIN_CODE_LENGTH && validateJoinCode(c)) && ![...codes].some(c => /[01ilo]/.test(c)));
test("500 codes are all different", codes.size === 500);
test("normalising trims and lowercases; junk is rejected",
  normalizeJoinCode("  ABCD2345 ") === "abcd2345" && validateJoinCode("ABCD2345") && !validateJoinCode("abc") && !validateJoinCode("abcd234!") && !validateJoinCode("abcd0123") && !validateJoinCode(null));

section("Migration");
const sql = read("migrations/2026-10-31_coach_join_links_and_grants.sql");
test("table, unique code, one active link per coach, RLS on", /create table if not exists public\.coach_join_links/.test(sql) && /coach_join_links_code_unique/.test(sql) && /coach_join_links_one_active_per_coach[\s\S]{0,80}where active/.test(sql) && /alter table public\.coach_join_links enable row level security/.test(sql));
test("both functions are service-role only", /revoke all on function public\.athlevo_join_coach_by_code[\s\S]*from public, anon, authenticated/.test(sql) && /revoke all on function public\.athlevo_set_role_by_email[\s\S]*from public, anon, authenticated/.test(sql) && /grant execute on function public\.athlevo_join_coach_by_code\(text, uuid\) to service_role/.test(sql) && /grant execute on function public\.athlevo_set_role_by_email\(text, text\) to service_role/.test(sql));
test("joining refuses a second active coach and never promotes to admin", /has_other_coach/.test(sql) && /'is_admin'/.test(sql) && /p_role not in \('coach', 'athlete'\)/.test(sql));

section("Gateway behaviour (in-memory database)");
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.APP_URL = "https://athlevo.org";
const users = {
  "tok-coach": { id: "c1", email: "coach@x.com" },
  "tok-admin": { id: "a1", email: "dean@x.com" },
  "tok-ath": { id: "t1", email: "ath@x.com" },
  "tok-ath2": { id: "t2", email: "ath2@x.com" }
};
const profiles = { c1: { id: "c1", role: "coach", full_name: "Coach Louie" }, a1: { id: "a1", role: "admin", full_name: "Dean" },
  t1: { id: "t1", role: "athlete", full_name: "Ana" }, t2: { id: "t2", role: "athlete", full_name: "Ben" }, n1: { id: "n1", role: "athlete", full_name: "New" } };
const authEmails = { "newcoach@x.com": "n1", "ath@x.com": "t1" };
let links = [];
let assignments = [{ id: "as0", coach_id: "c9", athlete_id: "t2", status: "active" }];
const realFetch = globalThis.fetch;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const path = u.pathname; const q = u.searchParams; const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === "/auth/v1/user") {
    const t = (init.headers.Authorization || "").replace("Bearer ", "");
    return users[t] ? json(users[t]) : json({}, 401);
  }
  if (path === "/rest/v1/profiles") { const id = (q.get("id") || "").replace("eq.", ""); return json(profiles[id] ? [profiles[id]] : []); }
  if (path === "/rest/v1/coach_join_links") {
    if (method === "GET") {
      const code = q.get("code"); const coach = q.get("coach_id");
      return json(links.filter(l => l.active && (!code || l.code === code.replace("eq.", "")) && (!coach || l.coach_id === coach.replace("eq.", ""))));
    }
    if (method === "POST") {
      if (links.some(l => l.code === body.code)) return json({}, 409);
      const row = { id: "l" + links.length, ...body, active: true }; links.push(row); return json([row], 201);
    }
    if (method === "PATCH") { const id = q.get("id").replace("eq.", ""); links.filter(l => l.id === id).forEach(l => Object.assign(l, body)); return json([{}]); }
  }
  if (path === "/rest/v1/coach_athlete_assignments") {
    const ath = (q.get("athlete_id") || "").replace("eq.", "");
    return json(assignments.filter(a => a.athlete_id === ath && ["invited", "active", "paused"].includes(a.status)));
  }
  if (path === "/rest/v1/rpc/athlevo_join_coach_by_code") {
    const l = links.find(x => x.code === body.p_code && x.active);
    if (!l) return json([{ result_state: "invalid" }]);
    if (assignments.some(a => a.coach_id === l.coach_id && a.athlete_id === body.p_athlete_id)) return json([{ result_state: "already_on_roster" }]);
    if (assignments.some(a => a.athlete_id === body.p_athlete_id && a.status === "active")) return json([{ result_state: "has_other_coach" }]);
    assignments.push({ id: "n" + assignments.length, coach_id: l.coach_id, athlete_id: body.p_athlete_id, status: "active" });
    return json([{ result_state: "accepted_now", result_coach_id: l.coach_id }]);
  }
  if (path === "/rest/v1/rpc/athlevo_set_role_by_email") {
    const id = authEmails[body.p_email]; if (!id) return json([{ result_state: "not_found" }]);
    if (profiles[id].role === "admin") return json([{ result_state: "is_admin" }]);
    profiles[id].role = body.p_role; return json([{ result_state: "updated", result_role: body.p_role }]);
  }
  return json([], 404);
};
const handler = (await import("../api/providers/index.js")).default;
function call(action, token, body, method = "POST") {
  return new Promise(resolve => {
    const res = { code: 0, body: null, headers: {}, setHeader(k, v) { res.headers[k] = v; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; resolve(res); return res; }, end() { resolve(res); } };
    handler({ method, query: { action }, headers: { authorization: token ? "Bearer " + token : "", origin: "https://athlevo.org" }, body }, res);
  });
}

let r = await call("coaching_join_link", "tok-coach", {});
const code = r.body && r.body.code;
test("a coach gets a link: 8-char code and an athlevo.org/?coach= URL", r.code === 201 && validateJoinCode(code) && r.body.url === `https://athlevo.org/?coach=${code}`, JSON.stringify(r.body));
r = await call("coaching_join_link", "tok-coach", {});
test("asking again returns the same link", r.code === 200 && r.body.code === code && r.body.created === false);
r = await call("coaching_join_link", "tok-ath", {});
test("an athlete cannot get a coach link", r.code === 403);
r = await call("coaching_join_link", null, {});
test("signed-out requests are refused", r.code === 401);
r = await call("coaching_join_link", "tok-coach", { rotate: true });
const code2 = r.body && r.body.code;
test("rotating makes a new code and the old one stops working", r.code === 201 && code2 && code2 !== code && links.filter(l => l.active).length === 1 && links.find(l => l.code === code).active === false);

r = await call("coaching_join_accept", "tok-ath", { code, intent: "preview" });
test("the retired code is invalid", r.code === 404 && r.body.state === "invalid");
r = await call("coaching_join_accept", "tok-ath", { code: "nope", intent: "preview" });
test("a malformed code is rejected before any lookup", r.code === 400);
r = await call("coaching_join_accept", "tok-ath", { code: code2, intent: "preview" });
test("preview shows the coach's name and that joining is possible", r.code === 200 && r.body.state === "pending" && r.body.coach_name === "Coach Louie");
r = await call("coaching_join_accept", "tok-coach", { code: code2, intent: "preview" });
test("a coach opening their own link gets 'conflict'", r.body.state === "conflict");
r = await call("coaching_join_accept", "tok-ath2", { code: code2, intent: "preview" });
test("an athlete who already has another coach is told so", r.body.state === "has_other_coach");
r = await call("coaching_join_accept", "tok-ath2", { code: code2, intent: "accept" });
test("…and cannot join anyway", r.code === 409 && !r.body.accepted && !assignments.some(a => a.athlete_id === "t2" && a.coach_id === "c1"));
r = await call("coaching_join_accept", "tok-ath", { code: code2, intent: "accept" });
test("confirming adds the athlete to the coach's roster", r.code === 200 && r.body.accepted === true && assignments.some(a => a.athlete_id === "t1" && a.coach_id === "c1" && a.status === "active"));
r = await call("coaching_join_accept", "tok-ath", { code: code2, intent: "accept" });
test("joining twice is harmless", r.code === 200 && r.body.already_on_roster === true && assignments.filter(a => a.athlete_id === "t1").length === 1);

r = await call("coaching_grant_coach", "tok-admin", { email: "newcoach@x.com" });
test("an admin can make a signed-up user a coach", r.code === 200 && profiles.n1.role === "coach");
r = await call("coaching_grant_coach", "tok-admin", { email: "nobody@x.com" });
test("an unknown email gets a clear 'sign up first' message", r.code === 404 && /sign up first/i.test(r.body.error));
r = await call("coaching_grant_coach", "tok-coach", { email: "ath@x.com" });
test("a coach (not admin) cannot grant coach access", r.code === 403 && profiles.t1.role === "athlete");
r = await call("coaching_grant_coach", "tok-ath", { email: "ath@x.com" });
test("an athlete cannot grant access to themselves", r.code === 403 && profiles.t1.role === "athlete");
r = await call("coaching_grant_coach", "tok-admin", { email: "dean@x.com" });
test("an admin cannot change their own access", r.code === 400);
r = await call("coaching_grant_coach", "tok-admin", { email: "not-an-email" });
test("a bad email is rejected", r.code === 400);
globalThis.fetch = realFetch;

section("Client");
const ci = read("js/coachInvites.js");
const html = read("index.html");
const cm = read("js/coachMode.js");
test("the ?coach= link is captured for the session and removed from the URL", /searchParams\.get\("coach"\)[\s\S]{0,400}athlevo_pending_join[\s\S]{0,200}searchParams\.delete\("coach"\)/.test(html));
test("after sign-in the athlete confirms before joining (never silent)", /waitForJoinDecision[\s\S]{0,2500}coaching_join_accept|joinRequest\(code, "accept"\)/.test(ci) && /resumeJoinAfterAuth/.test(ci) && /id="ciAcceptInvite">Join/.test(ci));
test("a pending join link counts as a pending invite (welcome, not landing)", /hasPendingInvite: function \(\) \{ return Boolean\(pendingToken\(\) \|\| pendingJoin\(\)\); \}/.test(ci));
test("the coach's Invite Athlete dialog leads with the link: copy, share, new link", /id="cmJoinCopy"/.test(cm) && /id="cmJoinShare"/.test(cm) && /id="cmJoinNew"/.test(cm) && /coaching_join_link/.test(cm) && /Or invite by email/.test(cm));
test("admins get an Add Coach button; coaches do not", /_role === "admin" \? '<button type="button" class="cm-invite-trigger" id="cmAddCoach">/.test(cm) && /coaching_grant_coach/.test(cm));
test("the join link is wired into the gateway without a new serverless function", /action === "coaching_join_link"/.test(read("api/providers/index.js")) && /action === "coaching_grant_coach"/.test(read("api/providers/index.js")));

test("coaches and admins land in the Coach Workspace after sign-in (athlete view stays one tap away)",
  /window\.ATHLEVO_COACH_LED === true && window\.AthlevoCoachMode &&[\s\S]{0,300}canAccessCoachWorkspace\(\) &&[\s\S]{0,120}isAthleteWorkspace\(\)\) \{\s*try \{ window\.AthlevoCoachMode\.switchToCoachWorkspace\(\)/.test(html));
test("a bootstrap script exists to make the first admin by email", /role = 'admin'/.test(read("migrations/coach_accounts_bootstrap_admin.sql")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

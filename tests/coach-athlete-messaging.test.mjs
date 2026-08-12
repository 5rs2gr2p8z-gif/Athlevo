/* Executable Athlete Detail → human Coach Messaging integration checks. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import providerHandler from "../api/providers/index.js";
import {
  buildCoachThread,
  sanitizeCoachMessage,
  validateCoachMessage
} from "../lib/server/coachMessaging.js";

const source = readFileSync("./js/coachMode.js", "utf8");
const apiSource = readFileSync("./api/providers/index.js", "utf8");
const migration = readFileSync("./migrations/2026-08-12_coach_messages.sql", "utf8");
let passed = 0;
let failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
};

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0, quote = null, escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const athlete = { athlete_id: "athlete-1", name: "Adi", initials: "A" };
const context = {
  _messageOrigin: "athlete_detail",
  _roster: [athlete],
  _athleteDetail: athlete,
  Date,
  Number,
  String,
  Array,
  esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }
};
vm.runInNewContext(
  `${["rosterAthlete", "coachMessageTime", "renderCoachThread"].map(extractFunction).join("\n")}
   this.renderCoachThread = renderCoachThread;`,
  context
);

const row = (overrides = {}) => ({
  id: "message-1",
  coach_id: "coach-1",
  athlete_id: "athlete-1",
  sender_user_id: "coach-1",
  sender_role: "coach",
  body: "How did today’s session feel?",
  created_at: "2026-08-12T06:18:00Z",
  ...overrides
});

console.log("\n──── Message model and thread identity ────");
{
  test("blank messages are rejected", validateCoachMessage({ body: "  " }).ok === false);
  test("valid message preserves exact trimmed text", validateCoachMessage({ body: "  Check in after the run.  " }).value.body === "Check in after the run.");
  test("overlong messages fail instead of truncating", validateCoachMessage({ body: "x".repeat(4001) }).ok === false);
  const clean = sanitizeCoachMessage(row());
  test("sanitized message retains only display fields", JSON.stringify(Object.keys(clean).sort()) === JSON.stringify(["body", "created_at", "id", "sender_role"]));
  test("unknown sender roles fail closed", sanitizeCoachMessage(row({ sender_role: "admin" })) === null);
  const thread = buildCoachThread([
    row({ id: "later", created_at: "2026-08-12T07:00:00Z" }),
    row({ id: "earlier", sender_role: "athlete", sender_user_id: "athlete-1", created_at: "2026-08-12T06:00:00Z" })
  ], { canSend: true });
  test("history is ordered oldest to newest", thread.messages.map(message => message.id).join(",") === "earlier,later");
  test("assignment pair is the thread identity; no thread table exists", !/create table[^;]*thread/i.test(migration) && /coach_id, athlete_id, created_at/.test(migration));
  const messageAction = apiSource.slice(apiSource.indexOf("async function actionCoachingDashboardMessages"), apiSource.indexOf("async function actionCoachingDashboardReview"));
  test("human messaging never reuses athlete AI coach_conversations", !/coach_conversations/.test(migration) && !/coach_conversations/.test(messageAction));
}

console.log("\n──── Athlete-scoped and empty/history UI ────");
{
  const existing = context.renderCoachThread("athlete-1", buildCoachThread([
    row({ sender_role: "athlete", sender_user_id: "athlete-1", body: "It felt controlled." }),
    row({ id: "message-2", created_at: "2026-08-12T07:00:00Z" })
  ], { canSend: true }));
  test("athlete name is explicit in compact thread header", /Adi/.test(existing) && /Athlete/.test(existing));
  test("existing coach and athlete messages are distinguishable", /is-athlete/.test(existing) && /is-coach/.test(existing));
  test("thread contains no athlete picker or conversation selector", !/Choose athlete|Select an athlete|<select/i.test(existing));
  test("composer is available in athlete context", /id="cmMessageComposer"/.test(existing) && /Message Adi/.test(existing));
  const empty = context.renderCoachThread("athlete-1", { messages: [], can_send: true });
  test("no-thread state is truthful and permits first send", /No messages yet\./.test(empty) && /Start a conversation with Adi\./.test(empty) && /cmMessageComposer/.test(empty));
  test("messages are escaped before DOM rendering", /&lt;script&gt;/.test(context.renderCoachThread("athlete-1", { messages: [{ ...sanitizeCoachMessage(row()), body: "<script>" }], can_send: false })));
}

console.log("\n──── Routing, context, caching, and global coexistence ────");
{
  const detailPage = source.slice(source.indexOf("function renderAthletePage"), source.indexOf("function metric"));
  const openMessaging = source.slice(source.indexOf("async function openAthleteMessaging"), source.indexOf("function renderCoachMessaging"));
  const globalMessaging = source.slice(source.indexOf("function renderCoachMessaging"), source.indexOf("function renderCoachTrain"));
  test("Athlete Detail header has one subtle Message action", /id="cmMessageAthlete">Message</.test(detailPage));
  test("entry passes the active athlete and originating tab", /openAthleteMessaging\(ath\.athlete_id, "athlete_detail", _athleteDetailTab\)/.test(source));
  test("Athlete Detail back restores the same athlete and tab", /_messageOrigin === "athlete_detail"[\s\S]*_athleteDetailTab = _messageReturnTab/.test(source));
  test("global directory remains and opens the selected athlete", /Coach Messaging/.test(globalMessaging) && /openAthleteMessaging\(item\.getAttribute\("data-athlete"\), "global"/.test(globalMessaging));
  test("global thread can open Athlete Detail with the same athlete", /cm-msg-athlete-detail/.test(source) && /openCoachAthletePage\(athleteId, "overview"\)/.test(source));
  const cachedPosition = openMessaging.indexOf("if (cached)");
  const requestPosition = openMessaging.indexOf('api("messages"');
  test("cached thread renders before the network request", cachedPosition >= 0 && cachedPosition < requestPosition);
  test("thread cache is keyed by athlete, preventing stale Adi content", /_messageThreadCache\[String\(athleteId\)\]/.test(openMessaging) && /requestId !== _messageRequest/.test(openMessaging));
  test("account logout clears cached message history", /function clearWorkspaceOnLogout\(\)[\s\S]*_messageThreadCache = Object\.create\(null\)/.test(source) && /clearWorkspaceOnLogout: clearWorkspaceOnLogout/.test(source));
  test("load failures do not masquerade as an empty conversation", /Messages unavailable\./.test(source) && /error: res\.status === 403/.test(openMessaging));
  test("stale send responses cannot overwrite a newly opened athlete", /var requestId = \+\+_messageRequest;[\s\S]*requestId !== _messageRequest \|\| !el\.classList\.contains\("active"\)/.test(source));
  test("messaging uses the existing single bottom-nav screen", /screen-coach-messaging/.test(source) && !/cm-msg-tabbar|message-tabbar/.test(source));
  test("mobile composer and thread are min-width safe at 375/390/430", /\.cm-msg-thread\{display:flex;flex:1;min-height:0/.test(source) && /grid-template-columns:minmax\(0,1fr\) auto/.test(source) && /overflow-wrap:anywhere/.test(source));
}

console.log("\n──── Server and migration security boundary ────");
{
  const action = apiSource.slice(apiSource.indexOf("async function actionCoachingDashboardMessages"), apiSource.indexOf("async function actionCoachingDashboardReview"));
  test("server derives coach identity from verified bearer user", /getCoachingUser\(tok\)/.test(action) && /coach_id: user\.id/.test(action));
  test("role and active assignment are checked before read/send", action.indexOf("canAccessCoachDashboard") < action.indexOf("loadCoachMessageThread") && action.indexOf("canCoachAccessAthlete") < action.indexOf("loadCoachMessageThread"));
  test("existing read_write permission policy controls message sends", /canCoachManageAthlete/.test(action) && /if \(!canSend\)/.test(action));
  test("every history query is scoped to coach and athlete", /coach_messages\?coach_id=eq\.\$\{enc\(coachId\)\}&athlete_id=eq\.\$\{enc\(athleteId\)\}/.test(apiSource));
  test("client has no direct privileged Supabase messaging access", /api\("messages"/.test(source) && !/\.from\(["']coach_messages/.test(source));
  test("migration enforces sender identity matches sender role", /sender_role = 'coach' and sender_user_id = coach_id/.test(migration) && /sender_role = 'athlete' and sender_user_id = athlete_id/.test(migration));
  test("RLS default-denies direct athlete and coach access", /enable row level security/.test(migration) && !/create\s+policy/i.test(migration));
  test("message content is never tracked or logged", !/trackCoach\([^\n]*(message\.body|coach_messages)/.test(source) && !/log\([^\n]*(message\.body|coach_messages)/.test(apiSource));
  test("account deletion cleans every participant reference", /deleteFrom\("coach_messages", "athlete_id", userId\)/.test(apiSource) && /deleteFrom\("coach_messages", "coach_id", userId\)/.test(apiSource) && /deleteFrom\("coach_messages", "sender_user_id", userId\)/.test(apiSource));
}

console.log("\n──── Executable authenticated messaging route ────");
{
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function callMessages({ method = "GET", athleteId = "athlete-1", assignment = "read", role = "coach", rows = [row()], body = "Hello" } = {}) {
    const writes = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const requestMethod = init.method || "GET";
      if (url.includes("/auth/v1/user")) return jsonResponse({ id: "coach-1" });
      if (url.includes("profiles?id=eq.coach-1")) return jsonResponse([{ id: "coach-1", role, full_name: "Dean" }]);
      if (url.includes("coach_athlete_assignments?")) return jsonResponse(assignment ? [{ coach_id: "coach-1", athlete_id: "athlete-1", status: "active", permission_level: assignment }] : []);
      if (url.endsWith("/rest/v1/coach_messages") && requestMethod === "POST") {
        const saved = JSON.parse(init.body);
        writes.push(saved);
        return jsonResponse([row({ body: saved.body })]);
      }
      if (url.includes("coach_messages?coach_id=eq.")) return jsonResponse(rows);
      throw new Error(`Unexpected fetch: ${requestMethod} ${url}`);
    };
    const request = {
      method,
      query: { action: "coaching_dashboard_messages", athlete_id: athleteId },
      headers: { authorization: "Bearer verified-jwt" },
      body: { athlete_id: athleteId, message: { body } }
    };
    const result = { statusCode: null, body: null };
    const response = {
      setHeader() {},
      status(code) { result.statusCode = code; return this; },
      json(value) { result.body = value; return value; }
    };
    await providerHandler(request, response);
    return { ...result, writes };
  }

  const existing = await callMessages({ method: "GET", rows: [row()] });
  test("GET loads existing thread without creating a duplicate", existing.statusCode === 200 && existing.body.thread.messages.length === 1 && existing.writes.length === 0);
  const none = await callMessages({ method: "GET", assignment: "read_write", rows: [] });
  test("GET returns a valid empty thread when none exists", none.statusCode === 200 && none.body.thread.messages.length === 0 && none.body.thread.can_send === true);
  const readThread = await callMessages({ method: "GET", assignment: "read", rows: [row()] });
  test("active read assignment can view but receives a view-only thread", readThread.statusCode === 200 && readThread.body.thread.messages.length === 1 && readThread.body.thread.can_send === false);
  const readSend = await callMessages({ method: "POST", assignment: "read", rows: [row()], body: "Read assignment send" });
  test("active read assignment cannot send", readSend.statusCode === 403 && readSend.writes.length === 0);
  const writeSend = await callMessages({ method: "POST", assignment: "read_write", rows: [row()], body: "Write assignment send" });
  test("active read_write assignment can send", writeSend.statusCode === 200 && writeSend.writes.length === 1);
  test("server stamps sender identity and never trusts client role", writeSend.writes[0].sender_user_id === "coach-1" && writeSend.writes[0].sender_role === "coach" && writeSend.writes[0].coach_id === "coach-1");
  const deniedAthlete = await callMessages({ method: "GET", athleteId: "athlete-2" });
  test("different-athlete thread fails closed", deniedAthlete.statusCode === 403 && deniedAthlete.writes.length === 0);
  const deniedRole = await callMessages({ method: "GET", role: "athlete" });
  test("athlete role cannot access coach messaging route", deniedRole.statusCode === 403 && deniedRole.writes.length === 0);

  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

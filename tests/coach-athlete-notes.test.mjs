/* Executable private Coach Notes validation, ownership, UI, and boundary checks. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  buildCoachNotes,
  canMutateCoachNote,
  sanitizeCoachNote,
  validateCoachNoteCreate,
  validateCoachNotePatch
} from "../lib/server/coachNotes.js";
import { canCoachAccessAthlete, canCoachManageAthlete } from "../lib/server/coachAssignments.js";
import providerHandler from "../api/providers/index.js";

const source = readFileSync("./js/coachMode.js", "utf8");
const apiSource = readFileSync("./api/providers/index.js", "utf8");
const migration = readFileSync("./migrations/2026-08-12_coach_notes.sql", "utf8");
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

const context = {
  _editingCoachNoteId: null,
  Date,
  Number,
  String,
  Set,
  esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }
};
vm.runInNewContext(
  `${["coachNoteDate", "renderCoachNoteItem", "renderAthleteNotes"].map(extractFunction).join("\n")}
   this.renderAthleteNotes = renderAthleteNotes;`,
  context
);

const baseRow = (overrides = {}) => ({
  id: "note-1",
  athlete_id: "athlete-1",
  author_user_id: "coach-1",
  body: "Race strategy discussed. Wants to negative split.",
  pinned: false,
  created_at: "2026-08-12T06:18:00Z",
  updated_at: "2026-08-12T06:18:00Z",
  ...overrides
});

console.log("\n──── Validation and sanitized model ────");
{
  test("empty note is rejected", validateCoachNoteCreate({ body: "  " }).ok === false);
  test("valid create preserves human-authored text", validateCoachNoteCreate({ body: "  Remember this.  " }).value.body === "Remember this.");
  test("overlong note is rejected instead of silently truncated", validateCoachNoteCreate({ body: "x".repeat(4001) }).ok === false);
  test("patch permits body-only edits", validateCoachNotePatch({ body: "Updated" }).value.body === "Updated");
  test("patch permits boolean pin-only edits", validateCoachNotePatch({ pinned: true }).value.pinned === true);
  test("empty patch fails closed", validateCoachNotePatch({}).ok === false);
  const clean = sanitizeCoachNote(baseRow(), { viewerId: "coach-1", canWrite: true, authorNames: { "coach-1": "Dean" } });
  test("sanitized note includes required opaque id and content", clean.id === "note-1" && clean.body === baseRow().body);
  test("sanitized note excludes athlete and author UUIDs", !("athlete_id" in clean) && !("author_user_id" in clean));
  test("author name is displayed without exposing internal id", clean.author_name === "Dean" && clean.is_author === true);
}

console.log("\n──── Assignment and author ownership ────");
{
  const assignments = [
    { coach_id: "coach-1", athlete_id: "athlete-1", status: "active", permission_level: "read_write" },
    { coach_id: "coach-2", athlete_id: "athlete-1", status: "active", permission_level: "read" }
  ];
  test("active read_write assignment grants athlete management", canCoachManageAthlete(assignments, "coach-1", "athlete-1"));
  test("read assignment grants view but not write", canCoachAccessAthlete(assignments, "coach-2", "athlete-1") && !canCoachManageAthlete(assignments, "coach-2", "athlete-1"));
  test("different athlete is denied", !canCoachAccessAthlete(assignments, "coach-1", "athlete-2"));
  test("own note with write permission may be changed", canMutateCoachNote(baseRow(), "coach-1", true));
  test("another coach cannot overwrite the author's note", !canMutateCoachNote(baseRow(), "coach-2", true));
  test("read-only author still cannot mutate", !canMutateCoachNote(baseRow(), "coach-1", false));
}

console.log("\n──── Ordering, multi-coach authorship, and rendering ────");
{
  const built = buildCoachNotes([
    baseRow({ id: "new", created_at: "2026-08-12T08:00:00Z", updated_at: "2026-08-12T08:00:00Z" }),
    baseRow({ id: "pinned", author_user_id: "coach-2", pinned: true, created_at: "2026-08-10T08:00:00Z", updated_at: "2026-08-10T08:00:00Z" })
  ], { viewerId: "coach-1", canWrite: true, authorNames: { "coach-1": "Dean", "coach-2": "Alex" } });
  test("pinned notes sort before newer unpinned notes", built.notes.map(note => note.id).join(",") === "pinned,new");
  test("only author-owned note exposes edit/delete", built.notes[0].can_edit === false && built.notes[1].can_edit === true);
  const html = context.renderAthleteNotes({ coach_notes: built });
  test("pinned and recent hierarchy renders", /Pinned/.test(html) && /Recent notes/.test(html));
  test("multiple coach names render subtly", /Alex/.test(html) && /Dean/.test(html));
  test("author note has edit, pin, and delete controls", /data-note-edit="new"/.test(html) && /data-note-pin="new"/.test(html) && /data-note-delete="new"/.test(html));
  test("another coach's note has no mutation controls", !/data-note-edit="pinned"/.test(html) && !/data-note-delete="pinned"/.test(html));
  test("note body is escaped", /&lt;script&gt;/.test(context.renderAthleteNotes({ coach_notes: { can_create: false, notes: [{ ...built.notes[0], body: "<script>" }] } })));
}

console.log("\n──── Empty, read-only, and unavailable states ────");
{
  const emptyWrite = context.renderAthleteNotes({ coach_notes: { notes: [], can_create: true } });
  const emptyRead = context.renderAthleteNotes({ coach_notes: { notes: [], can_create: false } });
  const unavailable = context.renderAthleteNotes({ coach_notes: { notes: [], can_create: false, unavailable: true } });
  test("empty state and composer coexist for read_write", /No coach notes yet/.test(emptyWrite) && /cmNoteCompose/.test(emptyWrite));
  test("read-only assignment sees no composer", /view private coach notes/.test(emptyRead) && !/cmNoteCompose/.test(emptyRead));
  test("unapplied migration is not misrepresented as empty notes", /private notes migration/.test(unavailable) && !/No coach notes yet/.test(unavailable));
  test("no athlete picker exists in Notes renderer", !/Choose athlete|athlete picker/i.test(emptyWrite));
}

console.log("\n──── Server, privacy, cache, deletion, and migration boundary ────");
{
  const athleteAction = apiSource.slice(apiSource.indexOf("async function actionCoachingDashboardAthlete"), apiSource.indexOf("async function actionCoachingDashboardNotes"));
  test("single-athlete API reads notes only after assignment guard", athleteAction.indexOf("canCoachAccessAthlete(assignments, user.id, athleteId)") < athleteAction.indexOf("loadCoachNotesForAthlete("));
  test("write route rechecks role, assignment, and read_write permission", /actionCoachingDashboardNotes[\s\S]*canAccessCoachDashboard[\s\S]*canCoachAccessAthlete[\s\S]*canCoachManageAthlete/.test(apiSource));
  test("create stamps authenticated author and selected athlete server-side", /athlete_id: athleteId,[\s\S]*author_user_id: user\.id/.test(apiSource));
  test("edit/delete lookup and writes are athlete + author scoped", /coach_notes\?id=eq\.\$\{enc\(noteId\)\}&athlete_id=eq\.\$\{enc\(athleteId\)\}&author_user_id=eq\.\$\{enc\(user\.id\)\}/.test(apiSource));
  test("client uses authenticated API boundary, never Supabase note writes", /api\("notes"/.test(source) && !/\.from\(["']coach_notes/.test(source));
  test("delete requires explicit confirmation copy", /Delete this note\?/.test(source) && /This cannot be undone\./.test(source));
  test("successful mutations refresh notes without overwriting cached training weeks", /_athleteDetail\.coach_notes = data/.test(source) && /_athleteDetailCache\[key\]\.coach_notes = data/.test(source) && !/_athleteDetailCache\[key\] = _athleteDetail/.test(source));
  test("athlete account deletion cleans athlete- and author-owned notes", /deleteFrom\("coach_notes", "athlete_id", userId\)/.test(apiSource) && /deleteFrom\("coach_notes", "author_user_id", userId\)/.test(apiSource));
  test("note values are never logged or sent to analytics", !/trackCoach\([^\n]*(coach_notes|note\.body|author_name)/.test(source) && !/log\([^\n]*(coach_notes|note\.body|author_name)/.test(apiSource));
  test("migration enables RLS and default-denies direct browser access", /enable row level security/.test(migration) && !/create\s+policy/i.test(migration));
  test("migration creates no client write policy", !/for\s+(insert|update|delete)/i.test(migration));
  test("athletes receive no coach-notes RLS policy", !/auth\.uid\(\)/.test(migration));
  test("mobile rules prevent narrow metadata/body collisions", /@media\(max-width:380px\)[^\n]*\.cm-note-item-head\{display:grid/.test(source));
}

console.log("\n──── Executable authenticated Notes route ────");
{
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
  async function callNotes({ method = "POST", athleteId = "athlete-1", noteId = null, note = null, assignment = "read_write", authorId = "coach-1", role = "coach" } = {}) {
    const writes = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const requestMethod = init.method || "GET";
      if (url.includes("/auth/v1/user")) return jsonResponse({ id: "coach-1" });
      if (url.includes("profiles?id=eq.coach-1")) return jsonResponse([{ id: "coach-1", role, full_name: "Dean" }]);
      if (url.includes("coach_athlete_assignments?")) {
        return jsonResponse(assignment ? [{ coach_id: "coach-1", athlete_id: "athlete-1", status: "active", permission_level: assignment }] : []);
      }
      if (url.includes("coach_notes?id=eq.")) {
        if (requestMethod === "GET") return jsonResponse([baseRow({ author_user_id: authorId })]);
        writes.push({ method: requestMethod, url, body: init.body && JSON.parse(init.body) });
        return jsonResponse(requestMethod === "DELETE" ? [] : [baseRow({ author_user_id: authorId, body: note && note.body || baseRow().body })]);
      }
      if (url.endsWith("/rest/v1/coach_notes") && requestMethod === "POST") {
        const body = JSON.parse(init.body);
        writes.push({ method: requestMethod, url, body });
        return jsonResponse([baseRow({ body: body.body, pinned: body.pinned })]);
      }
      if (url.includes("coach_notes?athlete_id=eq.")) return jsonResponse([baseRow()]);
      if (url.includes("profiles?id=in.")) return jsonResponse([{ id: "coach-1", full_name: "Dean" }]);
      throw new Error(`Unexpected fetch: ${requestMethod} ${url}`);
    };
    const request = {
      method,
      query: { action: "coaching_dashboard_notes" },
      headers: { authorization: "Bearer verified-jwt" },
      body: { athlete_id: athleteId, note_id: noteId, note }
    };
    const result = { statusCode: null, body: null, headers: {} };
    const response = {
      setHeader(name, value) { result.headers[name] = value; },
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return body; }
    };
    await providerHandler(request, response);
    return { ...result, writes };
  }

  const created = await callNotes({ method: "POST", note: { body: "Private context", pinned: true } });
  test("actual route creates a note for the authenticated author", created.statusCode === 200 && created.writes[0].body.author_user_id === "coach-1" && created.writes[0].body.athlete_id === "athlete-1");
  const edited = await callNotes({ method: "PATCH", noteId: "note-1", note: { body: "Updated context" } });
  test("actual route edits own note with athlete and author filters", edited.statusCode === 200 && edited.writes[0].method === "PATCH" && edited.writes[0].url.includes("author_user_id=eq.coach-1"));
  const deleted = await callNotes({ method: "DELETE", noteId: "note-1" });
  test("actual route deletes own note only after scoped verification", deleted.statusCode === 200 && deleted.writes[0].method === "DELETE" && deleted.writes[0].url.includes("athlete_id=eq.athlete-1"));
  const readOnly = await callNotes({ method: "POST", assignment: "read", note: { body: "Denied" } });
  test("actual route blocks read-only creation before note write", readOnly.statusCode === 403 && readOnly.writes.length === 0);
  const differentAthlete = await callNotes({ method: "POST", athleteId: "athlete-2", note: { body: "Denied" } });
  test("actual route blocks a different athlete before note write", differentAthlete.statusCode === 403 && differentAthlete.writes.length === 0);
  const wrongAuthor = await callNotes({ method: "PATCH", noteId: "note-1", note: { body: "Denied" }, authorId: "coach-2" });
  test("actual route blocks overwriting another coach's note", wrongAuthor.statusCode === 403 && wrongAuthor.writes.length === 0);
  const athleteRole = await callNotes({ method: "POST", role: "athlete", note: { body: "Denied" } });
  test("actual route blocks athlete-role access", athleteRole.statusCode === 403 && athleteRole.writes.length === 0);

  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

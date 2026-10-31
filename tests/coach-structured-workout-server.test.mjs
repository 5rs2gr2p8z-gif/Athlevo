/**
 * Coach structured workouts — server-side pure logic, endpoint wiring and the
 * migration. (No database is available in tests; DB behaviour is verified by
 * reading the code paths and by running the migration in Supabase.)
 * Run: node tests/coach-structured-workout-server.test.mjs
 */
import { readFileSync } from "node:fs";
import { sanitizeCoachWorkoutInput, buildCoachTrainingWeek, withoutStructureColumn } from "../lib/server/coachTraining.js";
import { resolveAthletePaces } from "../lib/server/coachPaces.js";
import { sanitizeLibraryItem, shapeLibraryRow } from "../lib/server/coachWorkoutLibrary.js";

let passed = 0, failed = 0;
function test(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}
const zone = z => ({ kind: "zone", zone: z });
const structure = { steps: [
  { type: "warmup", duration: { unit: "min", value: 15 }, target: zone("easy") },
  { type: "repeat", reps: 4, steps: [
    { type: "work", duration: { unit: "min", value: 8 }, target: zone("threshold") },
    { type: "recovery", duration: { unit: "min", value: 2 }, target: zone("recovery") } ] },
  { type: "cooldown", duration: { unit: "min", value: 10 }, target: zone("easy") } ] };
const paces = { easy: { secPerKm: 340 }, threshold: { secPerKm: 270 }, recovery: { secPerKm: 400 } };
const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

console.log("\n──── Coach workout input with a structure ────");
const r = sanitizeCoachWorkoutInput({ session_date: day, title: "Threshold 4 x 8", structure }, { paces });
test("a structured workout is accepted", r.ok);
test("duration and distance are derived from the steps and this athlete's paces", r.value.duration_minutes === 65 && r.value.distance_km > 10);
test("the plain arrays the athlete screens read are filled",
  r.value.warmup.length === 1 && r.value.main_set.length === 1 && r.value.cooldown.length === 1 && /threshold/.test(r.value.main_set[0]));
test("pace guidance and intensity are derived when the coach left them blank",
  r.value.pace_guidance === "Threshold 4:30 per km" && r.value.intensity === "Threshold");
test("the coach's own wording is never overwritten",
  sanitizeCoachWorkoutInput({ session_date: day, title: "T", description: "My words", pace_guidance: "Feel it", structure }, { paces }).value.description === "My words" &&
  sanitizeCoachWorkoutInput({ session_date: day, title: "T", pace_guidance: "Feel it", structure }, { paces }).value.pace_guidance === "Feel it");
test("an invalid structure is rejected with a readable message",
  (() => { const bad = sanitizeCoachWorkoutInput({ session_date: day, title: "T", structure: { steps: [] } }); return !bad.ok && /step/i.test(bad.error); })());
test("without paces the workout still saves; distance is left empty, not invented",
  (() => { const n = sanitizeCoachWorkoutInput({ session_date: day, title: "T", structure }); return n.ok && n.value.duration_minutes === 65 && n.value.distance_km === null; })());
test("a plain (non-structured) workout is unchanged: no structure or array keys appear",
  (() => { const p = sanitizeCoachWorkoutInput({ session_date: day, title: "Easy 8k", duration_minutes: 45 }); return p.ok && !("structure" in p.value) && !("main_set" in p.value); })());
test("a client cannot smuggle ownership fields through the workout payload",
  (() => { const p = sanitizeCoachWorkoutInput({ session_date: day, title: "T", structure, owner_type: "athlete", created_by: "x", user_id: "y" }, { paces }); return !("owner_type" in p.value) && !("created_by" in p.value) && !("user_id" in p.value); })());
test("withoutStructureColumn drops only the structure column", (() => { const row = withoutStructureColumn({ ...r.value, user_id: "u" }); return !("structure" in row) && row.user_id === "u" && row.main_set.length === 1; })());

console.log("\n──── Coach training week exposes the structure for re-editing ────");
const week = buildCoachTrainingWeek({
  sessions: [{ id: "s1", session_date: day, session_type: "threshold", title: "T", structure: r.value.structure }, { id: "s2", session_date: day, structure: { steps: "junk" } }],
  executions: [], weekStart: day, today: day
});
test("a valid stored structure is returned", week.sessions[0].structure && week.sessions[0].structure.steps.length === 3);
test("a corrupt stored structure is dropped, not passed to the browser", week.sessions[1].structure === null);

console.log("\n──── Athlete paces ────");
const recent = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
const p1 = resolveAthletePaces({ raceResults: [{ race_type: "official", race_date: recent, distance_meters: 10000, duration_seconds: 2700 }] });
test("a confirmed race gives paces for every zone from the existing VDOT engine",
  p1.source === "confirmed_race" && p1.vdot > 30 && p1.zones.threshold.secPerKm > 0 && p1.zones.easy.secPerKm > p1.zones.threshold.secPerKm);
test("no evidence gives no paces (builder falls back to zone names)", resolveAthletePaces({}).zones === null);
test("an old race is ignored and a recent run is used instead",
  resolveAthletePaces({ raceResults: [{ race_type: "official", race_date: "2020-01-01", distance_meters: 10000, duration_seconds: 2700 }], activities: [{ activity_type: "Run", start_date: recent + "T06:00:00Z", distance_meters: 8000, moving_time_seconds: 2640 }] }).source === "recent_run");
test("a casual or manual race entry is not treated as fitness evidence",
  resolveAthletePaces({ raceResults: [{ race_type: "casual", race_date: recent, distance_meters: 10000, duration_seconds: 2700 }] }).zones === null);

console.log("\n──── Library ────");
const lib = sanitizeLibraryItem({ name: "  Threshold 4x8  ", folder: "Threshold", structure });
test("a library workout is validated and summarised", lib.ok && lib.value.name === "Threshold 4x8" && lib.value.summary.duration_minutes === 65);
test("a library workout needs a name and a valid structure",
  !sanitizeLibraryItem({ name: "", structure }).ok && !sanitizeLibraryItem({ name: "x", structure: { steps: [] } }).ok);
test("library rows are shaped without leaking the owner", !("coach_id" in shapeLibraryRow({ id: 1, coach_id: "c", name: "n", structure })));

console.log("\n──── Endpoint wiring and migration ────");
const api = readFileSync("./api/providers/index.js", "utf8");
const migration = readFileSync("./migrations/2026-10-30_structured_workouts_and_library.sql", "utf8");
test("library actions are routed", ["coaching_library_list", "coaching_library_save", "coaching_library_delete"].every(a => api.includes(`action === "${a}"`)));
test("every library query is scoped to the authenticated coach, never a client-supplied id",
  (api.match(/coach_workout_library\?coach_id=eq\.\$\{enc\(user\.id\)\}/g) || []).length >= 3 && /coach_id: user\.id/.test(api));
test("library endpoints require the coach role", /async function authenticateCoach[\s\S]*?canAccessCoachDashboard\(profile\)/.test(api));
test("saving falls back cleanly when the structure column does not exist yet",
  /withoutStructureColumn\(row\)/.test(api) && /withoutStructureColumn\(patch\)/.test(api));
test("a missing library table is reported as unavailable, not as an empty library", /unavailable: true/.test(api));
test("a coach can schedule for an athlete who has no AI plan (insert-if-absent, never overwrite)",
  /on_conflict=user_id,week_start/.test(api) &&
  /if \(sameWeek\.rows\[0\] && sameWeek\.rows\[0\]\.id\) return \{ ok: true/.test(api) &&
  /if \(active\.rows\[0\] && active\.rows\[0\]\.id\) return \{ ok: true/.test(api));
test("coach-owned sessions keep the existing ownership stamp and edit guards",
  /stampOwnership\(\{[\s\S]{0,120}mode: "human_coached"/.test(api) && /canSafelyMutateCoachSession\(session, execution, todayKey\)/.test(api));
test("one workout per day is still enforced (the athlete screens assume it)", /A workout is already scheduled on that date\./.test(api));
test("athlete detail returns the athlete's paces for the builder", /overview\.training_paces = await loadAthletePaces\(athleteId\)/.test(api));
test("migration is additive: one nullable column, one new table, RLS on, no policies, no drops",
  /add column if not exists structure jsonb/.test(migration) && /create table if not exists public\.coach_workout_library/.test(migration) &&
  /enable row level security/.test(migration) && !/drop |delete from|update public|create policy/i.test(migration.replace(/--.*$/gm, "")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

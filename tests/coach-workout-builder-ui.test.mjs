/**
 * Coach workout builder — UI wiring and athlete display contract.
 * (The interactive behaviour was exercised in a real browser; these lock the wiring.)
 * Run: node tests/coach-workout-builder-ui.test.mjs
 */
import { readFileSync } from "node:fs";
import "../js/structuredWorkout.js";

const html = readFileSync("./index.html", "utf8");
const coachMode = readFileSync("./js/coachMode.js", "utf8");
const builder = readFileSync("./js/coachWorkoutBuilder.js", "utf8");
const cal = readFileSync("./js/trainCalendar.js", "utf8");
const SW = globalThis.AthlevoStructuredWorkout;

let passed = 0, failed = 0;
function test(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}
function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  const brace = source.indexOf("{", start);
  let depth = 0, quote = null, esc = false;
  for (let i = brace; i < source.length; i += 1) {
    const c = source[i];
    if (quote) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth += 1;
    if (c === "}") { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error("unclosed " + name);
}

console.log("\n──── Scripts ────");
const core = html.indexOf('js/structuredWorkout.js'), ui = html.indexOf('js/coachWorkoutBuilder.js'), mode = html.indexOf('js/coachMode.js');
test("core, builder and coach mode load in that order", core > 0 && core < ui && ui < mode);
test("the native bundle copies js/ wholesale, so the new files ship in the Android app",
  /for \(const entry of \["js", "assets", "legal"\]\)/.test(readFileSync("./scripts/build-native-web.mjs", "utf8")));

console.log("\n──── Coach workout editor wiring ────");
const editor = coachMode.slice(coachMode.indexOf("function openWorkoutEditor"), coachMode.indexOf("async function saveWorkoutForm"));
const save = coachMode.slice(coachMode.indexOf("async function saveWorkoutForm"), coachMode.indexOf("async function removeWorkout"));
test("the editor has a builder mount and passes the athlete's paces and existing structure",
  /id="cmBuilderMount"/.test(editor) && /paces: ath\.training_paces/.test(editor) && /structure: session && session\.structure/.test(editor));
test("read-only sessions render the builder read-only; the library is offered only to editors",
  /readOnly: !editable/.test(editor) && /library: editable \? workoutLibrary : null/.test(editor));
test("the simple duration/distance/intensity/pace fields hide while steps exist (the server derives them)",
  /flatFieldIds = \["cmWorkoutDuration", "cmWorkoutDistance", "cmWorkoutIntensity", "cmWorkoutPace"\]/.test(editor) && /field\.hidden = state\.hasSteps/.test(editor));
test("saving validates the steps client-side and sends the structure",
  /builder\.validate\(\)/.test(save) && /workout\.structure = checked\.value/.test(save));
test("derived fields are not sent back stale when the coach edits a built workout",
  /delete workout\.duration_minutes/.test(save) && /delete workout\.pace_guidance/.test(save) && /delete workout\.intensity/.test(save));
test("emptying the builder on a structured workout asks the server to clear it", /workout\.clear_structure = true/.test(save));
test("library calls go to the coach-scoped endpoints with the coach's own session token",
  /coaching_library_/.test(coachMode) && /Authorization: "Bearer " \+ session\.accessToken/.test(coachMode.slice(coachMode.indexOf("async function libraryApi"))));
test("the simple form still works with no steps (structure is only sent when steps exist)", /if \(builder && builder\.hasSteps\(\)\)/.test(save));

console.log("\n──── Builder safety ────");
test("library item names are escaped before being put in markup", /esc\(it\.name\)/.test(builder) && /function esc\(/.test(builder));
test("the builder makes no network calls itself", !/fetch\(|XMLHttpRequest/.test(builder));
test("the library 'save' form stays hidden until opened (display:flex must not override [hidden])", /\.wb \[hidden\]\{display:none!important\}/.test(builder));

console.log("\n──── Athlete calendar draws the coach's exact steps ────");
const fn = extractFunction(cal, "buildPlannedStripSegments");
const qualityRe = (cal.match(/const QUALITY_RE = (\/.*\/[a-z]*);/) || [])[1];
const strip = new Function("window", "num", `const QUALITY_RE = ${qualityRe};\n${fn}; return buildPlannedStripSegments;`)({ AthlevoStructuredWorkout: SW }, v => Number(v) || 0);
const structure = { steps: [
  { type: "warmup", duration: { unit: "min", value: 15 }, target: { kind: "zone", zone: "easy" } },
  { type: "repeat", reps: 6, steps: [
    { type: "work", duration: { unit: "m", value: 800 }, target: { kind: "zone", zone: "vo2" } },
    { type: "recovery", duration: { unit: "m", value: 400 }, target: { kind: "zone", zone: "recovery" } } ] },
  { type: "cooldown", duration: { unit: "min", value: 10 }, target: { kind: "zone", zone: "easy" } } ] };
const segs = strip({ session_type: "intervals", duration_minutes: 60, structure, main_set: ["6 × 0.8 km at 4:05 per km / 0.4 km recovery"] });
test("a structured session is drawn from its steps: 1 warm up + 6 work + 6 recovery + 1 cool down", segs.length === 14 && segs[0].kind === "warmup" && segs.filter(s => s.kind === "work").length === 6 && segs[13].kind === "cooldown");
test("distance reps are not misread as minutes (the old text parser would have read '800 m' as 800 minutes)", segs.filter(s => s.kind === "work").every(s => s.duration > 60 && s.duration < 600));
test("a session without a structure still uses the existing text parser",
  strip({ session_type: "easy", duration_minutes: 45 }).length >= 1 && !strip({ session_type: "rest" }).length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * Structured workout core — validation, per-athlete resolution, text output,
 * and compatibility with the athlete calendar's existing text parser.
 * Run: node tests/structured-workout.test.mjs
 */
import { readFileSync } from "node:fs";
import "../js/structuredWorkout.js";

const SW = globalThis.AthlevoStructuredWorkout;
let passed = 0, failed = 0;
function test(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}

const zone = (z) => ({ kind: "zone", zone: z });
const dur = (unit, value) => ({ unit, value });
const threshold4x8 = {
  steps: [
    { type: "warmup", duration: dur("min", 15), target: zone("easy") },
    { type: "repeat", reps: 4, steps: [
      { type: "work", duration: dur("min", 8), target: zone("threshold") },
      { type: "recovery", duration: dur("min", 2), target: zone("recovery") }
    ] },
    { type: "cooldown", duration: dur("min", 10), target: zone("easy") }
  ]
};
const paces = { recovery: { secPerKm: 400 }, easy: { secPerKm: 340 }, threshold: { secPerKm: 270 }, vo2: { secPerKm: 245 }, repetition: { secPerKm: 230 } };

console.log("\n──── Validation ────");
test("a normal workout validates", SW.validate(threshold4x8).ok);
test("empty workout is rejected", !SW.validate({ steps: [] }).ok && !SW.validate(null).ok);
test("unknown zone is rejected", !SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: zone("sprint") }] }).ok);
test("zero / negative / absurd durations are rejected",
  !SW.validate({ steps: [{ type: "work", duration: dur("min", 0), target: zone("easy") }] }).ok &&
  !SW.validate({ steps: [{ type: "work", duration: dur("min", -3), target: zone("easy") }] }).ok &&
  !SW.validate({ steps: [{ type: "work", duration: dur("min", 9999), target: zone("easy") }] }).ok);
test("unknown unit is rejected", !SW.validate({ steps: [{ type: "work", duration: { unit: "mile", value: 1 }, target: zone("easy") }] }).ok);
test("repeats must be 2-30 whole reps and cannot nest",
  !SW.validate({ steps: [{ type: "repeat", reps: 1, steps: [{ type: "work", duration: dur("min", 1), target: zone("easy") }] }] }).ok &&
  !SW.validate({ steps: [{ type: "repeat", reps: 31, steps: [{ type: "work", duration: dur("min", 1), target: zone("easy") }] }] }).ok &&
  !SW.validate({ steps: [{ type: "repeat", reps: 3, steps: [{ type: "repeat", reps: 2, steps: [] }] }] }).ok);
test("RPE, pace and heart-rate targets are range-checked",
  SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: { kind: "rpe", min: 6, max: 7 } }] }).ok &&
  !SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: { kind: "rpe", min: 0, max: 7 } }] }).ok &&
  SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: { kind: "pace", minSec: 255, maxSec: 270 } }] }).ok &&
  !SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: { kind: "pace", minSec: 270, maxSec: 255 } }] }).ok &&
  SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: { kind: "hr", min: 150, max: 165 } }] }).ok &&
  !SW.validate({ steps: [{ type: "work", duration: dur("min", 5), target: { kind: "hr", min: 20, max: 400 } }] }).ok);
test("sanitising drops unknown fields and trims notes",
  (() => { const r = SW.validate({ evil: "x", steps: [{ type: "work", duration: dur("min", 5), target: zone("easy"), note: "  go easy  ", script: "<b>" }] }); return r.ok && r.value.steps[0].note === "go easy" && !("evil" in r.value) && !("script" in r.value.steps[0]); })());

console.log("\n──── Resolution to an athlete's own paces ────");
const r = SW.resolve(threshold4x8, paces);
test("repeats are expanded: warm up + 4×(work+recovery) + cool down = 10 steps", r.ok && r.steps.length === 10);
test("total time = 15 + 4×(8+2) + 10 = 65 min", r.totals.durationMinutes === 65);
test("distance comes from each step's zone pace for THIS athlete",
  (() => { const m = 15*60/340 + 4*(8*60/270 + 2*60/400) + 10*60/340; return Math.abs(r.totals.distanceKm - Math.round(m * 10) / 10) < 0.11; })());
test("a faster athlete gets different numbers from the same workout",
  SW.resolve(threshold4x8, { ...paces, threshold: { secPerKm: 240 }, easy: { secPerKm: 300 }, recovery: { secPerKm: 360 } }).totals.distanceKm > r.totals.distanceKm);
test("without paces, time stays exact and distance is not invented",
  (() => { const n = SW.resolve(threshold4x8, null); return n.totals.durationMinutes === 65 && n.totals.distanceKm === null; })());
test("distance steps convert to time using the zone pace",
  (() => { const d = SW.resolve({ steps: [{ type: "repeat", reps: 6, steps: [{ type: "work", duration: dur("m", 800), target: zone("vo2") }, { type: "recovery", duration: dur("m", 400), target: zone("recovery") }] }] }, paces); return d.ok && d.totals.distanceKm === 7.2 && d.totals.durationMinutes === Math.round((6*(800/1000*245 + 400/1000*400))/60); })());
test("distance steps with no known pace are flagged as estimated for drawing only",
  (() => { const d = SW.resolve({ steps: [{ type: "work", duration: dur("km", 2), target: { kind: "rpe", min: 7, max: 8 } }] }, paces); return d.totals.hasEstimates === true && d.steps[0].seconds > 0; })());

console.log("\n──── Text lines (athlete calendar reads these) ────");
const lines = SW.toLines(threshold4x8, paces);
test("warm up, main set and cool down are split like the AI planner's output",
  lines.ok && lines.warmup.length === 1 && lines.main_set.length === 1 && lines.cooldown.length === 1);
test("repeat line uses the 'N × work / recovery' shape and shows the athlete's pace",
  /^4 × 8 min threshold at 4:30 per km \/ 2 min recovery$/.test(lines.main_set[0]), lines.main_set[0]);
test("no step text contains the characters the calendar parser splits on (comma, plus, 'with')",
  [...lines.warmup, ...lines.main_set, ...lines.cooldown].every(t => !/[,+]|\bwith\b|\bw\//i.test(t.replace(" × ", " x ").replace(" / ", " | "))));
test("distances are written in km (a bare 'm' would be read as minutes)",
  (() => { const l = SW.toLines({ steps: [{ type: "repeat", reps: 6, steps: [{ type: "work", duration: dur("m", 800), target: zone("vo2") }, { type: "recovery", duration: dur("m", 400), target: zone("recovery") }] }] }, paces); return /6 × 0\.8 km/.test(l.main_set[0]) && !/\d\s*m\b(?!in)/.test(l.main_set[0]); })());

// Round-trip against the REAL athlete-calendar parser functions.
const cal = readFileSync("./js/trainCalendar.js", "utf8");
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
const qualityRe = (cal.match(/const QUALITY_RE = (\/.*\/[a-z]*);/) || [])[1];
const parserApi = new Function(
  `const QUALITY_RE = ${qualityRe};\n${extractFunction(cal, "parsePrescribedDuration")}\n${extractFunction(cal, "parsePrescribedKind")}\n${extractFunction(cal, "extractRepetitions")}\nreturn { extractRepetitions, parsePrescribedDuration };`
)();
const parsed = parserApi.extractRepetitions(lines.main_set);
const expectedWorkSec = r.steps.filter(s => s.type === "work").map(s => s.seconds);
test("the existing athlete parser reads 4 work + 3 recovery segments from our line",
  parsed.filter(s => s.kind === "work").length === 4 && parsed.filter(s => s.kind === "recovery").length === 3,
  JSON.stringify(parsed.map(s => s.kind)));
test("and gets the right work and recovery durations (8 min / 2 min)",
  parsed.filter(s => s.kind === "work").every((s, i) => s.duration === expectedWorkSec[i]) &&
  parsed.filter(s => s.kind === "recovery").every(s => s.duration === 120));
test("warm up and cool down durations parse correctly",
  parserApi.parsePrescribedDuration(lines.warmup[0]) === 900 && parserApi.parsePrescribedDuration(lines.cooldown[0]) === 600);

console.log("\n──── Segments for the athlete shape strip ────");
const seg = SW.toSegments(threshold4x8, paces);
test("segments are ordered, typed and sum to the workout time",
  seg.length === 10 && seg[0].kind === "warmup" && seg[1].kind === "work" && seg[2].kind === "recovery" && seg[9].kind === "cooldown" &&
  seg.reduce((a, s) => a + s.duration, 0) === 65 * 60);
test("summary line reads naturally", /^65 min · \d+(\.\d)? km$/.test(SW.summaryLine(r)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

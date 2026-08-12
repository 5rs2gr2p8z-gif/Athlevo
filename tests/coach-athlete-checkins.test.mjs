/* Executable Athlete Detail Check-ins sanitizer + renderer checks. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildCoachCheckIns, sanitizeCoachCheckIn } from "../lib/server/coachCheckIns.js";
import { findSensitiveKeys } from "../lib/server/coachSanitize.js";
import { canCoachAccessAthlete } from "../lib/server/coachAssignments.js";

const source = readFileSync("./js/coachMode.js", "utf8");
const apiSource = readFileSync("./api/providers/index.js", "utf8");
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

const functionNames = [
  "checkInScaleLabel", "manilaDateKey", "formatCheckInDate", "latestCheckInRows",
  "renderSubjectiveTrends", "checkInTimelineSummary", "directCheckInSignals",
  "renderAthleteCheckIns"
];
const context = {
  _athleteCheckInsRange: 7,
  Number,
  String,
  Math,
  Array,
  Date,
  Intl,
  esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }
};
vm.runInNewContext(
  `${functionNames.map(extractFunction).join("\n")}
   this.renderAthleteCheckIns = renderAthleteCheckIns;`,
  context
);

function record(overrides = {}) {
  return {
    date: "2026-08-12",
    submitted_at: "2026-08-12T07:12:00Z",
    sleep_quality: 4,
    sleep_label: "Good",
    energy: 6,
    muscle_soreness: 3,
    mental_stress: 8,
    pain_present: false,
    pain_location: null,
    pain_severity: null,
    notes: null,
    ...overrides
  };
}

console.log("\n──── Sanitized server response ────");
{
  const raw = {
    id: "readiness-secret-id",
    user_id: "athlete-secret-id",
    readiness_date: "2026-08-12",
    created_at: "2026-08-12T06:30:00Z",
    updated_at: "2026-08-12T07:12:00Z",
    sleep_quality: 4,
    energy: 6,
    muscle_soreness: 3,
    mental_stress: 8,
    pain_present: true,
    pain_location: "Right calf",
    pain_severity: 4,
    notes: "Legs still feel heavy from yesterday’s session.",
    email: "private@example.com",
    access_token: "secret"
  };
  const clean = sanitizeCoachCheckIn(raw);
  test("full daily readiness fields are preserved truthfully", clean.sleep_label === "Good" && clean.energy === 6 && clean.muscle_soreness === 3 && clean.mental_stress === 8);
  test("pain location/severity and exact note are preserved", clean.pain_location === "Right calf" && clean.pain_severity === 4 && clean.notes === raw.notes);
  test("updated timestamp is used for latest submission time", clean.submitted_at === "2026-08-12T07:12:00.000Z");
  test("ids, email, and tokens never enter the response", findSensitiveKeys(clean).length === 0 && !("id" in clean) && !("user_id" in clean));
  test("invalid/out-of-range values become unavailable, not fabricated", sanitizeCoachCheckIn({ readiness_date: "2026-08-12", sleep_quality: 9, energy: 0, muscle_soreness: 22, mental_stress: "x" }).sleep_quality === null);
  test("records are sorted newest-first and capped at 14", buildCoachCheckIns(Array.from({ length: 16 }, (_, index) => ({ readiness_date: `2026-07-${String(index + 10).padStart(2, "0")}` }))).records.length === 14);
}

console.log("\n──── Latest, partial, pain, and notes ────");
{
  const full = context.renderAthleteCheckIns({ coach_check_ins: { records: [record({ pain_present: true, pain_location: "Right calf", pain_severity: 4, notes: "Legs still feel heavy from yesterday’s session." })] } });
  test("latest full check-in renders all available dimensions", /Sleep/.test(full) && /Energy/.test(full) && /Soreness/.test(full) && /Stress/.test(full));
  test("pain is surfaced separately with restrained warning semantics", /Pain reported/.test(full) && /Right calf/.test(full) && /4\/10/.test(full) && /cm-checkin-pain/.test(full));
  test("athlete note is rendered exactly and immediately after latest summary", full.includes("Legs still feel heavy from yesterday’s session.") && full.indexOf("Athlete note") > full.indexOf("Latest check-in"));
  const partial = context.renderAthleteCheckIns({ coach_check_ins: { records: [record({ sleep_quality: null, sleep_label: null, muscle_soreness: null, mental_stress: null })] } });
  test("partial check-in shows only fields that exist", /Energy/.test(partial) && !/class="cm-checkin-row"><span>Sleep/.test(partial) && !/class="cm-checkin-row"><span>Soreness/.test(partial));
  const noPain = context.renderAthleteCheckIns({ coach_check_ins: { records: [record()] } });
  test("no pain uses one quiet factual line", /No recent pain reported/.test(noPain) && !/Pain reported<\/span>/.test(noPain));
}

console.log("\n──── History, signals, ranges, and empty state ────");
{
  const records = [
    record({ date: "2026-08-12", sleep_quality: 2, sleep_label: "Poor", mental_stress: 8 }),
    record({ date: "2026-08-11", sleep_quality: 2, sleep_label: "Poor", mental_stress: 8, notes: "Long work day." }),
    record({ date: "2026-08-10", sleep_quality: 1, sleep_label: "Very poor", mental_stress: 9 }),
    record({ date: "2026-08-03", sleep_quality: 5, sleep_label: "Excellent", mental_stress: 2 })
  ];
  let html = context.renderAthleteCheckIns({ coach_check_ins: { records } });
  test("7D history includes only records inside the selected range", /Today/.test(html) && /Aug 10/.test(html) && !/Aug 3/.test(html));
  test("timeline reports changes instead of repeating unchanged fields", /No reported changes|Athlete note added/.test(html));
  test("micro-trends use actual stored numeric values", /Subjective trend/.test(html) && /Sleep reported values over 7 days/.test(html) && /Stress reported values over 7 days/.test(html));
  test("direct repeated low-sleep/high-stress signals are deterministic", /Sleep has been low for 3 consecutive check-ins/.test(html) && /Stress has remained high for 3 consecutive check-ins/.test(html));
  context._athleteCheckInsRange = 14;
  html = context.renderAthleteCheckIns({ coach_check_ins: { records } });
  test("14D range reveals older history and keeps same athlete context", /Aug 3/.test(html) && /data-checkins-range="14" aria-pressed="true"/.test(html));
  context._athleteCheckInsRange = 7;
  const empty = context.renderAthleteCheckIns({ coach_check_ins: { records: [] } });
  test("no check-ins renders the intentional empty state without zero metrics", /No check-ins yet/.test(empty) && /first check-in/.test(empty) && !/>0\/10</.test(empty));
}

console.log("\n──── Permissions, privacy, cache, and responsive wiring ────");
{
  const payload = { coach_check_ins: { records: [record()] } };
  const read = context.renderAthleteCheckIns({ ...payload, assignment_permission: "read" });
  const write = context.renderAthleteCheckIns({ ...payload, assignment_permission: "read_write" });
  test("read and read_write assignments render identical read-only check-ins", read === write);
  test("no submission, edit, readiness modal, or mutation control exists", !/Save check-in|Edit check-in|readinessModal|type="submit"|data-rd=/.test(read));
  test("Check-ins remains athlete-scoped with no picker", !/Choose athlete|athlete picker|data-athlete=/.test(read));
  test("API checks JWT, coach role, and active assignment before loading history", /getCoachingUser\(tok\)/.test(apiSource) && /canAccessCoachDashboard\(profile\)/.test(apiSource) && /canCoachAccessAthlete\(assignments, user\.id, athleteId\)/.test(apiSource));
  test("unauthorized coach cannot access another athlete", !canCoachAccessAthlete([], "coach-a", "athlete-a"));
  test("different athlete assignment cannot authorize requested athlete", !canCoachAccessAthlete([{ coach_id: "coach-a", athlete_id: "athlete-b", status: "active" }], "coach-a", "athlete-a"));
  test("daily readiness query is explicitly scoped to authenticated selected athlete", /daily_readiness\?user_id=eq\.\$\{idf\}.*pain_location.*notes/.test(apiSource));
  test("check-in payload is attached only to the single-athlete response", /overview\.coach_check_ins = buildCoachCheckIns/.test(apiSource));
  test("range toggles rerender locally without network or athlete-context change", /data-checkins-range/.test(source) && /panel\.innerHTML = renderAthleteCheckIns\(ath\)/.test(source));
  const openDetail = extractFunction("openCoachAthletePage");
  test("cached athlete detail returns before skeleton rendering", openDetail.indexOf("if (cached)") < openDetail.indexOf("renderAthletePageLoading();"));
  test("mobile-first styles prevent narrow-width compression", /\.cm-athlete-checkins\{display:grid/.test(source) && /@media\(max-width:380px\)/.test(source) && /minmax\(0,1fr\)/.test(source));
  test("no check-in values or notes are sent to analytics/logging", !/trackCoach\([^\n]*(coach_check_ins|pain_location|pain_severity|notes|sleep_quality|mental_stress)/.test(source));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

/**
 * Home (athlete daily dashboard) — focused contract.
 * Home reuses the existing Today screen (#screen-today) and the week snapshot it
 * already loads; it adds Next / Coach / Fuel rows and a status chip, invents no data.
 * Run: node tests/home-dashboard.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const fuel = readFileSync("./js/fuel.js", "utf8");
let passed = 0;
let failed = 0;
function test(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0, quote = null, escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`Could not close ${name}()`);
}

const headlines = html.slice(
  html.indexOf("var TODAY_REC_HEADLINES"),
  html.indexOf("function classifyPlannedSessionType")
);
const source = [
  headlines,
  extractFunction(html, "todayLocalKey"),
  extractFunction(html, "classifyPlannedSessionType"),
  extractFunction(html, "firstSentence"),
  extractFunction(html, "firstTodayInstruction"),
  extractFunction(html, "todaySessionWasAdjusted"),
  extractFunction(html, "buildTodayWorkoutCardView"),
  extractFunction(html, "homeDateKeyPlusDays"),
  extractFunction(html, "homeKeyToDate"),
  extractFunction(html, "homeNextWhenLabel"),
  extractFunction(html, "buildHomeNextView")
].join("\n\n");
const api = new Function(`${source}; return { buildTodayWorkoutCardView, buildHomeNextView, todayLocalKey, homeDateKeyPlusDays };`)();

const today = api.todayLocalKey();
const tomorrow = api.homeDateKeyPlusDays(1);
const inThree = api.homeDateKeyPlusDays(3);
const yesterday = api.homeDateKeyPlusDays(-1);
const futureRace = api.homeDateKeyPlusDays(20);

console.log("\n──── Home structure (first viewport = Today / context / Next) ────");
const order = ["todayActivePlanState", "homeNextCard", "todayWeekSnapshot", "homeFuelEntry", "todayProUpgradeCard"]
  .map(id => html.indexOf(`id="${id}"`));
test("all Home sections exist", order.every(i => i > 0), order.join(","));
test("order is Today → Next → Last 7 days → Fuel → Pro upgrade (upsell no longer above today's training)",
  order.every((v, i) => i === 0 || v > order[i - 1]));
test("Home keeps the existing greeting and training-context data sources",
  /id="todayGreeting"/.test(html) && /id="dailyBriefCard"/.test(html) && /id="todayWhyToday"/.test(html));
test("Home has no hero banner element", !/class="[^"]*home-hero/.test(html));
test("Home's first card reaches the coach through the canonical go() path; the separate Coach row is gone",
  /id="todayNoPlanAction"/.test(html) && /setAttribute\("onclick", "openCoachFromHome\(\)"\)/.test(html) &&
  /function openCoachFromHome\(\)[\s\S]*?#tabbar \.tab\[data-screen="screen-coachai"\][\s\S]*?go\(tab\)/.test(html) &&
  !/id="homeCoachCard"/.test(html));
test("Fuel row on Home is hidden by default, follows the Fuel flag, and is marked Beta",
  /id="homeFuelEntry" hidden/.test(html) &&
  /\["homeFuelEntry"\]/.test(fuel) &&
  /AthlevoFuel\.open\('home_card'\)/.test(html) &&
  /<b>Fuel <span class="beta-tag">Beta<\/span><\/b>/.test(html));
test("Fuel now lives on Home only (the You card was removed)", !/id="youFuelEntry"/.test(html) && !/AthlevoFuel\.open\('you_card'\)/.test(html));
test("Fuel is not the dominant Home feature (single link row, no Fuel summary markup)",
  (html.match(/id="homeFuelEntry"/g) || []).length === 1 && !/id="homeFuel(Summary|Card|Macros)/.test(html));

console.log("\n──── Today status (upcoming / completed / missed) ────");
const base = { id: "s1", session_date: today, session_type: "easy", duration_minutes: 45, distance_km: 8 };
const view = (session) => api.buildTodayWorkoutCardView({ hasPlan: true, plan: {}, sessions: [session] });
test("planned workout with no execution is Upcoming", view(base).status === "upcoming");
test("completed execution is Completed", view({ ...base, execution: { status: "completed" } }).status === "completed");
test("modified execution counts as Completed", view({ ...base, execution: { status: "modified" } }).status === "completed");
test("a matched activity counts as Completed", view({ ...base, matched_activity: { id: "a1" } }).status === "completed");
test("skipped execution is surfaced as missed", view({ ...base, execution: { status: "skipped" } }).status === "missed");
test("rest day carries no workout status",
  api.buildTodayWorkoutCardView({ hasPlan: true, plan: {}, sessions: [{ ...base, session_type: "rest" }] }).status === "");
test("planned duration/distance are surfaced when present", /45 min · 8 km/.test(view(base).meta));

console.log("\n──── Next (tomorrow / next session / race) — only real data ────");
const plan = (sessions, extra = {}) => ({ hasPlan: true, plan: { ...extra }, sessions });
const s = (date, type, extra = {}) => ({ id: `s-${date}`, session_date: date, session_type: type, duration_minutes: 60, ...extra });
test("no plan → nothing invented", api.buildHomeNextView({ hasPlan: false }).workout === null && api.buildHomeNextView(null).race === null);
test("tomorrow's session is shown first and labelled Tomorrow",
  (() => { const v = api.buildHomeNextView(plan([s(today, "easy"), s(inThree, "long"), s(tomorrow, "threshold", { title: "Threshold 4x8" })])); return v.workout && v.workout.title === "Threshold 4x8" && v.workout.when === "Tomorrow" && v.workout.meta === "60 min"; })());
test("falls back to the next planned session later in the week",
  (() => { const v = api.buildHomeNextView(plan([s(today, "easy"), s(inThree, "long")])); return v.workout && /Long/i.test(v.workout.title) && v.workout.when !== "Tomorrow" && v.workout.when !== ""; })());
test("a rest day tomorrow is shown as Rest day",
  api.buildHomeNextView(plan([s(tomorrow, "rest")])).workout.title === "Rest day");
test("today's and past sessions never appear under Next",
  api.buildHomeNextView(plan([s(today, "easy"), s(yesterday, "long")])).workout === null);
test("no race row when the plan carries no race date",
  api.buildHomeNextView(plan([s(tomorrow, "easy")], { target_race: "Manila Marathon" })).race === null);
test("race row appears only for a future race date",
  (() => { const v = api.buildHomeNextView(plan([s(tomorrow, "easy")], { target_race: "Manila Marathon", race_date: futureRace })); return v.race && v.race.title === "Manila Marathon" && /day|week/.test(v.race.when); })());
test("a past race date is not shown",
  api.buildHomeNextView(plan([], { target_race: "Old race", race_date: yesterday })).race === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

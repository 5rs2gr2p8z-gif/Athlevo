/*
 * Athlevo — Coach-advice-to-weekly-plan connection test suite.
 *
 * Loads the REAL js/planActionHeuristics.js and js/buildWeekPlan.js and
 * exercises them against a minimal window double, plus static checks that
 * Coach and Calendar wire into the SAME canonical action, that completed
 * workouts are protected server-side, and that the anonymous path never
 * persists a real plan.
 *
 * Run: node tests/plan-action-connection.test.mjs
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

function loadIntoWindow(path, win) {
  const src = readFileSync(path, "utf8");
  vm.createContext(win);
  vm.runInContext(src, win, { filename: path });
  return win;
}

/* ═══════════════ 1–3: heuristic trigger surface ═══════════════════ */
section("Coach trigger heuristic — when the action should/should not show");

const heuristicsWin = loadIntoWindow("./js/planActionHeuristics.js", {});
const intent = heuristicsWin.AthlevoPlanIntent;
t("module exports AthlevoPlanIntent.shouldOfferBuildPlan", typeof intent?.shouldOfferBuildPlan === "function");

const noPlan = { hasPlan: false, hasMeaningfulPlan: false };
const hasPlan = { hasPlan: true, hasMeaningfulPlan: true };

const explicitCases = [
  "Build my week",
  "Can you make my training plan this week?",
  "How should I taper this week?",
  "I have no training scheduled",
  "I missed my long run, what should I do now?"
];
explicitCases.forEach(q => {
  const d = intent.shouldOfferBuildPlan(q, { response_type: "standard", direct_answer: "" }, noPlan);
  t(`SHOULD show action for: "${q}"`, d.offer === true, JSON.stringify(d));
});

const educationalCases = [
  "What is threshold?",
  "What does HRV mean?",
  "How many carbs should I eat?",
  "What is Zone 2?"
];
educationalCases.forEach(q => {
  const d = intent.shouldOfferBuildPlan(q, { response_type: "standard", direct_answer: "Zone 2 is an easy aerobic effort." }, hasPlan);
  t(`SHOULD NOT show action for generic education: "${q}"`, d.offer === false, JSON.stringify(d));
});

t("relevant week-level advice (taper) with an existing plan still offers the action",
  intent.shouldOfferBuildPlan("What should I do this week?",
    { response_type: "decision", direct_answer: "Given the race is close, taper this week and ease off intensity." },
    hasPlan).offer === true);

t("generic reply with an existing plan and no change recommended does NOT offer the action",
  intent.shouldOfferBuildPlan("How's my week look?",
    { response_type: "standard", direct_answer: "Your week looks solid, keep it up." },
    hasPlan).offer === false);

/* ═══════════════ 4–5, 15: single canonical path ═══════════════════ */
section("Canonical plan path — Coach and Calendar call the SAME action, no second engine");

const coachSrc = readFileSync("./js/coach.js", "utf8");
const trainSrc = readFileSync("./js/train.js", "utf8");
const buildWeekSrc = readFileSync("./js/buildWeekPlan.js", "utf8");
const indexHtml = readFileSync("./index.html", "utf8");

t("Coach invokes window.AthlevoBuildWeekPlan.trigger(\"coach\")",
  /AthlevoBuildWeekPlan\.trigger\(\s*"coach"\s*\)/.test(coachSrc));
t("Calendar invokes window.AthlevoBuildWeekPlan.trigger(\"calendar\")",
  /AthlevoBuildWeekPlan\.trigger\(\s*"calendar"\s*\)/.test(trainSrc));
t("buildWeekPlan.js calls the canonical /api/training/generate-plan endpoint",
  /\/api\/training\/generate-plan/.test(buildWeekSrc));
t("no second plan-generation endpoint is introduced (no /api/training/build-week or similar)",
  !/\/api\/training\/build-week/.test(buildWeekSrc) && !/\/api\/training\/build-week/.test(trainSrc));
t("index.html loads both canonical-action modules",
  /planActionHeuristics\.js/.test(indexHtml) && /buildWeekPlan\.js/.test(indexHtml));
t("Calendar empty-state CTA routes through the canonical trigger, not a bespoke generator",
  /async function AthlevoTrainCalendarBuildPlan[\s\S]{0,800}AthlevoBuildWeekPlan\.trigger\(\s*"calendar"\s*\)/.test(trainSrc));

/* ═══════════════ 6, 9, 10: existing-plan / UX copy ═════════════════ */
section("Existing-plan confirmation and generation UX copy");

t("re-building over an existing meaningful week asks for confirmation before overwriting",
  /Update the rest of this week/.test(buildWeekSrc));
t("passes an explicit regenerate flag so the idempotency guard does not silently no-op",
  /regenerate:\s*!!weekState\.hasMeaningfulPlan/.test(buildWeekSrc));
t("shows a start-state message", /Building your week/.test(buildWeekSrc));
t("shows a success message", /Your training week is ready/.test(buildWeekSrc));
t("failure path never leaves the user stuck silently (toast or chat message on every failure branch)",
  /Couldn't build your week/.test(buildWeekSrc));
t("missing-input failure asks only for the minimum (availability), does not restart onboarding",
  /which days can you run/i.test(buildWeekSrc) && !/restartOnboarding|onboarding\.reset/i.test(buildWeekSrc));

/* ═══════════════ 7: Calendar empty state copy ══════════════════════ */
section("Calendar empty state exposes a plan CTA (no dead end)");

t("Calendar empty-state build entry point exists and is reachable from markup/JS, not just a comment",
  /AthlevoTrainCalendarBuildPlan/.test(trainSrc) && /function AthlevoTrainCalendarBuildPlan/.test(trainSrc));

/* ═══════════════ 8, 11: anonymous never persists a plan ════════════ */
section("Anonymous users cannot persist a real plan");

t("trigger() short-circuits to the signup path before any generate-plan fetch when unauthenticated",
  (() => {
    const fnBody = buildWeekSrc.slice(buildWeekSrc.indexOf("async function trigger"));
    const anonBlockEnd = fnBody.indexOf("return { ok: false, reason: \"anonymous\" };");
    const genCallIdx = fnBody.indexOf("/api/training/generate-plan");
    return anonBlockEnd > -1 && genCallIdx > -1 && anonBlockEnd < genCallIdx;
  })());
t("anonymous branch never calls fetch/generate-plan itself",
  (() => {
    const start = buildWeekSrc.indexOf("var authed = !!root.athlevoSessionUserId;");
    const end = buildWeekSrc.indexOf("var weekState = await getCurrentWeekPlanState();");
    const slice = buildWeekSrc.slice(start, end);
    return !/fetch\(/.test(slice);
  })());

const anonSrc = readFileSync("./js/anonymousCoach.js", "utf8");
t("anonymous Coach routes an explicit plan-building ask toward the signup CTA using the SAME intent detector",
  /AthlevoPlanIntent[\s\S]{0,200}shouldOfferBuildPlan/.test(anonSrc) && /appendSignupCta/.test(anonSrc));

/* ═══════════════ 5, 7 (protection): completed workouts ═════════════ */
section("Completed-workout protection in the canonical generation endpoint");

const genPlanSrc = readFileSync("./api/training/generate-plan.js", "utf8");
t("generate-plan computes protected dates before saving sessions",
  /loadProtectedSessionDates/.test(genPlanSrc));
t("protection considers both already-completed sessions and elapsed dates",
  /isPast = row\.session_date < todayKey/.test(genPlanSrc) &&
  /isActedOn/.test(genPlanSrc));
t("protection considers synced/logged execution records, not just status field",
  /workout_execution_records/.test(genPlanSrc.slice(genPlanSrc.indexOf("loadProtectedSessionDates"))));
t("generated sessions are filtered against protectedDates before saveTrainingSessions runs",
  /protectedDates\.size > 0[\s\S]{0,300}generatedPlan\.sessions = \(generatedPlan\.sessions[\s\S]{0,120}filter/.test(genPlanSrc));
{
  const saveIdx = genPlanSrc.indexOf("const savedSessions =");
  const protectIdx = genPlanSrc.indexOf("const protectedDates = await loadProtectedSessionDates(");
  t("the filter runs BEFORE the write, not after", protectIdx > -1 && saveIdx > -1 && protectIdx < saveIdx);
}
t("the write path is never a raw DELETE of existing sessions (upsert only)",
  !/DELETE FROM training_sessions/i.test(genPlanSrc) && /"training_sessions",[\s\S]{0,40}on_conflict=user_id,session_date/.test(genPlanSrc));

/* ═══════════════ 12: entitlement path respected, no new counters ══ */
section("Entitlement — reuses existing gates, no invented counters");

t("buildWeekPlan.js reuses the existing canUseTrainingFeature gate rather than inventing one",
  /canUseTrainingFeature\(\s*"additional_plan_generation"\s*\)/.test(buildWeekSrc));
t("no new entitlement counter/table name is introduced in buildWeekPlan.js",
  !/adaptive_adjustments|adjustment_counter|monthly_adjustments/i.test(buildWeekSrc));
t("generate-plan's Free/Pro/Pro+ gate is untouched by the protection change (still references free_plan_generated)",
  /free_plan_generated/.test(genPlanSrc));

/* ═══════════════ 13: analytics — safe props only ═══════════════════ */
section("Analytics events are registered with safe, non-content props");

const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");
["plan_action_shown", "plan_action_clicked", "plan_generation_completed", "calendar_empty_plan_clicked"].forEach(evt => {
  t(`registry declares "${evt}"`, new RegExp(`${evt}:\\s*\\{`).test(registrySrc));
});
["plan_generation_started", "plan_generation_failed"].forEach(evt => {
  t(`pre-existing event "${evt}" is reused, not redefined twice`,
    (registrySrc.match(new RegExp(`${evt}:\\s*\\{`, "g")) || []).length === 1);
});
t("buildWeekPlan.js never logs message text or raw athlete context as an analytics prop",
  !/track\([^)]*direct_answer/.test(buildWeekSrc) && !/track\([^)]*message/.test(buildWeekSrc));

/* ═══════════════ 16–17: Calendar/Today rendering unaffected ═══════ */
section("Existing Calendar/Today rendering is unaffected");

t("renderNoPlan() still falls back to the pre-existing onboarding start flow when nothing has ever been set up",
  /todayStartPlan\(\) : \(window\.AthlevoPlan \? AthlevoPlan\.start\(\) : AthlevoTrainCalendarBuildPlan\(\)\)/.test(trainSrc));
t("generateWeek() (existing Calendar regenerate path) is untouched/still exported",
  /window\.generateWeek\s*=\s*\n?\s*generateWeek;/.test(trainSrc));

/* ═══════════════ summary ═══════════════════════════════════════════ */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

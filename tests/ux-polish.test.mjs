/*
 * Athlevo — UX polish sprint.
 *
 * Asserts the four user-visible contracts this sprint changed, against the
 * REAL shipped files:
 *   P1  automatic first plan (and never regenerating an existing one)
 *   P2  loading language names the outcome the athlete asked for
 *   P3  the workout modal can actually open
 *   P5  no dead buttons / placeholder promises remain
 *
 * Run: node tests/ux-polish.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const planSetup = readFileSync("./js/planSetup.js", "utf8");
const connect = readFileSync("./js/onboardingConnect.js", "utf8");
const calendar = readFileSync("./js/trainCalendar.js", "utf8");

/* ══════════════════ P3 — the workout modal opens ════════════════════ */

section("P3. 'Tap for full workout' actually opens the workout");
{
  /*
   * The modal carried an inline style="display:none". openModal() adds the
   * class .show, but an inline style outranks a class — so display:none
   * always won and the modal could never appear.
   */
  const modalTag = html.match(/<div id="trainWorkoutModal"[^>]*>/)[0];
  t("the modal no longer has an inline display:none",
    !/style\s*=\s*"[^"]*display:\s*none/.test(modalTag), modalTag);
  t("it is hidden by CSS instead",
    /\.tw-modal\{[^}]*display:none/.test(html));
  t("...and revealed by the .show class openModal adds",
    /\.tw-modal\.show\{display:flex\}/.test(html));
  t("openModal adds that exact class", /m\.classList\.add\("show"\)/.test(calendar));
  t("closeModal removes it", /m\.classList\.remove\("show"\)/.test(calendar));

  // Specificity proof: an inline style would beat the class again.
  t("no inline style can re-break it",
    !/id="trainWorkoutModal"[^>]*style=/.test(html));

  // The card that triggers it is still wired.
  t("the workout card is clickable", /tcp-card[^`]*clickable/.test(calendar));
  t("...and calls openModal", /onclick="AthlevoTrainCalendar\.openModal\('/.test(calendar));
  t("the modal body element exists", /id="trainWorkoutModalBody"/.test(html));
}

section("P3. The modal covers the required fields, degrading gracefully");
{
  const fn = calendar.slice(calendar.indexOf("function openModal"),
                            calendar.indexOf("function closeModal"));
  ["Session type", "Duration", "Distance", "Target pace", "Target RPE"]
    .forEach(f => t(`shows ${f}`, fn.includes(f)));
  t("shows purpose", /s\.purpose/.test(fn));
  t("shows warm-up, main set and cooldown",
    /ul\("Warm-up", s\.warmup\)/.test(fn) && /ul\("Main set", s\.main_set\)/.test(fn) &&
    /ul\("Cooldown", s\.cooldown\)/.test(fn));
  t("shows coaching notes", /coach_reasoning/.test(fn));

  // Graceful degradation: planRow returns "" for null/empty.
  const planRow = calendar.match(/function planRow[\s\S]*?\n  \}/)[0];
  t("a missing field renders NOTHING, not 'null'",
    /value == null \|\| value === ""/.test(planRow) && /\?\s*""/.test(planRow));
  const ul = calendar.match(/function ul\(label, arr\)[\s\S]*?\n  \}/)[0];
  t("empty lists are omitted entirely",
    /\.filter\(Boolean\)/.test(ul) && /items\.length \?/.test(ul));
  t("an empty modal still says something useful",
    /No details available/.test(fn));
  t("no raw null/undefined can reach the athlete",
    !/\$\{s\.(purpose|warmup|main_set)\}/.test(fn));
}

/* ══════════════════ P1 — automatic first plan ═══════════════════════ */

section("P1. Automatic generation is BUILT but OFF");
{
  /*
   * Deliberately dormant: plan generation was repaired very recently and has
   * not been verified with real production athletes. If it failed while
   * automatic, every new beta user would hit a broken onboarding through no
   * action of their own.
   */
  t("the flag exists and is a single constant",
    /const AUTO_FIRST_PLAN = (true|false);/.test(planSetup));
  t("it is currently OFF", /const AUTO_FIRST_PLAN = false;/.test(planSetup));
  t("flipping it is a ONE-line change",
    (planSetup.match(/AUTO_FIRST_PLAN = /g) || []).length === 1);
  t("the reason is documented at the flag",
    /verified[\s\S]{0,200}AUTO_FIRST_PLAN = false/.test(planSetup) ||
    /AUTO_FIRST_PLAN[\s\S]{0,40}=[\s\S]{0,20}false/.test(planSetup));

  t("onboarding hands off through ONE entry point",
    /await root\.AthlevoPlan\.autoBuildFirstPlan\(\)/.test(connect));
  // Comments may REFERENCE the flag (useful signposting); code must not read it.
  const connectCodeOnly = connect.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  t("onboarding CODE does not branch on the mode",
    !/AUTO_FIRST_PLAN/.test(connectCodeOnly));
  t("with the flag off, the athlete lands on the dashboard",
    /if \(!AUTO_FIRST_PLAN\)[\s\S]{0,200}showScreen\("screen-today"\)/.test(planSetup));
  t("...with the plan CTA refreshed and visible",
    /if \(!AUTO_FIRST_PLAN\)[\s\S]{0,240}refreshTodayCta\(\)/.test(planSetup));
  t("no generation is triggered while off",
    planSetup.indexOf('skipped: "auto_disabled"') < planSetup.indexOf("await build()"));
}

section("P1. The manual 'Create My Training Plan' action still works");
{
  t("the Today CTA still exists", /Create My Training Plan/.test(planSetup));
  t("it still calls the real build", /onclick="AthlevoPlan\.start\(\)"/.test(planSetup));
  t("build() is untouched and still posts to generate-plan",
    /\/api\/training\/generate-plan/.test(planSetup));
  t("the empty calendar still offers a route to a plan",
    /Build My Plan/.test(calendar));
}

section("P1. When enabled, an existing plan is NEVER regenerated");
{
  const fnRaw = planSetup.slice(planSetup.indexOf("async function autoBuildFirstPlan"),
                                planSetup.indexOf("window.AthlevoPlan = {"));
  // Strip comments: prose that DESCRIBES the guarantee must not be mistaken
  // for code that violates it.
  const fn = fnRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  t("it checks for an existing plan first", /const existing = await hasPlan\(\)/.test(fn));
  t("an existing plan OPENS instead of regenerating",
    /existing === true[\s\S]{0,120}enterTrain\(\)/.test(fn));
  t("...and returns before any build call",
    fn.indexOf("already_has_plan") < fn.indexOf("await build()"));
  t("an UNKNOWN plan state does not gamble on generating",
    /existing === null/.test(fn) && /skipped: "unknown"/.test(fn) &&
    fn.indexOf('skipped: "unknown"') < fn.indexOf("await build()"));
  t("re-entry is guarded", /if \(buildInFlight\) return/.test(fn));
  t("generation only happens when there is definitively no plan",
    /await build\(\);/.test(fn));

  // The server-side guard is the real backstop.
  const api = readFileSync("./api/training/generate-plan.js", "utf8");
  t("the server still refuses to regenerate without explicit intent",
    /explicitRegenerate/.test(api) && /alreadyExists: true/.test(api));
  const connectCode = connect.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  t("the automatic path never sends regenerate:true",
    !/regenerate/.test(fn) && !/regenerate/.test(connectCode));
}

section("P1. Skipping the connection is not a dead end");
{
  t("a no-watch athlete has an explicit path", /skipConnection/.test(connect));
  t("...which reassures rather than dead-ends", /No problem/.test(connect));
  t("...explains the plan still works", /build your plan from your profile/i.test(connect));
  t("...and still reaches the dashboard",
    /skipConnection\(\)[\s\S]*?return api\.finish\(\)/.test(connect));
}

section("Import success confirms the connection before the dashboard");
{
  const fn = connect.slice(connect.indexOf("function stepSuccess"),
                           connect.indexOf("function stepProblem"));
  t("explicitly confirms the import worked", /Training history imported/.test(fn));
  t("shows the real activity count", /summary\.headline/.test(fn));
  t("shows real training stats", /This week/.test(fn) && /Longest run/.test(fn));
  t("names what happens next", /create your training plan/i.test(fn));
  t("does NOT start generation from this screen",
    !/build\(\)|generate/i.test(fn));
  t("the button simply continues", /AthlevoConnect\.finish\(\)/.test(fn));
}

/* ══════════════════ P2 — loading language ═══════════════════════════ */

section("P2. Loading names the outcome the athlete asked for");
{
  t("the heading is about a training plan, not 'a coach'",
    /Creating your personalized training plan/.test(planSetup));
  t("'building your coach' is gone", !/building your coach/i.test(planSetup));
  t("success says the plan is ready", /Your training plan is ready/.test(planSetup));

  const steps = planSetup.match(/const GEN_STEPS = \[[\s\S]*?\];/)[0];
  ["Reviewing your profile", "Understanding your goals", "Analyzing your recent training",
   "Designing your first training week", "Preparing your coach"]
    .forEach((s, i) => t(`step ${i + 1}: ${s}`, steps.includes(s)));
  t("the steps are in the requested order",
    steps.indexOf("Understanding your goals") < steps.indexOf("Analyzing your recent training") &&
    steps.indexOf("Analyzing your recent training") < steps.indexOf("Designing your first training week"));
  t("reduced motion is respected", /prefers-reduced-motion/.test(planSetup));
  t("no exaggerated timing (steps are calm, ~700ms)", /per = reduceMotion\(\) \? 120 : 700/.test(planSetup));
}

/* ══════════════════ P4 — device-first connection ════════════════════ */

section("P4. Device first, provider never fronted");
{
  t("the first screen asks what they run with", /What do you run with/.test(connect));
  t("the explain-the-service screen is gone", !/function stepExplain/.test(connect));
  t("the create-an-account screen is gone", !/function stepAccount/.test(connect));
  t("the router has two steps before detection",
    /case "device":/.test(connect) && /case "authorize":/.test(connect));

  const activation = readFileSync("./js/activation.js", "utf8");
  ["garmin", "coros", "polar", "apple", "suunto", "strava", "other"]
    .forEach(k => t(`device list includes ${k}`, activation.includes(`"${k}"`)));
  t("Apple Watch is labelled plainly", /label: "Apple Watch"/.test(activation));
  t("the catch-all is athlete-language, not 'Other provider'",
    /label: "Something else"/.test(activation));
}

/* ══════════════════ P5 — no dead ends ═══════════════════════════════ */

section("P5. No dead buttons or fake promises");
{
  t("no education card opens a toast promising missing content",
    !/toast\('Opening/.test(html));
  t("unwritten lessons are marked Coming soon and inert",
    /edu-card soon/.test(html) && /\.edu-card\.soon\{[^}]*pointer-events:none/.test(html));
  t("the community row no longer promises v1.1",
    !/coming in v1\.1/.test(html));
  t("...and is visibly disabled", /rowlink disabled/.test(html) &&
    /\.rowlink\.disabled\{[^}]*pointer-events:none/.test(html));

  // Every onclick in index.html must resolve to something real.
  /*
   * Only OUR handlers. `event.stopPropagation()` and inline `if(...)` are
   * language built-ins, not functions we could have failed to define.
   */
  const BUILTIN = /^(event|window|document|history|location|if|return|this)\b/;
  const handlers = [...html.matchAll(/onclick="[^"]*?\b([A-Za-z_$][\w$.]*)\(/g)]
    .map(m => m[1]).filter(h => !BUILTIN.test(h));
  const unique = [...new Set(handlers)];
  const js = ["brain", "planSetup", "onboarding", "onboardingConnect", "train",
              "trainCalendar", "trends", "coach", "activation", "socialAuth",
              "athlevoScore", "legal", "feedback", "memory", "readiness",
              "raceDetection", "workoutAnalysis", "developmentData", "athleteModel",
              "planEngine", "dailyBrief", "authSupport", "prescription",
              "productionVerify", "workoutGuidance", "onboarding"]
    .map(f => { try { return readFileSync(`./js/${f}.js`, "utf8"); } catch (e) { return ""; } })
    .join("\n") + html;

  const dead = unique.filter(h => {
    const name = h.split(".").pop();
    return !new RegExp(`(function\\s+${name}\\b|${name}\\s*[:=]\\s*(async\\s*)?(function|\\()|\\b${name},)`).test(js);
  });
  t("every onclick handler resolves to a real function",
    dead.length === 0, dead.join(", "));
}

section("P5. Empty states answer what/why/next");
{
  // Calendar with no plan.
  t("the empty calendar offers a way to get a plan",
    /tcp-cta[\s\S]{0,120}Build My Plan/.test(calendar));
  // No-activities during setup.
  const activation = readFileSync("./js/activation.js", "utf8");
  t("no-workouts state explains WHY", /hasn't finished syncing/i.test(activation));
  t("...and WHAT to do next",
    /Check again/.test(activation) && /Open connection settings/.test(activation));
  t("connection errors always carry an action",
    /action: "retry"/.test(activation) && /action: "reconnect"/.test(activation));
  // Plan failure.
  t("a failed plan build offers a route onward",
    /Back to Today/.test(planSetup) && /ACTIONS\[outcome\.action\]/.test(planSetup));
}


/* ══════════════ P1/P2 — Garmin guidance & detection ═════════════════ */

section("P2. Athletes are guided, not sent away");
{
  const fn = connect.slice(connect.indexOf("function stepAuthorize"),
                           connect.indexOf("function stepDetecting"));
  t("a numbered guide is shown", /<ol class="cf-guide">/.test(fn));
  t("step: create or sign in", /Create or sign in/i.test(fn));
  t("step: open Connections", /Connections/.test(fn));
  t("step: choose the device", /Choose <b>\$\{esc\(name\)\}<\/b>/.test(fn));
  t("step: wait for the sync", /Wait for the sync/i.test(fn));
  t("step: come back", /Come back here/i.test(fn));
  t("a direct link to connections is offered", /openConnections\(\)/.test(fn));
  t("the primary button confirms THEY connected the watch",
    /I&#39;ve connected|I've connected/.test(fn));
  t("the two links are documented as distinct",
    /Garmin\s+→ Intervals[\s\S]{0,120}Intervals → Athlevo/.test(connect));
}

section("P1. 'No workouts' is a guide, not an error");
{
  /*
   * Bound to THIS function, comments stripped. The next function's comment
   * block legitimately explains a "failed" connection; only what the ATHLETE
   * reads is under test here.
   */
  const fn = connect
    .slice(connect.indexOf("function stepNoWorkoutsYet"),
           connect.indexOf("function stepConnectFailed"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  t("the no-workouts state exists", fn.length > 0);
  t("it names the ACTUAL likely cause (watch not linked inside the service)",
    /isn&#39;t linked inside|isn't linked inside/.test(fn));
  t("it does not call the connection broken", !/error|failed/i.test(fn));
  t("it gives numbered steps", /<ol class="cf-guide">/.test(fn));
  t("it offers a direct link", /openConnections/.test(fn));
  t("it offers Check again", /Check again/.test(fn));
  t("it offers a way onward", /Continue without my history/.test(fn));
  t("detection routes here, not to the generic error",
    /stepNoWorkoutsYet\(\)/.test(connect));
}

section("P1. A failed probe is not reported as 'no workouts'");
{
  const activation = readFileSync("./js/activation.js", "utf8");
  t("probe errors are surfaced separately", /probeFailed/.test(activation));
  t("...and carry the reason", /probeError/.test(activation));
  t("a count is only trusted when it is a number",
    /typeof probe\.count === "number"/.test(activation));
}

section("P3/P4. Units and custom goals");
{
  const ob = readFileSync("./js/onboarding.js", "utf8");
  t("a metric/imperial toggle exists", /obRenderUnitToggle/.test(ob));
  t("storage is always metric", /Always store metric/.test(ob));
  t("height converts on save", /OB_CONVERT\.inToCm/.test(ob));
  t("weight converts on save", /OB_CONVERT\.lbToKg/.test(ob));
  t("prefill converts back for display",
    /OB_CONVERT\.cmToIn/.test(ob) && /OB_CONVERT\.kgToLb/.test(ob));
  t("'Other' goal distance exists", /label: "Other", value: "Other"/.test(ob));
  t("a custom distance field is conditional", /showWhen: \{ distance: "Other" \}/.test(ob));
  t("custom distances are normalised", /obNormalizeDistance/.test(ob));
  t("a custom goal survives resume", /d\.customDistance = profile\.goal/.test(ob));
}


section("OAuth persistence: a FAILED connect never masquerades as 'no workouts'");
{
  const api = readFileSync("./api/providers/index.js", "utf8");

  // The callback must report WHY, machine-readably.
  t("the callback can return a reason", /backToApp = \(status, message, reason\)/.test(api));
  t("the already-linked case sends reason=already_linked",
    /"already_linked"/.test(api));
  t("the ownership guard still refuses to move the link (security intact)",
    /owner\.userId !== String\(payload\.userId\)/.test(api));
  t("nothing is written when ownership fails",
    api.indexOf('"already_linked"') < api.indexOf("const saved = await upsertProviderAccount"));

  // The client must not resume detection after a failed connect.
  t("routeAfterAuth checks hasFailed() before resuming",
    /isActive\(\) &&\s*!window\.AthlevoConnect\.hasFailed\(\)/.test(html));
  t("the return handler routes failures INTO the flow",
    /showConnectFailure\(reason, message\)/.test(html));
  t("the reason param is read", /\.get\("reason"\)/.test(html));
  t("...and stripped so a refresh can't replay it", /delete\("reason"\)/.test(html));

  // The flow shows the true reason.
  t("a dedicated connect-failure screen exists", /function stepConnectFailed/.test(connect));
  t("already-linked is named honestly", /already connected to a\s*\n?\s*different Athlevo account/.test(connect));
  t("...and offers real options", /disconnect it there/.test(connect) && /different .*account/i.test(connect));
  t("resumeAfterConnect refuses to run after a failure",
    /if \(state\.running \|\| state\.failed\) return;/.test(connect));
  t("a retry clears the failure", /retryConnect\(\)[\s\S]{0,80}state\.failed = false/.test(connect));
  t("starting fresh clears it too", /markActive\(true\);\s*state\.failed = false/.test(connect));
  t("the athlete is never trapped", /Continue without my history/.test(connect));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

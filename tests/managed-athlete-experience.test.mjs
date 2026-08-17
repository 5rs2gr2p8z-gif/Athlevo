import { readFileSync } from "node:fs";

const index = readFileSync("./index.html", "utf8");
const athleteMode = readFileSync("./js/athleteMode.js", "utf8");
const coach = readFileSync("./js/coach.js", "utf8");
const dailyClient = readFileSync("./js/dailyBrief.js", "utf8");
const dailyServer = readFileSync("./api/daily-brief.js", "utf8");
const providers = readFileSync("./api/providers/index.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}

console.log("\n──── Coach surface and authority ────");
test("bottom navigation remains Today, Coach, Train, Trends, You", [
  "screen-today", "screen-coachai", "screen-train", "screen-trends", "screen-you"
].every(id => index.includes(`data-screen="${id}"`)));
test("managed Coach targets the production #screen-coachai", /getElementById\("screen-coachai"\)/.test(athleteMode));
test("obsolete #screen-coach target is absent", !/getElementById\("screen-coach"\)/.test(athleteMode));
test("AI DOM remains mounted and is hidden instead of replaced", /setAiCoachVisible/.test(athleteMode) && !/screen\.innerHTML\s*=/.test(athleteMode));
test("confirmed self-guided mode restores AI Coach and removes any human thread", /function restoreSelfGuidedCoachTab\(\)[\s\S]*removeCoachModeMounts\(\)[\s\S]*setAiCoachVisible\(true\)/.test(athleteMode));
test("confirmed human-coached mode hides AI Coach before mounting the human thread", /setAiCoachVisible\(false\)[\s\S]*am-coach-mode-mount am-human-coach/.test(athleteMode));
test("human mode hides AI starter prompts and proposals with the complete AI surface", /screen\.children[\s\S]*am-ai-surface-hidden/.test(athleteMode) && /applyCoachAction[\s\S]*AthlevoAthleteMode\.isManaged/.test(coach));
test("unknown mode renders a neutral structured Coach shell before authority resolves", /renderUnknownCoachTab/.test(athleteMode) && /am-coach-resolving-head/.test(athleteMode) && /am-coach-context-skeleton/.test(athleteMode) && !/Checking your coaching setup/.test(athleteMode));
test("Coach tab revalidates stale assignment state", /MODE_STALE_MS/.test(athleteMode) && /onCoachTabEnter/.test(index));
test("logout invalidates in-flight mode/thread work and clears stale AI DOM", /_requestGeneration \+= 1/.test(athleteMode) && /clearAiCoachDom\(\)/.test(athleteMode));
test("paused or ended transition restores self-guided Daily Brief", /previousMode === "human_coached"[\s\S]*_mode === "self_guided"[\s\S]*AthlevoDailyBrief\.load/.test(athleteMode));
test("AI history and ask execution both fail closed for managed or unknown mode", (coach.match(/AthlevoAthleteMode\.isManaged\(\) \|\| window\.AthlevoAthleteMode\.isUnknown\(\)/g) || []).length >= 3);
test("human thread uses the dedicated athlete_messages action", /action=athlete_messages/.test(athleteMode) && /actionAthleteMessages/.test(providers));
test("human messaging never uses AI coach_conversations", !athleteMode.includes("coach_conversations"));
test("human thread is bottom-anchored and has reduced-motion-safe loading skeletons", /\.am-human-coach-thread>:first-child\{margin-top:auto\}/.test(index) && /am-human-thread-loading/.test(index) && /prefers-reduced-motion:reduce/.test(index));
test("You does not receive a duplicate assigned-coach card", !/assigned_coach_viewed/.test(athleteMode) && !/section\.innerHTML[\s\S]*am-assigned-coach/.test(athleteMode));

console.log("\n──── Managed Today suppression ────");
test("managed mode hides AI Daily Brief, Coach note, and Coach Memory", /setManagedAdviceHidden\(true\)/.test(athleteMode) && /dailyBriefFull/.test(dailyClient) && /todayCoachNoteSection/.test(index) && /coachMemorySection/.test(index));
test("self-guided mode restores Coach Memory and AI advice surfaces", /_mode === "self_guided"[\s\S]*setManagedAdviceHidden\(false\)/.test(athleteMode));
test("factual Today workout and direction markup remains present", /id="dailyBriefCard"/.test(index) && /id="todayReadinessSignal"/.test(index));
test("client never requests a managed Daily Brief", /AthlevoAthleteMode\.isManaged\(\)/.test(dailyClient));
test("server resolves coaching mode before entitlement and model generation", dailyServer.indexOf("await loadCoachingMode(user.id)") < dailyServer.indexOf('requirePaidAccess(user.id, "daily_brief")') && dailyServer.indexOf("await loadCoachingMode(user.id)") < dailyServer.indexOf("await generateBriefing"));

console.log("\n──── Server privacy and identity boundary ────");
const athleteMessageAction = providers.slice(
  providers.indexOf("async function actionAthleteMessages"),
  providers.indexOf("async function actionAthleteRequestAdjustment")
);
test("athlete identity comes from verified bearer user", /getCoachingUser\(tok\)/.test(athleteMessageAction) && /athlete_id: user\.id/.test(athleteMessageAction));
test("coach identity comes from the active server-side assignment", /resolveCoachingMode/.test(athleteMessageAction) && /coach_id: resolved\.coachId/.test(athleteMessageAction));
test("client coach_id and athlete_id are never read", !/request\.body\.(coach_id|athlete_id)|request\.query.*(coach_id|athlete_id)/.test(athleteMessageAction));
test("message size uses the shared 4000-character validator", /validateCoachMessage/.test(athleteMessageAction));
test("thread response contains sanitized messages only", /loadCoachMessageThread/.test(athleteMessageAction));
test("message content is absent from analytics and server logs", !/track\([^\n]*(message|body)/.test(athleteMode) && !/log\([^\n]*(message|body)/.test(athleteMessageAction));

console.log("\n──── Executable managed Daily Brief block ────");
{
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalOpenAi = process.env.OPENAI_API_KEY;
  process.env.SUPABASE_URL = "https://supabase.managed.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  process.env.OPENAI_API_KEY = "openai-test";
  let modelCalls = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "athlete-1" }), { status: 200 });
    if (url.includes("coach_athlete_assignments")) {
      return new Response(JSON.stringify([{
        id: "assignment-1", coach_id: "coach-1", athlete_id: "athlete-1",
        status: "active", assigned_at: "2026-08-01T00:00:00Z"
      }]), { status: 200 });
    }
    if (url.includes("api.openai.com")) modelCalls += 1;
    throw new Error(`Unexpected request after managed-mode decision: ${url}`);
  };
  const { default: dailyHandler } = await import(`../api/daily-brief.js?managed=${Date.now()}`);
  const result = { status: null, body: null };
  await dailyHandler(
    { method: "POST", headers: { authorization: "Bearer verified-jwt" }, body: {} },
    { status(code) { result.status = code; return this; }, json(body) { result.body = body; return body; } }
  );
  test("managed athlete receives a clear 403", result.status === 403 && result.body.code === "HUMAN_COACHED");
  test("managed Daily Brief is blocked before any model request", modelCalls === 0);
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAi;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

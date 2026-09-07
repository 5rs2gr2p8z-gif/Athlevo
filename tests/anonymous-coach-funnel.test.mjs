/*
 * Anonymous Coach acquisition funnel — behavioral contract.
 * Run: node tests/anonymous-coach-funnel.test.mjs
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const coachSrc = readFileSync("./js/coach.js", "utf8");
const anonSrc = readFileSync("./js/anonymousCoach.js", "utf8");
const endpointSrc = readFileSync("./lib/server/coachAnonymousEndpoint.js", "utf8");
const gatewaySrc = readFileSync("./api/providers/index.js", "utf8");
const vercelSrc = readFileSync("./vercel.json", "utf8");
const ignoreSrc = readFileSync("./.vercelignore", "utf8");
const rateLimitSrc = readFileSync("./lib/server/rateLimit.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");
const handoffSrc = readFileSync("./js/diagnosticHandoff.js", "utf8");
const apiCoachSrc = readFileSync("./api/coach.js", "utf8");

function askCoachBody() {
  const start = coachSrc.indexOf("async function askCoach(question)");
  const end = coachSrc.indexOf("\nfunction ask(question)", start);
  return coachSrc.slice(start, end);
}

section("1 — Header Sign up already routes to the canonical signup flow");
{
  t("header Sign up button calls openSignup(true) (the canonical auth entrypoint)",
    /id="coachHeaderSignIn"[\s\S]{0,200}onclick="openSignup\(true\)"/.test(indexSrc));
  t("openSignup opens the single #authModal used by every other signup path",
    /function openSignup\(userChoseSignup\) \{[\s\S]{0,400}authModal/.test(indexSrc));
  t("no second/legacy signup modal implementation was added for anonymous Coach",
    !/coachHeaderSignIn[\s\S]{0,200}(legacyCreateAccount|openLegacySignup)/.test(indexSrc));
}

section("2 — First anonymous send no longer force-opens signup");
{
  const body = askCoachBody();
  t("anonymous branch still gates on !window.athlevoSessionUserId",
    /if \(!window\.athlevoSessionUserId\) \{/.test(body));
  t("anonymous branch no longer calls openSignup/openLogin as its primary path",
    !/if \(!window\.athlevoSessionUserId\) \{[^}]*?openSignup\(true\)/.test(body.split("Anonymous chat module failed")[0]));
  t("anonymous branch hands off to window.AthlevoAnonymousCoach.ask(...)",
    /window\.AthlevoAnonymousCoach && typeof window\.AthlevoAnonymousCoach\.ask === "function"/.test(body) &&
    /window\.AthlevoAnonymousCoach\.ask\(cleanQuestion\)/.test(body));
  t("a graceful fallback to signup still exists if the anonymous module fails to load",
    /Anonymous chat module failed to load/.test(body) && /openSignup\(true\)/.test(body));
  t("the authenticated branch (claimCoachRequest / quota / verified session) is unchanged below the anonymous gate",
    /claimCoachRequest\(\)/.test(body) && /resolveCoachAccessState/.test(body));
}

section("3/4/5 — Anonymous diagnostic reasoning: no hallucinated athlete data");
{
  const forbidden = ["mileage", "readiness", "HRV", "fitness", "trainingState", "race history", "wearable data"];
  t("developer prompt explicitly forbids claiming unavailable athlete data",
    forbidden.every(term => endpointSrc.includes(term)));
  t("developer prompt tells the model it has no training history for this visitor",
    /no training history, no wearable data, no readiness\/HRV, no plan, and no\s*race history/.test(endpointSrc));
  t("developer prompt asks for one small insight + the next most useful question, not a form",
    /No interrogation/.test(endpointSrc) && /at most one question/.test(endpointSrc));
  t("only the CURRENT diagnostic question's fields are ever sent to the model",
    /Only try to extract these fields/.test(endpointSrc));
}

section("6 — Conversion CTA, not a first-message interrupt");
{
  t("CTA only appears after a minimum number of real exchanges or a completed diagnostic",
    /MIN_TURNS_BEFORE_CTA/.test(anonSrc) && /_turnCount >= MIN_TURNS_BEFORE_CTA/.test(anonSrc));
  t("CTA button text matches the requested continuation copy",
    /Continue with Athlevo/.test(anonSrc));
  t("CTA routes to the same canonical openSignup(true) entrypoint",
    /root\.openSignup\(true\)/.test(anonSrc));
  t("CTA is only ever shown once per session (not re-injected every turn)",
    /_ctaShown/.test(anonSrc));
}

section("7 — Anonymous facts preserved through the EXISTING diagnostic handoff");
{
  t("anonymous module reuses window.AthlevoDiagnostic — no second profile/fact store",
    /root\.AthlevoDiagnostic\.load\(\) \|\| root\.AthlevoDiagnostic\.create\(\)/.test(anonSrc));
  t("anonymous module does not define its own storage key for athlete facts",
    !/localStorage\.setItem/.test(anonSrc));
  t("existing diagnosticHandoff.js is untouched and still gates import on a COMPLETED engine",
    /if \(!engine\.completed \|\| !engine\.result\) \{/.test(handoffSrc));
  t("anonymous module marks the engine completed via the engine's own complete() when sufficient",
    /engine\.complete\(\)/.test(anonSrc) && /canComplete/.test(anonSrc));
}

section("8 — Anonymous funnel is compatible with, but does not add, the future paid-tier UI");
{
  t("no payment/plan-selection UI was added by this change",
    !/choose.?pro|plan.?selection|payment.?method/i.test(anonSrc));
  t("authenticated Coach quota logic (api/coach.js) applies per-tier monthly allowances",
    /Free athletes receive 10 Coach messages per calendar month/.test(apiCoachSrc));
}

section("9 — Starters reuse the single askCoach() gate");
{
  t("starter buttons still call askCoach(prompt), same as typed sends",
    /container\.addEventListener\("click"[\s\S]{0,300}askCoach\(prompt\)/.test(coachSrc));
}

section("10 — Security / data boundaries on the new endpoint");
{
  t("no auth/session/token check gates the anonymous endpoint (by design — no private data to protect it from)",
    !/verifySupabaseAccessToken/.test(endpointSrc));
  t("anonymous endpoint is rate-limited via the anonymous limiter, not the per-user one",
    /checkAnonymousAiRateLimit\(anonClientKey\(req\), "coach-anonymous"\)/.test(endpointSrc));
  t("sanitizeBody only reads message/question_key/question_fields/history from the request",
    /const message = cleanText\(body\.message/.test(endpointSrc) &&
    !/body\.context|body\.trainingState|body\.athlete/.test(endpointSrc));
  t("endpoint source has no code path reading trainingState/wearable/coach_threads (only explanatory comments)",
    !/(req|payload|body)\.(trainingState|wearableData|athleteMemory)/.test(endpointSrc));
  t("request payload is strictly sanitized (message length cap, field allowlist, history cap)",
    /MAX_MESSAGE_LENGTH/.test(endpointSrc) && /sanitizeQuestionFields/.test(endpointSrc) && /MAX_HISTORY_TURNS/.test(endpointSrc));
  t("rate limit config adds a dedicated, tighter anonymous entry",
    /"coach-anonymous": \{ limit: 20, windowMinutes: 60 \}/.test(rateLimitSrc));
}

section("11 — Deployment wiring follows the existing Hobby-plan-safe pattern");
{
  t("gateway (api/providers) dispatches action=coach_anonymous to the new handler",
    /if \(action === "coach_anonymous"\) \{\s*return coachAnonymousHandler\(request, response\);/.test(gatewaySrc));
  t("vercel.json rewrites /api/coach-anonymous to the gateway, like diagnostic-chat",
    /"source": "\/api\/coach-anonymous"[\s\S]{0,80}"destination": "\/api\/providers\?action=coach_anonymous"/.test(vercelSrc));
  t(".vercelignore excludes the thin local entrypoint from deployment (does not spend a 13th function slot)",
    /api\/coach-anonymous\.js/.test(ignoreSrc));
}

section("12 — Nothing else in Coach/auth architecture was touched");
{
  t("authenticated verified-session check (AthlevoSession.getVerifiedSession) is unchanged",
    /AthlevoSession\.getVerifiedSession\(supabaseClient\)/.test(coachSrc));
  t("saveConversationMessage (coach_threads/coach_conversations persistence) is unchanged and untouched by anonymous code",
    /async function saveConversationMessage\(role, message\)/.test(coachSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

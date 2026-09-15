/*
 * Athlevo — routeAfterAuth fresh-signup ordering tests.
 *
 * Covers the "signup -> pricing immediately, skipping diagnostic
 * onboarding" bug: an ordinary /signup visit was being mistaken for the
 * paid-first /ai-signup funnel, forcing every fresh signup into
 * AthlevoDiagnosticAcquisition's paywall gate before routeAfterAuth ever
 * reached the onboarding_complete / diagnostic_onboarding_v2 branch.
 *
 * SOURCE-LEVEL verification (matches the style of
 * tests/diagnostic-onboarding-v2.test.mjs and tests/account-deletion.test.mjs)
 * — no live database or network.
 *
 * Run: node tests/route-after-auth-fresh-signup.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const apiSrc = readFileSync("./api/providers/index.js", "utf8");
const acquisitionSrc = readFileSync("./js/diagnosticAcquisition.js", "utf8");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}`); }
};
const section = s => console.log(`\n──── ${s} ────`);

/* ══════════════════════════════════════════════════════════════════════
 * (a)/(b) A plain /signup visit must not be mistaken for the paid-first
 * /ai-signup funnel.
 * ══════════════════════════════════════════════════════════════════════ */
section("ROOT CAUSE — isAiSignupPath() no longer aliases isSignupPath()");

const isAiSignupPathMatch = html.match(/function isAiSignupPath\(\)\s*\{[\s\S]*?\n\}/);
const isAiSignupPathBody = isAiSignupPathMatch ? isAiSignupPathMatch[0] : "";

t("isAiSignupPath() exists",
  !!isAiSignupPathBody);

t("isAiSignupPath() no longer delegates to isSignupPath() (that made plain /signup register as paid-first)",
  !/return isSignupPath\(\);/.test(isAiSignupPathBody));

t("isAiSignupPath() checks the dedicated /ai-signup path specifically",
  /["']\/ai-signup["']/.test(isAiSignupPathBody));

/* ════════════════════════════════════════════════════════════════════
 * (b) Boot-time ai-signup handoff marker (sessionStorage) must only be
 * set for the real /ai-signup entry, not for plain /signup.
 * ══════════════════════════════════════════════════════════════════════ */
section("ROOT CAUSE — boot-time rememberAiSignupHandoff() scoped to /ai-signup only");

const bootBlockMatch = html.match(
  /var aiPath = url\.pathname[\s\S]*?rememberAiSignupHandoff\(\);\s*\n\s*\}/
);
const bootBlock = bootBlockMatch ? bootBlockMatch[0] : "";

t("boot init block found (initializeAthlevoApp aiPath handling)",
  !!bootBlock);

t("plain /signup no longer sets the ai-signup handoff marker at boot",
  !/aiPath === ["']\/signup["'][^\n]*&&[\s\S]{0,40}rememberAiSignupHandoff/.test(bootBlock) &&
  !/\(aiPath === ["']\/signup["'] \|\|[\s\S]{0,60}rememberAiSignupHandoff/.test(bootBlock));

t("/ai-signup itself still sets the handoff marker (legacy link stays paid-first)",
  /aiPath === ["']\/ai-signup["'][\s\S]{0,80}rememberAiSignupHandoff\(\);/.test(bootBlock) ||
  (/aiPath === ["']\/ai-signup["']/.test(bootBlock) && /rememberAiSignupHandoff\(\);/.test(bootBlock)));

t("rememberAppEntryIntent for /ai, /, and /signup is untouched (unrelated tracking, not the paid-first gate)",
  /aiPath === ["']\/ai["'][\s\S]{0,20}aiPath === ["']["'][\s\S]{0,20}aiPath === ["']\/signup["'][\s\S]{0,20}aiPath === ["']\/ai-signup["'][\s\S]{0,40}rememberAppEntryIntent/.test(bootBlock));

/* ══════════════════════════════════════════════════════════════════════
 * (c)/(d) routeAfterAuth: onboarding-incomplete must never resolve straight
 * to pricing; the completed/diagnostic-v2 branch still sits after the
 * (unchanged) paid-first acquisition resolver, per the required order.
 * ══════════════════════════════════════════════════════════════════════ */
section("ROUTER ORDER — paid-first resolver, then onboarding-completion, then pricing gate");

const routeSrcFull = html.slice(
  html.indexOf("async function routeAfterAuth"),
  html.indexOf("async function routeAfterAuth") + 12000
);

const acquisitionResolvePos = routeSrcFull.indexOf("AthlevoDiagnosticAcquisition.resolveAfterAuth");
const completedConstPos = routeSrcFull.indexOf("const completed =");
const notCompletedBranchPos = routeSrcFull.indexOf("if (!completed) {");
const gateUnpaidPos = routeSrcFull.indexOf("gateUnpaidAthlete");

t("paid-first acquisition resolver runs before the onboarding_complete determination",
  acquisitionResolvePos > 0 && completedConstPos > 0 && acquisitionResolvePos < completedConstPos);

t("onboarding_complete is determined before the unpaid pricing gate (gateUnpaidAthlete)",
  completedConstPos > 0 && gateUnpaidPos > 0 && completedConstPos < gateUnpaidPos);

t("the unpaid pricing gate (gateUnpaidAthlete) is reached only after the !completed branch already returned",
  notCompletedBranchPos > 0 && gateUnpaidPos > 0 && notCompletedBranchPos < gateUnpaidPos);

t("fresh/loading profile (profile === null, e.g. row not yet created) is never treated as completed",
  /const completed =\s*\n\s*profile &&/.test(routeSrcFull));

/* ══════════════════════════════════════════════════════════════════════
 * (g) Paid-first acquisition behavior itself is unchanged by this fix.
 * ════════════════════════════════════════════════════════════════════ */
section("PAID-FIRST FUNNEL UNTOUCHED");

t("js/diagnosticAcquisition.js resolveAfterAuth / isAcquisitionGated logic is unmodified by this fix (fromAiSignup gate still present, unchanged shape)",
  /if \(fromAiSignup\) return true;/.test(acquisitionSrc));

t("resolveAfterAuth still short-circuits to the app/onboarding for verified paid access first (unchanged)",
  (() => {
    const fnMatch = acquisitionSrc.match(/async function resolveAfterAuth\([\s\S]*?\n}/);
    const fnBody = fnMatch ? fnMatch[0] : "";
    const paidPos = fnBody.indexOf("var paid = await verifiedPaidAccess(supabase, userId);");
    const gatedCallPos = fnBody.indexOf("isAcquisitionGated(userId,");
    return paidPos > 0 && gatedCallPos > 0 && paidPos < gatedCallPos;
  })());

/* ══════════════════════════════════════════════════════════════════════
 * (e) Account deletion clears onboarding/diagnostic/acquisition state but
 * preserves the athlevo_ff_* feature-flag override.
 * ══════════════════════════════════════════════════════════════════════ */
section("ACCOUNT DELETION — flag override preserved, everything else cleared");

const confirmDeleteMatch = html.match(/async function confirmDeleteAccount\([\s\S]*?^}/m);
const confirmDeleteBody = confirmDeleteMatch ? confirmDeleteMatch[0] : "";

t("confirmDeleteAccount found",
  !!confirmDeleteBody);

t("still wipes sessionStorage and localStorage wholesale as the baseline",
  /sessionStorage\.clear\(\)/.test(confirmDeleteBody) && /localStorage\.clear\(\)/.test(confirmDeleteBody));

t("captures athlevo_ff_ prefixed keys before localStorage.clear()",
  (() => {
    const clearPos = confirmDeleteBody.indexOf("localStorage.clear();");
    const before = confirmDeleteBody.slice(0, clearPos);
    return clearPos > 0 && /athlevo_ff_/.test(before) && /localStorage\.getItem/.test(before);
  })());

t("restores the captured athlevo_ff_ override(s) after localStorage.clear()",
  (() => {
    const clearPos = confirmDeleteBody.indexOf("localStorage.clear();");
    const after = confirmDeleteBody.slice(clearPos);
    return clearPos > 0 && /localStorage\.setItem/.test(after);
  })());

t("does not special-case the diagnostic acquisition STORAGE_KEY or any other non-flag key for preservation",
  !/athlevo_diagnostic_acquisition_v1/.test(confirmDeleteBody) &&
  !/athlevo_pending_diagnostic_v1/.test(confirmDeleteBody));

/* ══════════════════════════════════════════════════════════════════════
 * (a) Server-side deletion also removes the athlete_diagnostics row(s)
 * that a recreated account's paid-first acquisition state lives in.
 * ══════════════════════════════════════════════════════════════════════ */
section("ACCOUNT DELETION — server-side athlete_diagnostics cleanup");

t("actionDeleteAccount deletes athlete_diagnostics rows for this user (added to the Stage 3 userDataTables loop)",
  (() => {
    const tablesMatch = apiSrc.match(/const userDataTables = \[[\s\S]*?\];/);
    return !!tablesMatch && /"athlete_diagnostics"/.test(tablesMatch[0]);
  })());

t("athlete_diagnostics cleanup (stage 3, via userDataTables) happens before the profiles row is deleted (stage 4)",
  (() => {
    const userDataTablesPos = apiSrc.indexOf("const userDataTables = [");
    const profilesDeletePos = apiSrc.indexOf('deleteFrom("profiles"');
    return userDataTablesPos > 0 && profilesDeletePos > 0 && userDataTablesPos < profilesDeletePos;
  })());

/* ══════════════════════════════════════════════════════════════════════
 * (f) A missing/loading profile row must not fall through to "complete".
 * ══════════════════════════════════════════════════════════════════════ */
section("MISSING/LOADING PROFILE NEVER READS AS COMPLETE");

t("profile lookup error path falls back to onboarding (or paywall only for genuine ai-signup), never straight to app",
  (() => {
    const idx = routeSrcFull.indexOf("if (error) {");
    const block = routeSrcFull.slice(idx, idx + 500);
    return /startOnboarding\(\);/.test(block);
  })());

t("authenticatedOnboarding.start() fails safe (returns false -> legacy onboarding) when the profile row does not exist yet",
  (() => {
    const orchSrc = readFileSync("./js/authenticatedOnboarding.js", "utf8");
    return /if \(!profile\) return false;.*fail safe/.test(orchSrc.replace(/\n/g, " "));
  })());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

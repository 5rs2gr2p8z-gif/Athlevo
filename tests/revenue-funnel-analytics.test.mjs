/*
 * Athlevo — Revenue funnel measurability (PostHog).
 *
 * This suite does NOT re-assert every event already covered by
 * tests/conversion-monetization.test.mjs, tests/signup-funnel-analytics.test.mjs,
 * tests/acquisition-funnel-analytics.test.mjs, tests/coach-athlete-analytics.test.mjs,
 * or tests/posthog-analytics.test.mjs — those stay the source of truth for their
 * events and must remain green.
 *
 * It proves the ONE gap found in the "make the revenue funnel measurable" audit:
 * upgrade_clicked / upgrade_sheet_viewed / checkout_started previously carried no
 * property distinguishing WHY the upgrade path opened (first_plan vs coach_limit
 * vs plan_limit vs settings vs a direct/pricing open) — so PostHog could not build
 * Funnel C (Monetization) or Funnel D (Coach-limit monetization) breakdowns per
 * docs/acquisition-activation-analytics.md.
 *
 * Run: node tests/revenue-funnel-analytics.test.mjs
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");
const guardSrc = readFileSync("./js/accessGuard.js", "utf8");
const coachSrc = readFileSync("./js/coach.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");
const analyticsSrc = readFileSync("./js/analytics.js", "utf8");

/* ══════════ 1. Registry: trigger is an allowlisted, enumerated prop ═══ */
section("1. Trigger taxonomy is registered, not free text");
{
  t("upgrade_clicked accepts trigger",
    /upgrade_clicked:\s*\{\s*kind:\s*"behavioural",\s*props:\s*\[[^\]]*"trigger"[^\]]*\]\s*\}/.test(registrySrc));
  t("upgrade_sheet_viewed accepts trigger",
    /upgrade_sheet_viewed:\s*\{\s*kind:\s*"behavioural",\s*props:\s*\[[^\]]*"trigger"[^\]]*\]\s*\}/.test(registrySrc));
  t("checkout_started accepts trigger",
    /checkout_started:\s*\{\s*kind:\s*"behavioural",\s*props:\s*\[[^\]]*"trigger"[^\]]*\]/.test(registrySrc));
  t("trigger values are a closed enum: first_plan, coach_limit, plan_limit, settings, pricing_direct",
    /trigger:\s*\{\s*\n?\s*first_plan:\s*true,\s*coach_limit:\s*true,\s*plan_limit:\s*true,\s*\n?\s*settings:\s*true,\s*pricing_direct:\s*true/.test(registrySrc));
}

/* ══════════ 2. Every paywall entry point carries a real trigger ═══════ */
section("2. Every PAYWALL_CONTEXTS entry maps to a canonical trigger");
{
  const ctxBlock = guardSrc.slice(
    guardSrc.indexOf("const PAYWALL_CONTEXTS"),
    guardSrc.indexOf("function openPaywall"));
  const entries = ["athlete-status", "training-plan", "trends", "coach-limit",
    "first-plan-aha", "plan-limit", "general-upgrade", "settings-upgrade"];
  entries.forEach(key => {
    const idx = ctxBlock.indexOf(`"${key}":`);
    const chunk = ctxBlock.slice(idx, ctxBlock.indexOf("}),", idx));
    t(`"${key}" carries a trigger property`, idx !== -1 && /trigger:\s*"(first_plan|coach_limit|plan_limit|settings|pricing_direct)"/.test(chunk));
  });
  t("coach-limit is tagged coach_limit specifically (Funnel D)",
    /"coach-limit":[\s\S]{0,300}trigger:\s*"coach_limit"/.test(ctxBlock));
  t("first-plan-aha is tagged first_plan specifically",
    /"first-plan-aha":\s*Object\.freeze\(\{[\s\S]{0,600}?trigger:\s*"first_plan"/.test(ctxBlock));
  t("plan-limit is tagged plan_limit specifically",
    /"plan-limit":[\s\S]{0,300}trigger:\s*"plan_limit"/.test(ctxBlock));
  t("openPaywall() actually forwards ctx.trigger into showUpgradeSheet()",
    /showUpgradeSheet\(ctx\.feature, ctx\.surface, \{[\s\S]{0,150}\}, ctx\.trigger\);/.test(guardSrc));
}

/* ══════════ 3. Settings gets its own attribution, not lumped into direct ═ */
section("3. Settings upgrade CTA is distinguishable from a direct/pricing open");
{
  t("the Settings plan-status CTA opens the settings-upgrade context",
    /id="settingsPlanUpgradeCta"[\s\S]{0,60}onclick="AthlevoAccessGuard\.openPaywall\('settings-upgrade'\)"/.test(indexSrc));
  t("settings-upgrade is a distinct PAYWALL_CONTEXTS key from general-upgrade",
    /"settings-upgrade":\s*Object\.freeze\(\{/.test(guardSrc) &&
    /"general-upgrade":\s*Object\.freeze\(\{/.test(guardSrc));
}

/* ══════════ 4. Coach-limit branch threads trigger end to end ══════════ */
section("4. Coach-limit conversion branch (Funnel D) is measurable end to end");
{
  t("the coach quota-exhaustion prompt opens the coach-limit paywall context",
    /AthlevoAccessGuard\.openPaywall\("coach-limit"\)/.test(coachSrc));
  t("the coach.js direct showUpgradeSheet fallback also tags coach_limit",
    /AthlevoAccessGuard\.showUpgradeSheet\("coach_message", "coach", \{[\s\S]{0,200}\}, "coach_limit"\);/.test(coachSrc));
}

/* ══════════ 5. trackAthlevoEvent() actually forwards trigger to PostHog ═ */
section("5. Categorical sanitizer keeps trigger, drops everything unsafe");
{
  t("upgrade_clicked/premium_feature_viewed forward a present trigger",
    /if \(premiumCategorical\) \{\s*safe = \{[\s\S]{0,400}?trigger: safe\.trigger/.test(analyticsSrc));
  t("upgrade_sheet_viewed forwards a present trigger",
    /\} else if \(upgradeSheetCategorical\) \{\s*safe = \{[\s\S]{0,400}?trigger: safe\.trigger/.test(analyticsSrc));
  t("checkout_started forwards a present trigger",
    /\} else if \(checkoutCategorical\) \{\s*safe = \{[\s\S]{0,600}?trigger: safe\.trigger/.test(analyticsSrc));
}

/* ══════════ 6. accessGuard validates trigger against the closed enum ══ */
section("6. accessGuard never passes an arbitrary trigger value through");
{
  t("categoricalContext() validates trigger against UPGRADE_TRIGGERS before use",
    /const UPGRADE_TRIGGERS = new Set\(\[\s*"first_plan", "coach_limit", "plan_limit", "settings", "pricing_direct"\s*\]\);/.test(guardSrc));
  t("an unknown trigger value is dropped (null), never forwarded raw",
    /const trigger = UPGRADE_TRIGGERS\.has\(input\.trigger\) \? input\.trigger : null;/.test(guardSrc));
}

/* ══════════ 7. Sensitive-data audit (spec §12) ═════════════════════════ */
section("7. No sensitive keys were introduced by this change");
{
  t("PROHIBITED_KEYS still blocks email/name/token/message/etc.",
    /PROHIBITED_KEYS = \/\(email\|name\|token\|secret\|message\|content\|text\|note\|gps/.test(registrySrc));
  t("the new trigger prop is a short categorical enum, not matched by PROHIBITED_KEYS",
    !/email|name|token|secret|message|content|text|note|gps|lat|lng|lon|coord|address|phone|payload|raw|workout|injury|pain|dob|birth|password/i.test("trigger"));
}

/* ══════════ 8. Regression guard — existing funnel names untouched ═════ */
section("8. Canonical funnel event names are unchanged (reuse, not renaming)");
{
  ["signup_started", "registration_completed", "onboarding_completed",
   "payment_screen_viewed", "free_account_created", "first_plan_generated",
   "free_plan_aha_seen", "coach_weekly_limit_reached", "checkout_started",
   "subscription_activated", "coach_opened", "first_coach_message_sent"
  ].forEach(name => {
    t(`"${name}" is still a registered canonical event`,
      new RegExp(`\\b${name}:\\s*\\{\\s*kind:`).test(registrySrc));
  });
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

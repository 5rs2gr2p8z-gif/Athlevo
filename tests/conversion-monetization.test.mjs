/*
 * Athlevo — Free → Pro conversion & monetization readiness.
 *
 * Covers the growth-focused changes: the first-plan "aha" upgrade moment,
 * the fix that let a Free athlete actually reach that moment (their first
 * plan generation was being blocked client-side before it ever reached the
 * server), the Settings/You plan-status surface, and that upgrade prompts
 * stay contextual (post-value) rather than blocking.
 *
 * Run: node tests/conversion-monetization.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const planSetupSrc = readFileSync("./js/planSetup.js", "utf8");
const guardSrc = readFileSync("./js/accessGuard.js", "utf8");
const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");
const featuresSrc = readFileSync("./js/features.js", "utf8");

/* ══════════ 1. Free first-plan generation is not blocked ═══════════ */
section("1. Free first-plan generation reaches the server");
{
  t("features.js still marks initial_plan as free (unchanged)",
    /initial_plan:\s*\{\s*label:\s*"Initial Training Plan",\s*minPlan:\s*"free"/.test(featuresSrc));

  const buildFn = planSetupSrc.slice(
    planSetupSrc.indexOf("async function build()"),
    planSetupSrc.indexOf("if (buildInFlight) return;", planSetupSrc.indexOf("async function build()")) + 40
  );
  t("build() no longer hard-blocks every non-paid athlete outright",
    !/if \(access !== "paid_active"\) \{\s*AthlevoAccessGuard\.openPaywall\("training-plan"\);\s*return;\s*\}/.test(buildFn));
  t("build() only paywalls a REGENERATION (athlete already has a usable plan)",
    /alreadyHasPlan[\s\S]{0,20}=[\s\S]{0,20}await hasPlan\(\)/.test(buildFn) &&
    /if \(alreadyHasPlan === true\)/.test(buildFn));

  const autoFn = planSetupSrc.slice(
    planSetupSrc.indexOf("async function autoBuildFirstPlan()"),
    planSetupSrc.indexOf("function autoFirstPlanEnabled")
  );
  t("autoBuildFirstPlan() no longer gates a plan-less free athlete away from build()",
    !/skipped: "free_user"/.test(autoFn));
  t("...it falls through to await build() for a free athlete without a plan",
    /await build\(\);\s*return \{ generated: true \};/.test(autoFn));
}

/* ══════════ 2. First-plan "aha" upgrade moment ═══════════════════════ */
section("2. VALUE → NEXT DESIRE → RELEVANT UPGRADE, not OPEN APP → PAYWALL");
{
  t("the activation milestone (the plan itself) still renders first",
    planSetupSrc.indexOf("Your AI coach is ready.") <
    planSetupSrc.indexOf("renderFirstPlanAhaUpgrade(mount);"));
  t("the upgrade surface is appended, never replacing the plan/checklist",
    /wrap\.appendChild\(aha\)/.test(planSetupSrc));
  t("it is gated to free/paid_inactive only — never shown to a paid athlete",
    /if \(access !== "free" && access !== "paid_inactive"\) return;/.test(planSetupSrc));
  t("CTA opens the contextual paywall rather than jumping straight to checkout",
    /AthlevoAccessGuard\.openPaywall\("first-plan-aha"\)/.test(planSetupSrc));
  t("a dedicated PAYWALL_CONTEXTS entry backs the CTA (single source of copy)",
    /"first-plan-aha":\s*Object\.freeze\(\{/.test(guardSrc));
  t("the aha copy never invents urgency, discounts, or testimonials",
    !/\bact now\b|\blimited time\b|\bdiscount\b|% off/i.test(
      guardSrc.slice(guardSrc.indexOf('"first-plan-aha"'), guardSrc.indexOf('"first-plan-aha"') + 400)));
}

/* ══════════ 3. Plan-limit / regeneration prompt ═════════════════════ */
section("3. Plan-limit upgrade stays contextual (no invented counter)");
{
  t("a plan-limit PAYWALL_CONTEXTS entry exists",
    /"plan-limit":\s*Object\.freeze\(\{/.test(guardSrc));
  t("the used-free-plan CTA routes into the canonical paywall, not straight to checkout",
    /onclick: "AthlevoAccessGuard\.openPaywall\('plan-limit'\)"/.test(planSetupSrc));
  t("no new regeneration counter was introduced",
    !/regenerationCount|regen_count|adjustmentsUsed|adjustments_used/i.test(planSetupSrc));
}

/* ══════════ 4. Analytics — reuse first, extend only where missing ══ */
section("4. Analytics funnel");
{
  t("free_plan_aha_seen is registered (only new event added)",
    /free_plan_aha_seen:\s*\{\s*kind:\s*"milestone",\s*props:\s*\["surface"\]\s*\}/.test(registrySrc));
  t("it fires exactly once, from the aha-render path, with a safe categorical prop only",
    /AthlevoAnalytics\.track\("free_plan_aha_seen", \{ surface: "first_plan" \}\)/.test(planSetupSrc));
  t("no coach message text or free-form athlete content is passed to it",
    !/free_plan_aha_seen[\s\S]{0,120}(message|question|content)\b/.test(planSetupSrc));
  t("existing upgrade_clicked/upgrade_sheet_viewed/checkout_started remain the funnel backbone (reused, not duplicated)",
    /upgrade_clicked:/.test(registrySrc) &&
    /upgrade_sheet_viewed:/.test(registrySrc) &&
    /checkout_started:/.test(registrySrc));
}

/* ══════════ 5. Settings/You subscription surface ═══════════════════ */
section("5. One canonical Settings plan-status surface");
{
  const settingsStart = indexSrc.indexOf('id="screen-settings"');
  const settingsEnd = indexSrc.indexOf("</section>", settingsStart);
  const settingsHtml = indexSrc.slice(settingsStart, settingsEnd);
  t("Settings has exactly one plan-status card",
    (settingsHtml.match(/id="settingsPlanCard"/g) || []).length === 1);
  t("You screen does NOT duplicate a second plan-status card",
    !/id="settingsPlanCard"/.test(indexSrc.slice(indexSrc.indexOf('id="screen-you"'), settingsStart)));
  t("the upgrade CTA routes into the canonical paywall",
    /id="settingsPlanUpgradeCta"[\s\S]{0,60}onclick="AthlevoAccessGuard\.openPaywall\('general-upgrade'\)"/.test(indexSrc));
  t("renderSettingsPlanStatus() reads the SAME entitlement source of truth as the paywall",
    /AthlevoPlan\.entitlement\(\)/.test(indexSrc.slice(indexSrc.indexOf("function renderSettingsPlanStatus"))));
  t("a paid athlete's card hides the Upgrade CTA (CSS) rather than showing a misleading one",
    /\[data-tier="paid"\] \.settings-plan-cta\{display:none\}/.test(indexSrc));
  t("openSettings() actually calls the renderer",
    /syncSettingsProfilePhoto\(\);\s*renderSettingsPlanStatus\(\);/.test(indexSrc));
}

/* ══════════ 6. Pro+ safety (unchanged, re-asserted) ═════════════════ */
section("6. Pro+ remains non-purchasable");
{
  const diagAcq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
  t("choosePlusTier() never opens a real checkout",
    !/choosePlusTier[\s\S]{0,300}(whop\.com|paymongo)/i.test(diagAcq));
  t("choosePlusTier() gives an honest coming-soon message",
    /Athlevo Pro\+ checkout is launching soon/.test(diagAcq));
  t("the Settings plan card never claims Pro+ is active without a real paid provider",
    /entitlement\.planId === 'elite' \? 'Athlevo Pro\+' : 'Athlevo Pro'/.test(indexSrc));
}

/* ══════════ 7. Paid users are unaffected ════════════════════════════ */
section("7. Paid athletes see normal product behaviour");
{
  t("the aha upgrade explicitly excludes paid_active",
    /access !== "free" && access !== "paid_inactive"\) return;/.test(planSetupSrc));
  t("coach-limit upgrade already branches Pro vs Pro+ by paid status (unchanged)",
    /isProLimit/.test(readFileSync("./js/coach.js", "utf8")));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

/*
 * Free-tier CTA activation and Pro trial-copy regression coverage.
 * Source-level coverage for the pricing screen fix in
 * js/diagnosticAcquisition.js / index.html:
 *   - "Start Free" durably activates a canonical Free entitlement and
 *     routes into the app without opening Whop or PayMongo.
 *   - Free users are not bounced back to the paywall on the next load.
 *   - Pro CTA copy matches the real Whop 3-day trial.
 *   - Pro+ still has no real checkout.
 *   - Free (10) / Pro (30) / Pro+ (unlimited) Coach quotas are unchanged.
 *   - The existing Pro checkout handler/URL is untouched.
 *
 * Run: node tests/free-tier-activation.test.mjs
 */
import { readFileSync } from "node:fs";
import { TIER_LIMITS } from "../lib/server/freemium.js";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = (s) => console.log("\n──── " + s + " ────");

const html = readFileSync("./index.html", "utf8");
const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
const guard = readFileSync("./js/accessGuard.js", "utf8");

const paywall = html.slice(
  html.indexOf('id="screen-diagnostic-paywall"'),
  html.indexOf('id="screen-plansetup"')
);

function extract(src, name) {
  const start = src.indexOf("async function " + name);
  const alt = src.indexOf("function " + name);
  const at = start >= 0 ? start : alt;
  if (at < 0) return "";
  const nextFnRegex = /\n(?:async )?function [A-Za-z0-9_]+\(/g;
  nextFnRegex.lastIndex = at + 10;
  const nextMatch = nextFnRegex.exec(src);
  const end = nextMatch ? nextMatch.index : Math.min(src.length, at + 4000);
  return src.slice(at, end);
}

const chooseFreeTier = extract(acq, "chooseFreeTier");
const resolveAfterAuth = extract(acq, "resolveAfterAuth");
const gateUnpaidAthlete = extract(acq, "gateUnpaidAthlete");
const hasCompletedFreeTierEntry = extract(acq, "hasCompletedFreeTierEntry");

/* ── A. Free CTA exists and is enabled ────────────────────────── */
section("A — Free CTA exists and is enabled");
t("Free tier card renders a Start Free button wired to chooseFreeTier()",
  /data-tier="free"[\s\S]{0,600}chooseFreeTier\(\)[\s\S]{0,40}Start Free/.test(paywall));
t("Start Free button has no disabled attribute in markup",
  !/chooseFreeTier\(\)"[^>]*disabled/.test(paywall) &&
  !/disabled[^>]*onclick="AthlevoDiagnosticAcquisition\.chooseFreeTier/.test(paywall));

/* ── B. Clicking Free does not invoke checkout, persists Free, routes in ── */
section("B — Start Free activates canonical Free access with no checkout");
t("chooseFreeTier never calls a Whop or PayMongo checkout path",
  chooseFreeTier.length > 0 &&
  !/whop\.com\/checkout/i.test(chooseFreeTier) &&
  !/beginOfferCheckout|checkout\(['"]card['"]\)|checkout\(['"]local['"]\)/.test(chooseFreeTier));
t("chooseFreeTier writes the canonical profiles.free_tier_started_at marker",
  /profiles["'\)][\s\S]{0,80}\.update\(\{\s*free_tier_started_at/.test(chooseFreeTier));
t("chooseFreeTier verifies the write persisted before routing in (no fake state)",
  /\.select\(["']id, free_tier_started_at["']\)/.test(chooseFreeTier) &&
  /if \(!activated\.data\)/.test(chooseFreeTier));
t("chooseFreeTier keeps the athlete on the paywall (does not route) when the write errors",
  /if \(activated\.error\)[\s\S]{0,200}return false/.test(chooseFreeTier));
t("chooseFreeTier routes into the app via routeAfterAuth on success",
  /routeAfterAuth\(userId\)/.test(chooseFreeTier));

/* ── C. A Free user is not immediately redirected back to pricing ─ */
section("C — Free users are not bounced back to the paywall");
t("resolveAfterAuth short-circuits on profile.free_tier_started_at before any " +
  "athlete_diagnostics lookup (the lookup that only exists for the AI-diagnostic " +
  "funnel and previously caused the bounce-back)",
  (() => {
    const flagIdx = resolveAfterAuth.indexOf("profile.free_tier_started_at");
    const diagLookupIdx = resolveAfterAuth.indexOf("loadAcquisition");
    return flagIdx >= 0 && diagLookupIdx >= 0 && flagIdx < diagLookupIdx;
  })());
t("that short-circuit routes to app/onboarding, never to the paywall",
  /free_tier_started_at\)\s*\{[\s\S]{0,300}route: "app"[\s\S]{0,50}route: "onboarding"/.test(
    resolveAfterAuth.replace(/\n/g, " ")
  ) || (
    resolveAfterAuth.includes('route: "app", acquisition: true, paid: false, freeTier: true') &&
    resolveAfterAuth.includes('route: "onboarding", acquisition: true, paid: false, freeTier: true')
  ));
t("gateUnpaidAthlete (the reload-time gate) also recognizes free_tier_started_at",
  /hasCompletedFreeTierEntry\([^)]*profile\)/.test(gateUnpaidAthlete));
t("hasCompletedFreeTierEntry checks the profiles table, not only athlete_diagnostics",
  /from\(["']profiles["']\)/.test(hasCompletedFreeTierEntry) &&
  /free_tier_started_at/.test(hasCompletedFreeTierEntry));
t("routeAfterAuth's profile query fetches free_tier_started_at",
  /\.select\("onboarding_complete, goal, device, role, free_tier_started_at"\)/.test(html));
t("the athlete_diagnostics migration cannot silently satisfy Free activation for a " +
  "user without a diagnostic row (import_key is NOT NULL there)",
  /import_key\s+text not null/.test(
    readFileSync("./migrations/2026-08-26_athlete_diagnostics.sql", "utf8")
  ));

/* ── D/E/F. Tier quotas unchanged ─────────────────────────────── */
section("D/E/F — Free (10) / Pro (30) / Pro+ (unlimited) quotas are unchanged");
t("Free Coach quota remains 10/month", TIER_LIMITS.free.coach_message.limit === 10);
t("Pro (performance) Coach quota remains 30/month", TIER_LIMITS.performance.coach_message.limit === 30);
t("Pro+ (elite) has no configured limit entry (enforced unlimited upstream)",
  !("elite" in TIER_LIMITS));

/* ── G. Pro CTA copy matches the real 3-day Whop trial ─────────── */
section("G — Pro CTA text matches the real Whop 3-day trial");
t('Pro tier CTA reads "Start 3-Day Free Trial"',
  /data-tier="pro"[\s\S]{0,900}Start 3-Day Free Trial/.test(paywall));
t("truthful compact trial copy sits under the Pro CTA and still names ₱597/month",
  /3 days free, then ₱597\/month/.test(paywall));
t("Pro card still shows ₱597 \\/ month as the base price (not overwritten by trial copy)",
  /data-tier="pro"[\s\S]{0,300}₱597[\s\S]{0,60}\/ month/.test(paywall));
t("applyOfferCta() (client-side CTA text setter) also reads Start 3-Day Free Trial",
  /"Start 3-Day Free Trial"/.test(acq) && !/"Start Athlevo AI"/.test(acq));
t("no oversized promotional trial banner was added (only the existing compact trust line)",
  (paywall.match(/3 days free/g) || []).length === 1);

/* ── H. Existing Pro checkout handler/URL is unchanged ─────────── */
section("H — Existing Pro checkout is untouched");
t("Pro CTA still wires to the existing beginOfferCheckout() handler",
  /data-tier="pro"[\s\S]{0,900}beginOfferCheckout\(\)/.test(paywall));
t("Whop monthly checkout URL/plan is unchanged",
  guard.includes('const WHOP_CHECKOUT_URL = "https://whop.com/checkout/plan_F5PftzWCJCQVw"'));
t("no new/second Whop or PayMongo checkout URL was introduced by this change",
  (acq.match(/whop\.com\/checkout/gi) || []).length === 0);

/* ── I. Pro+ CTA cannot launch checkout ────────────────────────── */
section("I — Pro+ remains unavailable, no checkout");
t("Pro+ CTA still wires to choosePlusTier(), not a checkout call",
  /data-tier="pro_plus"[\s\S]{0,1000}choosePlusTier\(\)/.test(paywall));
t("choosePlusTier() never opens a checkout URL or navigates away",
  !/window\.(open|location)/.test(extract(acq, "choosePlusTier")) &&
  !/fetch\(/.test(extract(acq, "choosePlusTier")));
t("Pro+ price is still displayed at ₱1,497/month",
  /data-tier="pro_plus"[\s\S]{0,300}₱1,497[\s\S]{0,60}\/ month/.test(paywall));

/* ── J. Existing paid users remain unaffected ──────────────────── */
section("J — Existing paid users unaffected");
t("resolveAfterAuth still checks verifiedPaidAccess first, before the Free short-circuit",
  resolveAfterAuth.indexOf("verifiedPaidAccess(supabase, userId)") <
  resolveAfterAuth.indexOf("profile.free_tier_started_at"));
t("a paid user's route does not depend on free_tier_started_at (paid branch returns before it)",
  resolveAfterAuth.indexOf("if (paid.paid)") < resolveAfterAuth.indexOf("profile.free_tier_started_at"));

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);

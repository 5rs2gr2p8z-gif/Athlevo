/*
 * Athlevo — Free / Athlevo Pro / Athlevo Pro+ pricing and entitlement tests.
 * Run: node tests/pricing-tiers.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

const {
  resolveEntitlement,
  canUse
} = await import("../lib/server/features.js?pricing-tiers-test");
const {
  TIER_LIMITS,
  FREE_LIMITS,
  consumeFreeUsage
} = await import("../lib/server/freemium.js?pricing-tiers-test");

let passed = 0, failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}
const section = name => console.log(`\n──── ${name} ────`);

const paywall = readFileSync("./index.html", "utf8");
const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");

section("A/B — pricing renders exactly 3 tiers, named and priced correctly");
{
  test("exactly three .pricing-tier cards render",
    (paywall.match(/class="pricing-tier[ "]/g) || []).length === 3);
  test("Free is ₱0", /data-tier="free"[\s\S]{0,400}₱0/.test(paywall));
  test("Athlevo Pro is ₱597/month", /Athlevo Pro<[\s\S]{0,300}₱597/.test(paywall));
  test("Athlevo Pro\\+ is ₱1,497/month", /Athlevo Pro\+<[\s\S]{0,300}₱1,497/.test(paywall));
}

section("C — Pro is the emphasized/default recommendation");
{
  test("Pro card carries the restrained recommendation badge",
    /pricing-tier-pro[\s\S]{0,200}Best for most runners/.test(paywall));
  test("badge copy is restrained, not salesy",
    !/limited time|act now|hurry|don't miss/i.test(paywall));
}

section("D/E/F — CTA wiring: Free bypasses checkout, Pro uses canonical checkout, Pro+ has no fake checkout");
{
  test("Free CTA calls chooseFreeTier(), not any checkout function",
    /chooseFreeTier\(\)/.test(paywall) &&
    !/onclick="AthlevoDiagnosticAcquisition\.chooseFreeTier\(\)"[\s\S]{0,50}checkout/.test(paywall));
  test("chooseFreeTier() never opens a checkout URL or Whop",
    !/function chooseFreeTier[\s\S]{0,900}?whop\.com/i.test(acq) &&
    /function chooseFreeTier/.test(acq));
  test("Pro CTA uses the existing canonical beginOfferCheckout()/₱597 Whop flow",
    /beginOfferCheckout\(\)/.test(paywall));
  test("Pro+ CTA does not invent a checkout URL",
    /function choosePlusTier/.test(acq) &&
    !/choosePlusTier[\s\S]{0,400}?https?:\/\//.test(acq));
}

section("G — entitlement mapping free / performance (Pro) / elite (Pro+)");
{
  test("no subscription resolves to free, tier 0",
    resolveEntitlement(null).planId === "free" && resolveEntitlement(null).tier === 0);
  test("Whop row with plan_id performance resolves to Athlevo Pro (performance, tier 2)",
    resolveEntitlement({ provider: "whop", plan_id: "performance", status: "active" }).planId === "performance");
  test("Whop row with plan_id elite resolves to Athlevo Pro+ (elite, tier 3)",
    resolveEntitlement({ provider: "whop", plan_id: "elite", status: "active" }).tier === 3 &&
    resolveEntitlement({ provider: "whop", plan_id: "elite", status: "active" }).planId === "elite");
  test("legacy/unknown Whop plan_id still resolves to Pro (existing subscriber safety)",
    resolveEntitlement({ provider: "whop", plan_id: "founding_beta", status: "active" }).planId === "performance");
}

section("H — existing active ₱597 Whop subscribers map to Pro");
{
  const legacySub = { provider: "whop", plan_id: "performance", status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString() };
  test("existing subscriber keeps full Pro-level feature access",
    canUse("workout_modifications", legacySub) && canUse("adaptive_ai", legacySub));
}

section("I/J/K — Coach monthly quotas: Free 10, Pro 30, Pro+ unlimited");
{
  test("Free Coach limit is 10 per calendar month",
    TIER_LIMITS.free.coach_message.limit === 10 &&
    TIER_LIMITS.free.coach_message.period === "month");
  test("FREE_LIMITS back-compat alias matches TIER_LIMITS.free",
    FREE_LIMITS.coach_message.limit === 10 && FREE_LIMITS.coach_message.period === "month");
  test("Pro Coach limit is 30 per calendar month",
    TIER_LIMITS.performance.coach_message.limit === 30 &&
    TIER_LIMITS.performance.coach_message.period === "month");

  const counters = new Map();
  let subscription = null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const response = (status, body) => ({ ok: status < 300, status, async json() { return body; } });
    if (url.includes("rpc/ensure_free_trial")) return response(404, {});
    if (url.includes("/rest/v1/subscriptions")) return response(200, subscription ? [subscription] : []);
    if (url.includes("rpc/increment_rate_limit")) {
      const body = JSON.parse((arguments[1] && arguments[1].body) || "{}");
      return response(200, { allowed: true, current_count: 1 });
    }
    return response(404, {});
  };

  subscription = { provider: "whop", plan_id: "elite", status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString() };
  const proPlusUsage = await consumeFreeUsage("pro-plus-quota-user", "coach_message");
  test("Pro+ Coach usage is unlimited (no counter consulted)",
    proPlusUsage.allowed === true && proPlusUsage.unlimited === true);
}

section("L — reaching a Coach limit blocks new sends but never hides history");
{
  const coach = readFileSync("./js/coach.js", "utf8");
  test("Coach limit path shows an upgrade prompt instead of touching stored conversation history",
    /showCoachLimitUpgrade/.test(coach) &&
    !/showCoachLimitUpgrade[\s\S]{0,400}coach_conversations/.test(coach));
}

section("M/N — responsive pricing layout: mobile stacks, desktop shows 3 columns");
{
  test("mobile default is a single column (stacked)",
    /\.pricing-tiers\{[^}]*grid-template-columns:1fr/.test(paywall));
  test("desktop (>=880px) shows 3 columns side by side",
    /@media\(min-width:880px\)\{[\s\S]{0,400}\.pricing-tiers\{[^}]*repeat\(3,/.test(paywall));
}

section("O — dark-mode token usage on the new pricing cards");
{
  test("pricing-tier cards use semantic tokens, not hardcoded colors",
    /\.pricing-tier\{[^}]*background:var\(--paper\)/.test(paywall) &&
    !/\.pricing-tier\{[^}]*background:#fff/.test(paywall) &&
    !/\.pricing-tier\{[^}]*color:#000/.test(paywall));
}

section("P — annual plan stays disabled (no real annual product exists)");
{
  test("ANNUAL_CHECKOUT_READY remains false",
    /ANNUAL_CHECKOUT_READY\s*=\s*false/.test(acq));
  test("no annual toggle appears on the new 3-tier pricing screen",
    !/id="offerPlanAnnual"/.test(paywall));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

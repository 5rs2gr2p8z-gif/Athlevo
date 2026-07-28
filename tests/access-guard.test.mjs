/*
 * Athlevo — freemium navigation and server access wiring.
 * Run: node tests/access-guard.test.mjs
 */

import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name); }
};
const section = name => console.log(`\n──── ${name} ────`);

const featuresSource = readFileSync("./js/features.js", "utf8");
const guardSource = readFileSync("./js/accessGuard.js", "utf8");
const onboardingSource = readFileSync("./js/onboarding.js", "utf8");
const coachServerSource = readFileSync("./api/coach.js", "utf8");
const coachClientSource = readFileSync("./js/coach.js", "utf8");
const paywallSource = readFileSync("./js/paywall.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");

function browser(subscription) {
  const mounts = {};
  const analytics = [];
  const document = {
    getElementById(id) {
      if (!mounts[id]) mounts[id] = { style: {}, children: [], querySelector: () => null };
      return mounts[id];
    },
    createElement() {
      return { style: {}, className: "", children: [], set innerHTML(value) { this.html = value; } };
    }
  };
  const sandbox = {
    document,
    console: { log() {}, warn() {}, error() {} },
    supabaseClient: {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: subscription, error: null }) })
        })
      })
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent: (name, props) => analytics.push({ name, props })
    }
  };
  sandbox.window = sandbox;
  new Function(...Object.keys(sandbox), featuresSource)(...Object.values(sandbox));
  new Function(...Object.keys(sandbox), guardSource)(...Object.values(sandbox));
  return { sandbox, mounts, analytics };
}

section("Free navigation");
{
  const { sandbox, mounts } = browser(null);
  for (const screen of ["screen-coachai", "screen-train", "screen-trends"]) {
    test(`${screen} remains available to free users`,
      await sandbox.AthlevoAccessGuard.guardTab(screen) === false);
  }
  test("advanced Trends shows an upgrade entry", mounts.trendsUpgrade.style.display === "block");
  test("Today is never blocked",
    await sandbox.AthlevoAccessGuard.guardTab("screen-today") === false);
}

section("Whop authority");
{
  const active = browser({
    provider: "whop",
    plan_id: "performance",
    status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString()
  });
  test("verified active Whop subscription has paid access",
    await active.sandbox.AthlevoAccessGuard.hasPaidAccess());
  await active.sandbox.AthlevoAccessGuard.guardTab("screen-trends");
  test("paid user does not see Trends upgrade entry",
    active.mounts.trendsUpgrade.style.display === "none");

  const unverified = browser({
    provider: "manual", plan_id: "performance", status: "active"
  });
  test("non-Whop row cannot grant paid access",
    !(await unverified.sandbox.AthlevoAccessGuard.hasPaidAccess()));
}

section("Onboarding and limits");
{
  const finish = onboardingSource.slice(
    onboardingSource.indexOf("async function obFinish"),
    onboardingSource.indexOf("function obFirstIncompleteStep")
  );
  test("onboarding continues to training-data connection",
    /AthlevoConnect\.start/.test(finish));
  test("onboarding does not open checkout or paywall",
    !/AthlevoPaywall|maybeLaunchAfterOnboarding|checkout/.test(finish));
  test("Coach uses the atomic server free-usage helper",
    /consumeFreeUsage\(\s*authenticatedUser\.id,\s*"coach_message"\s*\)/.test(coachServerSource));
  test("Coach client handles free-limit 402",
    /response\.status === 402/.test(coachClientSource) &&
    /FREE_LIMIT_REACHED/.test(coachClientSource));
  test("Coach client offers Performance upgrade",
    /Upgrade to Performance/.test(coachClientSource) &&
    /AthlevoAccessGuard.*upgrade/.test(coachClientSource));
}

section("Upgrade and safety");
{
  const { sandbox, analytics } = browser(null);
  sandbox.AthlevoPaywall = { show() {} };
  sandbox.AthlevoAccessGuard.upgrade();
  test("upgrade click is tracked", analytics.some(e =>
    e.name === "upgrade_clicked" && e.props.source === "feature_gate"));
  test("upgrade UI shows the exact price",
    /Athlevo Performance/.test(guardSource) && /₱597\/month/.test(guardSource));
  test("checkout keeps a return URL", /redirect_url/.test(paywallSource));
  test("app navigation still invokes the access guard",
    /AthlevoAccessGuard.*guardTab/.test(indexSource));
  test("no timed free-trial copy remains",
    !/3[- ]day free trial|3 days free|after trial|trial ends/i.test(
      [guardSource, paywallSource, onboardingSource, indexSource].join("\n")));
  test("no server secret appears in client access code",
    !/WHOP_API_KEY|WHOP_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE|OPENAI_API_KEY/.test(guardSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

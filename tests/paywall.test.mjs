/*
 * Athlevo — paywall + personalized preview tests.
 *
 * Drives the REAL js/paywall.js and js/planSetup.js against a mock browser.
 * Verifies: entitlement gating, personalized preview content, paywall display,
 * checkout return handling, and that paid users never see the paywall.
 *
 * Run: node tests/paywall.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const featuresSrc = readFileSync("./js/features.js", "utf8");
const paywallSrc = readFileSync("./js/paywall.js", "utf8");
const planSetupSrc = readFileSync("./js/planSetup.js", "utf8");

/* ── mock browser factory ──────────────────────────────────────────── */

function world({ subscriptionRow = null, profile = {}, hasPlanValue = false,
                 providerConnected = false } = {}) {
  const screens = [];
  const mounts = {};
  const analytics = [];
  const openedUrls = [];

  const doc = {
    getElementById: (id) => {
      if (["paywallBody", "planSetupBody", "planGenBody", "todayPlanCta",
           "pgSteps", "pwConfirming", "pwConfirmTitle", "pwConfirmSub",
           "pwCheckBtn", "pw-checkout-btn"].includes(id)) {
        return mounts[id] || (mounts[id] = {
          style: {}, dataset: {},
          set innerHTML(v) { this._h = v; },
          get innerHTML() { return this._h || ""; },
          querySelectorAll: () => [],
          scrollIntoView() {}
        });
      }
      if (id === "tabbar") return mounts._tabbar || (mounts._tabbar = { style: {} });
      return null;
    },
    querySelector: (sel) => {
      if (sel === ".pw-preview") return { scrollIntoView() {} };
      if (sel === ".pw-wall") return { style: {} };
      if (sel === '.tab[data-screen="screen-train"]') return null;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible"
  };

  let planExists = hasPlanValue;

  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 5)),
    clearInterval,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    showScreen: (id) => screens.push(id),
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.includes("get-week")) return { ok: true, status: 200, json: async () => ({ hasPlan: planExists }) };
      if (u.includes("action=status")) return { ok: true, status: 200, json: async () => ({ connected: providerConnected }) };
      if (u.includes("generate-plan")) { planExists = true; return { ok: true, status: 200, json: async () => ({ success: true }) }; }
      if (u.includes("weekly-analysis")) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
    matchMedia: () => ({ matches: true }),
    open: (url) => { openedUrls.push(url); },
    URL: URL,
    URLSearchParams: URLSearchParams,
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: "tok" } } }),
        getUser: async () => ({ data: { user: { id: "u1", email: "runner@example.com" } } })
      },
      from: (table) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "subscriptions") return { data: subscriptionRow, error: null };
              return { data: null, error: null };
            }
          })
        })
      })
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
    location: { search: "", pathname: "/", hash: "" },
    scrollTo() {},
    AthlevoAnalytics: { track: (name) => analytics.push(name) },
    AthlevoBrain: {
      loadAthleteProfile: async () => profile,
      providerStatus: async () => ({ connected: providerConnected }),
      refreshAthleteUI: async () => {}
    }
  };
  sandbox.window = sandbox;

  // Load features.js (provides AthlevoPlan.canUse, .load, .entitlement)
  new Function(...Object.keys(sandbox), "root",
    featuresSrc)(
    ...Object.values(sandbox), sandbox);

  // Load paywall.js
  new Function(...Object.keys(sandbox), "root",
    paywallSrc)(
    ...Object.values(sandbox), sandbox);

  // Load planSetup.js
  new Function(...Object.keys(sandbox), "root",
    planSetupSrc.replace(/\}\)\(\);?\s*$/, "})()"))(
    ...Object.values(sandbox), sandbox);

  return {
    g: sandbox, screens, mounts, analytics, openedUrls,
    paywall: sandbox.AthlevoPaywall,
    plan: sandbox.AthlevoPlan,
    athlevoPlan: sandbox.AthlevoPlan   // the features.js version is overwritten by planSetup.js
  };
}

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const vis = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/* ══════════ 1 — personalized preview content ═══════════════════════ */

section("1. Personalized preview derives from profile data");
{
  const w = world();
  const preview = w.paywall._buildPreview({
    name: "Dean",
    goal: "Run a sub-2:00 half marathon",
    experience: "intermediate",
    weekly_distance: 30,
    available_days: 4,
    target_race: "Condura Half Marathon",
    race_date: "2026-12-06"
  });

  t("headline includes the athlete's name", /Dean/.test(preview.headline));
  t("headline references their goal", /half marathon/i.test(preview.headline));
  t("situation mentions weekly distance", /30\s*km/i.test(preview.situation));
  t("situation mentions available days", /4/.test(preview.situation));
  t("situation mentions the race", /Condura/i.test(preview.situation));
  t("approach is non-empty and specific", preview.approach.length > 30 &&
    /tempo|long|recovery|race|interval/i.test(preview.approach));
  t("sample workout has title, detail, and purpose",
    preview.sample.title && preview.sample.detail && preview.sample.purpose);
  t("why-fit is non-empty", preview.whyFit.length > 20);
}

section("1b. Preview adapts to experience level");
{
  const w = world();

  const beginner = w.paywall._buildPreview({ name: "Ana", experience: "beginner", goal: "5K" });
  t("beginner gets easy/base approach", /base|easy|foundation|habit/i.test(beginner.approach));
  t("beginner sample is gentle", /easy|conversation|walk/i.test(beginner.sample.detail));

  const advanced = w.paywall._buildPreview({ name: "Ben", experience: "advanced", goal: "marathon" });
  t("advanced gets periodized approach", /periodiz|threshold|intensity|interval/i.test(advanced.approach));
  t("advanced sample is structured", /warm|tempo|threshold|interval|recovery/i.test(advanced.sample.detail));
}

section("1c. Preview handles minimal profile gracefully");
{
  const w = world();
  const minimal = w.paywall._buildPreview({ name: "Jo" });
  t("minimal profile still produces a headline", /Jo/.test(minimal.headline));
  t("minimal profile still produces an approach", minimal.approach.length > 10);
  t("minimal profile still produces a sample workout", minimal.sample.title.length > 0);
}

/* ══════════ 2 — paywall gating ════════════════════════════════════ */

section("2. Free users see the paywall after onboarding");
{
  const w = world({ subscriptionRow: null, profile: { name: "Dean", goal: "10K", experience: "intermediate" } });
  await w.plan.maybeLaunchAfterOnboarding();
  await wait();
  t("screen-paywall is shown", w.screens.includes("screen-paywall"));
  t("paywall_shown analytics event fired", w.analytics.includes("paywall_shown"));
  const html = vis(w.mounts.paywallBody && w.mounts.paywallBody._h);
  t("paywall contains the headline", /coaching plan is ready/i.test(html));
  t("paywall contains the trial offer", /3 days free/i.test(html));
  t("paywall contains ₱0 today", /₱0 due today/i.test(html));
  t("paywall contains ₱597/month", /₱597\/month/i.test(html));
  t("paywall contains the CTA", /Start my 3-day free trial/i.test(html));
  t("paywall contains the review link", /Review my preview/i.test(html));
  t("tabbar is hidden during paywall", w.mounts._tabbar && w.mounts._tabbar.style.display === "none");
}

section("2b. Free user via autoBuildFirstPlan also sees paywall");
{
  const w = world({ subscriptionRow: null, profile: { name: "Dean", experience: "beginner" } });
  const result = await w.plan.autoBuildFirstPlan();
  await wait();
  t("autoBuildFirstPlan returns skipped:paywall", result && result.skipped === "paywall");
  t("screen-paywall is shown", w.screens.includes("screen-paywall"));
}

section("2c. Free user via start() also sees paywall");
{
  const w = world({ subscriptionRow: null, profile: { name: "Dean" } });
  await w.plan.start();
  await wait();
  t("start() routes to paywall for free user", w.screens.includes("screen-paywall"));
  t("screen-plansetup is NOT shown", !w.screens.includes("screen-plansetup"));
}

/* ══════════ 3 — paid users bypass the paywall ════════════════════ */

section("3. Active subscribers never see the paywall");
{
  const activeSub = {
    plan_id: "performance", status: "active",
    current_period_end: new Date(Date.now() + 20 * 86400000).toISOString()
  };
  const w = world({ subscriptionRow: activeSub, profile: { name: "Dean" } });
  await w.plan.maybeLaunchAfterOnboarding();
  await wait();
  t("paid user does NOT see screen-paywall", !w.screens.includes("screen-paywall"));
  t("paid user proceeds normally", w.screens.includes("screen-plansetup") ||
    w.screens.includes("screen-today"));
}

section("3b. Trial users bypass the paywall");
{
  const trialSub = {
    plan_id: "performance", status: "trialing",
    trial_end: new Date(Date.now() + 3 * 86400000).toISOString()
  };
  const w = world({ subscriptionRow: trialSub, profile: { name: "Dean" } });
  await w.plan.start();
  await wait();
  t("trial user does NOT see paywall", !w.screens.includes("screen-paywall"));
  t("trial user sees plan setup", w.screens.includes("screen-plansetup"));
}

/* ══════════ 4 — checkout flow ═════════════════════════════════════ */

section("4. Checkout CTA opens the Whop link");
{
  const w = world({ subscriptionRow: null, profile: { name: "Dean" } });
  await w.paywall.show({});
  await wait();
  w.paywall.checkout();
  t("checkout opens a URL", w.openedUrls.length === 1);
  t("URL is the Whop checkout link", /whop\.com/.test(w.openedUrls[0]));
  t("paywall_checkout_tapped analytics fired", w.analytics.includes("paywall_checkout_tapped"));
}

/* ══════════ 5 — paywall content ═══════════════════════════════════ */

section("5. Paywall shows personalized preview content");
{
  const w = world({ subscriptionRow: null });
  await w.paywall.show({
    name: "Maria", goal: "Run my first marathon",
    experience: "beginner", weekly_distance: 15, available_days: 3
  });
  await wait();
  const html = vis(w.mounts.paywallBody && w.mounts.paywallBody._h);
  t("preview includes the athlete's name", /Maria/.test(html));
  t("preview includes their goal", /marathon/i.test(html));
  t("preview includes recommended approach", /approach/i.test(html) || /aerobic|base|easy/i.test(html));
  t("preview includes a sample workout", /sample.*workout|easy.*run|aerobic/i.test(html));
  t("preview does NOT expose a full plan", !/Monday.*Tuesday.*Wednesday/i.test(html));
  t("no API key or secret in the rendered HTML",
    !/WHOP_API_KEY|WHOP_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE/.test(html));
}

/* ══════════ 6 — no secrets exposed ════════════════════════════════ */

section("6. No secrets in client-side paywall code");
{
  t("no WHOP_API_KEY in paywall.js", !/WHOP_API_KEY/.test(paywallSrc));
  t("no WHOP_WEBHOOK_SECRET in paywall.js", !/WHOP_WEBHOOK_SECRET/.test(paywallSrc));
  t("no SUPABASE_SERVICE_ROLE in paywall.js", !/SUPABASE_SERVICE_ROLE/.test(paywallSrc));
  t("paywall uses entitlement, not URL param, for access",
    /isPaid|entitlement|canUse/.test(paywallSrc) &&
    !/checkout_return.*=.*true.*grant|grant.*checkout_return/.test(paywallSrc));
}

/* ══════════ 7 — paywall structure ═════════════════════════════════ */

section("7. Paywall integrates with the plan setup flow");
{
  t("planSetup.js calls shouldShowPaywall",
    /shouldShowPaywall/.test(planSetupSrc));
  t("shouldShowPaywall delegates to AthlevoPaywall.isPaid",
    /AthlevoPaywall.*isPaid/.test(planSetupSrc));
  t("maybeLaunchAfterOnboarding checks paywall",
    /shouldShowPaywall/.test(
      planSetupSrc.slice(
        planSetupSrc.indexOf("maybeLaunchAfterOnboarding"),
        planSetupSrc.indexOf("maybeLaunchAfterOnboarding") + 600)));
  t("autoBuildFirstPlan checks paywall",
    /shouldShowPaywall/.test(
      planSetupSrc.slice(
        planSetupSrc.indexOf("autoBuildFirstPlan"),
        planSetupSrc.indexOf("autoBuildFirstPlan") + 600)));
  t("start() checks paywall",
    /shouldShowPaywall/.test(
      planSetupSrc.slice(
        planSetupSrc.indexOf("async function start"),
        planSetupSrc.indexOf("async function start") + 600)));
  t("paywall proceed() hands back to plan setup",
    /AthlevoPlan.*start|showScreen/.test(paywallSrc));
}

/* ══════════ 8 — existing behavior preserved ═══════════════════════ */

section("8. Existing plan-build journey is preserved for paid users");
{
  const activeSub = {
    plan_id: "performance", status: "active",
    current_period_end: new Date(Date.now() + 20 * 86400000).toISOString()
  };
  const w = world({
    subscriptionRow: activeSub,
    profile: { name: "Dean", goal: "10K" },
    providerConnected: true
  });
  await w.plan.start();
  await wait();
  const setup = vis(w.mounts.planSetupBody && w.mounts.planSetupBody._h);
  t("paid user sees plan setup screen", w.screens.includes("screen-plansetup"));
  t("plan setup shows Build Training Plan button", /Build Training Plan/i.test(setup));
  t("plan setup shows profile summary", /What Athlevo knows/i.test(setup));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

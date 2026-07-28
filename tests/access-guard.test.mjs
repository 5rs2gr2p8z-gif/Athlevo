/*
 * Athlevo — access guard + navigation entitlement tests.
 *
 * Tests: tab navigation guards, locked previews, paid user bypass,
 * onboarding flow reorder, server-side Coach enforcement, and
 * checkout URL construction.
 *
 * Run: node tests/access-guard.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const featuresSrc = readFileSync("./js/features.js", "utf8");
const accessGuardSrc = readFileSync("./js/accessGuard.js", "utf8");
const paywallSrc = readFileSync("./js/paywall.js", "utf8");
const planSetupSrc = readFileSync("./js/planSetup.js", "utf8");
const onboardingSrc = readFileSync("./js/onboarding.js", "utf8");
const coachSrc = readFileSync("./api/coach.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");

/* ── mock browser factory ──────────────────────────────────────────── */

function world({ subscriptionRow = null, profile = {}, coachMsgCount = 0 } = {}) {
  const screens = [];
  const mounts = {};
  const analytics = [];
  const openedUrls = [];

  const doc = {
    getElementById: (id) => {
      if (["paywallBody", "planSetupBody", "planGenBody", "todayPlanCta",
           "pgSteps", "pwConfirming", "pwConfirmTitle", "pwConfirmSub",
           "pwCheckBtn", "pw-checkout-btn", "tabbar",
           "screen-coachai", "screen-train", "screen-trends"].includes(id)) {
        return mounts[id] || (mounts[id] = {
          style: {}, dataset: {}, className: "",
          children: [],
          set innerHTML(v) { this._h = v; },
          get innerHTML() { return this._h || ""; },
          querySelector: (sel) => {
            if (sel === ".ag-overlay") return mounts[id + "_overlay"] || null;
            return null;
          },
          querySelectorAll: () => [],
          scrollIntoView() {},
          appendChild(child) {
            this.children.push(child);
            mounts[id + "_overlay"] = child;
          }
        });
      }
      return null;
    },
    querySelector: (sel) => {
      if (sel === ".pw-preview") return { scrollIntoView() {} };
      if (sel === ".pw-wall") return { style: {} };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      return {
        className: "", style: {},
        set innerHTML(v) { this._h = v; },
        get innerHTML() { return this._h || ""; },
      };
    },
    visibilityState: "visible"
  };

  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 5)),
    clearInterval,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    showScreen: (id) => screens.push(id),
    fetch: async (url) => {
      const u = String(url);
      if (u.includes("get-week")) return { ok: true, status: 200, json: async () => ({ hasPlan: false }) };
      if (u.includes("action=status")) return { ok: true, status: 200, json: async () => ({ connected: false }) };
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
    location: { search: "", pathname: "/", hash: "", origin: "https://athlevo.app" },
    scrollTo() {},
    AthlevoAnalytics: { track: (name, data) => analytics.push(name) },
    AthlevoBrain: {
      loadAthleteProfile: async () => profile,
      providerStatus: async () => ({ connected: false }),
      refreshAthleteUI: async () => {}
    }
  };
  sandbox.window = sandbox;

  // Load in order: features → paywall → accessGuard → planSetup
  new Function(...Object.keys(sandbox), "root", featuresSrc)(
    ...Object.values(sandbox), sandbox);
  new Function(...Object.keys(sandbox), "root", paywallSrc)(
    ...Object.values(sandbox), sandbox);
  new Function(...Object.keys(sandbox), "root", accessGuardSrc)(
    ...Object.values(sandbox), sandbox);
  new Function(...Object.keys(sandbox), "root",
    planSetupSrc.replace(/\}\)\(\);?\s*$/, "})()"))(
    ...Object.values(sandbox), sandbox);

  return {
    g: sandbox, screens, mounts, analytics, openedUrls,
    guard: sandbox.AthlevoAccessGuard,
    paywall: sandbox.AthlevoPaywall,
    plan: sandbox.AthlevoPlan
  };
}

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const vis = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/* ══════════ 1 — navigation guard blocks free users ═══════════════ */

section("1. Free users see locked previews on premium tabs");
{
  const w = world({ subscriptionRow: null });

  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab is blocked for free users", coachBlocked === true);

  const trainBlocked = await w.guard.guardTab("screen-train");
  t("Train tab is blocked for free users", trainBlocked === true);

  const trendsBlocked = await w.guard.guardTab("screen-trends");
  t("Trends tab is blocked for free users", trendsBlocked === true);
}

section("1b. Today and You tabs are never blocked");
{
  const w = world({ subscriptionRow: null });

  const todayBlocked = await w.guard.guardTab("screen-today");
  t("Today tab is NOT blocked", todayBlocked === false);

  const youBlocked = await w.guard.guardTab("screen-you");
  t("You tab is NOT blocked", youBlocked === false);
}

/* ══════════ 2 — paid users pass through ══════════════════════════ */

section("2. Active subscribers pass through all tabs");
{
  const activeSub = {
    plan_id: "performance", status: "active",
    current_period_end: new Date(Date.now() + 20 * 86400000).toISOString()
  };
  const w = world({ subscriptionRow: activeSub });

  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab passes for paid users", coachBlocked === false);

  const trainBlocked = await w.guard.guardTab("screen-train");
  t("Train tab passes for paid users", trainBlocked === false);

  const trendsBlocked = await w.guard.guardTab("screen-trends");
  t("Trends tab passes for paid users", trendsBlocked === false);
}

section("2b. Trial users pass through all tabs");
{
  const trialSub = {
    plan_id: "performance", status: "trialing",
    trial_end: new Date(Date.now() + 3 * 86400000).toISOString()
  };
  const w = world({ subscriptionRow: trialSub });

  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab passes for trial users", coachBlocked === false);

  const trendsBlocked = await w.guard.guardTab("screen-trends");
  t("Trends tab passes for trial users", trendsBlocked === false);
}

/* ══════════ 3 — locked screen content ════════════════════════════ */

section("3. Locked screens contain trial CTA");
{
  t("accessGuard.js contains trial CTA text",
    /Start Free Trial/.test(accessGuardSrc));
  t("accessGuard.js contains no-card messaging",
    /No card required/.test(accessGuardSrc));
  t("accessGuard.js contains expired trial upgrade CTA",
    /Continue with Athlevo Pro/.test(accessGuardSrc));

  t("Coach locked screen has sample interaction",
    /Sample coaching interaction/.test(accessGuardSrc));
  t("Train locked screen has sample week",
    /Sample training week/.test(accessGuardSrc));
  t("Trends locked screen has trend items",
    /Weekly volume/.test(accessGuardSrc));
}

/* ══════════ 4 — onboarding flow reorder ══════════════════════════ */

section("4. Onboarding goes to paywall before wearable connection");
{
  t("obFinish no longer calls AthlevoConnect.start directly",
    !/AthlevoConnect\.start/.test(
      onboardingSrc.slice(
        onboardingSrc.indexOf("async function obFinish"),
        onboardingSrc.indexOf("async function obFinish") + 1200)));

  t("obFinish calls startCardlessTrial (cardless trial flow)",
    /AthlevoPlan.*startCardlessTrial/.test(
      onboardingSrc.slice(
        onboardingSrc.indexOf("async function obFinish"),
        onboardingSrc.indexOf("async function obFinish") + 1200)));

  // Verify a free user ends up on the paywall after onboarding
  const w = world({ subscriptionRow: null, profile: { name: "Dean", goal: "10K" } });
  await w.plan.maybeLaunchAfterOnboarding();
  await wait();
  t("free user sees paywall after onboarding", w.screens.includes("screen-paywall"));
  t("free user does NOT see connect screen", !w.screens.includes("screen-connect"));
}

/* ══════════ 5 — go() function integration ════════════════════════ */

section("5. go() integrates with access guard");
{
  t("go() calls AthlevoAccessGuard.guardTab",
    /AthlevoAccessGuard.*guardTab/.test(indexSrc));
  t("go() returns early when blocked",
    /blocked.*return|if.*blocked.*return/.test(indexSrc));
  t("go() still loads weekly plan for paid Train tab",
    /loadWeeklyPlan/.test(indexSrc));
  t("go() still renders coach history for paid Coach tab",
    /renderConversationHistory/.test(indexSrc));
}

/* ══════════ 6 — checkout URL construction ════════════════════════ */

section("6. Checkout URL includes plan ID and redirect");
{
  t("WHOP_CHECKOUT_URL includes plan_ identifier",
    /plan_/.test(paywallSrc));
  t("checkout adds redirect_url param",
    /redirect_url/.test(paywallSrc));
  t("checkout adds email param",
    /email=/.test(paywallSrc));
}

/* ══════════ 7 — server-side Coach enforcement ════════════════════ */

section("7. Coach API endpoint enforces subscription");
{
  t("coach.js imports userCanUse",
    /import.*userCanUse.*from.*subscriptions/.test(coachSrc));
  t("coach.js checks coach_chat feature",
    /userCanUse[\s\S]*?coach_chat/.test(coachSrc));
  t("coach.js returns 402 for free users past sample",
    /status\(402\)/.test(coachSrc) && /SUBSCRIPTION_REQUIRED/.test(coachSrc));
  t("coach.js checks coach_conversations count",
    /coach_conversations.*user_id/.test(coachSrc));
  t("coach.js fails open on subscription check error",
    /Fail open|fail open|allowing/.test(coachSrc));
}

/* ══════════ 8 — client-side Coach 402 handling ═══════════════════ */

section("8. Coach client handles 402 gracefully");
{
  const coachClientSrc = readFileSync("./js/coach.js", "utf8");
  t("coach.js client checks for 402 status",
    /response\.status === 402/.test(coachClientSrc));
  t("coach.js client checks SUBSCRIPTION_REQUIRED code",
    /SUBSCRIPTION_REQUIRED/.test(coachClientSrc));
  t("coach.js client shows upgrade CTA",
    /Start my 3-day free trial/.test(coachClientSrc));
  t("coach.js client calls AthlevoAccessGuard.startTrial",
    /AthlevoAccessGuard.*startTrial/.test(coachClientSrc));
}

/* ══════════ 9 — unlock after checkout ════════════════════════════ */

section("9. Paywall proceed() unlocks tabs");
{
  t("paywall proceed() calls unlockAll",
    /AthlevoAccessGuard.*unlockAll/.test(paywallSrc));
  t("accessGuard exposes unlockAll",
    /unlockAll/.test(accessGuardSrc));
}

/* ══════════ 10 — no secrets exposed ══════════════════════════════ */

section("10. No secrets in client-side access guard");
{
  t("no WHOP_API_KEY in accessGuard.js", !/WHOP_API_KEY/.test(accessGuardSrc));
  t("no WHOP_WEBHOOK_SECRET in accessGuard.js", !/WHOP_WEBHOOK_SECRET/.test(accessGuardSrc));
  t("no SUPABASE_SERVICE_ROLE in accessGuard.js", !/SUPABASE_SERVICE_ROLE/.test(accessGuardSrc));
  t("no OPENAI_API_KEY in accessGuard.js", !/OPENAI_API_KEY/.test(accessGuardSrc));
}

/* ══════════ 11 — paid users completely unaffected ════════════════ */

section("11. Paid users: full flow is preserved");
{
  const activeSub = {
    plan_id: "performance", status: "active",
    current_period_end: new Date(Date.now() + 20 * 86400000).toISOString()
  };
  const w = world({ subscriptionRow: activeSub, profile: { name: "Dean" } });

  // After onboarding, paid user goes to plan setup, not paywall
  await w.plan.maybeLaunchAfterOnboarding();
  await wait();
  t("paid user does NOT see paywall after onboarding",
    !w.screens.includes("screen-paywall"));

  // start() works normally
  const w2 = world({ subscriptionRow: activeSub, profile: { name: "Dean" } });
  await w2.plan.start();
  await wait();
  t("paid user sees plan setup screen", w2.screens.includes("screen-plansetup"));
}

/* ══════════ 12 — feature registry alignment ═════════════════════ */

section("12. Feature registry gates coach_chat correctly");
{
  t("coach_chat requires essentials tier",
    /coach_chat.*minPlan.*essentials/.test(featuresSrc));
  t("adaptive_ai requires performance tier",
    /adaptive_ai.*minPlan.*performance/.test(featuresSrc));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

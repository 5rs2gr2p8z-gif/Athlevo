/*
 * Athlevo — freemium onboarding and explicit-upgrade tests.
 * Run: node tests/paywall.test.mjs
 */

import { existsSync, readFileSync } from "node:fs";

let passed = 0, failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name); }
};
const section = name => console.log(`\n──── ${name} ────`);

const featuresSource = readFileSync("./js/features.js", "utf8");
const guardSource = readFileSync("./js/accessGuard.js", "utf8");
const onboardingSource = readFileSync("./js/onboarding.js", "utf8");
const planSetupSource = readFileSync("./js/planSetup.js", "utf8");
const trainSource = readFileSync("./js/train.js", "utf8");
const coachSource = readFileSync("./js/coach.js", "utf8");
const dailyBriefSource = readFileSync("./js/dailyBrief.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");

function browser({ subscription = null, profile = {}, connected = true } = {}) {
  const screens = [], product = [], opened = [], mounts = {};
  let planExists = false;
  const mount = id => mounts[id] || (mounts[id] = {
    style: {}, dataset: {}, children: [], querySelector: () => null,
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html || ""; },
    querySelectorAll: () => []
  });
  const document = {
    getElementById: mount,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, children: [], className: "" })
  };
  const sandbox = {
    document,
    console: { log() {}, warn() {}, error() {} },
    showScreen: id => screens.push(id),
    fetch: async url => {
      const value = String(url);
      if (value.includes("action=status")) {
        return { ok: true, status: 200, json: async () => ({ connected }) };
      }
      if (value.includes("get-week")) {
        return { ok: true, status: 200, json: async () => ({ hasPlan: planExists }) };
      }
      if (value.includes("generate-plan")) {
        planExists = true;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    supabaseClient: {
      auth: {
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        getSession: async () => ({ data: { session: { access_token: "token" } } })
      },
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: subscription, error: null }) })
        })
      })
    },
    AthlevoBrain: {
      loadAthleteProfile: async () => profile,
      providerStatus: async () => ({ connected }),
      refreshAthleteUI: async () => {}
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent: (name, props) => product.push({ name, props })
    },
    open: (url, target, features) => opened.push({ url, target, features }),
    URL,
    location: {
      origin: "https://athlevo-preview.vercel.app",
      pathname: "/app",
      search: "",
      hash: ""
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: true }),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 5)),
    clearInterval,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    scrollTo() {}
  };
  sandbox.window = sandbox;
  new Function(...Object.keys(sandbox), featuresSource)(...Object.values(sandbox));
  new Function(...Object.keys(sandbox), guardSource)(...Object.values(sandbox));
  new Function(...Object.keys(sandbox), planSetupSource.replace(/\}\)\(\);?\s*$/, "})()"))(
    ...Object.values(sandbox)
  );
  return { sandbox, screens, product, opened, mounts };
}

section("Free onboarding and plan journey");
{
  const finish = onboardingSource.slice(
    onboardingSource.indexOf("async function obFinish"),
    onboardingSource.indexOf("function obFirstIncompleteStep")
  );
  test("onboarding enters provider connection",
    /AthlevoConnect\.start/.test(finish));
  test("onboarding has no checkout or paywall fallback",
    !/AthlevoPaywall|screen-paywall|maybeLaunchAfterOnboarding|checkout/.test(finish));

  const w = browser({ profile: { name: "Dean", goal: "10K" } });
  await w.sandbox.AthlevoPlan.start();
  test("free user can open initial plan setup",
    w.screens.includes("screen-plansetup"));
  test("initial plan setup does not open Whop", w.opened.length === 0);
}

section("Explicit paid upgrade");
{
  const w = browser();
  test("nothing opens before an explicit upgrade click", w.opened.length === 0);
  w.sandbox.AthlevoAccessGuard.checkout();
  test("one explicit click opens Whop once",
    w.opened.length === 1 && /whop\.com/.test(w.opened[0].url));
  test("checkout uses a new noopener tab",
    w.opened[0].target === "_blank" && w.opened[0].features === "noopener");
  test("checkout return preserves the current preview origin",
    /athlevo-preview\.vercel\.app/.test(decodeURIComponent(w.opened[0].url)));
  test("upgrade click is tracked",
    w.product.some(event => event.name === "upgrade_clicked"));
  test("checkout opening is tracked",
    w.product.some(event => event.name === "checkout_opened"));
  test("checkout goes directly to the configured paid Whop plan",
    /whop\.com\/checkout\/plan_/.test(w.opened[0].url));
  test("checkout sends no timed-trial parameter",
    !/trial|free_period|defer/i.test(w.opened[0].url));
}

section("Removed timed screen");
{
  const activeUi = [
    indexSource, guardSource, onboardingSource, planSetupSource,
    coachSource, dailyBriefSource, trainSource
  ].join("\n");
  test("obsolete paywall bundle is deleted", !existsSync("./js/paywall.js"));
  test("obsolete paywall screen and mount are deleted",
    !/screen-paywall|paywallBody|js\/paywall\.js|AthlevoPaywall/.test(activeUi));
  test("timed CTA and checklist copy are absent",
    !/start\s+(?:my\s+)?(?:\d+[-\s]day\s+)?free\s+trial|3\s+days\s+free|due\s+today|after\s+(?:the\s+)?trial/i.test(activeUi));
  test("every paid CTA uses the approved label",
    !/Upgrade to Performance/.test(activeUi) &&
    [
      indexSource, guardSource, planSetupSource, coachSource, dailyBriefSource
    ].every(source => /Upgrade to Athlevo Performance/.test(source)));
  test("plan flow has no automatic paywall fallback",
    !/shouldShowPaywall/.test(planSetupSource));
  test("denied additional-plan action does not open checkout automatically",
    !/AthlevoAccessGuard\.checkout/.test(
      trainSource.slice(
        trainSource.indexOf("async function generateWeek"),
        trainSource.indexOf("async function generateWeek") + 700
      )));
  test("client upgrade code contains no server secret",
    !/WHOP_API_KEY|WHOP_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE|OPENAI_API_KEY/.test(guardSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/*
 * Athlevo — freemium upgrade screen and plan-flow tests.
 * Run: node tests/paywall.test.mjs
 */

import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name); }
};
const section = name => console.log(`\n──── ${name} ────`);

const featuresSource = readFileSync("./js/features.js", "utf8");
const paywallSource = readFileSync("./js/paywall.js", "utf8");
const planSetupSource = readFileSync("./js/planSetup.js", "utf8");

function browser({ subscription = null, profile = {}, connected = true } = {}) {
  const screens = [], analytics = [], product = [], opened = [], mounts = {};
  let planExists = false;
  const mount = id => mounts[id] || (mounts[id] = {
    style: {}, dataset: {},
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html || ""; },
    querySelectorAll: () => [], scrollIntoView() {}
  });
  const document = {
    getElementById: mount,
    querySelector(selector) {
      if (selector === ".pw-wall" || selector === ".pw-preview") return mount(selector);
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible"
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
        getUser: async () => ({ data: { user: { id: "u1", email: "runner@example.test" } } }),
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
    AthlevoAnalytics: { track: name => analytics.push(name) },
    AthlevoProductAnalytics: {
      trackAthlevoEvent: (name, props) => product.push({ name, props })
    },
    open: url => opened.push(url),
    URL, URLSearchParams,
    location: { origin: "https://preview.vercel.app", pathname: "/", search: "", hash: "" },
    history: { replaceState() {} },
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
  new Function(...Object.keys(sandbox), paywallSource)(...Object.values(sandbox));
  new Function(...Object.keys(sandbox), planSetupSource.replace(/\}\)\(\);?\s*$/, "})()"))(
    ...Object.values(sandbox)
  );
  return { sandbox, screens, analytics, product, opened, mounts };
}

const visibleText = html => String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

section("Free plan journey");
{
  const w = browser({ profile: { name: "Dean", goal: "10K" } });
  await w.sandbox.AthlevoPlan.start();
  test("free user can open plan setup", w.screens.includes("screen-plansetup"));
  test("free plan setup does not open upgrade screen", !w.screens.includes("screen-paywall"));
  const setup = visibleText(w.mounts.planSetupBody.html);
  test("free user is offered initial plan generation",
    /Build Training Plan/.test(setup));
  test("initial plan generation does not open checkout", w.opened.length === 0);
}

section("Upgrade screen");
{
  const w = browser({ profile: { name: "Maria", goal: "Marathon" } });
  const shown = await w.sandbox.AthlevoPaywall.show({
    name: "Maria", goal: "Marathon", experience: "beginner"
  });
  const text = visibleText(w.mounts.paywallBody.html);
  test("free user can explicitly open the upgrade screen", shown === true &&
    w.screens.includes("screen-paywall"));
  test("upgrade screen names Athlevo Performance", /Athlevo Performance/.test(text));
  test("upgrade screen shows ₱597/month", /₱597\/month/.test(text));
  test("upgrade CTA is explicit", /Upgrade to Athlevo Performance/.test(text));
  test("upgrade screen has no timed free-trial copy",
    !/3[- ]day free trial|3 days free|after trial|trial ends/i.test(text));

  w.sandbox.AthlevoPaywall.checkout();
  test("checkout opens Whop", w.opened.length === 1 && /whop\.com/.test(w.opened[0]));
  test("checkout return uses the current origin",
    /preview\.vercel\.app/.test(decodeURIComponent(w.opened[0])));
  test("upgrade click is tracked", w.product.some(e => e.name === "upgrade_clicked"));
  test("checkout opening is tracked", w.product.some(e => e.name === "checkout_opened"));
}

section("Verified paid behavior");
{
  const activeWhop = {
    provider: "whop", plan_id: "performance", status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString()
  };
  const paid = browser({ subscription: activeWhop, profile: { name: "Ana" } });
  test("verified paid user is not shown the upgrade screen",
    await paid.sandbox.AthlevoPaywall.show({}) === false);
  await paid.sandbox.AthlevoPlan.start();
  test("verified paid user keeps normal plan setup behavior",
    paid.screens.includes("screen-plansetup"));

  const fake = browser({
    subscription: { provider: "manual", plan_id: "performance", status: "active" }
  });
  test("frontend cannot grant paid access from a non-Whop row",
    await fake.sandbox.AthlevoPaywall.isPaid() === false);
}

section("Static safety");
{
  test("plan flow has no automatic paywall fallback",
    !/shouldShowPaywall/.test(planSetupSource));
  test("upgrade screen preserves Whop return handling",
    /redirect_url/.test(paywallSource) && /visibilitychange/.test(paywallSource));
  test("client contains no payment or service-role secrets",
    !/WHOP_API_KEY|WHOP_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE/.test(paywallSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/*
 * Account-before-payment acquisition funnel.
 * Source-level coverage for /ai → /ai-signup → auth → entitlement → app.
 * Run: node tests/ai-signup-funnel.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolveEntitlement, ACCESS_STATES } from "../lib/server/features.js";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = (s) => console.log("\n──── " + s + " ────");

const html = readFileSync("./index.html", "utf8");
const ui = readFileSync("./js/diagnosticUI.js", "utf8");
const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
const handoff = readFileSync("./js/diagnosticHandoff.js", "utf8");
const onboard = readFileSync("./js/onboarding.js", "utf8");
const social = readFileSync("./js/socialAuth.js", "utf8");
const guard = readFileSync("./js/accessGuard.js", "utf8");
const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const providers = readFileSync("./api/providers/index.js", "utf8");
const webhook = readFileSync("./api/whop/webhook.js", "utf8");
const pending = readFileSync("./lib/server/whopPending.js", "utf8");
const claim = readFileSync("./lib/server/whopClaimEndpoint.js", "utf8");
const diagnostic = readFileSync("./js/diagnostic.js", "utf8");
const paymongoCheckout = readFileSync("./lib/server/paymongoCheckoutEndpoint.js", "utf8");

function extract(src, name) {
  const start = src.indexOf("async function " + name);
  const alt = src.indexOf("function " + name);
  const at = start >= 0 ? start : alt;
  return at >= 0 ? src.slice(at, at + 3500) : "";
}

section("1 — anonymous /ai still owns the diagnostic");
{
  t("logged-out /ai still starts the diagnostic",
    /pathname[\s\S]{0,80}=== '\/ai'[\s\S]{0,200}AthlevoDiagnosticUI\.start/.test(html) ||
    /replace\(\/\\\/\+\$\/, ''\) === '\/ai'[\s\S]{0,180}AthlevoDiagnosticUI\.start/.test(html));
  t("/ai is not a normal authenticated app entry",
    /Direct \/ai route: logged-out visitors enter the acquisition diagnostic/.test(html));
}

section("2 — completed diagnostic CTA routes to /ai-signup, not Whop");
{
  const cta = ui.slice(ui.indexOf("id=\"diagCTA\""), ui.indexOf("id=\"diagCTA\"") + 2200);
  t("result CTA calls openAiSignup", /openAiSignup\(\)/.test(cta));
  t("result CTA no longer opens Whop checkout",
    !/\.checkout\(["']card["']\)/.test(cta));
  t("anonymous chat checkout also hands off to /ai-signup",
    /function beginCheckoutFromChat[\s\S]{0,1800}openAiSignup/.test(ui));
  t("anonymous diagnosticAcquisition.checkout cannot start Whop",
    /if \(!root\.athlevoSessionUserId\)[\s\S]{0,180}openAiSignup/.test(acq));
}

section("3 — /ai-signup reuses existing Athlevo auth");
{
  t("Vercel rewrites /ai-signup to the SPA",
    (vercel.rewrites || []).some(r => r.source === "/ai-signup" && r.destination === "/index.html"));
  t("handoff reuses screen-welcome, not a second auth system",
    /function openAiSignup/.test(html) && /showScreen\("screen-welcome"\)/.test(extract(html, "openAiSignup")));
  t("copy asks to create an Athlevo account",
    /Create your Athlevo account/.test(html) && /Your diagnostic is saved/.test(html));
  t("Google / Email / Apple buttons remain the existing handlers",
    /continueWithGoogle\(\)/.test(html) && /id="authBtnEmail"/.test(html) && /continueWithApple\(\)/.test(html));
  t("existing users can sign in from /ai-signup",
    /Already have an account\?[\s\S]{0,80}Sign in/.test(html));
  t("email from /ai-signup opens signup, not a paywall",
    /emailBtn\.setAttribute\("onclick", "openSignup\(true\)"\)/.test(html));
}

section("4 — newly authenticated unpaid diagnostic user attaches then pays");
{
  const route = html.slice(html.indexOf("async function routeAfterAuth"), html.indexOf("async function restoreSession"));
  t("routeAfterAuth attaches diagnostic before entitlement",
    route.indexOf("AthlevoDiagnosticHandoff.attach") < route.indexOf("resolveAfterAuth"));
  t("unpaid acquisition lands on the paywall",
    /showPaywall\(state, false\)/.test(acq) && /route: "paywall"/.test(acq));
  t("authenticated checkout is required for new purchases",
    /if \(!root\.athlevoSessionUserId\)/.test(acq) &&
    /AthlevoAccessGuard\.checkout/.test(acq));
}

section("5 — authenticated paid user skips payment");
{
  const resolve = acq.slice(
    acq.indexOf("async function resolveAfterAuth"),
    acq.indexOf("function isPostPaymentOnboarding")
  );
  t("paid_active is checked before checkout UI",
    resolve.indexOf("verifiedPaidAccess") < resolve.indexOf("showPaywall") &&
    /if \(paid\.paid\)/.test(resolve));
  t("paid users never see the acquisition paywall",
    /if \(paid\.paid\)[\s\S]{0,900}route: "onboarding"[\s\S]{0,80}paid: true/.test(resolve) &&
    resolve.indexOf("if (paid.paid)") < resolve.indexOf("showPaywall"));
}

section("6 — payment return with webhook already processed");
{
  t("canonical entitlement uses paid_active, not URL params",
    /accessState === "paid_active"/.test(acq) &&
    !/checkout_return["']\s*===\s*["']1["'][\s\S]{0,80}paid = true/.test(acq));
  t("paid_active after poll continues to onboarding/app",
    /clearCheckoutReturn\(\)/.test(acq) && /route: "onboarding"/.test(acq));
  t("server entitlement still comes from subscriptions",
    resolveEntitlement({
      plan_id: "performance", status: "active", provider: "whop",
      current_period_end: new Date(Date.now() + 86400000).toISOString()
    }, Date.now()).accessState === ACCESS_STATES.PAID_ACTIVE);
}

section("7 — payment return before webhook shows activation, not a second CTA");
{
  t("checkout_return shows activating state before paywall buttons",
    /showActivation\(state\)/.test(acq) &&
    acq.indexOf("showActivation(state)") < acq.indexOf('route: "activating"'));
  t("unconfirmed return uses recheck, not immediate Start with Athlevo",
    /showRecheck\(state\)/.test(acq) && /route: "activating"/.test(acq));
  t("activating copy exists",
    /Activating your Athlevo account/.test(html));
  t("recheck and return-to-payment exist",
    /recheckEntitlement\(\)/.test(html) && /Return to payment/.test(html));
}

section("8 — account created, payment abandoned → later login is payment");
{
  t("loadAcquisition resumes awaiting_payment rows",
    /acquisition_stage[\s\S]{0,120}awaiting_payment/.test(handoff) &&
    /function loadAcquisition/.test(handoff));
  t("unpaid later login shows paywall, not diagnostic start",
    /if \(!paid\.paid\)[\s\S]{0,200}showPaywall\(state, false\)/.test(acq));
  t("routeAfterAuth never restarts AthlevoDiagnosticUI",
    !/AthlevoDiagnosticUI\.start/.test(html.slice(
      html.indexOf("async function routeAfterAuth"),
      html.indexOf("async function restoreSession")
    )));
}

section("9 — payment succeeded, browser closed → later login is paid_active");
{
  t("webhook still writes subscriptions independently of the browser",
    /from\("subscriptions"\)/.test(webhook) === false
      ? /subscriptions/.test(webhook)
      : true);
  t("claim path remains for unmatched prior purchases",
    /claim_pending_purchase/.test(providers) && /pending_whop_entitlements/.test(pending));
  t("later login resolves paid_active before paywall",
    acq.indexOf("if (paid.paid)") < acq.indexOf("showPaywall(state, false)"));
}

section("10 — paid user opening /ai goes to the app");
{
  t("authenticated /ai still uses routeAfterAuth, not a sales restart",
    /if \(session\)[\s\S]{0,1600}await routeAfterAuth\(session\.user\.id\)/.test(html));
  t("startDiagnostic still refuses an authenticated session",
    /if \(root\.athlevoSessionUserId\) \{[\s\S]{0,220}routeAfterAuth/.test(ui));
}

section("11 — imported diagnostic skips known onboarding fields");
{
  t("diagnostic maps goal, experience, volume, days, train time, status",
    /fields\.goal/.test(diagnostic) &&
    /fields\.experience_years/.test(diagnostic) &&
    /fields\.weekly_distance/.test(diagnostic) &&
    /fields\.weekly_hours/.test(diagnostic) &&
    /fields\.available_days/.test(diagnostic) &&
    /fields\.preferred_training_time/.test(diagnostic) &&
    /Training status:/.test(diagnostic));
  t("handoff writes those profile columns",
    /"goal", "experience_years", "weekly_distance", "weekly_hours"/.test(handoff) &&
    /mergeMissingProfileFields/.test(handoff));
  t("onboarding prefill + first-incomplete-step skips filled screens",
    /function obPrefillFromProfile/.test(onboard) &&
    /function obFirstIncompleteStep/.test(onboard) &&
    /obStepIndex = obFirstIncompleteStep\(\)/.test(onboard));
  t("acquisition users skip the long role-choice interview",
    /AthlevoDiagnosticAcquisition\.current\(\)[\s\S]{0,120}obStartAthleteFlow/.test(onboard));
  t("required leftover fields are personal/body/long-run/devices, not diagnostic answers",
    /key: "basics"[\s\S]{0,200}F\.name/.test(onboard) &&
    /key: "body"[\s\S]{0,200}F\.height/.test(onboard) &&
    /key: "longRun"/.test(onboard) &&
    /id: "devices"/.test(onboard));
}

section("12 — old pending Whop entitlement can still be claimed");
{
  t("pending helper is still shipped", /function pendingRowFromMapped/.test(pending));
  t("claim endpoint still exists", /claim_pending_whop_entitlement/.test(claim));
  t("routeAfterAuth still claims before diagnostic attach",
    html.indexOf("reconcileWhopPurchase") < html.indexOf("AthlevoDiagnosticHandoff.attach"));
  t("new funnel does not delete pending_whop_entitlements",
    /pending_whop_entitlements/.test(webhook) || /whopPending/.test(webhook));
}

section("13 — logged-out /ai-signup refresh remains auth handoff");
{
  t("restoreSession treats /ai-signup as auth, not diagnostic",
    /isAiSignupPath\(\)[\s\S]{0,80}hasAiSignupHandoff\(\)[\s\S]{0,120}openAiSignup/.test(html));
  t("refresh keeps the /ai-signup URL",
    /history\.replaceState\(\{ athlevoNav: "ai-signup" \}, "", "\/ai-signup"\)/.test(html));
}

section("14 — OAuth return from /ai-signup stays in the acquisition flow");
{
  t("OAuth redirectTarget preserves /ai-signup",
    /athlevo_ai_signup_handoff[\s\S]{0,200}\/ai-signup/.test(social));
  t("authenticated restore always continues via routeAfterAuth",
    /await routeAfterAuth\(session\.user\.id\)/.test(html));
  t("Google button on the reused welcome screen still starts OAuth",
    /onclick="continueWithGoogle\(\)"/.test(html));
}

section("Payment identity and PayMongo stay authenticated");
{
  t("Whop checkout can prefill the Athlevo email",
    /checkoutUrl\(prefillEmail\)/.test(guard) && /user\.email/.test(guard));
  t("PayMongo checkout still requires a bearer session",
    /401/.test(paymongoCheckout) && /Authorization/.test(guard));
  t("anonymous PayMongo is still not implemented from /ai",
    /if \(method === "local" && !root\.athlevoSessionUserId\) return/.test(ui) ||
    /QRPh · Maya · GrabPay/.test(ui));
}

section("Activation helpers are executable");
{
  const local = new Map();
  const shown = [];
  const context = {
    console: { warn() {}, log() {} },
    setTimeout: (fn) => { fn(); return 0; },
    URL,
    Date,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Object,
    Array,
    localStorage: {
      getItem: k => local.get(k) || null,
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: k => local.delete(k)
    },
    document: {
      getElementById: () => ({
        textContent: "",
        classList: { add() {}, remove() {}, toggle() {} }
      })
    },
    location: { href: "https://athlevo.org/ai-signup?checkout_return=1" },
    history: { replaceState() {} },
    AthlevoPlan: {
      _resolveEntitlement: (sub) => sub && sub.status === "active"
        ? { accessState: "paid_active", isPerformanceTrial: false }
        : { accessState: "free", isPerformanceTrial: false }
    },
    showScreen: id => shown.push(id)
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(acq, context);

  const unpaid = {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: { plan_id: "free", provider: "whop" }, error: null }) };
            }
          };
        }
      };
    }
  };
  const paidDb = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: { plan_id: "performance", provider: "whop", status: "active" },
                  error: null
                })
              };
            }
          };
        }
      };
    }
  };

  const unpaidAccess = await context.AthlevoDiagnosticAcquisition.verifiedPaidAccess(unpaid, "u1");
  const paidAccess = await context.AthlevoDiagnosticAcquisition.verifiedPaidAccess(paidDb, "u1");
  t("unpaid verifiedPaidAccess is not paid_active", unpaidAccess.paid === false);
  t("paid verifiedPaidAccess is paid_active", paidAccess.paid === true);
  t("checkout_return helper reads the query param without granting access",
    context.AthlevoDiagnosticAcquisition.hasCheckoutReturn() === true);
  context.AthlevoDiagnosticAcquisition.showActivation({ primaryLimiter: "schedule" });
  t("activation shows the existing paywall screen",
    shown.includes("screen-diagnostic-paywall"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

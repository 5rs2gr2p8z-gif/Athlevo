/*
 * Account-before-payment acquisition funnel.
 * Source-level coverage for /ai → /ai-signup → auth → entitlement → app.
 * Run: node tests/ai-signup-funnel.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
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
    /Create your Athlevo account/.test(html));
  t("/ai-signup does not show “Your diagnostic is saved.”",
    !/id="wAiSignupSaved"/.test(html) &&
    !html.slice(
      html.indexOf('id="screen-welcome"'),
      html.indexOf('id="screen-onboard"')
    ).includes("Your diagnostic is saved."));
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
  t("unpaid /ai-signup never falls through to existing/free app when gated",
    /if \(!loaded\.data\)[\s\S]{0,400}route: "paywall"/.test(acq) &&
    /isAcquisitionGated/.test(acq));
  t("routeAfterAuth snapshots /ai-signup before clearing the handoff",
    /var fromAiSignup = false[\s\S]{0,400}clearAiSignupHandoff/.test(
      html.slice(html.indexOf("async function routeAfterAuth"), html.indexOf("async function restoreSession"))
    ));
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
    /if \(paid\.paid\)[\s\S]{0,1600}route: "onboarding"[\s\S]{0,80}paid: true/.test(resolve) &&
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

section("Acquisition gating vs legacy freemium");
{
  t("new /ai-signup accounts without onboarding are gated",
    /fromAiSignup && !\(profile && profile\.onboarding_complete === true\)/.test(acq));
  t("completed-onboarding profiles without diagnostic stay on existing routing",
    /fromAiSignup && !\(profile && profile\.onboarding_complete === true\)\) return true/.test(acq) &&
    /return \{ handled: false, route: "existing" \}/.test(acq));
  t("paid_active still skips the paywall",
    /if \(paid\.paid\)/.test(acq));
  t("unpaid later login uses bound local awaiting_payment, not diagnostic UI",
    /bindAcquisitionUser/.test(acq) &&
    !/AthlevoDiagnosticUI\.start/.test(html.slice(
      html.indexOf("async function routeAfterAuth"),
      html.indexOf("async function restoreSession")
    )));
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

section("Executable unpaid /ai-signup cannot enter the app");
{
  function world({ href = "https://athlevo.org/ai-signup", paid = false, acquisitionRow = null } = {}) {
    const local = new Map();
    const shown = [];
    const context = {
      console: { warn() {}, log() {} },
      setTimeout: (fn) => { fn(); return 0; },
      URL, Date, JSON, Math, String, Number, Boolean, Object, Array,
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
      location: { href },
      history: { replaceState() {} },
      AthlevoPlan: {
        _resolveEntitlement: (sub) => sub && sub.status === "active"
          ? { accessState: "paid_active", isPerformanceTrial: false }
          : { accessState: "free", isPerformanceTrial: false }
      },
      AthlevoDiagnosticHandoff: {
        loadAcquisition: async () => ({ data: acquisitionRow, error: null }),
        setAcquisitionStage: async () => ({ updated: true })
      },
      showScreen: id => shown.push(id)
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(acq, context);
    const subscription = paid
      ? { plan_id: "performance", provider: "whop", status: "active" }
      : { plan_id: "free", provider: "whop" };
    const supabase = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: subscription, error: null }),
                  in() {
                    return {
                      order() {
                        return {
                          limit() {
                            return { maybeSingle: async () => ({ data: acquisitionRow, error: null }) };
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };
    return { api: context.AthlevoDiagnosticAcquisition, shown, supabase };
  }

  {
    const w = world();
    const result = await w.api.resolveAfterAuth("u-new", w.supabase, null,
      { onboarding_complete: false }, { fromAiSignup: true });
    t("new unpaid /ai-signup account is held on payment, not Today",
      result.handled === true && result.route === "paywall" &&
      w.shown.includes("screen-diagnostic-paywall"));
  }
  {
    const w = world();
    await w.api.resolveAfterAuth("u-refresh", w.supabase, null,
      { onboarding_complete: false }, { fromAiSignup: true });
    const again = await w.api.resolveAfterAuth("u-refresh", w.supabase, null,
      { onboarding_complete: false }, { fromAiSignup: false });
    t("refresh/later login of unpaid acquisition still hits payment",
      again.handled === true && again.route === "paywall");
  }
  {
    const w = world({ paid: true });
    const result = await w.api.resolveAfterAuth("u-paid", w.supabase, null,
      { onboarding_complete: false }, { fromAiSignup: true });
    t("paid_active /ai-signup user skips payment and enters short onboarding",
      result.paid === true && result.route === "onboarding" &&
      !w.shown.includes("screen-diagnostic-paywall"));
  }
  {
    const w = world({ paid: true });
    const result = await w.api.resolveAfterAuth("u-paid-done", w.supabase, null,
      { onboarding_complete: true }, { fromAiSignup: true });
    t("paid_active + onboarding complete continues to the app",
      result.paid === true && result.route === "app" && result.handled === false);
  }
  {
    const w = world();
    const result = await w.api.resolveAfterAuth("u-legacy", w.supabase, null,
      { onboarding_complete: true }, { fromAiSignup: true });
    t("legacy free account with completed onboarding is not converted to a paywall",
      result.handled === false && result.route === "existing");
  }
}

section("Handoff failure must not block authenticated checkout");
{
  const FATAL = /couldn't save your diagnostic|try again before continuing/i;
  t("fatal diagnostic-save copy is gone",
    !FATAL.test(acq) && !FATAL.test(html));
  t("attach/load failure no longer routes to import_unavailable",
    !/import_unavailable/.test(acq));
  t("routeAfterAuth exceptions still keep checkout CTAs", (() => {
    const route = html.slice(
      html.indexOf("async function routeAfterAuth"),
      html.indexOf("async function restoreSession")
    );
    const catchStart = route.indexOf("Diagnostic acquisition routing unavailable");
    const catchBlock = catchStart >= 0 ? route.slice(catchStart, catchStart + 1800) : "";
    return catchStart >= 0 &&
      /showPaywall\(/.test(catchBlock) &&
      !/,\s*true\s*\)/.test(catchBlock);
  })());
  t("paywall HTML still has card and local payment CTAs",
    /checkout\('card'\)/.test(html) && /checkout\('local'\)/.test(html));
  t("CSS hides payment actions only for is-unavailable, not import failure",
    /\.diagnostic-paywall-card\.is-unavailable \.diagnostic-paywall-actions\{display:none\}/.test(html));

  function paywallWorld({
    href = "https://athlevo.org/ai-signup",
    paid = false,
    acquisitionRow = null,
    loadError = null,
    pending = true,
    attachResult = { attached: false, error: "forced handoff failure" }
  } = {}) {
    const local = new Map();
    const shown = [];
    const cardClasses = new Set();
    const statusEl = { textContent: "" };
    const limiterEl = { textContent: "" };
    const card = {
      classList: {
        add(name) { cardClasses.add(name); },
        remove(...names) { names.forEach(name => cardClasses.delete(name)); },
        toggle(name, on) {
          if (on) cardClasses.add(name);
          else cardClasses.delete(name);
        },
        contains(name) { return cardClasses.has(name); }
      }
    };
    let pendingKept = pending;
    let attachCalls = 0;
    const context = {
      console: { warn() {}, log() {} },
      setTimeout: (fn) => { fn(); return 0; },
      URL, Date, JSON, Math, String, Number, Boolean, Object, Array,
      localStorage: {
        getItem: k => local.get(k) || null,
        setItem: (k, v) => local.set(k, String(v)),
        removeItem: k => local.delete(k)
      },
      document: {
        getElementById: (id) => {
          if (id === "diagnosticPaywallCard") return card;
          if (id === "diagnosticPaywallStatus") return statusEl;
          if (id === "diagnosticPaywallLimiter") return limiterEl;
          return { textContent: "", classList: { add() {}, remove() {}, toggle() {} } };
        }
      },
      location: { href },
      history: { replaceState() {} },
      athlevoSessionUserId: "u-handoff",
      AthlevoPlan: {
        _resolveEntitlement: (sub) => sub && sub.status === "active"
          ? { accessState: "paid_active", isPerformanceTrial: false }
          : { accessState: "free", isPerformanceTrial: false }
      },
      AthlevoDiagnostic: {
        hasPending: () => pendingKept,
        clearPending: () => { pendingKept = false; }
      },
      AthlevoDiagnosticHandoff: {
        loadAcquisition: async () => ({ data: acquisitionRow, error: loadError || null }),
        setAcquisitionStage: async () => ({ updated: true }),
        attach: async () => {
          attachCalls += 1;
          if (attachResult && attachResult.attached) pendingKept = false;
          return attachResult;
        }
      },
      AthlevoAccessGuard: {
        checkout: async () => true,
        checkoutLocal: async () => true
      },
      showScreen: id => shown.push(id)
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(acq, context);
    const subscription = paid
      ? { plan_id: "performance", provider: "whop", status: "active" }
      : { plan_id: "free", provider: "whop" };
    const supabase = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: subscription, error: null }),
                  in() {
                    return {
                      order() {
                        return {
                          limit() {
                            return { maybeSingle: async () => ({ data: acquisitionRow, error: loadError || null }) };
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };
    const engine = {
      importKey: () => "diag_prod_1",
      result: {
        primaryLimiter: { key: "training_structure" },
        athlevoRecommendation: { id: "ai", safetyOverride: false, strategy: "keep going" }
      }
    };
    context.AthlevoDiagnosticAcquisition.markDiagnosticCompleted(engine);
    local.set("athlevo_pending_diagnostic_v1", JSON.stringify({ v: 1, kept: true }));
    return {
      api: context.AthlevoDiagnosticAcquisition,
      shown, supabase, local, statusEl, cardClasses,
      pending: () => pendingKept,
      attachCalls: () => attachCalls
    };
  }

  {
    const w = paywallWorld();
    const result = await w.api.resolveAfterAuth("u-handoff", w.supabase, {
      attached: false, error: "network timeout"
    }, { onboarding_complete: false }, { fromAiSignup: true });
    t("forced attach failure still renders the payment page",
      result.handled === true && result.route === "paywall" &&
      w.shown.includes("screen-diagnostic-paywall"));
    t("forced attach failure does not hide checkout with is-unavailable",
      !w.cardClasses.has("is-unavailable"));
    t("forced attach failure has no fatal diagnostic-save blocker",
      !FATAL.test(w.statusEl.textContent || ""));
    t("pending diagnostic remains stored after attach failure",
      w.pending() === true && w.local.has("athlevo_pending_diagnostic_v1") &&
      w.local.has("athlevo_diagnostic_acquisition_v1"));
    const cardOpened = await w.api.checkout("card");
    const localOpened = await w.api.checkout("local");
    t("card CTA still works after attach failure", cardOpened === true);
    t("local payment CTA still works after attach failure", localOpened === true);
  }

  {
    const w = paywallWorld({ loadError: { message: "RLS denied" } });
    const result = await w.api.resolveAfterAuth("u-handoff", w.supabase, {
      attached: false, error: "RLS issue"
    }, { onboarding_complete: false }, { fromAiSignup: true });
    t("loadAcquisition failure still keeps checkout available",
      result.route === "paywall" && !w.cardClasses.has("is-unavailable"));
  }

  {
    const w = paywallWorld({
      paid: true,
      attachResult: { attached: false, error: "still failing after payment" }
    });
    const result = await w.api.resolveAfterAuth("u-handoff", w.supabase, {
      attached: false, error: "network timeout"
    }, { onboarding_complete: false }, { fromAiSignup: true });
    t("paid_active retries diagnostic attach before onboarding",
      w.attachCalls() >= 1);
    t("paid user proceeds to onboarding even if attach fails again",
      result.paid === true && result.route === "onboarding" &&
      !w.shown.includes("screen-diagnostic-paywall"));
    t("pending diagnostic is still retained after paid attach failure",
      w.pending() === true);
  }

  {
    const w = paywallWorld({
      paid: true,
      attachResult: { attached: true, importKey: "diag_prod_1", primaryLimiter: "training_structure" }
    });
    const result = await w.api.resolveAfterAuth("u-handoff", w.supabase, {
      attached: false, error: "first attempt failed"
    }, { onboarding_complete: true }, { fromAiSignup: true });
    t("successful post-payment attach still reaches the app",
      result.paid === true && result.route === "app" && w.pending() === false);
  }

  {
    const w = paywallWorld({
      pending: false,
      attachResult: { attached: true, importKey: "diag_ok", primaryLimiter: "schedule" },
      acquisitionRow: {
        import_key: "diag_ok",
        primary_limiter: "schedule",
        acquisition_stage: "awaiting_payment"
      }
    });
    const result = await w.api.resolveAfterAuth("u-ok", w.supabase, {
      attached: true, importKey: "diag_ok", primaryLimiter: "schedule"
    }, { onboarding_complete: false }, { fromAiSignup: true });
    t("successful diagnostic attach still shows normal checkout",
      result.route === "paywall" && !w.cardClasses.has("is-unavailable") &&
      !FATAL.test(w.statusEl.textContent || "") &&
      !/finish importing/i.test(w.statusEl.textContent || ""));
  }
}

section("Authenticated payment screen is a checkout selector");
{
  const paywall = html.slice(
    html.indexOf('id="screen-diagnostic-paywall"'),
    html.indexOf('id="screen-plansetup"')
  );
  const paywallCss = html.slice(
    html.indexOf(".diagnostic-paywall-scroll{"),
    html.indexOf(".connect-card p{")
  );

  t("limiter card no longer appears on payment page",
    !/diagnostic-paywall-limiter|diagnosticPaywallLimiter|Primary limiter/.test(paywall));
  t("Activate your Athlevo Pro access. appears",
    /Activate your[\s\S]{0,20}Athlevo Pro access\./.test(paywall));
  t("Choose how you’d like to pay. appears",
    /Choose how you’d like to pay\./.test(paywall));
  t("card payment option is white / non-danger visual treatment",
    /\.diagnostic-paywall-primary,\.diagnostic-paywall-local\{[\s\S]{0,500}background:var\(--paper\)/.test(paywallCss) &&
    !/\.diagnostic-paywall-primary\{[^}]*background:var\(--red\)/.test(paywallCss) &&
    !/background:var\(--red\);color:#fff/.test(paywallCss));
  t("card CTA uses existing Whop handler",
    /checkout\('card'\)/.test(paywall) &&
    /AthlevoAccessGuard\.checkout/.test(acq) &&
    /function checkout\(method\)[\s\S]{0,900}checkout\(context\)/.test(acq));
  t("local payment row uses existing PayMongo handler",
    /checkout\('local'\)/.test(paywall) &&
    /AthlevoAccessGuard\.checkoutLocal/.test(acq) &&
    /method === "local"[\s\S]{0,80}checkoutLocal/.test(acq));
  t("only QRPh/Maya/GrabPay are shown as the supported local methods",
    /QRPh · Maya · GrabPay/.test(paywall) &&
    (paywall.match(/checkout\('local'\)/g) || []).length === 1);
  t("card row keeps the card icon",
    /diagnostic-paywall-method-icon/.test(paywall) &&
    /<rect x="2.5" y="5" width="19" height="14"/.test(paywall));
  t("card row has no payment-brand logos",
    /Pay with credit \/ debit card/.test(paywall) &&
    /Secure card payment/.test(paywall) &&
    !/athlevo-assets\/payment-logo/.test(paywall) &&
    !/diagnostic-paywall-marks|diagnostic-paywall-logo/.test(paywall) &&
    !/is-visa|is-mastercard/.test(paywall));
  t("local row is text-only QRPh · Maya · GrabPay",
    /QRPh · Maya · GrabPay/.test(paywall) &&
    /Pay using your preferred local payment method/.test(paywall) &&
    !/is-qrph|is-maya|diagnostic-paywall-grab-label/.test(paywall));
  t("payment-logo files remain unused and are not requested",
    existsSync("./athlevo-assets/payment-logo/a36170404e5da93621ed8298daa957e6.webp") &&
    existsSync("./athlevo-assets/payment-logo/qr-ph-logo-6f76723590.webp") &&
    existsSync("./athlevo-assets/payment-logo/b9379ad46b7f2d23fc893714558d6f93.jpg") &&
    existsSync("./athlevo-assets/payment-logo/378f52cfebeec77a30daac4dd55b13.webp") &&
    !/athlevo-assets\/payment-logo/.test(html));
  t("GCash is not shown as a self-serve method",
    !/GCash/.test(paywall));
  t("local row does not use colored pills, logos, or wallet icons",
    !/diagnostic-paywall-brand-mark/.test(paywallCss) &&
    !/diagnostic-paywall-logo/.test(paywallCss) &&
    !/object-fit:/.test(paywallCss));
  t("₱597/month is visible", /₱597\/month/.test(paywall));
  t("Cancel anytime is visible", /Cancel anytime/.test(paywall));
  t("no unsupported GCash or bank transfer",
    !/GCash|bank transfer|Bank transfer/i.test(paywall));
  t("no coaching diagnosis text on payment page",
    !/Your diagnostic is saved|Start training with Athlevo|Let Athlevo build the training around it|training structure|feasibility|endurance\/pacing|Personalized training plan|Daily workout guidance/.test(paywall));
  t("paid/auth routing files were not changed by this UI polish",
    /function checkout\(method\)[\s\S]{0,400}AthlevoAccessGuard/.test(acq) &&
    /WHOP_CHECKOUT_URL = "https:\/\/whop\.com\/checkout\/plan_F5PftzWCJCQVw"/.test(guard));
}

section("Anonymous /ai conversion never shows payment");
{
  const storage = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document: {
      readyState: "complete",
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        appendChild() {},
        setAttribute() {}
      })
    },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: true })
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context, { filename: "diagnostic.js" });
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context, { filename: "diagnosticSalesEngine.js" });
  vm.runInContext(readFileSync("./js/diagnosticUI.js", "utf8"), context, { filename: "diagnosticUI.js" });
  const UI = context.AthlevoDiagnosticUI;
  const Sales = context.AthlevoDiagnosticSales;
  const helpers = UI._internal;

  const PAYMENT_LABELS = /Debit \/ Credit Card|QRPh|Maya|GrabPay|Whop|PayMongo/;
  const signupReply = "Great. Create your Athlevo account first so I can save your training and continue.";

  t("bare “yes” is a sales-CTA confirmation, not a global ready classifier",
    Sales.isSalesCtaConfirmation("yes") === true && Sales.classify("yes") === null);
  t("follow-up “yes” is treated as checkout by decideSalesFollowup",
    helpers.decideSalesFollowup("yes", null, [], { id: "goal" }, { key: "goal" }) === "checkout");

  const letsDoIt = Sales.classify("Let's do it.");
  t("anonymous “let’s do it” is ready_to_start → show_checkout",
    letsDoIt && letsDoIt.intent === "ready_to_start" && letsDoIt.next_action === "show_checkout");

  const imReady = Sales.classify("I'm ready.");
  t("anonymous “I’m ready” is ready_to_start → show_checkout",
    imReady && imReady.intent === "ready_to_start" && imReady.next_action === "show_checkout");

  const readyReply = Sales.composeSalesReply(letsDoIt, { answers: {} }, Sales.emptySalesState(), []);
  const rewritten = helpers.applyAnonymousConversionCopy({
    reply: readyReply.reply,
    reply_2: readyReply.reply_2,
    next_action: readyReply.next_action,
    show_checkout: readyReply.show_checkout
  });
  t("anonymous “yes”/ready_to_start copy is account-first, not a payment bridge",
    rewritten.reply === signupReply &&
    rewritten.reply_2 == null &&
    !PAYMENT_LABELS.test(rewritten.reply || ""));

  const anonChips = helpers.conversionHandoffOptions();
  t("anonymous conversion shows the signup CTA only",
    anonChips.length === 1 &&
    anonChips[0].label === "Create my Athlevo account" &&
    anonChips[0].value === "__ai_signup");
  t("no payment-provider labels appear in anonymous diagnostic conversion state",
    !PAYMENT_LABELS.test(anonChips.map(c => c.label).join(" ")));

  t("anonymous offerPaymentBridge routes to signup, not payment chips",
    /function offerPaymentBridge[\s\S]{0,500}if \(isAnonymousDiagnosticVisitor\(\)\)[\s\S]{0,80}offerSignupHandoff/.test(ui));
  t("signup CTA click uses beginCheckoutFromChat, which hands off to /ai-signup",
    /function offerSignupHandoff[\s\S]{0,400}beginCheckoutFromChat\("signup"\)/.test(ui) &&
    /function beginCheckoutFromChat[\s\S]{0,1800}openAiSignup/.test(ui));
  t("Build-my-training chip uses the same conversion handoff",
    (ui.match(/opt\.value === "__start"/g) || []).length >= 2 &&
    (ui.match(/presentConversionHandoff\(ready\)/g) || []).length >= 2);
  t("anonymous result CTA still goes to /ai-signup, not checkout",
    /id="diagCTA"[\s\S]{0,2200}openAiSignup\(\)/.test(ui) &&
    !/id="diagCTA"[\s\S]{0,2200}\.checkout\(/.test(ui));

  context.athlevoSessionUserId = "user-unpaid";
  const authChips = helpers.conversionHandoffOptions();
  t("authenticated unpaid user still sees payment options",
    authChips.some(c => c.label === "Debit / Credit Card") &&
    authChips.some(c => c.label === "QRPh · Maya · GrabPay") &&
    !authChips.some(c => c.value === "__ai_signup"));
  t("authenticated conversion copy is not rewritten to signup",
    helpers.applyAnonymousConversionCopy({
      reply: readyReply.reply,
      next_action: "show_checkout",
      show_checkout: true
    }).reply === readyReply.reply);

  t("authenticated paid_active users never enter /ai chat payment",
    /if \(root\.athlevoSessionUserId\) \{[\s\S]{0,220}routeAfterAuth/.test(ui));
  t("authenticated paid_active still skips payment for onboarding/app",
    (() => {
      const resolve = acq.slice(
        acq.indexOf("async function resolveAfterAuth"),
        acq.indexOf("function isPostPaymentOnboarding")
      );
      return resolve.indexOf("if (paid.paid)") < resolve.indexOf("showPaywall") &&
        /route: "onboarding"/.test(resolve);
    })());

  const welcome = html.slice(
    html.indexOf('id="screen-welcome"'),
    html.indexOf('id="screen-onboard"')
  );
  t("/ai-signup does not contain “Your diagnostic is saved.”",
    !welcome.includes("Your diagnostic is saved.") &&
    /Create your Athlevo account/.test(welcome));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

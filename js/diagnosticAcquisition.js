/* Athlevo — durable paid-first acquisition routing for completed diagnostics. */
(function (root) {
"use strict";

var STORAGE_KEY = "athlevo_diagnostic_acquisition_v1";
var PAYWALL_EXIT_KEY = "athlevo_paywall_exit";
var TTL_MS = 30 * 24 * 60 * 60 * 1000;
var PAID_PROVIDERS = ["whop", "paymongo", "gcash_manual"];
var active = null;
var acquisitionSupabase = null;
var checkoutInFlight = false;
var selectedOfferPlan = "monthly";
/*
 * Monthly Whop checkout is plan_F5PftzWCJCQVw via AthlevoAccessGuard.
 * No annual Whop plan ID exists in the repo, env samples, or checkout config.
 * PayMongo checkout is server-owned ATHLEVO_PRO_MONTHLY (₱597 / 30 days) and
 * ignores the request body, so local annual would charge the wrong amount.
 */
var ANNUAL_CHECKOUT_READY = false;

function nowIso() { return new Date().toISOString(); }

function readLocal() {
  try {
    var value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!value || value.v !== 1 || !value.importKey || !value.expiresAt) return null;
    if (Date.parse(value.expiresAt) <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value;
  } catch (e) { return null; }
}

function writeLocal(value) {
  try {
    value.v = 1;
    value.updatedAt = nowIso();
    value.expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (e) {}
  active = value;
  return value;
}

function clearLocal() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  active = null;
}

function track(name, props) {
  try {
    if (root.AthlevoAnalytics) root.AthlevoAnalytics.track(name, props || {});
    if (root.AthlevoProductAnalytics) root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
  } catch (e) {}
}

function trackOnce(name, state, props) {
  state.events = state.events || {};
  if (state.events[name]) return;
  state.events[name] = true;
  writeLocal(state);
  track(name, props || {});
}

/* First settled checkout-return observation for this page load only.
 * activating → paid inside the same return poll is recorded as paid,
 * not as two events. Later paywall views without checkout_return do
 * not fire. Not mapped to Meta. */
var checkoutReturnViewedFired = false;

function trackCheckoutReturnViewed(outcome, provider) {
  if (checkoutReturnViewedFired) return;
  if (outcome !== "unpaid" && outcome !== "activating" && outcome !== "paid") return;
  checkoutReturnViewedFired = true;
  var props = { outcome: outcome };
  if (provider === "whop" || provider === "paymongo") props.provider = provider;
  track("checkout_return_viewed", props);
}

function markDiagnosticCompleted(engine) {
  var result = engine && engine.result;
  if (!engine || !result || !result.athlevoRecommendation || result.athlevoRecommendation.safetyOverride) return null;
  return writeLocal({
    importKey: engine.importKey(),
    primaryLimiter: result.primaryLimiter ? result.primaryLimiter.key : null,
    stage: "diagnostic_completed",
    events: {}
  });
}

function currentForUser(userId) {
  var state = active || readLocal();
  if (!state) return null;
  if (state.userId && userId && state.userId !== userId) return null;
  return state;
}

function markImported(userId, outcome) {
  var state = currentForUser(userId) || { events: {} };
  state.userId = userId;
  state.importKey = outcome.importKey;
  state.primaryLimiter = outcome.primaryLimiter || state.primaryLimiter || null;
  state.stage = "awaiting_payment";
  return writeLocal(state);
}

async function verifiedPaidAccess(supabase, userId) {
  if (!supabase || !userId) return { paid: false, unavailable: true };
  var response = await supabase.from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (response.error) return { paid: false, unavailable: true, error: response.error };
  var sub = response.data;
  if (!sub || PAID_PROVIDERS.indexOf(String(sub.provider || "").toLowerCase()) < 0 ||
      String(sub.plan_id || "free").toLowerCase() === "free") {
    return { paid: false, unavailable: false };
  }
  var entitlement = root.AthlevoPlan && root.AthlevoPlan._resolveEntitlement
    ? root.AthlevoPlan._resolveEntitlement(sub, Date.now())
    : null;
  return {
    paid: !!(entitlement && entitlement.accessState === "paid_active" && !entitlement.isPerformanceTrial),
    unavailable: false,
    entitlement: entitlement,
    provider: sub && sub.provider ? String(sub.provider).toLowerCase() : null,
    plan_id: sub && sub.plan_id && String(sub.plan_id).toLowerCase() !== "free"
      ? String(sub.plan_id).slice(0, 40)
      : null
  };
}

async function setStage(state, stage, supabase) {
  if (!state) return false;
  state.stage = stage;
  writeLocal(state);
  if (!state.userId || !state.importKey || !root.AthlevoDiagnosticHandoff) return false;
  var response = await root.AthlevoDiagnosticHandoff.setAcquisitionStage(
    state.userId, state.importKey, stage, supabase
  );
  return !!response.updated;
}

function limiterLabel(value) {
  var labels = {
    consistency: "Training consistency",
    running_durability: "Running durability",
    aerobic_base: "Aerobic endurance",
    training_structure: "Training structure",
    endurance_pacing: "Endurance and pacing",
    schedule: "Schedule flexibility",
    injury_management: "Load and durability"
  };
  return labels[value] || "Your training structure";
}

/**
 * isDiagnosticAcquisition — checks whether the given user came through the
 * paid-first diagnostic acquisition path. Checks both the durable
 * athlete_diagnostics table (server-side) and local acquisition state.
 * This is the flag features.js uses to suppress the 24-hour trial RPC.
 */
async function isDiagnosticAcquisition(userId, supabase) {
  // Fast path: local state says this is a diagnostic-acquisition user.
  var local = currentForUser(userId);
  if (local && local.stage && local.stage !== "completed") return true;
  // Server path: check for an active (non-completed) acquisition row.
  if (!supabase || !userId) return false;
  try {
    var result = await supabase
      .from("athlete_diagnostics")
      .select("acquisition_stage")
      .eq("user_id", userId)
      .in("acquisition_stage", ["awaiting_payment", "checkout_started", "payment_confirmed", "onboarding"])
      .limit(1)
      .maybeSingle();
    return !!(result.data && result.data.acquisition_stage);
  } catch (e) { return false; }
}

function hasCheckoutReturn() {
  try {
    var url = new URL(root.location.href);
    return url.searchParams.get("checkout_return") === "1";
  } catch (e) { return false; }
}

function clearCheckoutReturn() {
  try {
    var url = new URL(root.location.href);
    url.searchParams.delete("checkout_return");
    root.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch (e) {}
}

function wait(ms) { return new Promise(function (resolve) { root.setTimeout(resolve, ms); }); }

async function reconcileWhopPurchase(supabase) {
  if (!supabase || !supabase.auth || typeof supabase.auth.getSession !== "function") {
    return { claimed: false, reason: "unavailable" };
  }
  try {
    var sessionResult = await supabase.auth.getSession();
    var session = sessionResult && sessionResult.data && sessionResult.data.session;
    if (!session || !session.access_token) return { claimed: false, reason: "unavailable" };
    var response = await fetch("/api/providers?action=claim_pending_purchase", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    var body = null;
    try { body = await response.json(); } catch (e) { body = null; }
    if (!response.ok) return { claimed: false, reason: "invalid_state" };
    return {
      claimed: !!(body && body.claimed === true),
      reason: body && body.reason ? String(body.reason) : "no_pending_purchase"
    };
  } catch (e) {
    return { claimed: false, reason: "invalid_state" };
  }
}

function setPaywallMode(mode) {
  var card = document.getElementById("diagnosticPaywallCard");
  var screen = document.getElementById("screen-diagnostic-paywall");
  if (!card || !card.classList) return;
  card.classList.remove("is-activating", "is-recheck", "is-unavailable");
  if (mode === "activating") card.classList.add("is-activating");
  else if (mode === "recheck") card.classList.add("is-recheck");
  else if (mode === "unavailable") card.classList.add("is-unavailable");
  if (screen && screen.classList) {
    screen.classList.toggle("is-activating", mode === "activating");
    screen.classList.toggle("is-recheck", mode === "recheck");
    if (mode === "activating" || mode === "recheck" || mode === "unavailable") {
      screen.classList.remove("is-choosing-method");
    }
  }
}

function markPaymentCompleted(userId, paid) {
  if (!userId || !paid || !paid.paid) return;
  var state = currentForUser(userId) || readLocal() || { events: {} };
  var props = {
    price_php: 597,
    source: "ai_signup"
  };
  if (paid.provider === "whop" || paid.provider === "paymongo") props.provider = paid.provider;
  if (paid.plan_id) props.plan_id = paid.plan_id;
  if (root.AthlevoProductAnalytics &&
      typeof root.AthlevoProductAnalytics.trackPaymentCompleted === "function") {
    root.AthlevoProductAnalytics.trackPaymentCompleted(userId, props);
  } else {
    trackOnce("payment_completed", state, props);
    return;
  }
  state.events = state.events || {};
  state.events.payment_completed = true;
  if (state.userId || userId) state.userId = state.userId || userId;
  writeLocal(state);
}

function hideAppTabbar() {
  var tabbar = document.getElementById("tabbar");
  if (tabbar && tabbar.style) tabbar.style.display = "none";
}

/*
 * Paid-only athlete gate. Coach/admin roles granted server-side may enter.
 * A valid paid_active entitlement (not a performance trial) may enter.
 * Everyone else is sent to the offer/payment page with no app shell.
 */
async function gateUnpaidAthlete(userId, supabase, profile) {
  if (profile && (profile.role === "coach" || profile.role === "admin")) {
    return { allowed: true, staff: true };
  }
  var paid = { paid: false };
  try {
    paid = await verifiedPaidAccess(supabase || acquisitionSupabase, userId);
  } catch (e) {
    paid = { paid: false };
  }
  if (paid && paid.paid) {
    clearPaywallExit();
    return { allowed: true, paid: true };
  }
  showPaywall(bindAcquisitionUser(userId), false);
  return { allowed: false, route: "paywall" };
}

function setPaywallStatus(message) {
  var status = document.getElementById("diagnosticPaywallStatus");
  if (status) status.textContent = message || "";
}

function setPaywallBusy(busy) {
  var buttons = document.querySelectorAll(
    ".diagnostic-paywall-primary, .diagnostic-paywall-local, .diagnostic-paywall-start"
  );
  for (var i = 0; i < buttons.length; i += 1) {
    if (buttons[i].id === "offerStartCta" && selectedOfferPlan === "annual" &&
        !ANNUAL_CHECKOUT_READY) {
      buttons[i].disabled = true;
      continue;
    }
    buttons[i].disabled = !!busy;
  }
}

function formatOfferPrice(amount) {
  return "₱" + Number(amount).toLocaleString("en-US");
}

function offerPlanCopy(plan) {
  if (plan === "annual") {
    return {
      price: formatOfferPrice(5498),
      cadence: "/ year",
      equiv: "₱458/month billed annually.",
      methods: "₱5,498/year",
      pricePhp: 5498
    };
  }
  return {
    price: formatOfferPrice(597),
    cadence: "/ month",
    equiv: "Cancel anytime.",
    methods: "₱597/month",
    pricePhp: 597
  };
}

function selectOfferPlan(plan) {
  selectedOfferPlan = plan === "annual" ? "annual" : "monthly";
  var annual = selectedOfferPlan === "annual";
  var copy = offerPlanCopy(selectedOfferPlan);
  var card = document.getElementById("diagnosticPaywallCard");
  var monthlyBtn = document.getElementById("offerPlanMonthly");
  var annualBtn = document.getElementById("offerPlanAnnual");
  var price = document.getElementById("offerPlanPrice");
  var cadence = document.getElementById("offerPlanCadence");
  var equiv = document.getElementById("offerPlanEquiv");
  var methodsPrice = document.getElementById("offerMethodsPrice");
  var start = document.getElementById("offerStartCta");
  if (card && card.classList) card.classList.toggle("is-annual", annual);
  if (monthlyBtn) {
    monthlyBtn.classList.toggle("is-active", !annual);
    if (typeof monthlyBtn.setAttribute === "function") {
      monthlyBtn.setAttribute("aria-selected", annual ? "false" : "true");
    }
  }
  if (annualBtn) {
    annualBtn.classList.toggle("is-active", annual);
    if (typeof annualBtn.setAttribute === "function") {
      annualBtn.setAttribute("aria-selected", annual ? "true" : "false");
    }
  }
  if (price) price.textContent = copy.price;
  if (cadence) cadence.textContent = copy.cadence;
  if (equiv) equiv.textContent = copy.equiv;
  if (methodsPrice) methodsPrice.textContent = copy.methods;
  if (start) start.disabled = annual && !ANNUAL_CHECKOUT_READY;
  return selectedOfferPlan;
}

function showOfferStep() {
  var screen = document.getElementById("screen-diagnostic-paywall");
  if (screen && screen.classList) screen.classList.remove("is-choosing-method");
  setPaywallStatus("");
}

function showPaymentMethods() {
  var screen = document.getElementById("screen-diagnostic-paywall");
  if (screen && screen.classList) screen.classList.add("is-choosing-method");
  var methodsPrice = document.getElementById("offerMethodsPrice");
  var copy = offerPlanCopy(selectedOfferPlan);
  if (methodsPrice) methodsPrice.textContent = copy.methods;
  setPaywallStatus("");
}

function beginOfferCheckout() {
  if (selectedOfferPlan === "annual" && !ANNUAL_CHECKOUT_READY) {
    setPaywallStatus("Annual checkout is not available yet. Choose Monthly to start now.");
    return false;
  }
  showPaymentMethods();
  return true;
}

function backFromPaywall() {
  var screen = document.getElementById("screen-diagnostic-paywall");
  if (screen && screen.classList && screen.classList.contains("is-choosing-method")) {
    showOfferStep();
    return false;
  }
  exitPaywall();
  return true;
}

function markPaywallExit() {
  try { root.sessionStorage.setItem(PAYWALL_EXIT_KEY, "1"); } catch (e) {}
}

function clearPaywallExit() {
  try { root.sessionStorage.removeItem(PAYWALL_EXIT_KEY); } catch (e) {}
}

function hasPaywallExit() {
  try { return root.sessionStorage.getItem(PAYWALL_EXIT_KEY) === "1"; }
  catch (e) { return false; }
}

function goToAuthEntry() {
  hideAppTabbar();
  var modal = document.getElementById("authModal");
  if (modal && modal.style) modal.style.display = "none";
  if (typeof root.rememberAppEntryIntent === "function") {
    root.rememberAppEntryIntent("entry");
  }
  if (typeof root.resetAiSignupWelcome === "function") root.resetAiSignupWelcome();
  if (typeof root.showScreen === "function") root.showScreen("screen-welcome");
  try { root.history.replaceState({ athlevoNav: "entry" }, ""); } catch (e) {}
}

function exitPaywall() {
  markPaywallExit();
  goToAuthEntry();
}

async function switchAccount() {
  clearPaywallExit();
  if (typeof root.clearAiSignupHandoff === "function") root.clearAiSignupHandoff();
  if (typeof root.doLogout === "function") {
    await root.doLogout();
    return true;
  }
  goToAuthEntry();
  return true;
}

async function sessionUserId() {
  if (root.athlevoSessionUserId) return root.athlevoSessionUserId;
  try {
    var supabase = acquisitionSupabase || root.supabaseClient;
    if (!supabase || !supabase.auth || typeof supabase.auth.getSession !== "function") {
      return null;
    }
    var result = await supabase.auth.getSession();
    var user = result && result.data && result.data.session && result.data.session.user;
    return user && user.id ? user.id : null;
  } catch (e) {
    return null;
  }
}

function showPaywall(state, unavailable, opts) {
  opts = opts || {};
  clearPaywallExit();
  hideAppTabbar();
  if (typeof root.showScreen === "function") root.showScreen("screen-diagnostic-paywall");
  var limiter = document.getElementById("diagnosticPaywallLimiter");
  var status = document.getElementById("diagnosticPaywallStatus");
  var card = document.getElementById("diagnosticPaywallCard");
  if (limiter) limiter.textContent = limiterLabel(state && state.primaryLimiter);
  /* unavailable=true is for real access/session failures only. A failed
     diagnostic import must never hide checkout CTAs. */
  setPaywallMode(unavailable === true ? "unavailable" : "checkout");
  if (card) card.classList.toggle("is-unavailable", unavailable === true);
  selectOfferPlan("monthly");
  showOfferStep();
  if (status) {
    if (unavailable === true) {
      status.textContent = "Payment is temporarily unavailable. Check your connection and try again.";
    } else if (opts.importDeferred) {
      status.textContent = "We'll finish importing your training details after setup.";
    } else {
      status.textContent = "";
    }
  }
  if (state && !unavailable) {
    trackOnce("payment_screen_viewed", state, {
      source: "ai_signup",
      price_php: offerPlanCopy(selectedOfferPlan).pricePhp,
      plan: "athlevo_ai"
    });
  }
}

function showActivation(state) {
  hideAppTabbar();
  if (typeof root.showScreen === "function") root.showScreen("screen-diagnostic-paywall");
  var limiter = document.getElementById("diagnosticPaywallLimiter");
  var status = document.getElementById("diagnosticPaywallStatus");
  if (limiter) limiter.textContent = limiterLabel(state && state.primaryLimiter);
  setPaywallMode("activating");
  if (status) status.textContent = "";
}

function showRecheck(state) {
  hideAppTabbar();
  if (typeof root.showScreen === "function") root.showScreen("screen-diagnostic-paywall");
  var limiter = document.getElementById("diagnosticPaywallLimiter");
  var status = document.getElementById("diagnosticPaywallStatus");
  if (limiter) limiter.textContent = limiterLabel(state && state.primaryLimiter);
  setPaywallMode("recheck");
  if (status) status.textContent = "";
}

async function checkout(method) {
  if (checkoutInFlight) return false;
  if (selectedOfferPlan === "annual" && !ANNUAL_CHECKOUT_READY) {
    setPaywallStatus("Annual checkout is not available yet. Choose Monthly to start now.");
    showOfferStep();
    return false;
  }
  var userId = await sessionUserId();
  if (userId) root.athlevoSessionUserId = userId;
  if (!userId) {
    setPaywallStatus("Sign in to continue to payment.");
    goToAuthEntry();
    if (typeof root.openLogin === "function") root.openLogin(true);
    return false;
  }
  if (!root.AthlevoAccessGuard) {
    setPaywallStatus("Payment is temporarily unavailable. Try again.");
    return false;
  }
  var state = currentForUser(userId) || bindAcquisitionUser(userId);
  var previous = state && state.stage;
  checkoutInFlight = true;
  setPaywallBusy(true);
  setPaywallStatus(method === "local"
    ? "Opening local checkout…"
    : "Opening secure checkout…");
  try {
    await setStage(state, "checkout_started", acquisitionSupabase);
    var context = {
      feature: "trends",
      surface: "diagnostic",
      source: "ai_signup"
    };
    var opened = method === "local"
      ? await root.AthlevoAccessGuard.checkoutLocal(context)
      : await root.AthlevoAccessGuard.checkout(context);
    if (!opened) {
      await setStage(state, previous || "awaiting_payment", acquisitionSupabase);
      setPaywallStatus(method === "local"
        ? "Local payment is unavailable right now. Card payment still works."
        : "Checkout could not be opened. Try again.");
      return false;
    }
    setPaywallStatus("");
    return true;
  } catch (error) {
    await setStage(state, previous || "awaiting_payment", acquisitionSupabase);
    setPaywallStatus("Checkout could not be opened. Try again.");
    return false;
  } finally {
    checkoutInFlight = false;
    setPaywallBusy(false);
  }
}

async function retryPendingDiagnosticAttach(userId, supabase, previous) {
  if (previous && previous.attached) return previous;
  var pending = false;
  try {
    pending = !!(root.AthlevoDiagnostic &&
      typeof root.AthlevoDiagnostic.hasPending === "function" &&
      root.AthlevoDiagnostic.hasPending());
  } catch (e) { pending = false; }
  if (!pending) return previous || null;
  if (!root.AthlevoDiagnosticHandoff ||
      typeof root.AthlevoDiagnosticHandoff.attach !== "function") {
    return previous || null;
  }
  try {
    return await root.AthlevoDiagnosticHandoff.attach(userId, supabase);
  } catch (error) {
    console.warn("Diagnostic handoff retry failed (non-fatal):", error);
    return previous || {
      attached: false,
      error: error && error.message ? error.message : "Diagnostic import failed"
    };
  }
}

function bindAcquisitionUser(userId) {
  var state = currentForUser(userId) || readLocal() || { events: {} };
  if (state.userId && userId && state.userId !== userId) {
    state = {
      events: {},
      importKey: state.importKey || null,
      primaryLimiter: state.primaryLimiter || null
    };
  }
  state.userId = userId;
  if (!state.stage || state.stage === "diagnostic_completed") state.stage = "awaiting_payment";
  return writeLocal(state);
}

function isAcquisitionGated(userId, attachOutcome, profile, fromAiSignup) {
  if (attachOutcome && (attachOutcome.attached || attachOutcome.error)) return true;
  var local = currentForUser(userId);
  if (local && local.stage && local.stage !== "completed") return true;
  try {
    if (root.AthlevoDiagnostic && typeof root.AthlevoDiagnostic.hasPending === "function" &&
        root.AthlevoDiagnostic.hasPending()) return true;
  } catch (e) {}
  // All /ai-signup accounts are paid-first, including returning unpaid
  // users whose onboarding is already complete. Authentication is not access.
  if (fromAiSignup) return true;
  return false;
}

async function resolveAfterAuth(userId, supabase, attachOutcome, profile, routeOpts) {
  acquisitionSupabase = supabase;
  var fromAiSignup = !!(routeOpts && routeOpts.fromAiSignup);
  var returningFromCheckout = hasCheckoutReturn();

  var paid = await verifiedPaidAccess(supabase, userId);
  if (paid.paid) {
    clearPaywallExit();
    if (returningFromCheckout) trackCheckoutReturnViewed("paid", paid.provider);
    markPaymentCompleted(userId, paid);
    attachOutcome = await retryPendingDiagnosticAttach(userId, supabase, attachOutcome);
    clearCheckoutReturn();
    var paidLocal = currentForUser(userId);
    if (attachOutcome && attachOutcome.attached) {
      paidLocal = markImported(userId, attachOutcome);
    }
    if (paidLocal && paidLocal.stage !== "completed") {
      await setStage(paidLocal, "completed", supabase);
    } else if (attachOutcome && attachOutcome.attached && attachOutcome.importKey &&
        root.AthlevoDiagnosticHandoff && root.AthlevoDiagnosticHandoff.setAcquisitionStage) {
      await root.AthlevoDiagnosticHandoff.setAcquisitionStage(
        userId, attachOutcome.importKey, "completed", supabase
      );
      clearLocal();
    }
    if (profile && profile.onboarding_complete === true) {
      return { handled: false, route: "app", acquisition: true, paid: true };
    }
    return { handled: true, route: "onboarding", acquisition: true, paid: true };
  }

  var gated = isAcquisitionGated(userId, attachOutcome, profile, fromAiSignup);
  var local = currentForUser(userId);
  if (attachOutcome && attachOutcome.attached) local = markImported(userId, attachOutcome);

  var loaded = { data: null, error: null };
  if (root.AthlevoDiagnosticHandoff &&
      typeof root.AthlevoDiagnosticHandoff.loadAcquisition === "function") {
    loaded = await root.AthlevoDiagnosticHandoff.loadAcquisition(userId, supabase);
  }
  /* Diagnostic import is not a checkout prerequisite. A missing or failed
     athlete_diagnostics row still shows authenticated payment. */
  if (!loaded.data) {
    if (local || gated) {
      if (returningFromCheckout) trackCheckoutReturnViewed("unpaid");
      showPaywall(bindAcquisitionUser(userId), false, {
        importDeferred: !!(loaded.error || (attachOutcome && attachOutcome.error))
      });
      return { handled: true, route: "paywall" };
    }
    return { handled: false, route: "existing" };
  }

  var state = local || { events: {} };
  state.userId = userId;
  state.importKey = loaded.data.import_key;
  state.primaryLimiter = loaded.data.primary_limiter || state.primaryLimiter || null;
  state.stage = loaded.data.acquisition_stage;
  writeLocal(state);

  if (!paid.paid && !paid.unavailable && hasCheckoutReturn()) {
    showActivation(state);
    for (var attempt = 0; attempt < 4 && !paid.paid; attempt += 1) {
      await wait(1500);
      paid = await verifiedPaidAccess(supabase, userId);
      if (paid.unavailable) break;
    }
  }
  if (paid.unavailable) {
    if (returningFromCheckout) trackCheckoutReturnViewed("unpaid");
    showPaywall(state, true);
    return { handled: true, route: "access_unavailable" };
  }
  if (!paid.paid) {
    if (hasCheckoutReturn()) {
      trackCheckoutReturnViewed("activating");
      showRecheck(state);
      return { handled: true, route: "activating" };
    }
    showPaywall(state, false);
    return { handled: true, route: "paywall" };
  }

  if (returningFromCheckout) trackCheckoutReturnViewed("paid", paid.provider);
  markPaymentCompleted(userId, paid);
  clearCheckoutReturn();

  if (state.stage !== "payment_confirmed" && state.stage !== "onboarding" && state.stage !== "completed") {
    await setStage(state, "payment_confirmed", supabase);
    trackOnce("access_confirmed", state, { source_surface: "diagnostic_paywall" });
  }
  if (profile && profile.onboarding_complete === true) {
    await setStage(state, "completed", supabase);
    return { handled: false, route: "app", acquisition: true };
  }
  await setStage(state, "onboarding", supabase);
  return { handled: true, route: "onboarding", acquisition: true };
}

function isPostPaymentOnboarding(userId) {
  var state = currentForUser(userId);
  return !!state && (state.stage === "payment_confirmed" || state.stage === "onboarding");
}

async function recheckEntitlement() {
  var userId = root.athlevoSessionUserId;
  if (!userId || !acquisitionSupabase) {
    showRecheck(active || readLocal());
    return { paid: false, route: "activating" };
  }
  showActivation(active || readLocal());
  var paid = await verifiedPaidAccess(acquisitionSupabase, userId);
  if (!paid.paid && !paid.unavailable) {
    for (var attempt = 0; attempt < 3 && !paid.paid; attempt += 1) {
      await wait(1500);
      paid = await verifiedPaidAccess(acquisitionSupabase, userId);
      if (paid.unavailable) break;
    }
  }
  if (paid.paid) {
    markPaymentCompleted(userId, paid);
    if (typeof root.routeAfterAuth === "function") {
      await root.routeAfterAuth(userId);
    }
    return { paid: true, route: "app" };
  }
  if (paid.unavailable) {
    showPaywall(active || readLocal(), true);
    return { paid: false, route: "access_unavailable" };
  }
  showRecheck(active || readLocal());
  return { paid: false, route: "activating" };
}

async function completePostPaymentOnboarding(supabase) {
  var state = active || readLocal();
  if (!state || !state.userId) return false;
  trackOnce("post_payment_onboarding_completed", state, { source_surface: "post_payment_onboarding" });
  await setStage(state, "completed", supabase);
  return true;
}

function markOnboardingStarted() {
  var state = active || readLocal();
  if (!state) return;
  trackOnce("post_payment_onboarding_started", state, { source_surface: "post_payment_onboarding" });
}

function markAppEntered() {
  var state = active || readLocal();
  if (!state || state.stage !== "completed") return;
  trackOnce("app_entered", state, { source_surface: "diagnostic" });
  clearLocal();
}

root.AthlevoDiagnosticAcquisition = {
  markDiagnosticCompleted: markDiagnosticCompleted,
  markPaymentCompleted: markPaymentCompleted,
  bindAcquisitionUser: bindAcquisitionUser,
  resolveAfterAuth: resolveAfterAuth,
  reconcileWhopPurchase: reconcileWhopPurchase,
  verifiedPaidAccess: verifiedPaidAccess,
  gateUnpaidAthlete: gateUnpaidAthlete,
  isDiagnosticAcquisition: isDiagnosticAcquisition,
  isAcquisitionGated: isAcquisitionGated,
  isPostPaymentOnboarding: isPostPaymentOnboarding,
  markOnboardingStarted: markOnboardingStarted,
  completePostPaymentOnboarding: completePostPaymentOnboarding,
  markAppEntered: markAppEntered,
  checkout: checkout,
  selectOfferPlan: selectOfferPlan,
  beginOfferCheckout: beginOfferCheckout,
  showOfferStep: showOfferStep,
  backFromPaywall: backFromPaywall,
  showPaywall: showPaywall,
  showActivation: showActivation,
  showRecheck: showRecheck,
  recheckEntitlement: recheckEntitlement,
  exitPaywall: exitPaywall,
  switchAccount: switchAccount,
  hasPaywallExit: hasPaywallExit,
  clearPaywallExit: clearPaywallExit,
  hasCheckoutReturn: hasCheckoutReturn,
  trackCheckoutReturnViewed: trackCheckoutReturnViewed,
  current: function () { return active || readLocal(); },
  clear: clearLocal
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    markDiagnosticCompleted: markDiagnosticCompleted,
    markPaymentCompleted: markPaymentCompleted,
    verifiedPaidAccess: verifiedPaidAccess,
    gateUnpaidAthlete: gateUnpaidAthlete,
    isDiagnosticAcquisition: isDiagnosticAcquisition,
    limiterLabel: limiterLabel,
    currentForUser: currentForUser,
    isAcquisitionGated: isAcquisitionGated
  };
}
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

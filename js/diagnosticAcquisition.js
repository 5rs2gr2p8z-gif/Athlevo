/* Athlevo — durable paid-first acquisition routing for completed diagnostics. */
(function (root) {
"use strict";

var STORAGE_KEY = "athlevo_diagnostic_acquisition_v1";
var TTL_MS = 30 * 24 * 60 * 60 * 1000;
var PAID_PROVIDERS = ["whop", "paymongo", "gcash_manual"];
var active = null;
var acquisitionSupabase = null;

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
  trackOnce("signup_completed", state, { source_surface: "diagnostic" });
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
    entitlement: entitlement
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
  if (!card || !card.classList) return;
  card.classList.remove("is-activating", "is-recheck", "is-unavailable");
  if (mode === "activating") card.classList.add("is-activating");
  else if (mode === "recheck") card.classList.add("is-recheck");
  else if (mode === "unavailable") card.classList.add("is-unavailable");
}

function showPaywall(state, unavailable) {
  if (typeof root.showScreen === "function") root.showScreen("screen-diagnostic-paywall");
  var limiter = document.getElementById("diagnosticPaywallLimiter");
  var status = document.getElementById("diagnosticPaywallStatus");
  var card = document.getElementById("diagnosticPaywallCard");
  if (limiter) limiter.textContent = limiterLabel(state && state.primaryLimiter);
  setPaywallMode(unavailable === true ? "unavailable" : "checkout");
  if (card) card.classList.toggle("is-unavailable", unavailable === true);
  if (status) status.textContent = unavailable
    ? "We couldn't save your diagnostic yet. Check your connection and try again before continuing."
    : "";
  if (state && !unavailable) {
    trackOnce("paywall_viewed", state, {
      source_surface: "diagnostic_paywall",
      primary_limiter: state.primaryLimiter || null
    });
  }
}

function showActivation(state) {
  if (typeof root.showScreen === "function") root.showScreen("screen-diagnostic-paywall");
  var limiter = document.getElementById("diagnosticPaywallLimiter");
  var status = document.getElementById("diagnosticPaywallStatus");
  if (limiter) limiter.textContent = limiterLabel(state && state.primaryLimiter);
  setPaywallMode("activating");
  if (status) status.textContent = "";
}

function showRecheck(state) {
  if (typeof root.showScreen === "function") root.showScreen("screen-diagnostic-paywall");
  var limiter = document.getElementById("diagnosticPaywallLimiter");
  var status = document.getElementById("diagnosticPaywallStatus");
  if (limiter) limiter.textContent = limiterLabel(state && state.primaryLimiter);
  setPaywallMode("recheck");
  if (status) status.textContent = "";
}

async function checkout(method) {
  if (!root.athlevoSessionUserId) {
    if (typeof root.openAiSignup === "function") {
      root.openAiSignup();
      return true;
    }
    return false;
  }
  var state = active || readLocal();
  if (!state || !root.AthlevoAccessGuard) return false;
  var previous = state.stage;
  await setStage(state, "checkout_started", acquisitionSupabase);
  trackOnce("checkout_started", state, {
    source_surface: "diagnostic_paywall",
    method: method || "card"
  });
  var context = { feature: "trends", surface: "diagnostic" };
  var opened = method === "local"
    ? await root.AthlevoAccessGuard.checkoutLocal(context)
    : await root.AthlevoAccessGuard.checkout(context);
  if (!opened) await setStage(state, previous || "awaiting_payment", acquisitionSupabase);
  return opened;
}

async function resolveAfterAuth(userId, supabase, attachOutcome, profile) {
  acquisitionSupabase = supabase;

  var paid = await verifiedPaidAccess(supabase, userId);
  if (paid.paid) {
    clearCheckoutReturn();
    var paidLocal = currentForUser(userId);
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

  var local = currentForUser(userId);
  if (attachOutcome && attachOutcome.attached) local = markImported(userId, attachOutcome);
  if (local && attachOutcome && attachOutcome.error) {
    showPaywall(local, true);
    return { handled: true, route: "import_unavailable" };
  }

  var loaded = await root.AthlevoDiagnosticHandoff.loadAcquisition(userId, supabase);
  if (loaded.error) {
    if (local) {
      showPaywall(local, true);
      return { handled: true, route: "import_unavailable" };
    }
    return { handled: false, route: "existing" };
  }
  if (!loaded.data) return { handled: false, route: "existing" };

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
    showPaywall(state, true);
    return { handled: true, route: "access_unavailable" };
  }
  if (!paid.paid) {
    if (hasCheckoutReturn()) {
      showRecheck(state);
      return { handled: true, route: "activating" };
    }
    showPaywall(state, false);
    return { handled: true, route: "paywall" };
  }

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
  resolveAfterAuth: resolveAfterAuth,
  reconcileWhopPurchase: reconcileWhopPurchase,
  verifiedPaidAccess: verifiedPaidAccess,
  isDiagnosticAcquisition: isDiagnosticAcquisition,
  isPostPaymentOnboarding: isPostPaymentOnboarding,
  markOnboardingStarted: markOnboardingStarted,
  completePostPaymentOnboarding: completePostPaymentOnboarding,
  markAppEntered: markAppEntered,
  checkout: checkout,
  showPaywall: showPaywall,
  showActivation: showActivation,
  showRecheck: showRecheck,
  recheckEntitlement: recheckEntitlement,
  hasCheckoutReturn: hasCheckoutReturn,
  current: function () { return active || readLocal(); },
  clear: clearLocal
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    markDiagnosticCompleted: markDiagnosticCompleted,
    verifiedPaidAccess: verifiedPaidAccess,
    isDiagnosticAcquisition: isDiagnosticAcquisition,
    limiterLabel: limiterLabel,
    currentForUser: currentForUser
  };
}
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Access Guard  (navigation entitlement gates)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Freemium navigation and paid-feature upgrade entry point. Coach history,
 *  Train/calendar, and basic Trends remain open; server APIs enforce free AI
 *  limits and paid-only mutations.
 *
 *  Source of truth: AthlevoPlan.entitlement() — the same subscription
 *  system the paywall and server endpoints trust.
 *
 *  Does NOT touch: Today tab, You tab, plan setup, onboarding, or any
 *  existing premium-user flow.
 */
(function () {
  "use strict";

  const WHOP_CHECKOUT_URL = "https://whop.com/checkout/plan_F5PftzWCJCQVw";
  const PREMIUM_FEATURES = new Set([
    "training_load", "recovery", "athlevo_score", "trends", "coach_message"
  ]);
  const PREMIUM_SURFACES = new Set([
    "today", "trends", "coach", "upgrade_sheet"
  ]);
  const PREMIUM_SCREEN_IDS = {
    today: "screen-today",
    trends: "screen-trends"
  };
  const PREMIUM_IMPRESSION_PREFIX = "athlevo_premium_impression_v1:";
  const observedPremiumTargets = new Map();
  const pendingPremiumChecks = new Set();
  const fallbackViewedThisPage = new Set();
  let premiumObserver = null;
  let premiumRefreshQueued = false;
  let upgradeContext = { feature: "trends", surface: "upgrade_sheet" };
  let restoreFocusTo = null;
  const DEFAULT_UPGRADE_COPY = Object.freeze({
    title: "Upgrade to Athlevo Performance",
    body: "",
    primary: "Continue",
    secondary: "Not now",
    hideBenefits: false
  });

  /* ─────────────── entitlement helpers ───────────────────────────── */

  /*
   * Check whether the current user has verified Whop paid entitlement.
   * Uses the already-loaded subscription from features.js — no extra
   * network call if AthlevoPlan is already loaded.
   */
  function cachedAccessState() {
    if (!window.AthlevoPlan ||
        typeof window.AthlevoPlan.isLoaded !== "function" ||
        window.AthlevoPlan.isLoaded() !== true) {
      return "unknown";
    }
    try {
      if (typeof window.AthlevoPlan.entitlement === "function") {
        const ent = window.AthlevoPlan.entitlement();
        const state = ent && ent.accessState;
        if (state === "paid_active" || state === "paid_inactive" || state === "free") {
          return state;
        }
      }
    } catch (e) {}
    return "unknown";
  }

  async function accessState() {
    if (!window.AthlevoPlan) return "unknown";
    try {
      if (cachedAccessState() === "unknown" &&
          typeof window.AthlevoPlan.load === "function") {
        await window.AthlevoPlan.load();
      }
      const state = cachedAccessState();
      return state;
    } catch (e) {
      return "unknown";
    }
  }

  async function hasPaidAccess() {
    return (await accessState()) === "paid_active";
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ─────────────── locked screen templates ───────────────────────── */

  const UPGRADE_CTA_HTML = `
    <div class="ag-cta">
      <div class="ag-cta-badge">Athlevo Performance</div>
      <p class="ag-cta-text">Unlock adaptive plan changes, deeper analysis, Daily Brief, and the full paid Coach allowance.</p>
      <button class="ag-cta-btn" type="button" onclick="AthlevoAccessGuard.checkout()">Upgrade to Athlevo Performance</button>
      <p class="ag-cta-sub">₱597/month · Cancel anytime</p>
    </div>`;

  function lockedCoachHTML() {
    return `
      <div class="ag-locked">
        <div class="ag-locked-header">
          <div class="ag-icon">💬</div>
          <h2 class="ag-title serif">AI Coach</h2>
          <p class="ag-desc">Your personal running coach, available 24/7. Ask about your training, get workout modifications, and receive coaching decisions based on your data.</p>
        </div>
        <div class="ag-sample">
          <div class="ag-sample-label">Sample coaching interaction</div>
          <div class="ag-chat-preview">
            <div class="ag-chat-msg ag-chat-user">
              <span class="ag-chat-role">You</span>
              <p>My calves are tight from yesterday's tempo. Should I still do intervals today?</p>
            </div>
            <div class="ag-chat-msg ag-chat-coach">
              <span class="ag-chat-role">Athlevo Coach</span>
              <p>Drop the intervals. Your calves need 24–48 hours after yesterday's tempo load. Replace with 35 minutes easy — <b>conversation pace, no exceptions</b>. Thursday's session is the priority this week; protecting it is worth more than today's intervals.</p>
            </div>
          </div>
        </div>
        ${UPGRADE_CTA_HTML}
      </div>`;
  }

  function lockedTrainHTML() {
    return `
      <div class="ag-locked">
        <div class="ag-locked-header">
          <div class="ag-icon">📅</div>
          <h2 class="ag-title serif">Training Plan</h2>
          <p class="ag-desc">Your personalized, adaptive training week. Built from your profile, updated as you train.</p>
        </div>
        <div class="ag-sample">
          <div class="ag-sample-label">Sample training week</div>
          <div class="ag-week-preview">
            <div class="ag-day"><span class="ag-day-name">Mon</span><span class="ag-day-type easy">Easy Run</span><span class="ag-day-detail">35 min · conversation pace</span></div>
            <div class="ag-day"><span class="ag-day-name">Tue</span><span class="ag-day-type rest">Rest</span><span class="ag-day-detail">Recovery day</span></div>
            <div class="ag-day"><span class="ag-day-name">Wed</span><span class="ag-day-type tempo">Tempo</span><span class="ag-day-detail">10 min easy + 20 min tempo + 10 min easy</span></div>
            <div class="ag-day"><span class="ag-day-name">Thu</span><span class="ag-day-type easy">Easy Run</span><span class="ag-day-detail">30 min · aerobic</span></div>
            <div class="ag-day"><span class="ag-day-name">Fri</span><span class="ag-day-type rest">Rest</span><span class="ag-day-detail">Recovery day</span></div>
            <div class="ag-day"><span class="ag-day-name">Sat</span><span class="ag-day-type long">Long Run</span><span class="ag-day-detail">60 min · easy effort</span></div>
            <div class="ag-day"><span class="ag-day-name">Sun</span><span class="ag-day-type rest">Rest</span><span class="ag-day-detail">Full recovery</span></div>
          </div>
        </div>
        ${UPGRADE_CTA_HTML}
      </div>`;
  }

  function lockedTrendsHTML() {
    return `
      <div class="ag-locked">
        <div class="ag-locked-header">
          <div class="ag-icon">📈</div>
          <h2 class="ag-title serif">Trends</h2>
          <p class="ag-desc">Track your training volume, intensity distribution, and fitness progression week over week.</p>
        </div>
        <div class="ag-sample">
          <div class="ag-sample-label">What you'll see</div>
          <div class="ag-trends-preview">
            <div class="ag-trend-item">
              <span class="ag-trend-label">Weekly volume</span>
              <div class="ag-trend-bar-wrap"><div class="ag-trend-bar" style="width:60%"></div></div>
              <span class="ag-trend-val">32 km</span>
            </div>
            <div class="ag-trend-item">
              <span class="ag-trend-label">Easy / Hard split</span>
              <div class="ag-trend-bar-wrap"><div class="ag-trend-bar easy" style="width:78%"></div><div class="ag-trend-bar hard" style="width:22%"></div></div>
              <span class="ag-trend-val">78 / 22%</span>
            </div>
            <div class="ag-trend-item">
              <span class="ag-trend-label">Fitness trend</span>
              <div class="ag-trend-bar-wrap"><div class="ag-trend-bar rising" style="width:45%"></div></div>
              <span class="ag-trend-val">↗ Building</span>
            </div>
          </div>
        </div>
        ${UPGRADE_CTA_HTML}
      </div>`;
  }

  /* ─────────────── guard logic ───────────────────────────────────── */

  const FREE_TABS = new Set([
    "screen-coachai",
    "screen-train",
    "screen-trends"
  ]);

  async function guardTab(screenId) {
    if (!FREE_TABS.has(screenId)) return false;
    await accessState();
    if (screenId === "screen-trends" &&
        window.AthlevoTrendsAnalytics &&
        typeof window.AthlevoTrendsAnalytics.refresh === "function") {
      await window.AthlevoTrendsAnalytics.refresh();
    }
    return false;
  }

  function renderLockedScreen(screenId, html) {
    const screen = document.getElementById(screenId);
    if (!screen) return;

    // Find or create a locked overlay container within the screen.
    let overlay = screen.querySelector(".ag-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ag-overlay";
      screen.appendChild(overlay);
    }
    overlay.innerHTML = html;
    overlay.style.display = "block";

    // Hide the real content behind the overlay.
    Array.from(screen.children).forEach(child => {
      if (child !== overlay) child.style.display = "none";
    });
  }

  /*
   * Restore the real screen content (called when a user gains access,
   * e.g. after completing checkout).
   */
  function removeLockedOverlay(screenId) {
    const screen = document.getElementById(screenId);
    if (!screen) return;
    const overlay = screen.querySelector(".ag-overlay");
    if (overlay) {
      overlay.style.display = "none";
      overlay.innerHTML = "";
    }
    Array.from(screen.children).forEach(child => {
      if (child !== overlay) child.style.display = "";
    });
  }

  /* ─────────────── actions ───────────────────────────────────────── */

  function checkoutUrl() {
    let url = WHOP_CHECKOUT_URL;
    try {
      const returnUrl = new URL(window.location.pathname, window.location.origin);
      returnUrl.searchParams.set("checkout_return", "1");
      const separator = url.includes("?") ? "&" : "?";
      url += separator + "redirect_url=" + encodeURIComponent(returnUrl.toString());
    } catch (e) {}
    return url;
  }

  function categoricalContext(context, surfaceFallback) {
    const input = context && typeof context === "object" ? context : {};
    const feature = PREMIUM_FEATURES.has(input.feature) ? input.feature : null;
    const surface = PREMIUM_SURFACES.has(input.surface)
      ? input.surface
      : surfaceFallback;
    const tier = input.access_tier === "free" ||
      input.access_tier === "paid_active" ||
      input.access_tier === "paid_inactive" ||
      input.access_tier === "unknown"
      ? input.access_tier
      : null;
    return { feature, surface, access_tier: tier };
  }

  function trackCategorical(name, context) {
    const safe = categoricalContext(context, "upgrade_sheet");
    const props = name === "checkout_failed"
      ? {
          stage: "checkout_open",
          failure_category:
            context && context.failure_category === "popup_blocked"
              ? "popup_blocked"
              : "browser",
          source_surface: "upgrade_sheet"
        }
      : { surface: safe.surface };
    if (name !== "checkout_failed" && safe.feature) {
      props.feature = safe.feature;
    }
    if (name !== "checkout_failed" && safe.access_tier) {
      props.access_tier = safe.access_tier;
    }
    try {
      if (window.AthlevoAnalytics) {
        window.AthlevoAnalytics.track(name, props);
      }
    } catch (e) {}
    try {
      if (window.AthlevoProductAnalytics) {
        window.AthlevoProductAnalytics.trackAthlevoEvent(name, props);
      }
    } catch (e) {}
  }

  function publicOrAuthSurfaceActive() {
    const landing = document.getElementById("screen-landing");
    const welcome = document.getElementById("screen-welcome");
    const auth = document.getElementById("authModal");
    if (landing && landing.classList.contains("active")) return true;
    if (welcome && welcome.classList.contains("active")) return true;
    if (auth) {
      const inlineOpen = auth.style && auth.style.display &&
        auth.style.display !== "none";
      const ariaOpen = auth.getAttribute &&
        auth.getAttribute("aria-hidden") === "false";
      if (inlineOpen || ariaOpen) return true;
    }
    return false;
  }

  function activeSurfaceMatches(surface) {
    if (publicOrAuthSurfaceActive()) return false;
    if (surface === "upgrade_sheet") {
      const modal = document.getElementById("performanceUpgradeModal");
      return Boolean(
        modal &&
        modal.classList.contains("show") &&
        modal.getAttribute("aria-hidden") === "false"
      );
    }
    const screenId = PREMIUM_SCREEN_IDS[surface];
    const screen = screenId ? document.getElementById(screenId) : null;
    return Boolean(screen && screen.classList.contains("active"));
  }

  function elementIsVisible(target, observerEntry) {
    if (!target || target.isConnected === false || target.hidden === true) {
      return false;
    }
    if (observerEntry && (
      observerEntry.isIntersecting !== true ||
      Number(observerEntry.intersectionRatio) <= 0
    )) {
      return false;
    }
    try {
      if (typeof target.closest === "function" &&
          target.closest('[hidden],[aria-hidden="true"]')) {
        return false;
      }
    } catch (e) {}
    try {
      if (typeof window.getComputedStyle === "function") {
        const style = window.getComputedStyle(target);
        if (!style ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0) {
          return false;
        }
      }
    } catch (e) {}
    if (!observerEntry && typeof target.getBoundingClientRect === "function") {
      const rect = target.getBoundingClientRect();
      const viewportWidth = window.innerWidth ||
        (document.documentElement && document.documentElement.clientWidth) || 0;
      const viewportHeight = window.innerHeight ||
        (document.documentElement && document.documentElement.clientHeight) || 0;
      if (!rect || rect.width <= 0 || rect.height <= 0 ||
          rect.bottom <= 0 || rect.right <= 0 ||
          rect.top >= viewportHeight || rect.left >= viewportWidth) {
        return false;
      }
    }
    return true;
  }

  async function authenticatedUserId() {
    try {
      if (typeof supabaseClient === "undefined" ||
          !supabaseClient.auth ||
          typeof supabaseClient.auth.getUser !== "function") {
        return null;
      }
      const result = await supabaseClient.auth.getUser();
      if (result && result.error) return null;
      const user = result && result.data && result.data.user;
      return user && typeof user.id === "string" && user.id
        ? user.id
        : null;
    } catch (e) {
      return null;
    }
  }

  function premiumSessionKey(userId, safe) {
    const scope = [userId, safe.feature, safe.surface]
      .map(value => String(value || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80))
      .join(":");
    return PREMIUM_IMPRESSION_PREFIX + scope;
  }

  function impressionAlreadyFired(key) {
    if (fallbackViewedThisPage.has(key)) return true;
    try { return sessionStorage.getItem(key) === "1"; }
    catch (e) { return false; }
  }

  function rememberImpression(key) {
    fallbackViewedThisPage.add(key);
    try { sessionStorage.setItem(key, "1"); } catch (e) {}
  }

  function impressionPrerequisites(target, safe, observerEntry) {
    if (document.visibilityState !== "visible") return false;
    if (!activeSurfaceMatches(safe.surface)) return false;
    if (!elementIsVisible(target, observerEntry)) return false;
    const state = cachedAccessState();
    return state === "free" || state === "paid_inactive";
  }

  async function confirmPremiumImpression(target, safe, observerEntry) {
    const pendingKey = `${safe.feature}:${safe.surface}`;
    if (pendingPremiumChecks.has(pendingKey)) return false;
    if (!impressionPrerequisites(target, safe, observerEntry)) return false;
    pendingPremiumChecks.add(pendingKey);
    try {
      const userId = await authenticatedUserId();
      if (!userId) return false;
      // Authentication can resolve after a navigation or entitlement change.
      // Re-check against the element's current viewport position rather than
      // trusting an observer entry that may already be stale.
      if (!impressionPrerequisites(target, safe, null)) return false;
      const key = premiumSessionKey(userId, safe);
      if (impressionAlreadyFired(key)) return false;
      trackCategorical("premium_feature_viewed", safe);
      rememberImpression(key);
      return true;
    } finally {
      pendingPremiumChecks.delete(pendingKey);
    }
  }

  function ensurePremiumObserver() {
    if (premiumObserver || typeof window.IntersectionObserver !== "function") {
      return premiumObserver;
    }
    premiumObserver = new window.IntersectionObserver(entries => {
      entries.forEach(entry => {
        const contexts = observedPremiumTargets.get(entry.target);
        if (!contexts) return;
        contexts.forEach(safe => {
          confirmPremiumImpression(entry.target, safe, entry).catch(() => {});
        });
      });
    }, { threshold: 0.01 });
    return premiumObserver;
  }

  function schedulePremiumTargetCheck(target, safe) {
    const run = () => {
      confirmPremiumImpression(target, safe, null).catch(() => {});
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else if (typeof window.setTimeout === "function") {
      window.setTimeout(run, 0);
    } else {
      Promise.resolve().then(run);
    }
  }

  /*
   * Registers a locked element for a real impression. Calling this from a
   * renderer is safe: no event is emitted until the element is authenticated,
   * entitled, on the active app screen, in a visible document, and in view.
   */
  function trackPremiumView(feature, surface, target) {
    const safe = categoricalContext({ feature, surface }, "today");
    if (!safe.feature || !target || typeof target !== "object") return false;
    let contexts = observedPremiumTargets.get(target);
    if (!contexts) {
      contexts = new Map();
      observedPremiumTargets.set(target, contexts);
    }
    const contextKey = `${safe.feature}:${safe.surface}`;
    contexts.set(contextKey, safe);
    const observer = ensurePremiumObserver();
    if (observer && typeof observer.observe === "function") {
      observer.observe(target);
    }
    schedulePremiumTargetCheck(target, safe);
    return true;
  }

  function refreshPremiumViews() {
    if (premiumRefreshQueued) return;
    premiumRefreshQueued = true;
    const run = () => {
      premiumRefreshQueued = false;
      observedPremiumTargets.forEach((contexts, target) => {
        if (!target || target.isConnected === false) {
          observedPremiumTargets.delete(target);
          try { if (premiumObserver) premiumObserver.unobserve(target); } catch (e) {}
          return;
        }
        contexts.forEach(safe => schedulePremiumTargetCheck(target, safe));
      });
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else if (typeof window.setTimeout === "function") {
      window.setTimeout(run, 0);
    } else {
      Promise.resolve().then(run);
    }
  }

  async function checkout(context) {
    const safe = categoricalContext(context, "upgrade_sheet");
    trackCategorical("upgrade_clicked", safe);
    try {
      let opened = null;
      if (window.AthlevoRuntime && window.AthlevoRuntime.openExternal) {
        opened = await window.AthlevoRuntime.openExternal(checkoutUrl());
        if (!opened || opened.ok !== true) {
          trackCategorical("checkout_failed", {
            surface: "upgrade_sheet",
            failure_category: "browser",
            stage: "checkout_open"
          });
          return false;
        }
      } else {
        opened = window.open(checkoutUrl(), "_blank", "noopener");
        if (!opened) {
          trackCategorical("checkout_failed", {
            surface: "upgrade_sheet",
            failure_category: "popup_blocked",
            stage: "checkout_open"
          });
          return false;
        }
      }
      trackCategorical("checkout_started", safe);
      return true;
    } catch (e) {
      trackCategorical("checkout_failed", {
        surface: "upgrade_sheet",
        failure_category: "browser",
        stage: "checkout_open"
      });
      return false;
    }
  }

  function setPaymentChoiceStatus(message, isError) {
    const status = document.getElementById("performancePaymentStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("is-error", isError === true);
  }

  async function sessionAccessToken() {
    if (typeof supabaseClient === "undefined" || !supabaseClient.auth ||
        typeof supabaseClient.auth.getSession !== "function") return null;
    const result = await supabaseClient.auth.getSession();
    return result && result.data && result.data.session &&
      result.data.session.access_token || null;
  }

  async function checkoutLocal(context) {
    const safe = categoricalContext(context, "upgrade_sheet");
    trackCategorical("upgrade_clicked", safe);
    const button = document.getElementById("performanceUpgradeLocal");
    if (button) button.disabled = true;
    setPaymentChoiceStatus("Opening secure local checkout…", false);
    try {
      const token = await sessionAccessToken();
      if (!token) throw new Error("auth");
      const response = await fetch("/api/paymongo/checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.checkout_url) throw new Error("checkout");
      const checkoutUrl = new URL(payload.checkout_url);
      if (checkoutUrl.protocol !== "https:" ||
          checkoutUrl.hostname.toLowerCase() !== "checkout.paymongo.com") {
        throw new Error("unsafe_checkout_url");
      }
      let opened = null;
      if (window.AthlevoRuntime && window.AthlevoRuntime.openExternal) {
        opened = await window.AthlevoRuntime.openExternal(checkoutUrl.toString());
        if (!opened || opened.ok !== true) throw new Error("browser");
      } else if (window.location && typeof window.location.assign === "function") {
        window.location.assign(checkoutUrl.toString());
      } else {
        window.location.href = checkoutUrl.toString();
      }
      trackCategorical("checkout_started", safe);
      return true;
    } catch (error) {
      setPaymentChoiceStatus("Local payment is unavailable right now. Card payment still works.", true);
      trackCategorical("checkout_failed", {
        surface: "upgrade_sheet",
        failure_category: "browser",
        stage: "checkout_open"
      });
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function focusableIn(modal) {
    if (!modal || typeof modal.querySelectorAll !== "function") return [];
    return Array.from(modal.querySelectorAll(
      'button:not([disabled]),a[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(node => !node.hidden);
  }

  function closeUpgradeSheet() {
    const modal = document.getElementById("performanceUpgradeModal");
    if (!modal) return;
    if (window.AthlevoSheet && window.AthlevoSheet.isOpen(modal)) {
      window.AthlevoSheet.close(modal, {
        onAfterClose: () => {
          modal.classList.remove("show");
          modal.setAttribute("aria-hidden", "true");
          restoreFocusTo = null;
          setPaymentChoiceStatus("", false);
        }
      });
      return;
    }
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function") {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
    setPaymentChoiceStatus("", false);
  }

  function onUpgradeKeydown(event) {
    const modal = document.getElementById("performanceUpgradeModal");
    if (!modal || !modal.classList.contains("show")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeUpgradeSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusableIn(modal);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function configureUpgradeSheet(copy) {
    const input = copy && typeof copy === "object" ? copy : {};
    const resolved = {
      title: input.title || DEFAULT_UPGRADE_COPY.title,
      body: input.body || DEFAULT_UPGRADE_COPY.body,
      // Both payment routes use the same concise action label; the surrounding
      // option copy identifies whether Continue means card or local payment.
      primary: DEFAULT_UPGRADE_COPY.primary,
      secondary: input.secondary || DEFAULT_UPGRADE_COPY.secondary,
      hideBenefits: input.hideBenefits === true
    };
    const title = document.getElementById("performanceUpgradeTitle");
    const body = document.getElementById("performanceUpgradeBody");
    const benefits = document.getElementById("performanceUpgradeBenefits");
    const primary = document.getElementById("performanceUpgradePrimary");
    const secondary = document.getElementById("performanceUpgradeSecondary");
    if (title) title.textContent = resolved.title;
    if (body) {
      body.textContent = resolved.body;
      body.hidden = !resolved.body;
    }
    if (benefits) benefits.hidden = resolved.hideBenefits;
    if (primary) primary.textContent = resolved.primary;
    if (secondary) secondary.textContent = resolved.secondary;
  }

  function showUpgradeSheet(feature, surface, copy) {
    const modal = document.getElementById("performanceUpgradeModal");
    if (!modal) return;
    const wasOpen = modal.classList.contains("show") &&
      modal.getAttribute("aria-hidden") === "false";
    const accessTier = cachedAccessState();
    const safe = categoricalContext({
      feature,
      surface,
      access_tier: accessTier
    }, "today");
    upgradeContext = {
      feature: safe.feature || "trends",
      surface: "upgrade_sheet"
    };
    configureUpgradeSheet(copy || DEFAULT_UPGRADE_COPY);
    restoreFocusTo = document.activeElement;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    if (window.AthlevoSheet) {
      window.AthlevoSheet.open({
        root: modal,
        sheet: ".performance-upgrade-sheet",
        draggable: false,
        initialFocus: "#performanceUpgradePrimary",
        fallbackFocus: "#tabbar .tab.on",
        onRequestClose: () => {
          closeUpgradeSheet();
          return false;
        }
      });
    }
    if (
      !wasOpen &&
      document.visibilityState === "visible" &&
      (accessTier === "free" || accessTier === "paid_inactive")
    ) {
      authenticatedUserId().then(userId => {
        const stillOpen = modal.classList.contains("show") &&
          modal.getAttribute("aria-hidden") === "false";
        if (
          userId &&
          stillOpen &&
          document.visibilityState === "visible" &&
          cachedAccessState() === accessTier
        ) {
          trackCategorical("upgrade_sheet_viewed", {
            feature: safe.feature,
            surface: "upgrade_sheet",
            access_tier: accessTier
          });
        }
      }).catch(() => {});
    }
    if (!window.AthlevoSheet && modal.dataset.focusBound !== "true") {
      modal.addEventListener("keydown", onUpgradeKeydown);
      modal.dataset.focusBound = "true";
    }
    if (!window.AthlevoSheet) {
      const nodes = focusableIn(modal);
      if (nodes.length && typeof nodes[0].focus === "function") nodes[0].focus();
    }
  }

  async function checkoutFromUpgrade() {
    await checkout(upgradeContext);
    closeUpgradeSheet();
  }

  async function checkoutLocalFromUpgrade() {
    const opened = await checkoutLocal(upgradeContext);
    if (opened) closeUpgradeSheet();
  }

  function paymentReturnNotice(message) {
    if (typeof window.toast === "function") window.toast(message);
  }

  function waitForPaymentRetry(delay) {
    return new Promise(resolve => window.setTimeout(resolve, delay));
  }

  async function paymentTransactionStatus(reference) {
    if (!reference || typeof supabaseClient === "undefined") return null;
    const result = await supabaseClient.from("payment_transactions")
      .select("status")
      .eq("reference_number", reference)
      .maybeSingle();
    return result && !result.error && result.data ? result.data.status : null;
  }

  async function confirmPaymongoReturn() {
    let url;
    try { url = new URL(window.location.href); } catch (error) { return; }
    const state = url.searchParams.get("paymongo_return");
    if (!state) return;
    const reference = url.searchParams.get("paymongo_reference");
    url.searchParams.delete("paymongo_return");
    url.searchParams.delete("paymongo_reference");
    try { window.history.replaceState({}, "", url.pathname + url.search + url.hash); } catch (error) {}
    if (state !== "success") {
      paymentReturnNotice("Payment was not completed.");
      return;
    }

    paymentReturnNotice("Payment received. Confirming access…");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await waitForPaymentRetry(1500);
      const status = await paymentTransactionStatus(reference);
      if (status === "paid") {
        if (window.AthlevoPlan && typeof window.AthlevoPlan.load === "function") {
          await window.AthlevoPlan.load();
        }
        if (cachedAccessState() === "paid_active") {
          unlockAll();
          refreshPremiumViews();
          paymentReturnNotice("Athlevo Performance access confirmed.");
          return;
        }
      }
    }
    paymentReturnNotice("Your payment is still being confirmed.");
  }

  /*
   * Called after a successful paid activation to remove all
   * locked overlays so tabs work normally going forward.
   */
  function unlockAll() {
    ["screen-coachai", "screen-train", "screen-trends"].forEach(removeLockedOverlay);
  }

  if (document && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshPremiumViews();
    });
  }

  confirmPaymongoReturn().catch(() => {
    paymentReturnNotice("Your payment is still being confirmed.");
  });

  /* ─────────────── trial countdown ────────────────────────────────── */

  let trialIndicatorTimer = null;

  function renderTrialIndicator() {
    if (!window.AthlevoPlan || typeof window.AthlevoPlan.entitlement !== "function") return;
    const ent = window.AthlevoPlan.entitlement();
    const existing = document.getElementById("athlevoTrialIndicator");

    if (!ent || !ent.isPerformanceTrial || !ent.trialExpiresAt) {
      if (existing) existing.remove();
      if (trialIndicatorTimer) { clearInterval(trialIndicatorTimer); trialIndicatorTimer = null; }
      return;
    }

    const expiresMs = new Date(ent.trialExpiresAt).getTime();
    const remainMs = Math.max(0, expiresMs - Date.now());

    if (remainMs <= 0) {
      if (existing) existing.remove();
      if (trialIndicatorTimer) { clearInterval(trialIndicatorTimer); trialIndicatorTimer = null; }
      return;
    }

    const hours = Math.floor(remainMs / 3600000);
    const mins = Math.floor((remainMs % 3600000) / 60000);
    const label = hours > 0
      ? "Performance access · " + hours + "h " + mins + "m remaining"
      : "Performance access · " + mins + "m remaining";

    if (existing) {
      existing.textContent = label;
    } else {
      const el = document.createElement("div");
      el.id = "athlevoTrialIndicator";
      el.className = "ag-trial-indicator";
      el.textContent = label;
      // Insert at top of active screen or body
      const today = document.getElementById("screen-today");
      if (today) {
        today.insertBefore(el, today.firstChild);
      } else {
        document.body.appendChild(el);
      }
    }

    if (!trialIndicatorTimer) {
      trialIndicatorTimer = setInterval(renderTrialIndicator, 60000);
    }
  }

  // Refresh trial indicator whenever entitlement loads
  if (document && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") renderTrialIndicator();
    });
  }

  /* ─────────────── public API ────────────────────────────────────── */

  window.AthlevoAccessGuard = {
    guardTab,
    accessState,
    cachedAccessState,
    hasPaidAccess,
    unlockAll,
    checkout,
    checkoutLocal,
    checkoutFromUpgrade,
    checkoutLocalFromUpgrade,
    showUpgradeSheet,
    closeUpgradeSheet,
    trackPremiumView,
    refreshPremiumViews,
    renderTrialIndicator,
    VERSION: "access-guard-v5"
  };
})();

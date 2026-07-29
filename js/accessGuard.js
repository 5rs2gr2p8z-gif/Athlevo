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
    "training_load", "recovery", "athlevo_score", "trends"
  ]);
  const PREMIUM_SURFACES = new Set(["today", "trends", "upgrade_sheet"]);
  const viewedThisSession = new Set();
  let upgradeContext = { feature: "trends", surface: "upgrade_sheet" };
  let restoreFocusTo = null;

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
      return state === "unknown" ? "free" : state;
    } catch (e) {
      return "free";
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
    return { feature, surface };
  }

  function trackCategorical(name, context) {
    const safe = categoricalContext(context, "upgrade_sheet");
    const props = { surface: safe.surface };
    if (safe.feature) props.feature = safe.feature;
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

  function trackPremiumView(feature, surface) {
    const safe = categoricalContext({ feature, surface }, "today");
    if (!safe.feature) return;
    const key = `${safe.feature}:${safe.surface}`;
    if (viewedThisSession.has(key)) return;
    viewedThisSession.add(key);
    trackCategorical("premium_feature_viewed", safe);
  }

  function checkout(context) {
    const safe = categoricalContext(context, "upgrade_sheet");
    trackCategorical("upgrade_clicked", safe);
    trackCategorical("checkout_opened", safe);
    window.open(checkoutUrl(), "_blank", "noopener");
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
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    if (restoreFocusTo && typeof restoreFocusTo.focus === "function") {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
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

  function showUpgradeSheet(feature, surface) {
    const modal = document.getElementById("performanceUpgradeModal");
    if (!modal) return;
    const safe = categoricalContext({ feature, surface }, "today");
    upgradeContext = {
      feature: safe.feature || "trends",
      surface: "upgrade_sheet"
    };
    trackPremiumView(safe.feature || "trends", safe.surface);
    restoreFocusTo = document.activeElement;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    if (modal.dataset.focusBound !== "true") {
      modal.addEventListener("keydown", onUpgradeKeydown);
      modal.dataset.focusBound = "true";
    }
    const nodes = focusableIn(modal);
    if (nodes.length && typeof nodes[0].focus === "function") nodes[0].focus();
  }

  function checkoutFromUpgrade() {
    checkout(upgradeContext);
    closeUpgradeSheet();
  }

  /*
   * Called after a successful paid activation to remove all
   * locked overlays so tabs work normally going forward.
   */
  function unlockAll() {
    ["screen-coachai", "screen-train", "screen-trends"].forEach(removeLockedOverlay);
  }

  /* ─────────────── public API ────────────────────────────────────── */

  window.AthlevoAccessGuard = {
    guardTab,
    accessState,
    cachedAccessState,
    hasPaidAccess,
    unlockAll,
    checkout,
    checkoutFromUpgrade,
    showUpgradeSheet,
    closeUpgradeSheet,
    trackPremiumView,
    VERSION: "access-guard-v2"
  };
})();

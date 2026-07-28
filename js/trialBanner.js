/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Trial status banner
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Displays restrained trial status on the Today screen.
 *  Uses server-provided expiry (never browser time alone).
 *  Updates on load and meaningful navigation — no second-by-second timers.
 *
 *  States:
 *    trial_active  → "3-day Athlevo trial · X days remaining"
 *    trial_active (last day) → "Your trial ends tomorrow."
 *    expired_limited → "Your trial has ended." + upgrade CTA
 *    paid_active / no_entitlement → hidden
 */
(function () {
  "use strict";

  // Per-session dedup for trial_expired — fire once per app session, not per render.
  var _expiredFired = false;

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function daysRemaining(trialEndsAt) {
    if (!trialEndsAt) return 0;
    const end = new Date(trialEndsAt).getTime();
    const now = Date.now();
    if (end <= now) return 0;
    return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  }

  function render() {
    const el = document.getElementById("trialBanner");
    if (!el) return;

    if (!window.AthlevoPlan || typeof window.AthlevoPlan.accessState !== "function") {
      el.style.display = "none";
      return;
    }

    const state = window.AthlevoPlan.accessState();
    if (!state) { el.style.display = "none"; return; }

    const access = state.access_state;

    if (access === "trial_active") {
      const days = daysRemaining(state.trial_ends_at);
      const isLastDay = days <= 1;
      const cls = isLastDay ? "trial-banner trial-expiring" : "trial-banner trial-active";
      const label = isLastDay
        ? "Your trial ends tomorrow."
        : `3-day Athlevo trial`;
      const sub = isLastDay
        ? "Upgrade to keep your coaching and plan."
        : `${days} day${days !== 1 ? "s" : ""} remaining`;

      el.innerHTML = `
        <div class="${esc(cls)}">
          <div class="tb-text">
            <div class="tb-label">${esc(label)}</div>
            <div class="tb-sub">${esc(sub)}</div>
          </div>
          ${isLastDay ? '<button class="tb-btn" type="button" onclick="AthlevoTrialBanner.upgrade()">Upgrade</button>' : ''}
        </div>`;
      el.style.display = "block";

      if (isLastDay) {
        try { if (window.AthlevoProductAnalytics) AthlevoProductAnalytics.trackAthlevoEvent('trial_expiring_viewed'); } catch (e) {}
      }
      return;
    }

    if (access === "expired_limited") {
      el.innerHTML = `
        <div class="trial-banner trial-expired">
          <div class="tb-text">
            <div class="tb-label">Your trial has ended.</div>
            <div class="tb-sub">Your training history is safe. Upgrade to continue receiving adaptive coaching.</div>
          </div>
          <button class="tb-btn" type="button" onclick="AthlevoTrialBanner.upgrade()">Continue with Athlevo Pro</button>
        </div>`;
      el.style.display = "block";

      try { if (window.AthlevoProductAnalytics) AthlevoProductAnalytics.trackAthlevoEvent('trial_expired'); } catch (e) {}
      return;
    }

    // paid_active or no_entitlement — hide
    el.style.display = "none";
    el.innerHTML = "";
  }

  function upgrade() {
    if (window.AthlevoPaywall && typeof window.AthlevoPaywall.checkout === "function") {
      window.AthlevoPaywall.checkout();
    }
    try { if (window.AthlevoProductAnalytics) AthlevoProductAnalytics.trackAthlevoEvent('upgrade_clicked', { source: 'trial_banner' }); } catch (e) {}
    try { if (window.AthlevoProductAnalytics) AthlevoProductAnalytics.trackAthlevoEvent('checkout_opened', { source: 'trial_banner' }); } catch (e) {}
  }

  /* Refresh on load and meaningful navigation */
  async function refresh() {
    if (window.AthlevoPlan && typeof window.AthlevoPlan.loadEntitlement === "function") {
      await window.AthlevoPlan.loadEntitlement();
    }
    render();
  }

  window.AthlevoTrialBanner = {
    render,
    refresh,
    upgrade,
    VERSION: "trial-banner-v1"
  };
})();

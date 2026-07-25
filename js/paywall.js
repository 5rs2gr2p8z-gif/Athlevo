/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Post-onboarding personalized preview + paywall
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Shown ONCE, right after onboarding, BEFORE plan generation.
 *  1. The athlete has completed their profile and (optionally) connected
 *     training data. Athlevo has enough context to show a personalized
 *     preview of their coaching approach.
 *  2. Before revealing the full generated plan and premium coaching, the
 *     paywall presents the Whop Performance checkout with a 3-day trial.
 *  3. Paid / trial users bypass this entirely — they never see it.
 *
 *  Source of truth: AthlevoPlan.load() → resolveEntitlement(). The
 *  paywall NEVER grants access from a URL parameter or localStorage.
 *
 *  Does NOT touch: Today, Coach, Readiness, Workout Analysis, or any
 *  feature outside the onboarding-to-plan transition.
 */
(function () {
  "use strict";

  /* ─────────────── configuration ──────────────────────────────────── */

  /*
   * The Whop checkout link for Athlevo Performance. Update this to your
   * actual Whop checkout URL. The link should point to the Performance
   * plan with a 3-day free trial configured on the Whop side.
   */
  const WHOP_CHECKOUT_URL = "https://whop.com/athlevo-performance/checkout/";

  /*
   * How long to poll for entitlement after checkout return, and how
   * often. The webhook typically arrives within seconds, but network
   * jitter happens.
   */
  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_MS      = 45000;

  /* ─────────────── state ──────────────────────────────────────────── */

  let active = false;           // is the paywall screen currently showing?
  let pollTimer = null;
  let visHandler = null;

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ─────────────── entitlement check ──────────────────────────────── */

  /*
   * Returns true when the athlete has an active paid subscription or
   * trial — the ONLY check that matters. Uses the existing subscription
   * system (features.js → AthlevoPlan.load → resolveEntitlement).
   */
  async function isPaid() {
    if (!window.AthlevoPlan || typeof window.AthlevoPlan.load !== "function") {
      return false;
    }
    try {
      await window.AthlevoPlan.load();
    } catch (e) { /* offline / cold start — default to not-paid */ }
    if (typeof window.AthlevoPlan.entitlement === "function") {
      const ent = window.AthlevoPlan.entitlement();
      return ent && ent.tier > 0;
    }
    // Fallback: isLoaded + canUse on a Performance-tier feature.
    if (typeof window.AthlevoPlan.canUse === "function") {
      return window.AthlevoPlan.canUse("adaptive_ai");
    }
    return false;
  }

  /* ─────────────── personalized preview ───────────────────────────── */

  /*
   * Derive a personalized preview from the onboarding profile ONLY.
   * No AI call, no plan generation — just the data the athlete provided.
   */
  function buildPreview(profile) {
    const p = profile || {};
    const name = p.name || p.display_name || "Athlete";
    const goal = p.goal || p.goal_distance || "";
    const race = p.target_race || p.race || "";
    const raceDate = p.race_date || p.target_race_date || "";
    const experience = (p.experience || p.running_experience || "").toLowerCase();
    const weeklyKm = Number(p.weekly_distance) || 0;
    const days = Number(p.available_days) || 0;
    const longRunDay = p.long_run_day || p.preferred_long_run_day || "";

    // Headline
    const headline = goal
      ? `${esc(name)}, here's your path to ${esc(goal.toLowerCase().replace(/^(to |my |a )/, ""))}`
      : `${esc(name)}, your coaching approach is ready`;

    // Situation summary
    const situationParts = [];
    if (weeklyKm > 0) situationParts.push(`currently running ~${weeklyKm} km/week`);
    if (experience) situationParts.push(`${esc(experience)} runner`);
    if (days > 0) situationParts.push(`${days} days available`);
    if (race) {
      let raceLine = esc(race);
      if (raceDate) raceLine += ` on ${esc(formatDate(raceDate))}`;
      situationParts.push(`targeting ${raceLine}`);
    }
    const situation = situationParts.length > 0
      ? capitalise(situationParts.join(", ")) + "."
      : "Your profile is set. Athlevo has what it needs to coach you.";

    // Training approach
    const approach = deriveApproach(experience, weeklyKm, days, goal);

    // Sample workout
    const sample = deriveSampleWorkout(experience, weeklyKm, goal);

    // Why this fits
    const whyFit = deriveWhyFit(experience, weeklyKm, days, goal, name);

    return { headline, situation, approach, sample, whyFit };
  }

  function capitalise(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatDate(d) {
    try {
      const dt = new Date(d);
      if (isNaN(dt)) return String(d);
      return dt.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    } catch (e) { return String(d); }
  }

  function deriveApproach(experience, weeklyKm, days, goal) {
    const isRace = /marathon|half|10k|5k|race|ultra/i.test(goal);
    if (!experience || /beginner|start|new/i.test(experience)) {
      return isRace
        ? "Build a consistent aerobic base first, then add race-specific sessions. " +
          "Your early weeks focus on easy running to develop endurance safely before introducing structured workouts."
        : "Start with a foundation of easy, consistent running. " +
          "Your plan prioritizes building the habit and aerobic base before adding intensity.";
    }
    if (/advanced|competitive|elite|experienced/i.test(experience)) {
      return isRace
        ? "Periodize around your race date with targeted threshold, interval, and long-run progressions. " +
          "Your volume and intensity will be calibrated to your current fitness."
        : "Structure your training with purposeful variety: threshold work, intervals, and recovery. " +
          "Each session has a specific physiological target.";
    }
    // Intermediate / default
    return isRace
      ? "Balance your current volume with progressive race-specific work. " +
        "Structured long runs, tempo sessions, and recovery days tailored to your schedule."
      : "Progress your current training with structured variety: easy runs for recovery, " +
        "tempo and interval sessions for fitness, and a weekly long run for endurance.";
  }

  function deriveSampleWorkout(experience, weeklyKm, goal) {
    if (!experience || /beginner|start|new/i.test(experience)) {
      return {
        title: "Easy aerobic run",
        detail: "30 minutes at conversation pace. You should be able to talk in full sentences throughout. " +
                "Walk breaks are welcome and encouraged.",
        purpose: "Builds your aerobic base and running habit safely."
      };
    }
    if (/advanced|competitive|elite|experienced/i.test(experience)) {
      const isMarathon = /marathon|ultra/i.test(goal);
      return isMarathon
        ? { title: "Threshold cruise intervals",
            detail: "Warm up 15 min easy, then 4 × 8 min at half-marathon effort with 2-min easy jog recovery. Cool down 10 min.",
            purpose: "Develops lactate clearance and race-specific stamina." }
        : { title: "VO₂max intervals",
            detail: "Warm up 15 min easy, then 5 × 1000 m at 5K effort with 90-sec jog recovery. Cool down 10 min.",
            purpose: "Improves maximal aerobic capacity and speed endurance." };
    }
    // Intermediate
    return {
      title: "Tempo progression",
      detail: "Warm up 10 min easy, then 20 minutes at a “comfortably hard” pace — you can speak in short phrases but not hold a conversation. Cool down 10 min.",
      purpose: "Raises your lactate threshold, the key to running faster at every distance."
    };
  }

  function deriveWhyFit(experience, weeklyKm, days, goal, name) {
    const parts = [];
    if (/beginner|start|new/i.test(experience || "")) {
      parts.push("Starting with easy volume builds the injury resistance and aerobic engine you need before adding speed work.");
    } else if (/advanced|competitive|elite|experienced/i.test(experience || "")) {
      parts.push("With your training background, purposeful intensity and recovery balance drives the next level of performance.");
    } else {
      parts.push("Mixing structured sessions with easy running matches where you are and moves you forward without overloading.");
    }
    if (days > 0 && days <= 3) {
      parts.push(`With ${days} days, every session counts — each one targets a different energy system.`);
    } else if (days >= 5) {
      parts.push(`${days} days gives room for proper recovery between hard efforts, which is where adaptation actually happens.`);
    }
    return parts.join(" ");
  }

  /* ─────────────── render ─────────────────────────────────────────── */

  function render(profile) {
    const mount = document.getElementById("paywallBody");
    if (!mount) return;

    const preview = buildPreview(profile);

    // Try to get the user's email for checkout prefill.
    let checkoutUrl = WHOP_CHECKOUT_URL;
    try {
      if (window.supabaseClient) {
        // Don't await — this is best-effort prefill. The URL works without it.
        window.supabaseClient.auth.getUser().then(({ data }) => {
          if (data && data.user && data.user.email) {
            const btn = document.getElementById("pw-checkout-btn");
            if (btn) btn.dataset.email = data.user.email;
          }
        }).catch(() => {});
      }
    } catch (e) {}

    mount.innerHTML = `
      <div class="pw-scroll">

        <!-- personalized preview -->
        <div class="pw-preview">
          <div class="pw-badge">Your personalized preview</div>
          <h1 class="pw-headline serif">${preview.headline}</h1>
          <p class="pw-situation">${esc(preview.situation)}</p>

          <div class="pw-section">
            <span class="pw-section-label">Recommended approach</span>
            <p class="pw-section-body">${esc(preview.approach)}</p>
          </div>

          <div class="pw-sample">
            <span class="pw-section-label">Sample first-week workout</span>
            <div class="pw-sample-card">
              <div class="pw-sample-title">${esc(preview.sample.title)}</div>
              <p class="pw-sample-detail">${esc(preview.sample.detail)}</p>
              <p class="pw-sample-purpose">${esc(preview.sample.purpose)}</p>
            </div>
          </div>

          <div class="pw-section">
            <span class="pw-section-label">Why this fits you</span>
            <p class="pw-section-body">${esc(preview.whyFit)}</p>
          </div>
        </div>

        <!-- paywall -->
        <div class="pw-wall">
          <h2 class="pw-wall-title serif">Your coaching plan is ready.</h2>
          <p class="pw-wall-sub">Athlevo has built your starting approach around your goal, training history, and available schedule.</p>

          <div class="pw-offer">
            <div class="pw-offer-row pw-offer-trial">
              <span class="pw-offer-check">✓</span>
              <span>3 days free</span>
            </div>
            <div class="pw-offer-row">
              <span class="pw-offer-check">✓</span>
              <span>₱0 due today</span>
            </div>
            <div class="pw-offer-row">
              <span class="pw-offer-check">✓</span>
              <span>₱597/month after trial</span>
            </div>
            <div class="pw-offer-row">
              <span class="pw-offer-check">✓</span>
              <span>Cancel anytime</span>
            </div>
          </div>

          <button class="pw-cta" id="pw-checkout-btn" type="button" onclick="AthlevoPaywall.checkout()">
            Start my 3-day free trial
          </button>

          <button class="pw-secondary" type="button" onclick="AthlevoPaywall.scrollToPreview()">
            Review my preview
          </button>
        </div>

        <!-- checkout-return confirmation (hidden by default) -->
        <div class="pw-confirming" id="pwConfirming" style="display:none">
          <div class="pw-confirming-orb">
            <img src="assets/athlevo-icon.png" alt="" width="40" height="40">
          </div>
          <h2 class="pw-wall-title serif" id="pwConfirmTitle">Confirming your trial…</h2>
          <p class="pw-wall-sub" id="pwConfirmSub">We're verifying your subscription. This usually takes a few seconds.</p>
          <button class="pw-secondary" id="pwCheckBtn" type="button" onclick="AthlevoPaywall.checkAccess()" style="display:none">
            Check access
          </button>
        </div>
      </div>`;
  }

  /* ─────────────── actions ────────────────────────────────────────── */

  async function show(profile) {
    // Never show to a paid user.
    if (await isPaid()) return false;

    active = true;
    render(profile);
    if (typeof showScreen === "function") showScreen("screen-paywall");

    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "none";

    // Listen for tab re-focus (user returning from Whop checkout).
    if (visHandler) document.removeEventListener("visibilitychange", visHandler);
    visHandler = () => {
      if (document.visibilityState === "visible" && active) {
        onCheckoutReturn();
      }
    };
    document.addEventListener("visibilitychange", visHandler);

    try { if (window.AthlevoAnalytics) AthlevoAnalytics.track("paywall_shown"); } catch (e) {}
    return true;
  }

  function checkout() {
    let url = WHOP_CHECKOUT_URL;
    // Best-effort email prefill for Whop matching.
    const btn = document.getElementById("pw-checkout-btn");
    const email = btn && btn.dataset.email;
    if (email) {
      const sep = url.includes("?") ? "&" : "?";
      url += sep + "email=" + encodeURIComponent(email);
    }
    try { if (window.AthlevoAnalytics) AthlevoAnalytics.track("paywall_checkout_tapped"); } catch (e) {}
    window.open(url, "_blank");
  }

  function scrollToPreview() {
    const preview = document.querySelector(".pw-preview");
    if (preview) preview.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ─────────────── checkout return + polling ──────────────────────── */

  async function onCheckoutReturn() {
    // Only act if we're still on the paywall.
    if (!active) return;

    // Quick check — maybe the webhook already arrived.
    if (await isPaid()) {
      showConfirmed();
      return;
    }

    // Show the confirming state and begin polling.
    showConfirming();
    startPolling();
  }

  function showConfirming() {
    const wall = document.querySelector(".pw-wall");
    const preview = document.querySelector(".pw-preview");
    const confirm = document.getElementById("pwConfirming");
    if (wall) wall.style.display = "none";
    if (preview) preview.style.display = "none";
    if (confirm) confirm.style.display = "flex";
  }

  function startPolling() {
    clearTimeout(pollTimer);
    const start = Date.now();
    const tick = async () => {
      if (!active) return;
      if (await isPaid()) { showConfirmed(); return; }
      if (Date.now() - start > POLL_MAX_MS) {
        // Polling exhausted — show manual check button.
        const sub = document.getElementById("pwConfirmSub");
        const btn = document.getElementById("pwCheckBtn");
        if (sub) sub.textContent = "We haven't received confirmation yet. This can take a minute.";
        if (btn) btn.style.display = "inline-block";
        return;
      }
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  async function checkAccess() {
    const btn = document.getElementById("pwCheckBtn");
    const sub = document.getElementById("pwConfirmSub");
    if (btn) btn.textContent = "Checking…";
    if (await isPaid()) { showConfirmed(); return; }
    if (btn) btn.textContent = "Check access";
    if (sub) sub.textContent = "Still waiting for confirmation. If you just completed checkout, give it another moment.";
  }

  function showConfirmed() {
    active = false;
    clearTimeout(pollTimer);
    if (visHandler) { document.removeEventListener("visibilitychange", visHandler); visHandler = null; }

    const mount = document.getElementById("paywallBody");
    if (mount) {
      mount.innerHTML = `
        <div class="pw-scroll">
          <div class="pw-confirmed">
            <div class="pw-confirmed-check">✓</div>
            <h2 class="pw-wall-title serif">Your Athlevo Performance trial is active.</h2>
            <p class="pw-wall-sub">Full coaching access is unlocked. Let's build your plan.</p>
            <button class="pw-cta" type="button" onclick="AthlevoPaywall.proceed()">Continue</button>
          </div>
        </div>`;
    }

    try { if (window.AthlevoAnalytics) AthlevoAnalytics.track("paywall_converted"); } catch (e) {}
  }

  function proceed() {
    active = false;
    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "flex";
    // Hand back to the plan setup flow.
    if (window.AthlevoPlan && typeof window.AthlevoPlan.start === "function") {
      window.AthlevoPlan.start();
    } else if (typeof showScreen === "function") {
      showScreen("screen-today");
    }
  }

  /* ─────────────── checkout return on page load ───────────────────── */

  /*
   * If the user returns to Athlevo via a Whop redirect with a query
   * parameter, handle it. We NEVER trust the parameter for access —
   * we just use it as a trigger to start polling the real entitlement.
   */
  function handlePageLoadReturn() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("checkout_return") || params.has("whop_return")) {
        // Clean the URL without reloading.
        const url = new URL(window.location);
        url.searchParams.delete("checkout_return");
        url.searchParams.delete("whop_return");
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
        // Trigger the return flow.
        onCheckoutReturn();
        return true;
      }
    } catch (e) {}
    return false;
  }

  /* ─────────────── cleanup ────────────────────────────────────────── */

  function dismiss() {
    active = false;
    clearTimeout(pollTimer);
    if (visHandler) { document.removeEventListener("visibilitychange", visHandler); visHandler = null; }
  }

  /* ─────────────── public API ─────────────────────────────────────── */

  window.AthlevoPaywall = {
    show,
    checkout,
    scrollToPreview,
    checkAccess,
    proceed,
    dismiss,
    handlePageLoadReturn,
    isPaid,
    isActive: () => active,
    // Exposed for tests.
    _buildPreview: buildPreview,
    _WHOP_CHECKOUT_URL: WHOP_CHECKOUT_URL,
    VERSION: "paywall-v1"
  };
})();

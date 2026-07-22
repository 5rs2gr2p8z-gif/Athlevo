/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Proactive Plan Setup  (product flow, not AI)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Makes the coach set ITSELF up. After onboarding (or from a Today CTA) the
 *  athlete is guided straight into building their plan instead of having to find
 *  plan generation on the Train tab. Uses ONLY existing endpoints
 *  (/api/training/get-week, /api/training/generate-plan) and the profile the
 *  onboarding flow already saved — no coaching-engine or algorithm changes.
 *
 *  Returning users with a plan are never touched: generation is only ever
 *  triggered by an explicit tap, never automatically.
 */
(function () {
  "use strict";

  let buildInFlight = false;
  let lastHasPlan = null;         // cache of the most recent get-week result
  let dismissedThisSession = false;

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function authToken() {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      return session ? session.access_token : null;
    } catch (e) { return null; }
  }

  // True/false whether the athlete already has a generated plan. Never throws.
  async function hasPlan() {
    const token = await authToken();
    if (!token) return null;
    try {
      const res = await fetch("/api/training/get-week", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      lastHasPlan = !!data.hasPlan;
      return lastHasPlan;
    } catch (e) { return null; }
  }

  /* ─────────────────────────── setup screen ──────────────────────────── */

  function summaryRow(label, value) {
    if (value == null || value === "" ) return "";
    return `<div class="ps-row"><span class="ps-row-label">${esc(label)}</span><span class="ps-row-val">${esc(value)}</span></div>`;
  }

  function renderSetup(profile) {
    const mount = document.getElementById("planSetupBody");
    if (!mount) return;
    const p = profile || {};
    /*
     * Provider-agnostic activation. An athlete blocked by Strava's athlete
     * limit can connect Intervals.icu instead and is just as "connected" —
     * gating on Strava specifically would lock them out of plan generation.
     */
    const connected = p.strava_connected === true || p.intervals_connected === true;

    const goal = p.goal || p.goal_distance || p.target_distance || null;
    const race = p.target_race || p.race || null;
    const raceDate = p.race_date || p.target_race_date || null;
    const days = p.available_days != null ? `${p.available_days} days/week` : (p.training_days || null);
    const longRun = p.long_run_day || p.preferred_long_run_day || null;
    const volume = Number(p.weekly_distance) > 0 ? `${p.weekly_distance} km/week` : null;

    const review =
      summaryRow("Goal", goal) +
      summaryRow("Target event", race) +
      summaryRow("Race date", raceDate) +
      summaryRow("Weekly availability", days) +
      summaryRow("Long run day", longRun) +
      summaryRow("Current volume", volume);

    // Provider-agnostic: connect training data once; the service is an
    // implementation detail, never named here.
    const connectBlock = connected
      ? `<div class="ps-strava ok"><span>✓</span> Your training is connected — Athlevo will learn from every run.</div>`
      : `<div class="ps-strava">
           <div><b>Connect your training data</b><small>Recommended — lets your plan adapt to your real training.</small></div>
           <button class="ps-strava-btn" type="button" onclick="AthlevoPlan.connectTrainingData()">Connect</button>
         </div>`;

    mount.innerHTML = `
      <div class="ps-hero">
        <div class="ps-badge">✓ Your athlete profile is ready</div>
        <h1 class="ps-title serif">Build your training plan.</h1>
        <p class="ps-lead">Athlevo will turn everything you told us into a personalized, adapting training plan.</p>
      </div>
      ${connectBlock}
      ${review ? `<div class="ps-review"><span class="ps-review-eyebrow">What Athlevo knows</span>${review}</div>` : ""}
      <button class="ps-build" type="button" onclick="AthlevoPlan.build()">Build Training Plan</button>
      <p class="ps-note">Your plan is ready to generate. You can adjust anything later.</p>
      <button class="ps-later" type="button" onclick="AthlevoPlan.notNow()">Not right now</button>`;
  }

  async function start() {
    let profile = null;
    try { profile = window.AthlevoBrain ? await window.AthlevoBrain.loadAthleteProfile() : null; } catch (e) {}
    renderSetup(profile);
    if (typeof showScreen === "function") showScreen("screen-plansetup");
  }

  // Let the athlete step back to Today, but keep the persistent CTA so they're
  // guided, never trapped.
  function notNow() {
    dismissedThisSession = true;
    if (typeof showScreen === "function") showScreen("screen-today");
    refreshTodayCta();
  }

  /* ───────────────────────── generation flow ─────────────────────────── */

  /*
   * What the athlete actually asked for was a training plan, so the copy
   * names that outcome. The steps mirror the real pipeline order the server
   * follows: profile → goals → history → week → coach.
   */
  const GEN_STEPS = [
    "Reviewing your profile",
    "Understanding your goals",
    "Analyzing your recent training",
    "Designing your first training week",
    "Preparing your coach"
  ];

  function renderGen() {
    const mount = document.getElementById("planGenBody");
    if (!mount) return;
    mount.innerHTML = `
      <div class="pg-wrap">
        <div class="pg-orb"><img src="assets/athlevo-icon.png" alt="" width="46" height="46"></div>
        <h2 class="pg-title serif" id="pgTitle">Creating your personalized training plan</h2>
        <ul class="pg-steps" id="pgSteps">
          ${GEN_STEPS.map((s, i) => `<li data-i="${i}"><span class="pg-dot"></span><span>${esc(s)}</span></li>`).join("")}
        </ul>
      </div>`;
  }

  function reduceMotion() {
    try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  // Advance the visible steps on a timer; resolves when the animation has at
  // least reached the final step (min perceived build time).
  function runStepAnimation() {
    const list = document.getElementById("pgSteps");
    if (!list) return Promise.resolve();
    const items = Array.from(list.querySelectorAll("li"));
    const per = reduceMotion() ? 120 : 700;
    return new Promise(resolve => {
      let i = 0;
      const tick = () => {
        if (i > 0) items[i - 1].classList.add("done");
        if (i < items.length) {
          items[i].classList.add("active");
          i += 1;
          setTimeout(tick, per);
        } else { resolve(); }
      };
      tick();
    });
  }

  function showSuccess() {
    const mount = document.getElementById("planGenBody");
    if (!mount) return;
    mount.innerHTML = `
      <div class="pg-wrap success">
        <div class="pg-check">✓</div>
        <h2 class="pg-title serif">Your training plan is ready.</h2>
        <p class="pg-sub">Your first week is set. Let's train.</p>
        <button class="ps-build" type="button" onclick="AthlevoPlan.enterTrain()">Enter Training</button>
      </div>`;
    if (!reduceMotion()) setTimeout(() => { enterTrain(); }, 1600);
  }

  async function build() {
    if (buildInFlight) return;
    buildInFlight = true;
    if (typeof showScreen === "function") showScreen("screen-plangen");
    renderGen();

    const token = await authToken();
    const minAnim = runStepAnimation();

    /*
     * The server returns { error, code, action } on failure. Previously only
     * res.ok was read and the body discarded, so every failure — expired
     * session, incomplete profile, provider outage — collapsed into the same
     * "That didn't finish." The athlete had no idea what to do next.
     */
    let outcome = { ok: false };
    try {
      if (!token) {
        outcome = { ok: false, code: "AUTH_REQUIRED",
          message: "Please sign in again to build your plan.", action: "signIn" };
      } else {
        // Best-effort pre-generation analysis refresh. Never blocks the build.
        try {
          await fetch("/api/training/weekly-analysis", { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) { /* non-fatal */ }

        /*
         * Generation can legitimately take a while. Bound it so a hung
         * request can never leave the athlete on an endless spinner.
         */
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
        try {
          const res = await fetch("/api/training/generate-plan", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal
          });
          const data = await res.json().catch(() => ({}));
          outcome = res.ok
            ? { ok: true, alreadyExists: data.alreadyExists === true }
            : { ok: false, code: data.code || "PLAN_FAILED",
                message: data.error, action: data.action || "retry" };
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      outcome = (e && e.name === "AbortError")
        ? { ok: false, code: "PLAN_TIMEOUT", action: "retry",
            message: "This is taking longer than usual. Your plan may still be building — try again in a moment." }
        : { ok: false, code: "PLAN_NETWORK", action: "retry",
            message: "We couldn't reach Athlevo. Check your connection and try again." };
    }

    await minAnim;                                  // let the animation finish
    buildInFlight = false;

    if (outcome.ok) {
      lastHasPlan = true;
      showSuccess();
      return;
    }
    showBuildProblem(outcome);
  }

  // How long to wait before telling the athlete something is wrong. Generous,
  // because a real generation involves a reasoning model.
  const BUILD_TIMEOUT_MS = 90000;

  /*
   * One failure screen, always with a way forward. The action determines the
   * primary button, so "fix your profile" never shows a pointless "Try again".
   */
  function showBuildProblem(outcome) {
    const mount = document.getElementById("planGenBody");
    if (!mount) return;

    const message = outcome.message ||
      "We couldn't create your plan just now. Please try again.";

    const ACTIONS = {
      retry: { label: "Try again", onclick: "AthlevoPlan.build()" },
      signIn: { label: "Sign in", onclick: "AthlevoPlan.notNow()" },
      completeProfile: { label: "Complete my profile", onclick: "AthlevoPlan.start()" },
      viewPlan: { label: "View my plan", onclick: "AthlevoPlan.enterTrain()" }
    };
    const primary = ACTIONS[outcome.action] || ACTIONS.retry;

    mount.innerHTML = `
      <div class="pg-wrap">
        <div class="pg-check err">!</div>
        <h2 class="pg-title serif">That didn't finish.</h2>
        <p class="pg-sub">${escapeText(message)}</p>
        <button class="ps-build" type="button" onclick="${primary.onclick}">${escapeText(primary.label)}</button>
        <button class="ps-later" type="button" onclick="AthlevoPlan.notNow()">Back to Today</button>
      </div>`;
  }

  function escapeText(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function enterTrain() {
    const btn = document.querySelector('.tab[data-screen="screen-train"]');
    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "flex";
    if (btn && typeof go === "function") { go(btn); return; }
    if (typeof showScreen === "function") showScreen("screen-train");
    if (typeof window.loadWeeklyPlan === "function") window.loadWeeklyPlan();
  }

  /* ───────────── auto-detection + Today CTA (discovery) ───────────────── */

  // Called by onboarding when it finishes. New athlete + no plan → guide them
  // straight into setup. Anything else → Today.
  async function maybeLaunchAfterOnboarding() {
    const has = await hasPlan();
    if (has === false) { await start(); return true; }
    if (typeof showScreen === "function") showScreen("screen-today");
    return false;
  }

  // Persistent Today CTA so EXISTING users without a plan also discover it.
  function renderTodayCta(profile, has, connectedOverride) {
    const el = document.getElementById("todayPlanCta");
    if (!el) return;
    if (has !== false) { el.style.display = "none"; el.innerHTML = ""; return; }
    /*
     * ONE training-data connection. Athlevo aggregates through a provider, so
     * "is Strava linked" is the wrong question — any working provider
     * connection means the athlete's training data is connected. Passing the
     * flag in explicitly (rather than reading profile.intervals_connected,
     * which is only decorated onto the profile after refreshIntervalsStatus()
     * happens to have run) means step 1 can no longer look unfinished to an
     * athlete who is already connected.
     */
    const connected = connectedOverride === true || Boolean(profile &&
      (profile.strava_connected === true || profile.intervals_connected === true));
    el.style.display = "block";
    /*
     * Three states, one card:
     *   A  no data, no plan  → connect, then build
     *   B  data connected, no plan  → just build
     *   C  data + plan  → handled above (card hidden)
     */
    el.innerHTML = connected
      ? `<div class="tpc-cta">
           <div class="tpc-cta-copy"><b>Your training is connected</b><small>Your activity history is syncing with Athlevo. Next, build your personalized training plan.</small></div>
           <button class="tpc-cta-btn" type="button" onclick="AthlevoPlan.start()">Build Training Plan</button>
         </div>`
      : `<div class="tpc-cta">
           <div class="tpc-cta-copy"><b>Set up your training</b><small>Step 1 — connect your training data. Step 2 — build your training plan.</small></div>
           <div class="tpc-cta-steps">
             <button class="tpc-cta-btn ghost" type="button" onclick="AthlevoPlan.connectTrainingData()">Connect Training Data</button>
             <button class="tpc-cta-btn" type="button" onclick="AthlevoPlan.start()">Build Training Plan</button>
           </div>
         </div>`;
  }

  /*
   * The single entry point for connecting training data. Routes into the
   * EXISTING, working guided provider flow — no new OAuth path.
   */
  function connectTrainingData() {
    if (window.AthlevoConnect && typeof window.AthlevoConnect.start === "function") {
      return window.AthlevoConnect.start();
    }
    if (window.AthlevoBrain && window.AthlevoBrain.connectIntervals) {
      return window.AthlevoBrain.connectIntervals();
    }
  }

  // Refresh the Today CTA from current profile + plan status. Safe to call on
  // every Today render.
  async function refreshTodayCta() {
    let profile = null;
    try { profile = window.AthlevoBrain ? await window.AthlevoBrain.loadAthleteProfile() : null; } catch (e) {}
    let has = lastHasPlan;
    if (has == null) has = await hasPlan();

    // Authoritative provider state — the same source the OAuth guard uses.
    let connected;
    try {
      const s = window.AthlevoBrain && window.AthlevoBrain.providerStatus
        ? await window.AthlevoBrain.providerStatus() : null;
      if (s && s.connected === true) connected = true;
    } catch (e) { /* fall back to the profile flags */ }

    renderTodayCta(profile, has, connected);
  }

  /*
   * ── Automatic first plan — BUILT, DORMANT ──────────────────────────
   *
   * Flip this ONE constant to true to enable automatic generation after
   * onboarding. Everything below is already wired and tested; nothing else
   * needs to change.
   *
   * It is deliberately OFF. Plan generation was repaired very recently and
   * has not yet been verified end to end with real production users. If it
   * fails while automatic, every new beta athlete hits a broken onboarding
   * with no action they chose — strictly worse than a visible button they
   * tapped. Verify one real production flow first, then flip this.
   */
  const AUTO_FIRST_PLAN = false;

  /*
   * The single entry point onboarding calls. While AUTO_FIRST_PLAN is false
   * this lands the athlete on the dashboard, where the "Create My Training
   * Plan" card is waiting — the flow they control.
   *
   * SAFETY (already in force for when this is enabled): it refuses to run if
   * a plan exists, opens that plan instead, and never sends `regenerate`.
   */
  async function autoBuildFirstPlan() {
    if (!AUTO_FIRST_PLAN) {
      // Manual for now. Show the dashboard with the plan CTA visible.
      if (typeof showScreen === "function") showScreen("screen-today");
      refreshTodayCta();
      return { skipped: "auto_disabled" };
    }

    if (buildInFlight) return { skipped: "in_flight" };

    const existing = await hasPlan();
    if (existing === true) {
      // Never regenerate. Open what they already have.
      enterTrain();
      return { skipped: "already_has_plan" };
    }
    if (existing === null) {
      // Couldn't tell (offline, auth hiccup). Do NOT gamble on generating.
      if (typeof showScreen === "function") showScreen("screen-today");
      refreshTodayCta();
      return { skipped: "unknown" };
    }

    await build();
    return { generated: true };
  }

  // Exposed so the UX test can assert the flag's state without guessing.
  function autoFirstPlanEnabled() { return AUTO_FIRST_PLAN; }

  window.AthlevoPlan = {
    hasPlan, start, build, autoBuildFirstPlan, autoFirstPlanEnabled, notNow, enterTrain,
    maybeLaunchAfterOnboarding, refreshTodayCta, renderTodayCta, connectTrainingData,
    VERSION: "plan-setup-v1"
  };
})();

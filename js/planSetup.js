/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Proactive Plan Setup  (product flow, not AI)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Makes the coach set ITSELF up. After onboarding (or from a Today CTA) the
 *  athlete is guided straight into "Build My Coach" instead of having to find
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

    const stravaBlock = connected
      ? `<div class="ps-strava ok"><span>✓</span> Strava connected — your coach will learn from every run.</div>`
      : `<div class="ps-strava">
           <div><b>Connect Strava</b><small>Recommended — lets your coach adapt to your real training.</small></div>
           <button class="ps-strava-btn" type="button" onclick="connectStrava()">Connect</button>
         </div>`;

    mount.innerHTML = `
      <div class="ps-hero">
        <div class="ps-badge">✓ Your athlete profile is ready</div>
        <h1 class="ps-title serif">Let's build your coach.</h1>
        <p class="ps-lead">Athlevo will turn everything you told us into a personalized, adapting training plan.</p>
      </div>
      ${stravaBlock}
      ${review ? `<div class="ps-review"><span class="ps-review-eyebrow">What your coach knows</span>${review}</div>` : ""}
      <button class="ps-build" type="button" onclick="AthlevoPlan.build()">Build My Coach</button>
      <p class="ps-note">Your AI coach is ready to start planning. You can adjust anything later.</p>
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

  const GEN_STEPS = [
    "Reviewing your profile",
    "Analyzing recent training",
    "Understanding your goals",
    "Building your personalized plan",
    "Coach ready"
  ];

  function renderGen() {
    const mount = document.getElementById("planGenBody");
    if (!mount) return;
    mount.innerHTML = `
      <div class="pg-wrap">
        <div class="pg-orb"><img src="assets/athlevo-icon.png" alt="" width="46" height="46"></div>
        <h2 class="pg-title serif" id="pgTitle">Athlevo is building your coach…</h2>
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
        <h2 class="pg-title serif">Your coach is ready.</h2>
        <p class="pg-sub">Your first personalized week is set. Let's train.</p>
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

    // Best-effort pre-generation analysis refresh (same as the Train button).
    let apiOk = false;
    try {
      if (token) {
        try {
          await fetch("/api/training/weekly-analysis", { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) { /* non-fatal */ }
        const res = await fetch("/api/training/generate-plan", {
          method: "POST", headers: { Authorization: `Bearer ${token}` }
        });
        apiOk = res.ok;
      }
    } catch (e) {
      apiOk = false;
    }

    await minAnim;                                  // let the animation finish
    buildInFlight = false;

    if (apiOk) {
      lastHasPlan = true;
      showSuccess();
    } else {
      const mount = document.getElementById("planGenBody");
      if (mount) {
        mount.innerHTML = `
          <div class="pg-wrap">
            <div class="pg-check err">!</div>
            <h2 class="pg-title serif">That didn't finish.</h2>
            <p class="pg-sub">We couldn't build your plan just now. Please try again.</p>
            <button class="ps-build" type="button" onclick="AthlevoPlan.build()">Try again</button>
            <button class="ps-later" type="button" onclick="AthlevoPlan.notNow()">Back to Today</button>
          </div>`;
      }
    }
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
  function renderTodayCta(profile, has) {
    const el = document.getElementById("todayPlanCta");
    if (!el) return;
    if (has !== false) { el.style.display = "none"; el.innerHTML = ""; return; }
    // Provider-agnostic: Strava OR Intervals.icu both count as connected.
    const connected = Boolean(profile &&
      (profile.strava_connected === true || profile.intervals_connected === true));
    el.style.display = "block";
    el.innerHTML = connected
      ? `<div class="tpc-cta">
           <div class="tpc-cta-copy"><b>Build My Coach</b><small>Turn your profile into a personalized training plan.</small></div>
           <button class="tpc-cta-btn" type="button" onclick="AthlevoPlan.start()">Create My Training Plan</button>
         </div>`
      : `<div class="tpc-cta">
           <div class="tpc-cta-copy"><b>Set up your coach</b><small>Step 1 — connect Strava. Step 2 — build your plan.</small></div>
           <div class="tpc-cta-steps">
             <button class="tpc-cta-btn ghost" type="button" onclick="connectStrava()">Connect Strava</button>
             <button class="tpc-cta-btn" type="button" onclick="AthlevoPlan.start()">Build My Coach</button>
           </div>
         </div>`;
  }

  // Refresh the Today CTA from current profile + plan status. Safe to call on
  // every Today render.
  async function refreshTodayCta() {
    let profile = null;
    try { profile = window.AthlevoBrain ? await window.AthlevoBrain.loadAthleteProfile() : null; } catch (e) {}
    let has = lastHasPlan;
    if (has == null) has = await hasPlan();
    renderTodayCta(profile, has);
  }

  window.AthlevoPlan = {
    hasPlan, start, build, notNow, enterTrain,
    maybeLaunchAfterOnboarding, refreshTodayCta, renderTodayCta,
    VERSION: "plan-setup-v1"
  };
})();

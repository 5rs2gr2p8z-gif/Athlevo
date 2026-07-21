/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Guided training-data setup (onboarding steps 3–6)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Runs after the athlete profile is complete and before the dashboard.
 *  Athlevo guides the athlete the whole way: education → account → device →
 *  automatic detection → automatic import → real numbers.
 *
 *  Design rules this file follows:
 *
 *  · The athlete never runs a command, never refreshes, never sees a status
 *    code. Detection and import happen on their own.
 *  · The connection service is an IMPLEMENTATION DETAIL. It is named exactly
 *    once, in the sentence that explains why it exists. Every other screen
 *    talks about "your training" and "your watch".
 *  · Everything goes through AthlevoDataSource, never through a provider
 *    directly. When direct Garmin/COROS integrations land, this file does
 *    not change — only the adapter behind it does.
 *  · Nothing here alters sync, dedup, classification, Score or Coach. It
 *    calls the existing production pipeline in the right order.
 */

(function (root) {
  "use strict";

  const A = () => root.AthlevoAnalytics;
  const DS = () => root.AthlevoDataSource;
  const ACT = () => root.AthlevoActivation;

  /*
   * How long we keep watching for a watch to push its history through.
   * Mutable so tests can compress the wait; production never changes them.
   */
  const timing = { pollMs: 5000, maxMs: 90000 };

  const state = {
    step: null,
    wearable: null,
    detectStartedAt: 0,
    detectTimer: null,
    result: null,
    active: false
  };

  const $ = (id) => document.getElementById(id);
  const mount = () => $("connectFlowBody");

  /*
   * Authorization leaves the app entirely, so "guided setup is in progress"
   * must survive a full page load. sessionStorage (not localStorage) is the
   * right scope: it belongs to this setup attempt, not to the device.
   */
  const FLAG = "athlevo_guided_setup";
  const WEARABLE_KEY = "athlevo_guided_wearable";

  function markActive(on) {
    state.active = on;
    try {
      if (on) sessionStorage.setItem(FLAG, "1");
      else { sessionStorage.removeItem(FLAG); sessionStorage.removeItem(WEARABLE_KEY); }
    } catch (e) { /* private mode — in-memory state still works */ }
  }

  function wasActive() {
    if (state.active) return true;
    try { return sessionStorage.getItem(FLAG) === "1"; } catch (e) { return false; }
  }

  function rememberWearable(key) {
    state.wearable = key;
    try { sessionStorage.setItem(WEARABLE_KEY, key); } catch (e) {}
  }

  function restoreWearable() {
    if (state.wearable) return;
    try { state.wearable = sessionStorage.getItem(WEARABLE_KEY) || null; } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function show(html) {
    const el = mount();
    if (el) el.innerHTML = html;
  }

  function go(step) {
    state.step = step;
    render();
  }

  /* ═══════════════════════════ steps ═══════════════════════════════ */

  /*
   * Step 3 — why we need training data.
   *
   * This is the only screen that names the connection service, and it names
   * it as a means, not a destination: the athlete is connecting their
   * training to Athlevo, not signing up for something else.
   */
  function stepExplain() {
    A().track("connect_step_viewed");
    show(`
      <div class="cf-step">
        <div class="cf-icon">📈</div>
        <h2 class="cf-title serif">Let's bring in your training</h2>
        <p class="cf-body">
          Athlevo analyzes your previous workouts to build a coach that
          understands how <em>you</em> train — your paces, your volume, your
          recovery.
        </p>
        <p class="cf-note">
          To import your history securely we use ${esc(DS().serviceName)} as our
          connection service. It links your watch to Athlevo in a few taps.
        </p>
        <button class="cf-btn primary" onclick="AthlevoConnect.next('account')">Continue</button>
      </div>
    `);
  }

  /*
   * Step 4 — do they already have an account with the connection service?
   * Most runners will not, and assuming otherwise is where this flow would
   * lose people. Both paths are equally weighted.
   */
  function stepAccount() {
    show(`
      <div class="cf-step">
        <h2 class="cf-title serif">One quick account</h2>
        <p class="cf-body">
          ${esc(DS().serviceName)} is free and takes about a minute. It's the
          bridge between your watch and Athlevo.
        </p>
        <div class="cf-choice-list">
          <button class="cf-choice" onclick="AthlevoConnect.createAccount()">
            <b>I need an account</b>
            <small>Opens ${esc(DS().serviceName)} — come straight back when you're done</small>
          </button>
          <button class="cf-choice" onclick="AthlevoConnect.next('wearable')">
            <b>I already have one</b>
            <small>Continue to connect your watch</small>
          </button>
        </div>
      </div>
    `);
  }

  /*
   * Step 5 — which watch. Framed as "pick the one you actually use", because
   * the list is a menu, not a checklist. This list comes from the data-source
   * adapter, so a future direct integration appears here automatically.
   */
  function stepWearable() {
    const items = DS().wearables.map(w => `
      <button class="cf-device" onclick="AthlevoConnect.pickWearable('${esc(w.key)}')">
        <span class="cf-device-name">${esc(w.label)}</span>
      </button>
    `).join("");

    show(`
      <div class="cf-step">
        <h2 class="cf-title serif">Which do you use?</h2>
        <p class="cf-body">
          Pick the one your runs already go to. You only need one — whichever
          you actually use.
        </p>
        <div class="cf-device-grid">${items}</div>
        <button class="cf-link" onclick="AthlevoConnect.next('authorize')">
          Skip — I'll pick later
        </button>
      </div>
    `);
  }

  /*
   * Step 5b — device-specific instruction, then authorize. Kept concrete and
   * short: three steps, in the athlete's language.
   */
  function stepAuthorize() {
    const w = DS().wearables.find(x => x.key === state.wearable);
    const name = w ? w.label : "your watch";
    show(`
      <div class="cf-step">
        <h2 class="cf-title serif">Connect ${esc(name)}</h2>
        <ol class="cf-steps">
          <li>Open your ${esc(DS().serviceName)} settings</li>
          <li>Choose <b>${esc(name)}</b> and sign in</li>
          <li>Come back here — we'll take it from there</li>
        </ol>
        <button class="cf-btn secondary" onclick="AthlevoConnect.openConnections()">
          Open connection settings
        </button>
        <button class="cf-btn primary" onclick="AthlevoConnect.authorize()">
          Connect to Athlevo
        </button>
        <p class="cf-note small">
          Athlevo only ever reads your workouts. We never post, edit or delete anything.
        </p>
      </div>
    `);
  }

  /*
   * Step 6a — automatic detection. A watch can take minutes to push history
   * through, so this polls patiently rather than declaring failure once.
   */
  function stepDetecting() {
    const waited = Math.round((Date.now() - state.detectStartedAt) / 1000);
    show(`
      <div class="cf-step center">
        <div class="cf-pulse"></div>
        <h2 class="cf-title serif">Looking for your workouts</h2>
        <p class="cf-body">
          We're checking for your training history. This can take a minute or
          two right after connecting a watch.
        </p>
        ${waited > 25 ? `<p class="cf-note small">Still looking… ${waited}s</p>` : ""}
      </div>
    `);
  }

  // Step 6b — the import itself, shown as honest progress.
  const IMPORT_STAGES = [
    "Connected",
    "Importing workouts",
    "Reading lap and interval data",
    "Building your athlete profile",
    "Analyzing training history",
    "Preparing your AI coach"
  ];

  function stepImporting(activeIndex, counts) {
    const rows = IMPORT_STAGES.map((label, i) => {
      const cls = i < activeIndex ? "done" : (i === activeIndex ? "active" : "pending");
      const mark = i < activeIndex ? "✓" : (i === activeIndex ? "" : "");
      return `<li class="cf-stage ${cls}"><span class="cf-stage-mark">${mark}</span>${esc(label)}</li>`;
    }).join("");

    show(`
      <div class="cf-step">
        <h2 class="cf-title serif">Setting up your coach</h2>
        <ul class="cf-stages">${rows}</ul>
        ${counts ? `<p class="cf-note small">${esc(counts)}</p>` : ""}
      </div>
    `);
  }

  /*
   * Step 6c — success, in the athlete's own numbers. Generic praise means
   * nothing; "we found 274 workouts" proves Athlevo actually read their
   * training.
   */
  function stepSuccess(summary) {
    const stat = (label, value) => value
      ? `<div class="cf-stat"><b>${esc(value)}</b><small>${esc(label)}</small></div>` : "";

    show(`
      <div class="cf-step">
        <div class="cf-icon">✓</div>
        <h2 class="cf-title serif">${esc(summary.headline)}</h2>
        <p class="cf-body">${esc(summary.subline)}</p>
        <div class="cf-stats">
          ${stat("This week", summary.weeklyKm)}
          ${stat("Longest run", summary.longestKm)}
          ${stat("Most recent", summary.latest)}
          ${stat("Training streak", summary.streak)}
        </div>
        <button class="cf-btn primary" onclick="AthlevoConnect.finish()">Enter Dashboard</button>
      </div>
    `);
  }

  // Any dead end, in plain language, always with a way forward.
  function stepProblem(problem) {
    show(`
      <div class="cf-step">
        <div class="cf-icon muted">!</div>
        <h2 class="cf-title serif">${esc(problem.title)}</h2>
        <p class="cf-body">${esc(problem.body)}</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.handle('${esc(problem.action)}')">
          ${esc(problem.primary)}
        </button>
        ${problem.secondary ? `
          <button class="cf-btn secondary" onclick="AthlevoConnect.handle('${esc(problem.secondaryAction)}')">
            ${esc(problem.secondary)}
          </button>` : ""}
      </div>
    `);
  }

  function render() {
    switch (state.step) {
      case "explain":   return stepExplain();
      case "account":   return stepAccount();
      case "wearable":  return stepWearable();
      case "authorize": return stepAuthorize();
      case "detecting": return stepDetecting();
      case "success":   return stepSuccess(state.result);
      default:          return stepExplain();
    }
  }

  /* ═══════════════════════ orchestration ═══════════════════════════ */

  function openExternal(url) {
    try { window.open(url, "_blank", "noopener"); } catch (e) { location.href = url; }
  }

  async function authorize() {
    try {
      await DS().connect();   // navigates to the provider; callback returns
    } catch (error) {
      stepProblem(ACT().humanError(error));
    }
  }

  /*
   * Called when the athlete lands back in the app after authorizing. From
   * here everything is automatic: detect → import → summarize.
   */
  async function resumeAfterConnect() {
    markActive(true);
    restoreWearable();
    if (typeof showScreen === "function") showScreen("screen-connect");
    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "none";
    A().track("intervals_connected", { wearable: state.wearable || null });
    beginDetection();
  }

  function beginDetection() {
    state.detectStartedAt = Date.now();
    go("detecting");
    pollForActivities();
  }

  async function pollForActivities() {
    const found = await DS().detectActivities();

    if (found.authProblem) {
      A().track("sync_failed", { reason: "auth" });
      return stepProblem(ACT().humanError({ code: "RECONNECT_REQUIRED" }));
    }

    if (found.ok) {
      clearTimeout(state.detectTimer);
      A().track("activities_detected", { count: found.count });
      return runImport();
    }

    // Keep waiting — a watch that just linked may still be pushing history.
    if (Date.now() - state.detectStartedAt < timing.maxMs) {
      stepDetecting();
      state.detectTimer = setTimeout(pollForActivities, timing.pollMs);
      return;
    }

    A().track("no_activities");
    stepProblem(ACT().noActivitiesMessage());
  }

  /*
   * The automatic import. Stages are advanced around the REAL pipeline calls
   * — the animation reflects work actually happening, it isn't theatre on a
   * timer.
   */
  async function runImport() {
    A().track("initial_sync_started");
    stepImporting(1);

    let result = null;
    try {
      result = await DS().sync();
    } catch (error) {
      A().track("sync_failed", { reason: "sync" });
      return stepProblem(ACT().humanError(error));
    }

    stepImporting(3, result && result.imported
      ? `${result.imported} workouts imported` : null);

    // Rebuild the athlete's derived data through the existing pipeline.
    try {
      if (root.AthlevoBrain && root.AthlevoBrain.invalidateActivityCache) {
        root.AthlevoBrain.invalidateActivityCache();
      }
      stepImporting(4, null);
      if (root.AthlevoBrain && root.AthlevoBrain.refreshAthleteUI) {
        await root.AthlevoBrain.refreshAthleteUI();
      }
    } catch (error) {
      console.warn("Post-import refresh failed:", error);
    }

    stepImporting(5, null);
    const summary = await buildSummary(result);
    A().track("initial_sync_completed", {
      imported: (result && result.imported) || 0,
      withLaps: (result && result.withLaps) || 0
    });

    state.result = summary;
    go("success");
  }

  /*
   * Real numbers, read back from what actually landed. Uses the normal
   * loader — no special query — so the success screen shows exactly what the
   * dashboard will show. Nothing here is estimated or rounded up.
   */
  async function buildSummary(syncResult) {
    let activities = [];
    try {
      if (root.AthlevoBrain && root.AthlevoBrain.loadAthleteActivities) {
        activities = await root.AthlevoBrain.loadAthleteActivities("history",
          { forceRefresh: true });
      }
    } catch (e) { activities = []; }

    const runs = activities.filter(a =>
      /run/i.test(String(a.sport_type || a.activity_type || "")));
    const total = activities.length;
    const km = (m) => Math.round((Number(m) || 0) / 100) / 10;

    // Monday-start week, matching the rest of the app.
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(),
      now.getDate() - ((now.getDay() + 6) % 7)).getTime();
    const weeklyKm = km(runs
      .filter(a => Date.parse(a.start_date) >= monday)
      .reduce((s, a) => s + (Number(a.distance_meters) || 0), 0));

    const longest = runs.reduce((best, a) =>
      (Number(a.distance_meters) || 0) > (Number(best && best.distance_meters) || 0) ? a : best, null);

    const latest = runs[0] || null;
    const latestLabel = latest
      ? `${km(latest.distance_meters)} km` : null;

    // Consecutive days with a run, ending today or yesterday.
    const days = new Set(runs.map(a => String(a.start_date).slice(0, 10)));
    let streak = 0;
    for (let i = 0; i < 400; i += 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      if (days.has(d)) streak += 1;
      else if (i > 0) break;
    }

    const imported = (syncResult && syncResult.imported) || 0;
    return {
      headline: total > 0
        ? `We found ${total} workout${total === 1 ? "" : "s"}.`
        : "Your coach is ready.",
      subline: imported
        ? `We imported ${imported} and analyzed your training history.`
        : "We analyzed your training history.",
      weeklyKm: weeklyKm > 0 ? `${weeklyKm} km` : null,
      longestKm: longest ? `${km(longest.distance_meters)} km` : null,
      latest: latestLabel,
      streak: streak > 1 ? `${streak} days` : null,
      totalActivities: total,
      imported
    };
  }

  /* ═════════════════════════ public API ════════════════════════════ */

  const api = {
    // Entry point, called once the athlete profile is complete.
    async start() {
      markActive(true);
      restoreWearable();
      if (typeof showScreen === "function") showScreen("screen-connect");
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "none";

      // Already connected (e.g. they came back later) → skip straight to the
      // automatic part rather than re-explaining.
      try {
        const status = await DS().status();
        if (status && status.connected) return resumeAfterConnect();
      } catch (e) { /* treat as not connected */ }

      go("explain");
    },

    next: (step) => go(step),

    createAccount() {
      openExternal(DS().signupUrl);
      go("wearable");
    },

    openConnections() {
      openExternal(DS().connectionsUrl);
    },

    pickWearable(key) {
      rememberWearable(key);
      go("authorize");
    },

    authorize,
    resumeAfterConnect,

    handle(action) {
      if (action === "retry") return beginDetection();
      if (action === "wait") return beginDetection();
      if (action === "reconnect") return authorize();
      if (action === "openConnections") return api.openConnections();
      return beginDetection();
    },

    async finish() {
      markActive(false);
      clearTimeout(state.detectTimer);
      A().track("dashboard_opened");
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "flex";
      if (typeof showScreen === "function") showScreen("screen-today");
      try {
        if (root.AthlevoBrain && root.AthlevoBrain.refreshAthleteUI) {
          await root.AthlevoBrain.refreshAthleteUI();
        }
      } catch (e) { /* dashboard renders its own empty states */ }
    },

    isActive: wasActive,
    // Test-only: compress the detection wait. Untouched in production.
    _timing: timing,
    _state: state
  };

  root.AthlevoConnect = api;
})(typeof window !== "undefined" ? window : globalThis);

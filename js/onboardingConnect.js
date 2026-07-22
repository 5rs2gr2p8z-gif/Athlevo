
/*
 * PRODUCTION BUILD MARKER — executes the instant this file is parsed.
 * If __ATHLEVO_CONNECT_TRACE_VERSION is undefined in the console, the browser
 * is running an OLDER onboardingConnect.js (stale-while-revalidate cache).
 */
try { (typeof window !== "undefined" ? window : globalThis).__ATHLEVO_CONNECT_TRACE_VERSION = "connect-wizard-v2"; } catch (e) {}
/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Guided wearable onboarding (a first-run runner can follow it
 *  without asking anyone)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A completely non-technical runner must understand, at every screen:
 *    1. WHY a second (Sync) account is needed,
 *    2. WHAT to do next,
 *    3. WHAT happens after, and
 *    4. WHEN they are finished.
 *
 *  The wizard never sends the athlete to a bare login page cold. It explains
 *  first, names the Sync account and why it exists, walks connecting the watch
 *  explicitly, waits with visible progress, and confirms with real numbers.
 *
 *  Design rules (unchanged from the previous flow — still true):
 *   · The athlete never runs a command, refreshes, or sees a status code.
 *   · The connection service (Intervals.icu) is an implementation detail,
 *     disclosed exactly once, in the sentence explaining why the Sync account
 *     exists. Everywhere else it is the "Sync Partner".
 *   · Everything goes through AthlevoDataSource — never a provider directly —
 *     so a future direct Garmin/COROS integration changes only the adapter.
 *   · Nothing here alters sync, dedup, recognition, Score, the plan or Coach.
 */

(function (root) {
  "use strict";

  const A = () => root.AthlevoAnalytics;
  const DS = () => root.AthlevoDataSource;
  const ACT = () => root.AthlevoActivation;

  // The athlete-facing name for the sync layer, and the one-time technical
  // disclosure — both injected from the adapter, never hard-coded here.
  const partner = () => (DS() && DS().partnerName) || "Sync Partner";
  const serviceName = () => (DS() && DS().serviceName) || partner();

  const timing = { pollMs: 5000, maxMs: 90000 };

  const state = {
    step: null, wearable: null, detectStartedAt: 0, detectTimer: null,
    result: null, active: false, running: false, failed: false
  };

  const $ = (id) => document.getElementById(id);
  const mount = () => $("connectFlowBody");

  const FLAG = "athlevo_guided_setup";
  const WEARABLE_KEY = "athlevo_guided_wearable";

  function markActive(on) {
    state.active = on;
    try {
      if (on) sessionStorage.setItem(FLAG, "1");
      else { sessionStorage.removeItem(FLAG); sessionStorage.removeItem(WEARABLE_KEY); }
    } catch (e) {}
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
  function wearableLabel() {
    const w = DS().wearables.find(x => x.key === state.wearable);
    return w ? w.label : "Garmin";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function show(html) { const el = mount(); if (el) el.innerHTML = html; }
  function go(step) { state.step = step; render(); }

  /* ─────────────────── shared UI: progress + help + art ─────────────── */

  // A 4-phase indicator so the athlete always knows where they are and that
  // the flow is short. Phases: 1 Setup · 2 Account · 3 Connect · 4 Import.
  function progress(n) {
    const dots = [1, 2, 3, 4].map(i =>
      `<span class="cf-dot${i < n ? " done" : ""}${i === n ? " active" : ""}"></span>`).join("");
    return `<div class="cf-progress" role="img" aria-label="Step ${n} of 4">${dots}</div>`;
  }

  // PART 4 — the same short, plain help everywhere. One toggle, five answers.
  const FAQ = [
    ["Why do I need another account?",
      "It's the secure bridge that lets your watch send workouts to Athlevo. You sign in once and it runs in the background."],
    ["Is it free?", "Yes. The Sync account is completely free — there's nothing to pay."],
    ["Where do I connect Garmin?",
      "Inside the Sync Partner, under Connections. Athlevo opens it for you and brings you back."],
    ["Can I delete it later?", "Anytime. Disconnecting stops all syncing immediately, from You → Connections."],
    ["Which watches are supported?", "Garmin, COROS, Polar, Apple Watch, Suunto, Strava and more."]
  ];
  function helpBlock() {
    return `
      <div class="cf-help">
        <button class="cf-help-toggle" onclick="AthlevoConnect.toggleHelp()">Need help?</button>
        <div id="cfHelpBody" class="cf-help-body" style="display:none">
          ${FAQ.map(([q, a]) => `<div class="cf-faq"><b>${esc(q)}</b><p>${esc(a)}</p></div>`).join("")}
        </div>
      </div>`;
  }
  function toggleHelp() {
    const el = $("cfHelpBody");
    if (el) el.style.display = (el.style.display === "none" ? "" : "none");
  }

  // Large, flat, premium line illustrations — no photos, no emoji.
  const ART = {
    link: `<svg class="cf-art" viewBox="0 0 120 120" aria-hidden="true"><rect x="18" y="30" width="84" height="60" rx="14"/><circle cx="42" cy="60" r="9"/><circle cx="78" cy="60" r="9"/><path d="M51 60h18"/></svg>`,
    account: `<svg class="cf-art" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="46" r="18"/><path d="M28 92c4-18 18-27 32-27s28 9 32 27"/></svg>`,
    watch: `<svg class="cf-art" viewBox="0 0 120 120" aria-hidden="true"><rect x="40" y="34" width="40" height="52" rx="12"/><path d="M50 34l3-14h14l3 14M50 86l3 14h14l3-14"/><path d="M60 52v10l7 5"/></svg>`,
    check: `<svg class="cf-art ok" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="40"/><path d="M44 61l12 12 22-26"/></svg>`,
    search: `<svg class="cf-art" viewBox="0 0 120 120" aria-hidden="true"><circle cx="54" cy="54" r="26"/><path d="M74 74l18 18"/></svg>`
  };

  /* ═══════════════════════════ steps ═══════════════════════════════ */

  /*
   * STEP 1 — "Connect your training data".
   * One sentence on WHY, the supported platforms, an honest time estimate,
   * and a single Continue. No redirect yet — nothing scary has happened.
   */
  function stepIntro() {
    A().track("connect_step_viewed");
    const chips = DS().wearables.map(w => {
      const on = state.wearable === w.key ? " selected" : "";
      return `<button class="cf-chip${on}" onclick="AthlevoConnect.pickWearable('${esc(w.key)}')">${esc(w.label)}</button>`;
    }).join("");
    show(`
      <div class="cf-step">
        ${progress(1)}
        ${ART.link}
        <h2 class="cf-title serif">Connect your training data</h2>
        <p class="cf-body">Athlevo securely imports your workouts using our Sync Partner — so your coaching is built from how you actually train.</p>
        <div class="cf-platnote">Works with</div>
        <div class="cf-chips">${chips}</div>
        <div class="cf-time">Takes about 2 minutes</div>
        <button class="cf-btn primary" onclick="AthlevoConnect.continueToAccount()">Continue</button>
        <button class="cf-link" onclick="AthlevoConnect.skipConnection()">I don't have a watch yet</button>
        ${helpBlock()}
      </div>
    `);
  }

  /*
   * STEP 2 — "Create your free Sync account".
   * Explains WHY plainly and makes it clear this is normal and free. This is
   * the ONE place the underlying service is named. Continue starts the secure
   * sign-in (our OAuth) through the adapter.
   */
  function stepAccount() {
    show(`
      <div class="cf-step">
        ${progress(2)}
        ${ART.account}
        <h2 class="cf-title serif">Create your free Sync account</h2>
        <p class="cf-body">This free account lets Athlevo receive your workouts from Garmin, COROS, Polar and others. It's the standard, secure way training apps connect to your watch — most runners set it up once and forget it.</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.authorize()">Create free account &amp; continue</button>
        <p class="cf-note small">Your Sync Partner is ${esc(serviceName())}. Athlevo only ever <b>reads</b> your workouts — it never posts, edits or deletes anything.</p>
        ${helpBlock()}
      </div>
    `);
  }

  /*
   * STEP 3 — "Connect Garmin".
   * Reached when the athlete is signed in to the Sync account but the watch
   * itself isn't linked yet, so there is genuinely nothing to import. Named
   * as the missing step, with an exact three-line how-to.
   */
  function stepConnectGarmin() {
    const name = wearableLabel();
    show(`
      <div class="cf-step">
        ${progress(3)}
        ${ART.watch}
        <h2 class="cf-title serif">Connect ${esc(name)}</h2>
        <ol class="cf-howto">
          <li><b>Open the Sync Partner</b><small>We'll take you there.</small></li>
          <li><b>Connect ${esc(name)}</b><small>Tap ${esc(name)} and sign in once.</small></li>
          <li><b>Return to Athlevo</b><small>We'll automatically detect your workouts.</small></li>
        </ol>
        <button class="cf-btn primary" onclick="AthlevoConnect.openConnections()">Open Sync Partner</button>
        <button class="cf-link" onclick="AthlevoConnect.handle('wait')">I've done this — check now</button>
        ${helpBlock()}
      </div>
    `);
  }

  // STEP 4 — waiting. Never a blank screen: pulse + honest reassurance.
  function stepDetecting() {
    const waited = Math.round((Date.now() - state.detectStartedAt) / 1000);
    show(`
      <div class="cf-step center">
        ${progress(4)}
        <div class="cf-pulse"></div>
        <h2 class="cf-title serif">Checking for workouts…</h2>
        <p class="cf-body">We're importing your training history. This can take a minute right after connecting a watch — you don't need to do anything.</p>
        ${waited > 25 ? `<p class="cf-note small">Still checking… ${waited}s</p>` : ""}
      </div>
    `);
  }

  // STEP 4 (import) — honest progress around the REAL pipeline calls.
  const IMPORT_STAGES = [
    "Connected", "Importing workouts", "Reading lap and interval data",
    "Building your athlete profile", "Analyzing training history", "Preparing your AI coach"
  ];
  function stepImporting(activeIndex, counts) {
    const rows = IMPORT_STAGES.map((label, i) => {
      const cls = i < activeIndex ? "done" : (i === activeIndex ? "active" : "pending");
      const mark = i < activeIndex ? "✓" : "";
      return `<li class="cf-stage ${cls}"><span class="cf-stage-mark">${mark}</span>${esc(label)}</li>`;
    }).join("");
    show(`
      <div class="cf-step">
        ${progress(4)}
        <h2 class="cf-title serif">Setting up your coach</h2>
        <ul class="cf-stages">${rows}</ul>
        ${counts ? `<p class="cf-note small">${esc(counts)}</p>` : ""}
      </div>
    `);
  }

  // STEP 5 — success, in the athlete's own numbers, with the finish line named.
  function stepSuccess(summary) {
    const stat = (label, value) => value
      ? `<div class="cf-stat"><b>${esc(value)}</b><small>${esc(label)}</small></div>` : "";
    show(`
      <div class="cf-step center">
        ${ART.check}
        <span class="cf-confirm">${esc(wearableLabel())} connected</span>
        <h2 class="cf-title serif">${esc(summary.headline)}</h2>
        <p class="cf-body">Your AI coach is now ready.</p>
        <div class="cf-stats">
          ${stat("This week", summary.weeklyKm)}
          ${stat("Longest run", summary.longestKm)}
          ${stat("Most recent", summary.latest)}
          ${stat("Training streak", summary.streak)}
        </div>
        <div id="analysisCelebration"></div>
        <button class="cf-btn primary" onclick="AthlevoConnect.finish()">Continue to Athlevo</button>
      </div>
    `);
    try {
      if (root.AthlevoCoach && root.AthlevoBrain && root.AthlevoBrain.loadAthleteActivities) {
        root.AthlevoBrain.loadAthleteActivities().then(function (acts) {
          root.AthlevoCoach.renderCelebration(acts, "analysisCelebration");
        }).catch(function () {});
      }
    } catch (e) {}
  }

  /*
   * PART 3 — the athlete came back but the watch isn't connected (they bounced
   * off the sign-in, or closed the tab). Never a silent failure: name it and
   * give three ways forward.
   */
  function stepNotConnected() {
    const name = wearableLabel();
    show(`
      <div class="cf-step">
        ${progress(3)}
        <div class="cf-icon muted">!</div>
        <h2 class="cf-title serif">Looks like ${esc(name)} isn't connected yet</h2>
        <p class="cf-body">No problem — this is the most common hiccup. Let's finish linking your watch so Athlevo can import your workouts.</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">Reconnect</button>
        <button class="cf-btn secondary" onclick="AthlevoConnect.openConnections()">Open Sync Partner</button>
        <button class="cf-link" onclick="AthlevoConnect.skipConnection()">I'll do this later</button>
        ${helpBlock()}
      </div>
    `);
  }

  /* ── connection-attempt failures (distinct from "connected, no data") ── */
  function stepConnectFailed(reason, message) {
    state.failed = true;
    clearTimeout(state.detectTimer);

    if (reason === "SESSION_CHANGED") {
      show(`
        <div class="cf-step">
          <div class="cf-icon muted">!</div>
          <h2 class="cf-title serif">Your account changed while connecting</h2>
          <p class="cf-body">Your Athlevo account changed while connecting your training data. For security, please restart the connection from the account you want to use.</p>
          <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">Restart connection</button>
          <button class="cf-link" onclick="AthlevoConnect.skipConnection()">Continue without my history for now</button>
          ${helpBlock()}
        </div>`);
      return;
    }
    if (reason === "COMPLETION_EXPIRED" || reason === "COMPLETION_INVALID" ||
        reason === "COMPLETION_MISSING" || reason === "UNAUTHENTICATED") {
      show(`
        <div class="cf-step">
          <div class="cf-icon muted">!</div>
          <h2 class="cf-title serif">That connection didn't finish</h2>
          <p class="cf-body">${reason === "COMPLETION_EXPIRED"
            ? "The connection took a little too long to complete."
            : "The connection link was already used or is no longer valid."} Starting again takes a few seconds.</p>
          <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">Restart connection</button>
          <button class="cf-link" onclick="AthlevoConnect.skipConnection()">Continue without my history for now</button>
          ${helpBlock()}
        </div>`);
      return;
    }
    if (reason === "already_linked" || reason === "ALREADY_LINKED") {
      show(`
        <div class="cf-step">
          <div class="cf-icon muted">!</div>
          <h2 class="cf-title serif">That account is already in use</h2>
          <p class="cf-body">This ${esc(serviceName())} account is already connected to a different Athlevo account. For your security we won't move it automatically.</p>
          <ol class="cf-guide">
            <li>Sign in to your <b>other Athlevo account</b> and disconnect it there, or</li>
            <li>Use a <b>different ${esc(serviceName())} account</b> for this one</li>
          </ol>
          <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">Try a different account</button>
          <button class="cf-link" onclick="AthlevoConnect.skipConnection()">Continue without my history for now</button>
          ${helpBlock()}
        </div>`);
      return;
    }
    show(`
      <div class="cf-step">
        <div class="cf-icon muted">!</div>
        <h2 class="cf-title serif">We couldn&#39;t finish connecting</h2>
        <p class="cf-body">${esc(message || "The connection didn't complete. Nothing was changed — please try again.")}</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">Try again</button>
        <button class="cf-link" onclick="AthlevoConnect.skipConnection()">Continue without my history for now</button>
        ${helpBlock()}
      </div>`);
  }

  function stepProblem(problem) {
    state.running = false;
    show(`
      <div class="cf-step">
        <div class="cf-icon muted">!</div>
        <h2 class="cf-title serif">${esc(problem.title)}</h2>
        <p class="cf-body">${esc(problem.body)}</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.handle('${esc(problem.action)}')">${esc(problem.primary)}</button>
        ${problem.secondary ? `<button class="cf-btn secondary" onclick="AthlevoConnect.handle('${esc(problem.secondaryAction)}')">${esc(problem.secondary)}</button>` : ""}
        ${helpBlock()}
      </div>`);
  }

  function render() {
    switch (state.step) {
      case "intro":         return stepIntro();
      case "account":       return stepAccount();
      case "connectGarmin": return stepConnectGarmin();
      case "detecting":     return stepDetecting();
      case "notConnected":  return stepNotConnected();
      case "success":       return stepSuccess(state.result);
      default:              return stepIntro();
    }
  }

  /* ═══════════════════════ orchestration ═══════════════════════════ */

  function openExternal(url) {
    try { window.open(url, "_blank", "noopener"); } catch (e) { location.href = url; }
  }
  const stage = (s, d) => { try { if (root.__athlevoOAuthStage) root.__athlevoOAuthStage(s, d); } catch (e) {} };

  async function authorize() {
    stage("connect_button_clicked");
    try {
      stage("authorize_entered", { hasDataSource: Boolean(DS()) });
      await DS().connect();
    } catch (error) {
      stage("authorize_failed", { message: (error && error.message) || "unknown" });
      stepProblem(ACT().humanError(error));
    }
  }

  async function resumeAfterConnect() {
    if (state.running || state.failed) return;
    state.running = true;

    restoreWearable();
    if (typeof showScreen === "function") showScreen("screen-connect");
    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "none";

    let status = null;
    try { status = await DS().status(); } catch (error) { status = null; }

    if (!status || status.connected !== true) {
      state.running = false;
      return notConnectedYet(status ? "disconnected" : "unknown");
    }

    markActive(true);
    A().track("intervals_connected", { wearable: state.wearable || null });
    beginDetection();
  }

  // Not connected → the clear Part-3 edge screen (never a silent bounce back).
  function notConnectedYet(reason) {
    A().track("no_activities", { reason: "not_connected_" + reason });
    const wearable = state.wearable;
    markActive(false);
    state.wearable = wearable;              // keep their platform for the copy
    clearTimeout(state.detectTimer);
    go("notConnected");
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
    if (Date.now() - state.detectStartedAt < timing.maxMs) {
      stepDetecting();
      state.detectTimer = setTimeout(pollForActivities, timing.pollMs);
      return;
    }
    A().track("no_activities");
    go("connectGarmin");                    // connected, but the watch isn't linked yet
  }

  async function runImport() {
    A().track("initial_sync_started");
    stepImporting(1);
    let result = null;
    try { result = await DS().sync(); }
    catch (error) { A().track("sync_failed", { reason: "sync" }); return stepProblem(ACT().humanError(error)); }

    stepImporting(3, result && result.imported ? `${result.imported} workouts imported` : null);
    try {
      if (root.AthlevoBrain && root.AthlevoBrain.invalidateActivityCache) root.AthlevoBrain.invalidateActivityCache();
      stepImporting(4, null);
      if (root.AthlevoBrain && root.AthlevoBrain.refreshAthleteUI) await root.AthlevoBrain.refreshAthleteUI();
    } catch (error) { console.warn("Post-import refresh failed:", error); }

    stepImporting(5, null);
    const summary = await buildSummary(result);
    A().track("initial_sync_completed", {
      imported: (result && result.imported) || 0, withLaps: (result && result.withLaps) || 0
    });
    state.result = summary;
    go("success");
  }

  async function buildSummary(syncResult) {
    let activities = [];
    try {
      if (root.AthlevoBrain && root.AthlevoBrain.loadAthleteActivities) {
        activities = await root.AthlevoBrain.loadAthleteActivities("history", { forceRefresh: true });
      }
    } catch (e) { activities = []; }

    const runs = activities.filter(a => /run/i.test(String(a.sport_type || a.activity_type || "")));
    const total = activities.length;
    const km = (m) => Math.round((Number(m) || 0) / 100) / 10;

    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(),
      now.getDate() - ((now.getDay() + 6) % 7)).getTime();
    const weeklyKm = km(runs.filter(a => Date.parse(a.start_date) >= monday)
      .reduce((s, a) => s + (Number(a.distance_meters) || 0), 0));
    const longest = runs.reduce((best, a) =>
      (Number(a.distance_meters) || 0) > (Number(best && best.distance_meters) || 0) ? a : best, null);
    const latest = runs[0] || null;
    const latestLabel = latest ? `${km(latest.distance_meters)} km` : null;

    const days = new Set(runs.map(a => String(a.start_date).slice(0, 10)));
    let streak = 0;
    for (let i = 0; i < 400; i += 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      if (days.has(d)) streak += 1; else if (i > 0) break;
    }
    const imported = (syncResult && syncResult.imported) || 0;
    return {
      headline: total > 0 ? `We found ${total} workout${total === 1 ? "" : "s"}.` : "Your coach is ready.",
      weeklyKm: weeklyKm > 0 ? `${weeklyKm} km` : null,
      longestKm: longest ? `${km(longest.distance_meters)} km` : null,
      latest: latestLabel,
      streak: streak > 1 ? `${streak} days` : null,
      totalActivities: total, imported
    };
  }

  /* ═════════════════════════ public API ════════════════════════════ */

  const api = {
    async start() {
      markActive(true);
      state.failed = false;
      restoreWearable();
      if (typeof showScreen === "function") showScreen("screen-connect");
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "none";

      // Already connected (returning athlete) → skip explanation, go automatic.
      try {
        const status = await DS().status();
        if (status && status.connected) return resumeAfterConnect();
      } catch (e) {}

      go("intro");
    },

    next: (step) => go(step),

    // Step 1: select a platform (cosmetic personalisation) — stays on intro.
    pickWearable(key) { rememberWearable(key); if (state.step === "intro") stepIntro(); },

    // Step 1 → Step 2.
    continueToAccount() {
      if (!state.wearable) rememberWearable("garmin");
      go("account");
    },

    createAccount() { openExternal(DS().signupUrl); },
    openConnections() { openExternal(DS().connectionsUrl); },

    authorize,
    resumeAfterConnect,
    toggleHelp,

    async skipConnection() {
      A().track("no_activities", { reason: "skipped" });
      show(`
        <div class="cf-step center">
          <div class="cf-pulse"></div>
          <h2 class="cf-title serif">No problem</h2>
          <p class="cf-body">We'll build your plan from your profile, and it'll get sharper the moment you connect a watch. You can do that any time from You.</p>
        </div>`);
      return api.finish();
    },

    handle(action) {
      state.running = false;
      if (action === "retry") return beginDetection();
      if (action === "wait") return beginDetection();
      if (action === "reconnect") return authorize();
      if (action === "openConnections") return api.openConnections();
      return beginDetection();
    },

    async finish() {
      markActive(false);
      state.running = false;
      clearTimeout(state.detectTimer);
      A().track("dashboard_opened");
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "flex";
      try {
        if (root.AthlevoBrain && root.AthlevoBrain.refreshAthleteUI) await root.AthlevoBrain.refreshAthleteUI();
      } catch (e) {}
      if (root.AthlevoPlan && typeof root.AthlevoPlan.autoBuildFirstPlan === "function") {
        try { await root.AthlevoPlan.autoBuildFirstPlan(); return; }
        catch (e) { console.warn("Plan handoff failed:", e); }
      }
      if (typeof showScreen === "function") showScreen("screen-today");
    },

    isActive: wasActive,
    hasFailed: () => state.failed,

    showConnectFailure(reason, message) {
      markActive(true);
      state.running = false;
      if (typeof showScreen === "function") showScreen("screen-connect");
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "none";
      A().track("sync_failed", { reason: reason || "connect_failed" });
      stepConnectFailed(reason, message);
    },

    retryConnect() {
      state.failed = false;
      state.running = false;
      go("account");                        // back to the account step, not a cold login
    },

    _timing: timing,
    _state: state
  };

  root.AthlevoConnect = api;
})(typeof window !== "undefined" ? window : globalThis);

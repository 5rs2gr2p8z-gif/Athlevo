
/*
 * PRODUCTION BUILD MARKER — executes the instant this file is parsed.
 *
 * Runtime-cached JS is served stale-while-revalidate, so the first load after
 * a deploy can still run the PREVIOUS copy of this file. Checking a behaviour
 * (a stage log, a network call) cannot distinguish "code is stale" from "code
 * ran and took a different branch". This marker can: if it is undefined in
 * the console, the browser is executing an older onboardingConnect.js.
 */
try { (typeof window !== "undefined" ? window : globalThis).__ATHLEVO_CONNECT_TRACE_VERSION = "connect-trace-v1"; } catch (e) {}
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
    active: false,
    running: false,  // guards against double-entry on the OAuth return
    failed: false    // the connection attempt itself failed; do not resume
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
   * Step 1 — DEVICE FIRST.
   *
   * This used to open with a page explaining our connection service, then a
   * page asking whether they had an account with it. Both asked the athlete
   * to understand our plumbing before they had done anything. A runner knows
   * exactly one thing here: what they run with. So that is the first question,
   * and the "why" rides along in a single line beneath it.
   */
  function stepDevice() {
    A().track("connect_step_viewed");
    const items = DS().wearables.map(w => `
      <button class="cf-device" onclick="AthlevoConnect.pickWearable('${esc(w.key)}')">
        <span class="cf-device-name">${esc(w.label)}</span>
      </button>
    `).join("");

    show(`
      <div class="cf-step">
        <h2 class="cf-title serif">What do you run with?</h2>
        <p class="cf-body">
          Athlevo reads your past workouts to learn your paces, your volume and
          how you recover — that's what makes the coaching yours.
        </p>
        <div class="cf-device-grid">${items}</div>
        <button class="cf-link" onclick="AthlevoConnect.skipConnection()">
          I don't have a watch yet
        </button>
      </div>
    `);
  }

  /*
   * Step 2 — connect that device.
   *
   * IMPORTANT: there are TWO separate links, and conflating them is what
   * made real athletes land on "no workouts found":
   *
   *   A. Garmin  → Intervals   (the athlete does this inside Intervals)
   *   B. Intervals → Athlevo   (our OAuth)
   *
   * Our OAuth only ever performs B. If A has never been done, the account we
   * are authorised to read is genuinely empty. So the athlete is walked
   * through A first, explicitly, before we ask for B.
   */
  function stepAuthorize() {
    const w = DS().wearables.find(x => x.key === state.wearable);
    const name = w ? w.label : "your watch";
    show(`
      <div class="cf-step">
        <h2 class="cf-title serif">Connect ${esc(name)}</h2>
        <p class="cf-body">
          ${esc(name)} sends your workouts to Athlevo through
          ${esc(DS().serviceName)}, a free service that sits in between.
          It's a two-minute setup, once.
        </p>
        <ol class="cf-guide">
          <li><b>Create or sign in</b> to your ${esc(DS().serviceName)} account</li>
          <li>Open <b>Settings</b>, then find <b>Connections</b></li>
          <li>Choose <b>${esc(name)}</b> and sign in with your ${esc(name)} account</li>
          <li><b>Wait for the sync</b> — your history can take a few minutes to appear</li>
          <li>Come back here and continue</li>
        </ol>
        <button class="cf-btn secondary" onclick="AthlevoConnect.openConnections()">
          Open ${esc(DS().serviceName)} connections
        </button>
        <button class="cf-btn primary" onclick="AthlevoConnect.authorize()">
          I've connected ${esc(name)} — continue
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

    /*
     * Confirms the CONNECTION worked before the athlete reaches the
     * dashboard, in their own numbers. Deliberately does NOT start plan
     * generation — the athlete chooses that from Today, so a generation
     * failure can never hijack a successful import.
     */
    show(`
      <div class="cf-step">
        <div class="cf-icon">✓</div>
        <span class="cf-confirm">Training history imported</span>
        <h2 class="cf-title serif">${esc(summary.headline)}</h2>
        <p class="cf-body">${esc(summary.subline)}</p>
        <div class="cf-stats">
          ${stat("This week", summary.weeklyKm)}
          ${stat("Longest run", summary.longestKm)}
          ${stat("Most recent", summary.latest)}
          ${stat("Training streak", summary.streak)}
        </div>
        <p class="cf-note">Next: create your training plan from the dashboard.</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.finish()">Continue</button>
      </div>
    `);
  }

  /*
   * The most common real outcome of a first connection: the athlete
   * authorised Athlevo, but has not yet linked their watch INSIDE the
   * connection service — so there is genuinely nothing to read. That is not
   * an error, it is a missing step, and it must be named as one.
   */
  function stepNoWorkoutsYet() {
    const w = DS().wearables.find(x => x.key === state.wearable);
    const name = w ? w.label : "your watch";
    show(`
      <div class="cf-step">
        <div class="cf-icon muted">!</div>
        <h2 class="cf-title serif">Almost there</h2>
        <p class="cf-body">
          Athlevo is connected, but we can't see any workouts yet. That
          usually means ${esc(name)} isn't linked inside
          ${esc(DS().serviceName)} — or it's still syncing.
        </p>
        <ol class="cf-guide">
          <li>Open ${esc(DS().serviceName)} <b>Settings → Connections</b></li>
          <li>Check that <b>${esc(name)}</b> is connected</li>
          <li>Give it a few minutes to pull your history across</li>
        </ol>
        <button class="cf-btn secondary" onclick="AthlevoConnect.openConnections()">
          Open ${esc(DS().serviceName)} connections
        </button>
        <button class="cf-btn primary" onclick="AthlevoConnect.handle('retry')">
          Check again
        </button>
        <button class="cf-link" onclick="AthlevoConnect.skipConnection()">
          Continue without my history for now
        </button>
      </div>
    `);
  }

  /*
   * The connection attempt itself failed, so nothing was saved. This is
   * distinct from "connected but no workouts" — and conflating them is what
   * made a real athlete see "we couldn't find any workouts" when the truth
   * was that their Intervals account is already linked to a different
   * Athlevo account and the connection was never persisted.
   */
  function stepConnectFailed(reason, message) {
    state.failed = true;
    clearTimeout(state.detectTimer);

    /*
     * The Athlevo session changed between starting the connection and
     * returning from it. The server refused to save rather than move the
     * connection between accounts. This is a security outcome, not a data
     * outcome — the athlete must never see "no workouts found" here.
     */
    if (reason === "SESSION_CHANGED") {
      show(`
        <div class="cf-step">
          <div class="cf-icon muted">!</div>
          <h2 class="cf-title serif">Your account changed while connecting</h2>
          <p class="cf-body">
            Your Athlevo account changed while connecting your training data.
            For security, please restart the connection from the account you
            want to use.
          </p>
          <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">
            Restart connection
          </button>
          <button class="cf-link" onclick="AthlevoConnect.skipConnection()">
            Continue without my history for now
          </button>
        </div>
      `);
      return;
    }

    /*
     * The handoff expired or was already used. Both are ordinary and both are
     * fixed the same way, so they share one calm screen.
     */
    if (reason === "COMPLETION_EXPIRED" || reason === "COMPLETION_INVALID" ||
        reason === "COMPLETION_MISSING" || reason === "UNAUTHENTICATED") {
      show(`
        <div class="cf-step">
          <div class="cf-icon muted">!</div>
          <h2 class="cf-title serif">That connection didn't finish</h2>
          <p class="cf-body">
            ${reason === "COMPLETION_EXPIRED"
              ? "The connection took a little too long to complete."
              : "The connection link was already used or is no longer valid."}
            Starting again takes a few seconds.
          </p>
          <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">
            Restart connection
          </button>
          <button class="cf-link" onclick="AthlevoConnect.skipConnection()">
            Continue without my history for now
          </button>
        </div>
      `);
      return;
    }

    if (reason === "already_linked" || reason === "ALREADY_LINKED") {
      show(`
        <div class="cf-step">
          <div class="cf-icon muted">!</div>
          <h2 class="cf-title serif">That account is already in use</h2>
          <p class="cf-body">
            This ${esc(DS().serviceName)} account is already connected to a
            different Athlevo account. For your security we won't move it
            automatically.
          </p>
          <ol class="cf-guide">
            <li>Sign in to your <b>other Athlevo account</b> and disconnect it there, or</li>
            <li>Use a <b>different ${esc(DS().serviceName)} account</b> for this one</li>
          </ol>
          <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">
            Try a different account
          </button>
          <button class="cf-link" onclick="AthlevoConnect.skipConnection()">
            Continue without my history for now
          </button>
        </div>
      `);
      return;
    }

    show(`
      <div class="cf-step">
        <div class="cf-icon muted">!</div>
        <h2 class="cf-title serif">We couldn&#39;t finish connecting</h2>
        <p class="cf-body">${esc(message || "The connection didn't complete. Nothing was changed — please try again.")}</p>
        <button class="cf-btn primary" onclick="AthlevoConnect.retryConnect()">Try again</button>
        <button class="cf-link" onclick="AthlevoConnect.skipConnection()">
          Continue without my history for now
        </button>
      </div>
    `);
  }

  // Any dead end, in plain language, always with a way forward.
  function stepProblem(problem) {
    state.running = false;   // this attempt is over; allow a retry
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
      case "device":    return stepDevice();
      case "authorize": return stepAuthorize();
      case "detecting": return stepDetecting();
      case "success":   return stepSuccess(state.result);
      default:          return stepDevice();
    }
  }

  /* ═══════════════════════ orchestration ═══════════════════════════ */

  function openExternal(url) {
    try { window.open(url, "_blank", "noopener"); } catch (e) { location.href = url; }
  }

  /*
   * TEMPORARY STAGE TRAIL (js/onboardingConnect.js, js/activation.js,
   * js/brain.js). Production shows repeated action=diagnose and NO
   * action=connect, so the click path dies somewhere between the button and
   * fetch(). Source inspection says every hop is wired correctly, so the
   * trail records which hop is actually reached. Names and error messages
   * only — never a token, secret or credential.
   */
  const stage = (s, d) => {
    try { if (root.__athlevoOAuthStage) root.__athlevoOAuthStage(s, d); } catch (e) {}
  };

  async function authorize() {
    // If this line does not appear, the click never reached the handler.
    stage("connect_button_clicked");
    try {
      stage("authorize_entered", { hasDataSource: Boolean(DS()) });
      await DS().connect();   // navigates to the provider; callback returns
    } catch (error) {
      // The swallowed error. This is what a problem screen was hiding.
      stage("authorize_failed", { message: (error && error.message) || "unknown" });
      stepProblem(ACT().humanError(error));
    }
  }

  /*
   * Called when the athlete lands back in the app after authorizing. From
   * here everything is automatic: detect → import → summarize.
   */
  async function resumeAfterConnect() {
    /*
     * Re-entrancy guard. On the OAuth return index.html reaches this from TWO
     * places: the ?intervals=connected handler, and routeAfterAuth() during
     * session restore. Without this guard both fire, producing two detection
     * loops competing for the screen and a second sync that the server's
     * 5-minute lock rejects — surfacing a spurious "still working" error in
     * the middle of a successful import.
     */
    // A failed connect must never fall through into detection: there is no
    // connection to detect against, and doing so replaced an accurate error
    // with a misleading "no workouts found" screen.
    if (state.running || state.failed) return;
    state.running = true;

    restoreWearable();
    if (typeof showScreen === "function") showScreen("screen-connect");
    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "none";

    /*
     * ═══ THE GUARD ═══
     *
     * sessionStorage.athlevo_guided_setup was being treated as proof that
     * OAuth had happened. It is not: it only records that guided setup was
     * STARTED, and it survives every reload. routeAfterAuth() resumed on that
     * flag alone, so a disconnected athlete was sent straight to
     * "Looking for your workouts" and polled diagnose forever — never seeing
     * the Connect button that would have fixed it. The loop was self-
     * sustaining, because the flag is only cleared on a completed setup.
     *
     * The server is the only authority on whether a provider is connected.
     * We ask it, every time, before any detection starts. This check lives
     * HERE rather than in routeAfterAuth so that every caller — the OAuth
     * return, session restore, and any future one — is covered by
     * construction.
     */
    let status = null;
    try {
      status = await DS().status();
    } catch (error) {
      status = null;      // unreachable is NOT connected
    }

    if (!status || status.connected !== true) {
      state.running = false;
      return notConnectedYet(status ? "disconnected" : "unknown");
    }

    markActive(true);
    A().track("intervals_connected", { wearable: state.wearable || null });
    beginDetection();
  }

  /*
   * No verified provider connection. Clear the stale guided-setup state so a
   * reload cannot resurrect the detection loop, then put the athlete back on
   * the step that can actually fix it — keeping the wearable they already
   * chose so they do not repeat that choice.
   */
  function notConnectedYet(reason) {
    A().track("no_activities", { reason: "not_connected_" + reason });

    // Capture the wearable BEFORE clearing storage; markActive(false) drops it.
    const wearable = state.wearable;
    markActive(false);
    state.wearable = wearable;

    clearTimeout(state.detectTimer);
    go(wearable ? "authorize" : "device");
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
    stepNoWorkoutsYet();
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
      state.failed = false;
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

      go("device");
    },

    next: (step) => go(step),

    createAccount() {
      // Opens the connection service in a new tab. They come straight back to
      // the same screen and tap Connect — no extra step in our flow.
      openExternal(DS().signupUrl);
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

    /*
     * No watch, or not now. Athlevo still works: the plan is built from the
     * completed profile, and it improves the moment training data arrives.
     * A dead end here would lose the athlete entirely.
     */
    async skipConnection() {
      A().track("no_activities", { reason: "skipped" });
      show(`
        <div class="cf-step center">
          <div class="cf-pulse"></div>
          <h2 class="cf-title serif">No problem</h2>
          <p class="cf-body">
            We'll build your plan from your profile, and it'll get sharper as
            soon as you connect a watch. You can do that any time from You.
          </p>
        </div>
      `);
      return api.finish();
    },

    handle(action) {
      // A problem screen is terminal for this attempt — releasing the guard
      // lets Try again / Reconnect actually restart the flow.
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
        if (root.AthlevoBrain && root.AthlevoBrain.refreshAthleteUI) {
          await root.AthlevoBrain.refreshAthleteUI();
        }
      } catch (e) { /* dashboard renders its own empty states */ }

      /*
       * Hand off to the plan layer. It decides whether to generate
       * automatically or land on the dashboard with the "Create My Training
       * Plan" card visible — governed by ONE constant (AUTO_FIRST_PLAN in
       * js/planSetup.js), currently OFF while the generation pipeline is
       * verified with real production athletes.
       *
       * Onboarding does not need to know which mode is active.
       */
      if (root.AthlevoPlan && typeof root.AthlevoPlan.autoBuildFirstPlan === "function") {
        try { await root.AthlevoPlan.autoBuildFirstPlan(); return; }
        catch (e) { console.warn("Plan handoff failed:", e); }
      }
      if (typeof showScreen === "function") showScreen("screen-today");
    },

    isActive: wasActive,

    // True when the last connection attempt failed and nothing was saved.
    // routeAfterAuth checks this so it never resumes into detection against
    // a connection that does not exist.
    hasFailed: () => state.failed,

    // Called by the OAuth-return handler with the real reason.
    showConnectFailure(reason, message) {
      markActive(true);
      state.running = false;
      if (typeof showScreen === "function") showScreen("screen-connect");
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "none";
      A().track("sync_failed", { reason: reason || "connect_failed" });
      stepConnectFailed(reason, message);
    },

    // Start a fresh attempt after a failure.
    retryConnect() {
      state.failed = false;
      state.running = false;
      go("device");
    },
    // Test-only: compress the detection wait. Untouched in production.
    _timing: timing,
    _state: state
  };

  root.AthlevoConnect = api;
})(typeof window !== "undefined" ? window : globalThis);

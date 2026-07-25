
/*
 * PRODUCTION BUILD MARKER — executes the instant this file is parsed.
 *
 * Runtime-cached JS is served stale-while-revalidate, so the first load after
 * a deploy can still run the PREVIOUS copy of this file. Checking a behaviour
 * (a stage log, a network call) cannot distinguish "code is stale" from "code
 * ran and took a different branch". This marker can: if it is undefined in
 * the console, the browser is executing an older activation.js.
 */
try { (typeof window !== "undefined" ? window : globalThis).__ATHLEVO_ACTIVATION_TRACE_VERSION = "connect-trace-v1"; } catch (e) {}
/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Activation layer
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Two things, both deliberately thin:
 *
 *  1. AthlevoAnalytics — funnel events, written best-effort. An analytics
 *     failure must NEVER block an athlete from finishing setup, so every
 *     write is fire-and-forget and swallows its own errors.
 *
 *  2. AthlevoDataSource — a PROVIDER-AGNOSTIC training-data adapter.
 *
 *     Onboarding talks only to this interface: connect(), status(),
 *     detectActivities(), sync(). Today it is implemented by Intervals.icu.
 *     When direct Garmin / COROS / Polar integrations replace it, only this
 *     adapter changes — the onboarding screens, copy structure, progress
 *     animation and success screen all stay exactly as they are.
 *
 *     That is why nothing below hard-codes "Intervals" into a UI decision.
 *     The provider is an implementation detail; the athlete is connecting
 *     "your training data" to Athlevo.
 *
 *  Changes NOTHING about sync, dedup, classification, Score or Coach — it
 *  only calls the existing production functions in the right order.
 */

(function (root) {
  "use strict";

  /* ═══════════════════════════ analytics ═══════════════════════════ */

  // Back-compat export. The canonical taxonomy now lives in the registry
  // (window.AthlevoAnalyticsRegistry); this list is kept only so older callers
  // that read AthlevoAnalytics.FUNNEL_EVENTS still resolve.
  const FUNNEL_EVENTS = [
    "account_created", "email_verified", "athlete_onboarding_started",
    "athlete_onboarding_completed", "wearable_setup_started", "wearable_connection_succeeded",
    "first_sync_started", "first_activity_imported", "first_plan_generated",
    "first_workout_analysis_viewed", "first_coach_message_sent", "app_session_started"
  ];

  // Kept in memory so the funnel is inspectable even before the migration has
  // run, and so tests can assert ordering without a database.
  const buffer = [];
  const firedMilestones = new Set();            // once-only guard (mirrors the DB unique index)
  const A_STATE = { userId: null, sessionStarted: false, sessionCount: 0, pending: [] };

  function registry() { return root.AthlevoAnalyticsRegistry || null; }

  // Best-effort persistence. A missing table/migration, RLS, or a network blip
  // all fail silently — the product never breaks because telemetry did.
  async function persistEvent(userId, canonical, kind, safeProps) {
    try {
      if (typeof supabaseClient === "undefined") return;
      await supabaseClient.from("activation_events").insert({
        user_id: userId, event_name: canonical, event_kind: kind, metadata: safeProps || null
      });
    } catch (error) { /* silent: telemetry, not product */ }
  }

  /*
   * track(eventName, props) — validate against the registry, strip everything
   * but the event's allowed categorical props, dedupe one-time milestones, and
   * queue pre-auth events until identifySafe() supplies a user.
   */
  async function track(eventName, props) {
    const entry = { event: eventName, at: new Date().toISOString(), metadata: props || null };
    buffer.push(entry);
    if (buffer.length > 200) buffer.shift();

    const R = registry();
    let canonical = eventName, kind = "behavioural", safe = props || null;
    if (R) {
      if (!R.isKnown(eventName)) {                 // reject unknown names (loud in dev, never persisted)
        try { console.warn("[analytics] unknown event rejected:", eventName); } catch (e) {}
        return entry;
      }
      canonical = R.canonicalName(eventName);
      kind = R.kindOf(eventName);
      safe = R.sanitizeProps(eventName, props);
      if (R.isMilestone(eventName)) {
        if (firedMilestones.has(canonical)) return entry;   // one-time milestone → fire once
        firedMilestones.add(canonical);
      }
    }

    let userId = A_STATE.userId;
    if (!userId) {
      try {
        if (typeof supabaseClient !== "undefined") {
          const { data: { user } } = await supabaseClient.auth.getUser();
          if (user) { userId = user.id; A_STATE.userId = user.id; }
        }
      } catch (e) { /* pre-auth */ }
    }
    if (!userId) { A_STATE.pending.push({ canonical, kind, safe }); return entry; }
    await persistEvent(userId, canonical, kind, safe);
    return entry;
  }

  // Attach a real user id and flush any anonymous, pre-auth events safely.
  function identifySafe(userId) {
    if (!userId || typeof userId !== "string") return;
    A_STATE.userId = userId;
    const queued = A_STATE.pending.splice(0);
    queued.forEach(e => persistEvent(userId, e.canonical, e.kind, e.safe));
  }

  // Start (once) an app session. Survives the anonymous → authenticated jump.
  function session(source) {
    if (!A_STATE.sessionStarted) {
      A_STATE.sessionStarted = true;
      A_STATE.sessionCount += 1;
      track("app_session_started", source ? { source: source } : null);
    }
    return { sessionCount: A_STATE.sessionCount, userId: A_STATE.userId };
  }

  /* ═════════════════ provider-agnostic data source ═════════════════ */

  /*
   * The wearable platforms an athlete can bring in. `via` records how we
   * reach them TODAY — when a direct integration lands, only that field
   * changes and the onboarding list stays identical.
   */
  const WEARABLES = [
    { key: "garmin", label: "Garmin", via: "intervals" },
    { key: "coros",  label: "COROS",  via: "intervals" },
    { key: "polar",  label: "Polar",  via: "intervals" },
    { key: "apple",  label: "Apple Watch", via: "intervals" },
    { key: "suunto", label: "Suunto", via: "intervals" },
    { key: "strava", label: "Strava", via: "intervals" },
    { key: "other",  label: "Something else", via: "intervals" }
  ];

  const INTERVALS_SIGNUP_URL = "https://intervals.icu/signup";
  const INTERVALS_SETTINGS_URL = "https://intervals.icu/settings";

  function brain() {
    return root.AthlevoBrain || null;
  }

  /*
   * Retry helper for transient failures. Network blips and cold serverless
   * starts are common on a first connection; a single failure should not end
   * onboarding. Auth failures are NOT retried — they need the athlete.
   */
  async function withRetry(fn, { attempts = 3, delayMs = 1500, label = "operation" } = {}) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error && (error.code === "RECONNECT_REQUIRED" || error.code === "NOT_CONNECTED")) throw error;
        if (i < attempts - 1) {
          console.debug(`[activation] ${label} failed, retrying (${i + 1}/${attempts - 1})`);
          await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        }
      }
    }
    throw lastError;
  }

  const DataSource = {
    // Identity of the CURRENT implementation. UI must not print this as if
    // it were the product; it exists for logging and for the one place we
    // have to name the connection service in copy.
    providerKey: "intervals",
    serviceName: "Intervals.icu",
    // Athlete-facing name for the sync layer. "Intervals.icu" is disclosed
    // ONCE, in an explanatory sentence; everywhere else it is the Sync Partner.
    partnerName: "Sync Partner",
    wearables: WEARABLES,
    signupUrl: INTERVALS_SIGNUP_URL,
    connectionsUrl: INTERVALS_SETTINGS_URL,

    // Is a training-data source connected for this athlete?
    async status() {
      const b = brain();
      if (!b || !b.refreshIntervalsStatus) return { connected: false, available: false };
      try {
        const s = await b.providerStatus ? b.providerStatus() : null;
        if (s) return s;
      } catch (e) { /* fall through */ }
      try {
        return await b.refreshIntervalsStatus() || { connected: false };
      } catch (e) {
        return { connected: false, error: true };
      }
    },

    // Begin authorization. Navigates away; the callback returns to the app.
    async connect() {
      const b = brain();
      // TEMPORARY: records whether the brain layer resolved at click time.
      try {
        if (root.__athlevoOAuthStage) {
          root.__athlevoOAuthStage("datasource_resolved", {
            hasBrain: Boolean(b), hasConnect: Boolean(b && b.connectIntervals)
          });
        }
      } catch (e) {}
      if (!b || !b.connectIntervals) throw new Error("Connection unavailable.");
      return b.connectIntervals();
    },

    /*
     * Does the connected source actually have workouts yet? This is the
     * question that matters after a wearable is linked — Garmin can take a
     * few minutes to push history through, so "connected" and "has data" are
     * genuinely different states and onboarding must distinguish them.
     */
    async detectActivities() {
      const b = brain();
      if (!b || !b.diagnoseIntervalsQuiet) return { ok: false, count: 0, reason: "unavailable" };
      try {
        const report = await withRetry(() => b.diagnoseIntervalsQuiet(), { label: "detect" });
        const probes = (report && report.probes) || {};
        const probe = probes.wideWindow3y || probes.syncWindow180d || null;

        /*
         * A probe that ERRORED is not the same as an account with zero
         * activities. Previously both produced count 0, so a rate limit or a
         * transient failure was reported to the athlete as "no workouts
         * found" — sending them to fix a connection that was fine.
         */
        const probeFailed = Boolean(probe && probe.error);
        const count = probe && typeof probe.count === "number" ? probe.count : 0;

        return {
          ok: count > 0,
          count,
          probeFailed,
          probeError: probe ? probe.error : null,
          verdict: report ? report.verdict : null,
          authProblem: /Token rejected|reconnect/i.test((report && report.verdict) || "")
        };
      } catch (error) {
        /*
         * A NOT_CONNECTED reply means there is no provider row at all — the
         * opposite of "connected but empty". Saying "Athlevo is connected,
         * but we can't see any workouts" in that case is simply false.
         */
        return { ok: false, count: 0, reason: "error", error };
      }
    },

    // Import. Wraps the EXISTING sync — no behaviour change, just retries.
    async sync() {
      const b = brain();
      if (!b || !b.syncIntervals) throw new Error("Sync unavailable.");
      return withRetry(() => b.syncIntervals(), { attempts: 2, delayMs: 2000, label: "sync" });
    }
  };

  /* ══════════════════════ human error language ══════════════════════ */

  /*
   * One place that turns any failure into something an athlete can act on.
   * No status codes, no provider jargon, no "returned null".
   */
  function humanError(error) {
    const code = (error && error.code) || "";
    const msg = String((error && error.message) || error || "").toLowerCase();

    if (code === "RECONNECT_REQUIRED" || /reconnect|401|unauthor/.test(msg)) {
      return {
        title: "We lost access to your training data",
        body: "The connection needs to be approved again. It only takes a moment.",
        primary: "Reconnect", action: "reconnect"
      };
    }
    if (code === "SYNC_IN_PROGRESS" || /already running/.test(msg)) {
      return {
        title: "Still working",
        body: "Your import is already running. Give it a few seconds.",
        primary: "Keep waiting", action: "wait"
      };
    }
    if (/rate limit|429/.test(msg)) {
      return {
        title: "Too many requests just now",
        body: "We'll pick this up again in a few minutes — nothing is lost.",
        primary: "Try again", action: "retry"
      };
    }
    if (/network|failed to fetch|timeout/.test(msg)) {
      return {
        title: "We couldn't reach your training data",
        body: "Check your connection and try again.",
        primary: "Try again", action: "retry"
      };
    }
    if (/403|forbidden/.test(msg)) {
      return {
        title: "We couldn't access your activities yet",
        body: "Your account is connected, but we weren't given permission to read your workouts.",
        primary: "Reconnect", action: "reconnect"
      };
    }
    return {
      title: "That didn't work",
      body: "Something went wrong on our side. Your data is safe — please try again.",
      primary: "Try again", action: "retry"
    };
  }

  // "No workouts found" is not an error — it is a normal, expected state
  // when a wearable has been linked but hasn't pushed history through yet.
  function noActivitiesMessage() {
    return {
      title: "We couldn't find any workouts yet",
      body: "This usually means your watch hasn't finished syncing. It can take a " +
            "few minutes after you connect a device.",
      primary: "Check again", action: "retry",
      secondary: "Open connection settings", secondaryAction: "openConnections"
    };
  }

  root.AthlevoAnalytics = { track, identifySafe, session, buffer, FUNNEL_EVENTS, _state: A_STATE };
  root.AthlevoDataSource = DataSource;
  root.AthlevoActivation = { humanError, noActivitiesMessage, withRetry, WEARABLES };
})(typeof window !== "undefined" ? window : globalThis);

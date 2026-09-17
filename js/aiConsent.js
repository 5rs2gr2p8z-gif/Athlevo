/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — AI-processing consent (client)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Canonical client-side gate for every AI-backed surface (Coach —
 *  anonymous and authenticated —, plan generation, Daily Brief, memory
 *  extraction, onboarding diagnostic chat). This is UX only: the server
 *  helper (lib/server/aiConsent.js) is what actually refuses to run AI
 *  processing, so a blocked request here can never be "fixed" by
 *  bypassing this module — that just moves the rejection server-side.
 *
 *  Two consent scopes, matching the request's identity:
 *    · Anonymous — no durable identity exists yet. Acknowledgment is a
 *      session-scoped sessionStorage flag (athlevo_ai_consent_v1), never
 *      a substitute for durable account consent.
 *    · Authenticated — durable, server-read record in public.ai_consent,
 *      written here via the athlete's own RLS-scoped Supabase client
 *      (same pattern as js/notifications.js's notification_preferences).
 *
 *  ensure({ authenticated, source }) is the ONE entry point every AI call
 *  site should await before sending a request. It resolves true only when
 *  it is safe to proceed (already granted, or just granted in this call);
 *  false means the caller must not send the request. Because callers
 *  `await` it inline, in their own straight-line function, "resume the
 *  pending action" falls out naturally — there is no separate queue that
 *  could double-fire or drop the athlete's typed message.
 */
(function (root) {
  "use strict";

  var CONSENT_VERSION = "1";
  var ANON_STORAGE_KEY = "athlevo_ai_consent_v1";
  var TABLE = "ai_consent";

  var _authCache = null; // { userId, status, version } | null
  var _modalBusy = false;

  function track(name, source) {
    try {
      if (root.AthlevoProductAnalytics &&
          typeof root.AthlevoProductAnalytics.trackAthlevoEvent === "function") {
        root.AthlevoProductAnalytics.trackAthlevoEvent(name, {
          source: source || "unknown",
          consent_version: CONSENT_VERSION
        });
      }
    } catch (e) { /* analytics must never break the gate */ }
  }

  /* ── anonymous (session-scoped) ─────────────────────────────────── */

  function anonymousGranted() {
    try { return sessionStorage.getItem(ANON_STORAGE_KEY) === "1"; }
    catch (e) { return false; }
  }

  function setAnonymousGranted() {
    try { sessionStorage.setItem(ANON_STORAGE_KEY, "1"); } catch (e) {}
  }

  /* Read by the two anonymous AI call sites (anonymousCoach.js,
   * diagnosticSalesEngine.js / diagnostic chat) so they can send the
   * `ai_consent: true` flag the server's anonymous trust boundary checks. */
  function anonymousAckForRequest() {
    return anonymousGranted();
  }

  /* ── authenticated (durable, Supabase-backed) ───────────────────── */

  function getSupabase() {
    return root.supabaseClient || null;
  }

  async function readAuthenticatedStatus(userId) {
    if (_authCache && _authCache.userId === userId) return _authCache;
    var client = getSupabase();
    if (!client || !userId) return null;
    try {
      var result = await client
        .from(TABLE)
        .select("status,consent_version")
        .eq("user_id", userId)
        .maybeSingle();
      if (result.error) return null;
      var row = result.data;
      _authCache = {
        userId: userId,
        status: row ? row.status : null,
        version: row ? row.consent_version : null
      };
      return _authCache;
    } catch (e) {
      return null;
    }
  }

  async function writeAuthenticatedStatus(userId, status) {
    var client = getSupabase();
    if (!client || !userId) return false;
    var now = new Date().toISOString();
    var next = {
      user_id: userId,
      status: status,
      consent_version: CONSENT_VERSION,
      updated_at: now
    };
    if (status === "granted") next.granted_at = now;
    if (status === "withdrawn" || status === "denied") next.withdrawn_at = now;
    try {
      var result = await client.from(TABLE).upsert(next, { onConflict: "user_id" });
      if (result.error) return false;
      _authCache = { userId: userId, status: status, version: CONSENT_VERSION };
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ── modal ───────────────────────────────────────────────────────── */

  function showModal(source) {
    return new Promise(function (resolve) {
      var modal = document.getElementById("aiConsentModal");
      if (!modal) { resolve(false); return; } // fail closed — no gate, no request
      if (_modalBusy) { resolve(false); return; } // never stack prompts
      _modalBusy = true;
      track("ai_consent_prompt_shown", source);

      var continueBtn = document.getElementById("aiConsentContinueBtn");
      var notNowBtn = document.getElementById("aiConsentNotNowBtn");
      var learnMoreBtn = document.getElementById("aiConsentLearnMoreBtn");

      function cleanup(result) {
        modal.classList.remove("show");
        continueBtn.removeEventListener("click", onContinue);
        notNowBtn.removeEventListener("click", onNotNow);
        learnMoreBtn.removeEventListener("click", onLearnMore);
        _modalBusy = false;
        resolve(result);
      }
      function onContinue() { cleanup(true); }
      function onNotNow() { track("ai_consent_declined", source); cleanup(false); }
      function onLearnMore() {
        try { if (typeof root.openLegal === "function") root.openLegal("privacy"); } catch (e) {}
        // Learn more does not resolve the prompt — the athlete returns to it.
      }

      continueBtn.addEventListener("click", onContinue);
      notNowBtn.addEventListener("click", onNotNow);
      learnMoreBtn.addEventListener("click", onLearnMore);
      modal.classList.add("show");
    });
  }

  /* ── the one entry point ─────────────────────────────────────────── */

  async function ensure(options) {
    var opts = options || {};
    var source = opts.source || "unknown";
    var authenticated = !!opts.authenticated;

    if (!authenticated) {
      if (anonymousGranted()) return true;
      var anonGranted = await showModal(source);
      if (anonGranted) {
        setAnonymousGranted();
        track("ai_consent_granted", source);
      }
      return anonGranted;
    }

    var userId = opts.userId || root.athlevoSessionUserId;
    if (!userId) return false;
    var record = await readAuthenticatedStatus(userId);
    if (record && record.status === "granted") return true;

    var granted = await showModal(source);
    if (!granted) return false;
    var persisted = await writeAuthenticatedStatus(userId, "granted");
    if (!persisted) {
      // Could not durably persist — do not claim consent was granted.
      return false;
    }
    track("ai_consent_granted", source);
    return true;
  }

  /* ── Settings surface ────────────────────────────────────────────── */

  async function currentAuthenticatedStatus() {
    var userId = root.athlevoSessionUserId;
    if (!userId) return null;
    _authCache = null; // Settings always wants a fresh read, not a stale cache
    return readAuthenticatedStatus(userId);
  }

  async function setStatusFromSettings(nextGranted) {
    var userId = root.athlevoSessionUserId;
    if (!userId) return false;
    var status = nextGranted ? "granted" : "withdrawn";
    var ok = await writeAuthenticatedStatus(userId, status);
    if (ok) track(nextGranted ? "ai_consent_reenabled" : "ai_consent_withdrawn", "settings");
    return ok;
  }

  async function syncSettingsUI() {
    var toggle = document.getElementById("aiConsentToggle");
    var label = document.getElementById("aiConsentStatusLabel");
    if (!toggle) return;
    var record = await currentAuthenticatedStatus();
    var granted = !!(record && record.status === "granted");
    toggle.checked = granted;
    if (label) {
      label.textContent = granted
        ? "Enabled — Coach responses, training plans, and personalized insights."
        : "Disabled — Coach, training plans, and insights won't use AI.";
    }
  }

  root.AthlevoAiConsent = {
    CONSENT_VERSION: CONSENT_VERSION,
    ensure: ensure,
    anonymousAckForRequest: anonymousAckForRequest,
    setStatusFromSettings: setStatusFromSettings,
    syncSettingsUI: syncSettingsUI,
    // Exposed for account-deletion / logout cleanup and tests.
    _resetAnonymousForTests: function () {
      try { sessionStorage.removeItem(ANON_STORAGE_KEY); } catch (e) {}
    },
    _resetAuthCacheForTests: function () { _authCache = null; }
  };
})(typeof window !== "undefined" ? window : globalThis);

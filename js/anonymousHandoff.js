/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — anonymous cross-browser continuation handoff (client)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Bridges the existing anonymous DiagnosticEngine (js/diagnostic.js) and
 *  the existing external-browser handoff notice (js/authSupport.js) across
 *  a browser switch, via a short-lived opaque token stored server-side
 *  (lib/server/anonymousHandoffEndpoint.js, migrations/2026-09-07_anonymous_handoffs.sql).
 *
 *  This module does NOT introduce a second diagnostic system: it only
 *  ships the SAME DiagnosticEngine.toStoredPayload() shape to a temporary
 *  server record, and on the other side restores it via the SAME
 *  DiagnosticEngine.restoreFromServer(). Everything downstream (the
 *  existing js/diagnosticHandoff.js post-auth flow) is untouched.
 *
 *  create() is only ever called when a visitor actually chooses an action
 *  that needs the external browser (Google OAuth, wearable connection, or
 *  an explicit "Continue in Safari or Chrome") — never for every anonymous
 *  visitor, and never for email/password signup or login.
 *
 *  Fails quietly everywhere: a network error, missing table, or invalid
 *  response never throws and never blocks signup/onboarding.
 */
(function (root) {
  "use strict";

  function track(name, props) {
    try {
      if (root.AthlevoProductAnalytics &&
          typeof root.AthlevoProductAnalytics.trackAthlevoEvent === "function") {
        root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
      }
    } catch (e) {}
  }

  function safeBrowser(v) {
    return v === "facebook" || v === "instagram" ? v : undefined;
  }

  function safeIntent(v) {
    return v === "signup" || v === "login" ? v : undefined;
  }

  /*
   * Create a temporary handoff record for the visitor's current anonymous
   * diagnostic state and return an opaque token, or null if there is
   * nothing worth carrying over (no pending diagnostic) or the request
   * failed for any reason.
   */
  async function create(options) {
    var opts = options || {};
    var browser = safeBrowser(opts.browser);
    var intent = safeIntent(opts.intent);
    var sourceSurface = opts.sourceSurface;

    try {
      if (!root.AthlevoDiagnostic || !root.AthlevoDiagnostic.hasPending()) {
        return null; // nothing to carry over — do not create a DB row.
      }
      var engine = root.AthlevoDiagnostic.load();
      if (!engine || typeof engine.toStoredPayload !== "function") return null;
      var payload = engine.toStoredPayload();

      var res = await fetch("/api/anonymous-handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: payload,
          sourceBrowser: browser,
          sourceSurface: typeof sourceSurface === "string" ? sourceSurface.slice(0, 40) : undefined
        })
      });

      if (!res.ok) {
        track("external_handoff_failed", {
          browser: browser, intent: intent, source_surface: sourceSurface,
          failure_category: res.status === 429 ? "rate_limit" : "server"
        });
        return null;
      }
      var data = await res.json().catch(function () { return null; });
      if (!data || !data.ok || typeof data.token !== "string" || !data.token) {
        track("external_handoff_failed", {
          browser: browser, intent: intent, source_surface: sourceSurface,
          failure_category: "invalid_state"
        });
        return null;
      }

      track("external_handoff_created", { browser: browser, intent: intent, source_surface: sourceSurface });
      return data.token;
    } catch (e) {
      track("external_handoff_failed", {
        browser: browser, intent: intent, source_surface: sourceSurface, failure_category: "network"
      });
      return null;
    }
  }

  /*
   * Consume a continuation token (if one is present in the current URL),
   * restoring the existing DiagnosticEngine state via restoreFromServer().
   * Always removes the token from the visible URL once an attempt has been
   * made, whether it succeeded or not, and never throws. Returns true only
   * when diagnostic facts were actually restored.
   */
  async function consume() {
    var continuation = null;
    try {
      continuation = root.AthlevoEnv && typeof root.AthlevoEnv.readContinuation === "function"
        ? root.AthlevoEnv.readContinuation()
        : null;
    } catch (e) {}

    var token = continuation && continuation.handoffToken;
    if (!token) return false;

    var browser = safeBrowser(continuation.browser);
    var intent = safeIntent(continuation.intent);
    var sourceSurface = continuation.sourceSurface;
    var restored = false;

    try {
      var res = await fetch("/api/anonymous-handoff?token=" + encodeURIComponent(token), {
        method: "GET"
      });
      if (res.ok) {
        var data = await res.json().catch(function () { return null; });
        var payload = data && data.ok ? data.payload : null;
        if (payload && root.AthlevoDiagnostic && typeof root.AthlevoDiagnostic.restoreFromServer === "function") {
          var engine = root.AthlevoDiagnostic.restoreFromServer(payload);
          restored = !!engine;
        }
      }
    } catch (e) {
      restored = false;
    }

    if (restored) {
      track("external_handoff_restored", { browser: browser, intent: intent, source_surface: sourceSurface });
    } else {
      track("external_handoff_failed", {
        browser: browser, intent: intent, source_surface: sourceSurface, failure_category: "invalid_state"
      });
    }

    try {
      if (root.AthlevoEnv && typeof root.AthlevoEnv.stripHandoffToken === "function") {
        root.AthlevoEnv.stripHandoffToken();
      }
    } catch (e) {}

    return restored;
  }

  root.AthlevoAnonymousHandoff = { create: create, consume: consume };
})(typeof window !== "undefined" ? window : this);

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Product analytics (PostHog)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Thin, fail-silent wrapper. Analytics must NEVER block or break the
 *  product. Every public function swallows its own errors.
 *
 *  Privacy by construction:
 *    · Only the declared SAFE_PROPS are forwarded — everything else is dropped.
 *    · Tokens, health notes, coach message text, payment info, OAuth codes
 *      and secrets are never captured (PROHIBITED pattern).
 *    · Session replay is intentionally not enabled.
 *
 *  Deduplication:
 *    · _fired protects view events from rerenders within one page load.
 *    · user milestones use sessionStorage keys scoped to the Supabase UUID.
 *    · _initDone prevents double-init on repeated script execution.
 *    · app_returned fires only on a later calendar date than the last visit.
 *
 *  PostHog is loaded from their CDN snippet only when the public API key
 *  (POSTHOG_KEY) is present — the project key, never the private key.
 */
(function (root) {
  "use strict";

  /* ═══════════════════════ configuration ═══════════════════════════ */

  /*
   * The PostHog public project API key. Injected at build/deploy time as
   * a window global or read from a meta tag. NEVER a secret/private key.
   */
  function resolveKey() {
    try {
      if (root.POSTHOG_KEY) return root.POSTHOG_KEY;
      var m = document.querySelector('meta[name="posthog-key"]');
      if (m && m.content) return m.content;
    } catch (e) { /* silent */ }
    return null;
  }

  var POSTHOG_HOST = "https://us.i.posthog.com";

  /*
   * Properties that are safe to attach to any event. Everything not on
   * this list is silently dropped by sanitize().
   */
  var SAFE_PROPS = [
    "source", "campaign", "medium", "provider", "auth_method",
    "device_type", "is_first_time", "wearable", "experience_level",
    "plan_goal_type", "feature", "surface", "limit_period",
    "completion_status", "page_url", "page_path", "referrer",
    "cta_text", "cta_location", "destination", "entry_source",
    "previous_page", "signup_method", "user_id", "goal_distance",
    "plan_start_date",
    "browser", "intent", "source_surface",
    "utm_source", "utm_medium", "utm_campaign", "utm_content",
    "utm_term", "fbclid"
  ];

  /*
   * Patterns that must NEVER appear in captured properties — even if a
   * caller passes them. Defence in depth against accidental PII leaks.
   */
  var PROHIBITED = /(token|secret|code|password|email|name|phone|address|message|text|note|content|health|injury|pain|payment|card|ssn|dob|birth|gps|lat|lng|lon|coord|raw|payload)/i;
  var APPROVED_NAMED_KEYS = { cta_text: true, utm_content: true };
  var APPROVED_CTA_TEXT = { "Build My Training Plan": true };
  var APPROVED_HANDOFF_VALUES = {
    browser: { facebook: true, instagram: true },
    intent: { signup: true, login: true },
    source_surface: { landing: true, auth: true }
  };

  /* ═══════════════════ attribution persistence ═════════════════════ */

  var _utmParams = null;
  var ATTRIBUTION_KEY = "athlevo_utm";
  var ATTRIBUTION_KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"
  ];
  var AUTH_ENTRY_KEY = "athlevo_auth_entry_v1";
  var SIGNUP_INTENT_KEY = "athlevo_signup_intent_v1";
  var NEW_REGISTRATION_KEY = "athlevo_new_registration_v1";
  var MILESTONE_PREFIX = "athlevo_product_milestone_v1:";

  function shortValue(value, max) {
    if (typeof value !== "string") return null;
    var clean = value.trim();
    if (!clean || clean.length > max) return null;
    return clean;
  }

  function captureUtm() {
    try {
      var p = new URLSearchParams(window.location.search);
      var current = {};
      ATTRIBUTION_KEYS.forEach(function (key) {
        var value = shortValue(p.get(key), key === "fbclid" ? 500 : 160);
        if (value) current[key] = value;
      });
      if (Object.keys(current).length) {
        _utmParams = current;
        try { sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(_utmParams)); } catch (e) {}
      } else {
        try {
          var saved = JSON.parse(sessionStorage.getItem(ATTRIBUTION_KEY) || "null");
          if (saved && typeof saved === "object") {
            _utmParams = {};
            ATTRIBUTION_KEYS.forEach(function (key) {
              var value = shortValue(saved[key], key === "fbclid" ? 500 : 160);
              if (value) _utmParams[key] = value;
            });
          }
        } catch (e) {}
      }
    } catch (e) { /* silent */ }
  }

  function utmProps() {
    if (!_utmParams) return {};
    var out = {};
    ATTRIBUTION_KEYS.forEach(function (key) {
      if (_utmParams[key]) out[key] = _utmParams[key];
    });
    return out;
  }

  function locationParts() {
    try {
      var loc = window.location || {};
      var origin = loc.origin || "https://athlevo.org";
      var path = loc.pathname || "/";
      var href = loc.href || (origin + path + (loc.search || ""));
      return { origin: origin, path: path, href: href };
    } catch (e) {
      return { origin: "https://athlevo.org", path: "/", href: "https://athlevo.org/" };
    }
  }

  // Query strings on referrers and previous pages may contain OAuth codes or
  // arbitrary identifiers. Keep only origin + path. The landing URL keeps
  // only the explicitly approved attribution parameters.
  function safeUrl(value, keepAttribution) {
    try {
      if (typeof value !== "string" || !value.trim()) return null;
      var base = locationParts().origin;
      var url = new URL(value, base);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = "";
      if (keepAttribution) {
        Array.from(url.searchParams.keys()).forEach(function (key) {
          if (ATTRIBUTION_KEYS.indexOf(key) === -1) url.searchParams.delete(key);
        });
      } else {
        url.search = "";
      }
      return shortValue(url.toString(), 500);
    } catch (e) { return null; }
  }

  function landingProps() {
    var loc = locationParts();
    var props = {
      page_url: safeUrl(loc.href, true),
      page_path: shortValue(loc.path, 200)
    };
    try {
      var referrer = safeUrl(document.referrer || "", false);
      if (referrer) props.referrer = referrer;
    } catch (e) {}
    return props;
  }

  function rememberAuthEntry(entry) {
    try {
      var loc = locationParts();
      var safe = {
        entry_source: shortValue(entry && entry.entry_source, 80) || "direct",
        previous_page: safeUrl(
          (entry && entry.previous_page) || loc.href,
          false
        ) || loc.path
      };
      sessionStorage.setItem(AUTH_ENTRY_KEY, JSON.stringify(safe));
      return safe;
    } catch (e) { return {}; }
  }

  function authEntryProps() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(AUTH_ENTRY_KEY) || "null");
      if (saved && typeof saved === "object") {
        return {
          entry_source: shortValue(saved.entry_source, 80) || "direct",
          previous_page: safeUrl(saved.previous_page, false) || shortValue(saved.previous_page, 200)
        };
      }
    } catch (e) {}
    return rememberAuthEntry({ entry_source: "direct" });
  }

  function beginSignupIntent(method) {
    try {
      var safeMethod = method === "google" ? "google" : (method === "email" ? "email" : null);
      if (!safeMethod) return;
      sessionStorage.setItem(SIGNUP_INTENT_KEY, JSON.stringify({
        method: safeMethod,
        started_at: Date.now()
      }));
    } catch (e) {}
  }

  function signupIntent() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(SIGNUP_INTENT_KEY) || "null");
      if (!saved || (saved.method !== "google" && saved.method !== "email")) return null;
      if (!Number.isFinite(Number(saved.started_at))) return null;
      return saved;
    } catch (e) { return null; }
  }

  function clearSignupIntent() {
    try { sessionStorage.removeItem(SIGNUP_INTENT_KEY); } catch (e) {}
  }

  /* ═══════════════════════ sanitization ════════════════════════════ */

  function sanitize(props) {
    if (!props || typeof props !== "object") return {};
    var out = {};
    SAFE_PROPS.forEach(function (key) {
      if (props[key] == null) return;
      if (PROHIBITED.test(key) && !APPROVED_NAMED_KEYS[key]) return;
      var v = props[key];
      var t = typeof v;
      if (t === "boolean" || t === "number") { out[key] = v; return; }
      if (t !== "string" || !v.length) return;
      if (key === "cta_text" && !APPROVED_CTA_TEXT[v.trim()]) return;
      if (APPROVED_HANDOFF_VALUES[key] &&
          !APPROVED_HANDOFF_VALUES[key][v.trim()]) return;
      if (key === "page_url") v = safeUrl(v, true);
      if (key === "referrer" || key === "previous_page") v = safeUrl(v, false);
      if (!v) return;
      var max = (key === "page_url" || key === "referrer" || key === "fbclid") ? 500 :
        ((key === "page_path" || key === "previous_page" || key === "destination") ? 200 : 80);
      if (v.length <= max) out[key] = v;
    });
    return out;
  }

  /* ═══════════════════════ PostHog loader ══════════════════════════ */

  var _initDone = false;

  function posthog() {
    try { return root.posthog || null; } catch (e) { return null; }
  }

  function initPostHog() {
    if (_initDone) return;
    _initDone = true;

    var key = resolveKey();
    if (!key) return;

    try {
      /* PostHog JS snippet — standard lightweight loader */
      !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageviewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,root.posthog||[]);

      root.posthog.init(key, {
        api_host: POSTHOG_HOST,
        capture_pageview: false,           // we fire landing_viewed manually
        capture_pageleave: true,
        persistence: "localStorage+cookie",
        autocapture: false,                // only explicit events
        disable_session_recording: true    // no replay yet
      });
    } catch (e) { /* silent — analytics must never break the product */ }
  }

  /* ═══════════════════════ deduplication ═══════════════════════════ */

  var _fired = {};
  var VIEW_EVENTS = {
    landing_viewed: true,
    auth_screen_viewed: true
  };

  /* ═══════════════════ app_returned logic ══════════════════════════ */

  var APP_RETURN_KEY = "athlevo_last_visit_date";

  function checkAppReturned() {
    try {
      var today = new Date().toISOString().slice(0, 10);
      var last = localStorage.getItem(APP_RETURN_KEY);
      localStorage.setItem(APP_RETURN_KEY, today);
      if (last && last !== today) return true;
    } catch (e) { /* silent */ }
    return false;
  }

  /* ═══════════════════════ public API ══════════════════════════════ */

  function trackAthlevoEvent(name, properties) {
    try {
      if (VIEW_EVENTS[name] && _fired[name]) return;
      if (VIEW_EVENTS[name]) _fired[name] = true;

      initPostHog();
      var ph = posthog();
      if (!ph || typeof ph.capture !== "function") return;

      var safe = sanitize(properties);
      var premiumCategorical = name === "premium_feature_viewed" ||
        name === "upgrade_clicked" ||
        name === "checkout_opened";
      var handoffCategorical = name === "in_app_browser_signup_blocked" ||
        name === "external_signup_link_copied" ||
        name === "external_signup_continuation_viewed";
      if (premiumCategorical) {
        safe = {
          ...(safe.feature ? { feature: safe.feature } : {}),
          ...(safe.surface ? { surface: safe.surface } : {})
        };
      } else if (handoffCategorical) {
        safe = {
          ...(safe.browser ? { browser: safe.browser } : {}),
          ...(safe.intent ? { intent: safe.intent } : {}),
          ...(safe.source_surface ? { source_surface: safe.source_surface } : {})
        };
      } else {
        // Acquisition and device context belong on general funnel events.
        // Premium feature events intentionally carry feature/surface only.
        var utm = utmProps();
        Object.keys(utm).forEach(function (k) { if (!safe[k]) safe[k] = utm[k]; });
        if (!safe.device_type) {
          try {
            safe.device_type = /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop";
          } catch (e) {}
        }
      }

      ph.capture(name, safe);
    } catch (e) { /* silent */ }
  }

  function milestoneStorageKey(name, scope) {
    var safeName = String(name || "").replace(/[^a-z0-9_]/gi, "").slice(0, 60);
    var safeScope = String(scope || "session").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    return MILESTONE_PREFIX + safeName + ":" + safeScope;
  }

  function trackUserMilestone(name, userId, properties) {
    try {
      var scope = userId || "anonymous";
      var key = milestoneStorageKey(name, scope);
      if (sessionStorage.getItem(key) === "1") return false;
      trackAthlevoEvent(name, properties);
      sessionStorage.setItem(key, "1");
      return true;
    } catch (e) {
      trackAthlevoEvent(name, properties);
      return true;
    }
  }

  function completeRegistration(user, method, confirmedNew) {
    try {
      if (!confirmedNew || !user || !user.id) return false;
      var safeMethod = method === "google" ? "google" : (method === "email" ? "email" : null);
      if (!safeMethod) return false;
      var registrationKey = milestoneStorageKey("registration_completed", user.id);
      if (sessionStorage.getItem(registrationKey) === "1") {
        clearSignupIntent();
        return false;
      }
      identifyAthlete(user);
      trackAthlevoEvent("registration_completed", {
        signup_method: safeMethod,
        user_id: user.id
      });
      sessionStorage.setItem(registrationKey, "1");
      sessionStorage.setItem(NEW_REGISTRATION_KEY, JSON.stringify({
        user_id: user.id,
        signup_method: safeMethod
      }));
      clearSignupIntent();
      return true;
    } catch (e) { return false; }
  }

  function isGenuinelyNewOAuthUser(user, intent) {
    try {
      if (!user || !user.id || !intent || intent.method !== "google") return false;
      var created = Date.parse(user.created_at || "");
      var signedIn = Date.parse(user.last_sign_in_at || "");
      var started = Number(intent.started_at);
      var now = Date.now();
      if (![created, signedIn, started].every(Number.isFinite)) return false;
      return Math.abs(signedIn - created) <= 120000 &&
        created >= started - 120000 &&
        now - created <= 15 * 60 * 1000;
    } catch (e) { return false; }
  }

  function completeOAuthRegistration(user) {
    try {
      var intent = signupIntent();
      if (!intent || intent.method !== "google") return false;
      var isNew = isGenuinelyNewOAuthUser(user, intent);
      var completed = completeRegistration(user, "google", isNew);
      if (!isNew) clearSignupIntent();
      return completed;
    } catch (e) { return false; }
  }

  function isNewRegistration(userId) {
    try {
      var saved = JSON.parse(sessionStorage.getItem(NEW_REGISTRATION_KEY) || "null");
      return Boolean(saved && saved.user_id && saved.user_id === userId);
    } catch (e) { return false; }
  }

  function identifyAthlete(user) {
    try {
      if (!user || !user.id) return;
      initPostHog();
      var ph = posthog();
      if (!ph || typeof ph.identify !== "function") return;

      // Use Supabase UUID as distinct_id. PostHog automatically merges
      // the anonymous pre-signup activity into this identified user.
      ph.identify(user.id);
    } catch (e) { /* silent */ }
  }

  function resetAthleteAnalytics() {
    try {
      _fired = {};
      var ph = posthog();
      if (ph && typeof ph.reset === "function") ph.reset();
    } catch (e) { /* silent */ }
  }

  /* ═══════════════════════ init on load ════════════════════════════ */

  captureUtm();

  /* ═══════════════════════ export ══════════════════════════════════ */

  root.AthlevoProductAnalytics = {
    trackAthlevoEvent: trackAthlevoEvent,
    identifyAthlete: identifyAthlete,
    resetAthleteAnalytics: resetAthleteAnalytics,
    checkAppReturned: checkAppReturned,
    attributionProps: utmProps,
    landingProps: landingProps,
    rememberAuthEntry: rememberAuthEntry,
    authEntryProps: authEntryProps,
    beginSignupIntent: beginSignupIntent,
    clearSignupIntent: clearSignupIntent,
    completeRegistration: completeRegistration,
    completeOAuthRegistration: completeOAuthRegistration,
    isNewRegistration: isNewRegistration,
    trackUserMilestone: trackUserMilestone,
    // Exposed for tests only — not part of the public contract.
    _fired: _fired,
    _utmParams: function () { return _utmParams; },
    _initDone: function () { return _initDone; },
    _sanitize: sanitize,
    _captureUtm: captureUtm,
    _signupIntent: signupIntent,
    _isGenuinelyNewOAuthUser: isGenuinelyNewOAuthUser
  };

})(typeof window !== "undefined" ? window : globalThis);

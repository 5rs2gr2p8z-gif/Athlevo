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
 *    · _fired tracks event names already sent this page load.
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
    "plan_goal_type", "feature", "limit_period",
    "completion_status",
    "utm_source", "utm_medium", "utm_campaign"
  ];

  /*
   * Patterns that must NEVER appear in captured properties — even if a
   * caller passes them. Defence in depth against accidental PII leaks.
   */
  var PROHIBITED = /(token|secret|code|password|email|name|phone|address|message|text|note|content|health|injury|pain|payment|card|ssn|dob|birth|gps|lat|lng|lon|coord|raw|payload)/i;

  /* ═══════════════════════ UTM persistence ═════════════════════════ */

  var _utmParams = null;

  function captureUtm() {
    try {
      var p = new URLSearchParams(window.location.search);
      var s = p.get("utm_source"), m = p.get("utm_medium"), c = p.get("utm_campaign");
      if (s || m || c) {
        _utmParams = { utm_source: s || null, utm_medium: m || null, utm_campaign: c || null };
        try { sessionStorage.setItem("athlevo_utm", JSON.stringify(_utmParams)); } catch (e) {}
      } else {
        try {
          var saved = JSON.parse(sessionStorage.getItem("athlevo_utm") || "null");
          if (saved) _utmParams = saved;
        } catch (e) {}
      }
    } catch (e) { /* silent */ }
  }

  function utmProps() {
    if (!_utmParams) return {};
    var out = {};
    if (_utmParams.utm_source)   out.utm_source   = _utmParams.utm_source;
    if (_utmParams.utm_medium)   out.utm_medium   = _utmParams.utm_medium;
    if (_utmParams.utm_campaign) out.utm_campaign  = _utmParams.utm_campaign;
    return out;
  }

  /* ═══════════════════════ sanitization ════════════════════════════ */

  function sanitize(props) {
    if (!props || typeof props !== "object") return {};
    var out = {};
    SAFE_PROPS.forEach(function (key) {
      if (props[key] == null) return;
      if (PROHIBITED.test(key)) return;
      var v = props[key];
      var t = typeof v;
      if (t === "boolean" || t === "number") { out[key] = v; return; }
      if (t === "string" && v.length > 0 && v.length <= 80) { out[key] = v; }
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

  var _fired = {};    // { eventName: true } — once per page load

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
      if (_fired[name]) return;        // deduplicate within page load
      _fired[name] = true;

      initPostHog();
      var ph = posthog();
      if (!ph || typeof ph.capture !== "function") return;

      var safe = sanitize(properties);
      // Merge UTM params into every event
      var utm = utmProps();
      Object.keys(utm).forEach(function (k) { if (!safe[k]) safe[k] = utm[k]; });

      // Add device_type if not provided
      if (!safe.device_type) {
        try {
          safe.device_type = /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop";
        } catch (e) {}
      }

      ph.capture(name, safe);
    } catch (e) { /* silent */ }
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
    // Exposed for tests only — not part of the public contract.
    _fired: _fired,
    _utmParams: function () { return _utmParams; },
    _initDone: function () { return _initDone; },
    _sanitize: sanitize,
    _captureUtm: captureUtm
  };

})(typeof window !== "undefined" ? window : globalThis);

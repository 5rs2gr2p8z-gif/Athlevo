/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Meta Pixel helper  (browser-side only)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Thin, fail-silent wrapper around the Meta (Facebook) Pixel.
 *
 *  Design principles (mirrors analytics.js):
 *    · Never blocks or breaks the product — every public function
 *      swallows its own errors.
 *    · The Pixel ID is read from a <meta> tag injected by the deploy
 *      pipeline, never hardcoded here.
 *    · Deduplication: _fired tracks events already sent this page load
 *      so a re-render or SPA "navigation" does not double-count.
 *    · Conversion events are a downstream mirror of canonical Athlevo
 *      product milestones via trackMapped(). Do not scatter fbq calls.
 *    · Do NOT fire StartTrial. Athlevo has no trial.
 *
 *  Usage:
 *    AthlevoMetaPixel.init();                 // called once on page load
 *    AthlevoMetaPixel.trackMapped("diagnostic_completed");
 */
(function (root) {
  "use strict";

  var _initDone = false;
  var _pixelId  = null;
  var _fired    = {};   // per-page-load dedup

  var SESSION_KEY = "athlevo_meta_pixel_fired";

  /*
   * Canonical Athlevo product event → Meta standard event.
   * Unknown names are a no-op. Payloads are built here from scratch —
   * never spread PostHog/product properties into Meta.
   */
  var CANONICAL_TO_META = {
    ai_landing_viewed:      { event: "ViewContent",          once: false, commerce: false },
    diagnostic_completed:   { event: "Lead",                 once: true,  commerce: false },
    registration_completed: { event: "CompleteRegistration", once: true,  commerce: false },
    checkout_started:       { event: "InitiateCheckout",     once: false, commerce: true },
    payment_completed:      { event: "Purchase",             once: true,  commerce: true }
  };

  var META_COMMERCE = { value: 597, currency: "PHP" };

  /* ─────────────── helpers ────────────────────────────────────────── */

  function resolvePixelId() {
    try {
      // 1) Window global (set by Vercel env injection or inline script).
      if (root.META_PIXEL_ID) return String(root.META_PIXEL_ID);
      // 2) <meta name="meta-pixel-id" content="...">
      var m = document.querySelector('meta[name="meta-pixel-id"]');
      if (m && m.content) return m.content;
    } catch (e) { /* silent */ }
    return null;
  }

  function sessionFired() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function markSessionFired(eventName) {
    try {
      var map = sessionFired();
      map[eventName] = Date.now();
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(map));
    } catch (e) { /* quota / private mode — still deduped in-page */ }
  }

  function isNativeRuntime() {
    try {
      if (root.AthlevoRuntime && typeof root.AthlevoRuntime.isNative === "function") {
        return root.AthlevoRuntime.isNative();
      }
      return Boolean(
        root.Capacitor &&
        typeof root.Capacitor.isNativePlatform === "function" &&
        root.Capacitor.isNativePlatform()
      );
    } catch (e) {
      return false;
    }
  }

  /* ─────────────── init ───────────────────────────────────────────── */

  /**
   * Inject the Meta Pixel base code and fire PageView.
   * Safe to call multiple times — only runs once.
   */
  function init() {
    if (_initDone) return;
    _initDone = true;

    // Native tracking remains off until Athlevo intentionally ships ATT and
    // a consent-aware native tracking policy. Browser analytics are unchanged.
    if (isNativeRuntime()) return;

    _pixelId = resolvePixelId();
    if (!_pixelId) {
      // No Pixel ID configured — silently disable.
      return;
    }

    try {
      // Standard Meta Pixel base code (minified).
      /* eslint-disable */
      !function(f,b,e,v,n,t,s)
      {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};
      if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
      n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t,s)}(window, document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */

      fbq('init', _pixelId);
      fbq('track', 'PageView');
    } catch (e) {
      // Pixel load failure must never break the app.
    }
  }

  /* ─────────────── tracking ───────────────────────────────────────── */

  function resolveFbq() {
    try {
      if (root.fbq && typeof root.fbq === "function") return root.fbq;
    } catch (e) {}
    try {
      if (typeof fbq === "function") return fbq;
    } catch (e) {}
    return null;
  }

  /**
   * Fire a standard or custom Meta Pixel event.
   * @param {string} eventName  e.g. 'Lead', 'Purchase'
   * @param {object} [params]   optional event parameters
   */
  function track(eventName, params) {
    if (!_pixelId) return;
    try {
      var fn = resolveFbq();
      if (fn) fn("track", eventName, params || {});
    } catch (e) { /* silent */ }
  }

  /**
   * Fire an event at most ONCE per browser session (survives refresh).
   * Use for one-shot conversion events that must not double-fire.
   *
   * @param {string} eventName
   * @param {object} [params]
   * @returns {boolean} true if the event was actually fired
   */
  function trackOnce(eventName, params) {
    // In-page dedup.
    if (_fired[eventName]) return false;
    // Cross-refresh dedup via sessionStorage.
    if (sessionFired()[eventName]) return false;

    _fired[eventName] = true;
    markSessionFired(eventName);
    track(eventName, params);
    return true;
  }

  function metaParams(mapping) {
    if (mapping && mapping.commerce) {
      return { value: META_COMMERCE.value, currency: META_COMMERCE.currency };
    }
    return {};
  }

  /**
   * Mirror a canonical Athlevo product event into a Meta standard event.
   * Caller properties are ignored — Meta payloads are constructed here.
   *
   * @param {string} canonicalEventName
   * @returns {boolean} true if a Meta event was dispatched (or queued)
   */
  function trackMapped(canonicalEventName) {
    try {
      if (isNativeRuntime()) return false;
      if (!_pixelId) return false;
      var mapping = CANONICAL_TO_META[canonicalEventName];
      if (!mapping) return false;
      var params = metaParams(mapping);
      if (mapping.once) return trackOnce(mapping.event, params);
      track(mapping.event, params);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ─────────────── auto-init on load ───────────────────────────────── */

  init();

  /* ─────────────── public API ─────────────────────────────────────── */

  root.AthlevoMetaPixel = {
    init:        init,
    track:       track,
    trackOnce:   trackOnce,
    trackMapped: trackMapped,
    /** Exposed for testing — returns whether init() has run. */
    isReady:     function () { return _initDone && !!_pixelId; },
    VERSION:     "meta-pixel-v2"
  };

})(window);

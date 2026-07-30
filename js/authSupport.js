/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Auth Support  (embedded-browser detection, auth-error
 *  mapping, and a "wait for valid session" helper)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Stabilises entry through shared links opened inside in-app browsers
 *  (Messenger, Instagram, Facebook, TikTok, LINE, Android WebView), where
 *  storage partitioning and webview quirks break sign-in, session
 *  persistence, and third-party OAuth.
 *
 *  Three independent, reusable namespaces (all pure/testable):
 *    · window.AthlevoEnv          — conservative embedded-browser + storage
 *                                   detection + a guidance notice.
 *    · window.AthlevoAuthErrors   — accurate Supabase → user-facing mapping
 *                                   with safe internal codes.
 *    · window.AthlevoSession      — bounded "wait for a valid session".
 *
 *  Adds no product features and touches no brand CSS (the notice is a
 *  self-contained neutral overlay). Never logs passwords, tokens, or codes.
 */

(function () {
  "use strict";

  const CANONICAL_URL = "https://athlevo.org";
  const CONTINUATION_INTENTS = new Set(["signup", "login"]);
  const HANDOFF_BROWSERS = new Set(["facebook", "instagram"]);
  const HANDOFF_SURFACES = new Set(["landing", "auth"]);
  const ATTRIBUTION_KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"
  ];
  let handoffRestoreFocus = null;
  let continuationTracked = false;

  /* ═══════════════════ 1 · embedded-browser detection ═══════════════════ */

  // Named in-app browsers we recognise. Order matters (Messenger before the
  // broader Facebook match). Android WebView is detected via the "; wv"
  // token. We deliberately do NOT use fragile "iOS without Safari"
  // heuristics, so ordinary Safari/Chrome/Edge/Firefox are never flagged.
  const EMBEDDED = [
    { name: "Messenger", re: /FB_IAB\/MESSENGER|Messenger(ForiOS|LiteForiOS)?/i },
    { name: "Facebook", re: /\bFBAN\b|\bFBAV\b|FB_IAB|\bFBIOS\b/i },
    { name: "Instagram", re: /\bInstagram\b/i },
    { name: "TikTok", re: /musical_ly|BytedanceWebview|\bTikTok\b|\btrill\b/i },
    { name: "LINE", re: /\bLine\//i },
    { name: "Snapchat", re: /Snapchat/i },
    { name: "WebView", re: /;\s?wv\)/i }
  ];

  function uaString() {
    try {
      return (navigator.userAgent || "") + " " + (navigator.vendor || "");
    } catch (error) {
      return "";
    }
  }

  function isStandalonePWA() {
    try {
      if (navigator.standalone === true) return true;
      return typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches;
    } catch (error) {
      return false;
    }
  }

  // Returns the friendly name of the embedded browser, or null. An
  // installed PWA (standalone) is never treated as embedded.
  function getEmbeddedBrowserName() {
    if (isStandalonePWA()) return null;
    const s = uaString();
    for (const e of EMBEDDED) {
      if (e.re.test(s)) return e.name;
    }
    return null;
  }

  function isEmbeddedBrowser() {
    return getEmbeddedBrowserName() !== null;
  }

  // Whether local storage is usable (Messenger/Instagram often partition or
  // block it, which is what actually breaks session persistence).
  function isStorageAvailable() {
    try {
      const k = "__athlevo_probe__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return true;
    } catch (error) {
      return false;
    }
  }

  // True when we should warn before auth/OAuth: an embedded browser that is
  // not an installed PWA.
  function shouldWarn() {
    return isEmbeddedBrowser() && !isStandalonePWA();
  }

  /* ── the guidance notice (self-contained neutral overlay) ── */

  function handoffBrowser() {
    const name = getEmbeddedBrowserName();
    if (name === "Instagram") return "instagram";
    if (name === "Facebook" || name === "Messenger") return "facebook";
    return null;
  }

  function safeIntent(value) {
    return CONTINUATION_INTENTS.has(value) ? value : null;
  }

  function safeSurface(value) {
    return HANDOFF_SURFACES.has(value) ? value : "auth";
  }

  function safeHandoffBrowser(value) {
    return HANDOFF_BROWSERS.has(value) ? value : null;
  }

  function shortAttribution(value, key) {
    if (typeof value !== "string") return null;
    const clean = value.trim();
    const max = key === "fbclid" ? 500 : 160;
    return clean && clean.length <= max ? clean : null;
  }

  function attributionForHandoff() {
    const approved = {};
    try {
      if (window.AthlevoProductAnalytics &&
          typeof window.AthlevoProductAnalytics.attributionProps === "function") {
        const stored = window.AthlevoProductAnalytics.attributionProps() || {};
        ATTRIBUTION_KEYS.forEach(key => {
          const value = shortAttribution(stored[key], key);
          if (value) approved[key] = value;
        });
      }
    } catch (error) {}
    try {
      const current = new URLSearchParams(window.location.search || "");
      ATTRIBUTION_KEYS.forEach(key => {
        if (approved[key]) return;
        const value = shortAttribution(current.get(key), key);
        if (value) approved[key] = value;
      });
    } catch (error) {}
    return approved;
  }

  function buildContinuationUrl(intent, options) {
    const allowedIntent = safeIntent(intent) || "signup";
    const opts = options || {};
    const url = new URL(CANONICAL_URL + "/");
    url.searchParams.set("continue", allowedIntent);
    const browser = safeHandoffBrowser(opts.browser || handoffBrowser());
    const surface = safeSurface(opts.sourceSurface);
    if (browser) url.searchParams.set("handoff_browser", browser);
    url.searchParams.set("source_surface", surface);
    const attribution = attributionForHandoff();
    ATTRIBUTION_KEYS.forEach(key => {
      if (attribution[key]) url.searchParams.set(key, attribution[key]);
    });
    return url.toString();
  }

  function readContinuation() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const intent = safeIntent(params.get("continue"));
      if (!intent) return null;
      return {
        intent,
        browser: safeHandoffBrowser(params.get("handoff_browser")),
        sourceSurface: safeSurface(params.get("source_surface"))
      };
    } catch (error) {
      return null;
    }
  }

  function trackHandoffEvent(name, context) {
    const input = context || {};
    const browser = safeHandoffBrowser(input.browser);
    const intent = safeIntent(input.intent);
    const sourceSurface = safeSurface(input.sourceSurface);
    if (!browser || !intent) return;
    try {
      if (window.AthlevoProductAnalytics &&
          typeof window.AthlevoProductAnalytics.trackAthlevoEvent === "function") {
        window.AthlevoProductAnalytics.trackAthlevoEvent(name, {
          browser,
          intent,
          source_surface: sourceSurface
        });
      }
    } catch (error) {}
  }

  function consumeContinuation() {
    const continuation = readContinuation();
    if (!continuation) return null;
    if (!continuationTracked) {
      continuationTracked = true;
      trackHandoffEvent("external_signup_continuation_viewed", continuation);
    }
    return continuation;
  }

  async function copyLink(url) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        return true;
      }
    } catch (error) {}
    return fallbackCopy(url);
  }

  function fallbackCopy(url) {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(ta);
      return copied !== false;
    } catch (error) {
      return false;
    }
  }

  function noticeCopy(context, browserName) {
    const base = {
      title: "Continue in Safari or Chrome",
      body: "Facebook’s browser can interrupt Google sign-in and training-data connection."
    };
    if (browserName === "Instagram") {
      base.body = "Instagram’s browser can interrupt Google sign-in and training-data connection.";
    }
    if (context === "strava") {
      base.body = "This in-app browser can interrupt training-data connection. Continue in Safari or Chrome.";
    }
    return base;
  }

  function ensureHandoffStyles() {
    if (document.getElementById("athlevoEnvNoticeStyles")) return;
    const style = document.createElement("style");
    style.id = "athlevoEnvNoticeStyles";
    style.textContent =
      "#athlevoEnvNotice{position:fixed;inset:0;z-index:99999;background:rgba(20,20,22,.58);display:flex;align-items:flex-end;justify-content:center;font-family:var(--sans,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif)}" +
      "#athlevoEnvNotice .aeh-card{width:100%;max-width:430px;background:var(--paper,#fff);color:var(--text,#141416);border:1px solid var(--line,#e7e7e4);border-radius:24px 24px 0 0;padding:24px 22px calc(22px + env(safe-area-inset-bottom));box-shadow:0 -20px 60px rgba(0,0,0,.2)}" +
      "#athlevoEnvNotice h2{font-size:20px;line-height:1.2;margin:0 0 9px}" +
      "#athlevoEnvNotice p{font-size:14px;line-height:1.5;color:var(--ink2,#60636a);margin:0 0 13px}" +
      "#athlevoEnvNotice .aeh-instruction{font-weight:600;color:var(--text,#141416)}" +
      "#athlevoEnvNotice .aeh-actions{display:flex;gap:10px;margin-top:18px}" +
      "#athlevoEnvNotice button{min-height:46px;border-radius:999px;padding:12px 16px;font:600 14px/1 var(--sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);cursor:pointer}" +
      "#athlevoEnvCopy{flex:1;border:1px solid var(--ink,#141416);background:var(--ink,#141416);color:var(--paper,#fff)}" +
      "#athlevoEnvClose{border:1px solid var(--line,#d9d9d5);background:transparent;color:var(--text,#141416)}" +
      "#athlevoEnvFeedback{min-height:18px;margin:13px 0 0!important;font-size:13px!important}" +
      "#athlevoEnvNotice button:focus-visible{outline:3px solid color-mix(in srgb,var(--red,#e5484d) 45%,transparent);outline-offset:2px}" +
      "@media(max-width:360px){#athlevoEnvNotice .aeh-card{padding-left:18px;padding-right:18px}#athlevoEnvNotice .aeh-actions{flex-direction:column}#athlevoEnvClose{width:100%}}" +
      "@media(min-width:600px){#athlevoEnvNotice{align-items:center}#athlevoEnvNotice .aeh-card{border-radius:24px;margin:20px}}" +
      "@media(prefers-reduced-motion:reduce){#athlevoEnvNotice *{animation:none!important;transition:none!important}}";
    document.head.appendChild(style);
  }

  function closeNotice(overlay) {
    if (!overlay) return;
    overlay.remove();
    if (handoffRestoreFocus && typeof handoffRestoreFocus.focus === "function") {
      handoffRestoreFocus.focus();
    }
    handoffRestoreFocus = null;
  }

  // Renders a copy-only handoff. Ordinary navigation cannot escape iOS IABs.
  function showNotice(opts) {
    opts = opts || {};
    const browserName = getEmbeddedBrowserName();
    const copy = noticeCopy(opts.context, browserName);
    const intent = safeIntent(opts.intent) ||
      (opts.context === "login" || opts.context === "strava" ? "login" : "signup");
    const sourceSurface = safeSurface(opts.sourceSurface);
    const browser = safeHandoffBrowser(opts.browser || handoffBrowser());
    const continuationUrl = buildContinuationUrl(intent, {
      browser,
      sourceSurface
    });

    let overlay = document.getElementById("athlevoEnvNotice");
    if (overlay) closeNotice(overlay);

    ensureHandoffStyles();
    handoffRestoreFocus = document.activeElement;
    overlay = document.createElement("div");
    overlay.id = "athlevoEnvNotice";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "athlevoEnvTitle");
    overlay.setAttribute("aria-describedby", "athlevoEnvBody athlevoEnvInstruction");

    overlay.innerHTML =
      '<div class="aeh-card">' +
        '<h2 id="athlevoEnvTitle">' + escapeHtml(copy.title) + "</h2>" +
        '<p id="athlevoEnvBody">' + escapeHtml(copy.body) + "</p>" +
        '<p class="aeh-instruction" id="athlevoEnvInstruction">Tap the ••• menu in the top-right corner, then choose Open in external browser or Open in Safari.</p>' +
        '<div class="aeh-actions">' +
          '<button id="athlevoEnvCopy" type="button">' +
            (intent === "signup" ? "Copy signup link" : "Copy login link") +
          "</button>" +
          '<button id="athlevoEnvClose" type="button">Close</button>' +
        "</div>" +
        '<p id="athlevoEnvFeedback" role="status" aria-live="polite"></p>' +
      "</div>";

    document.body.appendChild(overlay);

    const copyBtn = overlay.querySelector("#athlevoEnvCopy");
    const feedback = overlay.querySelector("#athlevoEnvFeedback");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const copied = await copyLink(continuationUrl);
        if (copied) {
          copyBtn.textContent = "Link copied";
          if (feedback) {
            feedback.textContent =
              "Link copied. Tap ••• above, choose Open in external browser, then paste the link if needed.";
          }
          trackHandoffEvent("external_signup_link_copied", {
            browser,
            intent,
            sourceSurface
          });
        } else if (feedback) {
          feedback.textContent = "Could not copy the link. Please try again.";
        }
      });
    }

    const closeBtn = overlay.querySelector("#athlevoEnvClose");
    if (closeBtn) closeBtn.addEventListener("click", () => closeNotice(overlay));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeNotice(overlay);
    });
    overlay.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNotice(overlay);
        return;
      }
      if (event.key !== "Tab" || !copyBtn || !closeBtn) return;
      if (event.shiftKey && document.activeElement === copyBtn) {
        event.preventDefault();
        closeBtn.focus();
      } else if (!event.shiftKey && document.activeElement === closeBtn) {
        event.preventDefault();
        copyBtn.focus();
      }
    });
    if (copyBtn && typeof copyBtn.focus === "function") copyBtn.focus();
    trackHandoffEvent("in_app_browser_signup_blocked", {
      browser,
      intent,
      sourceSurface
    });
    return { continuationUrl, intent, browser, sourceSurface };
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /*
   * Guard an auth/OAuth action. Returns true if the action was intercepted
   * (a notice was shown) and the caller should stop. For Strava, pass
   * allowContinue:false so OAuth never begins inside an embedded browser.
   */
  function guard(context, options) {
    options = options || {};
    if (!shouldWarn()) return false;
    showNotice({
      context,
      intent: options.intent,
      sourceSurface: options.sourceSurface
    });
    return true;
  }

  function guardSignupHandoff(intent, sourceSurface) {
    if (!shouldWarn()) return false;
    const browser = handoffBrowser();
    if (!browser) return false;
    showNotice({
      context: intent === "login" ? "login" : "signup",
      intent: safeIntent(intent) || "signup",
      sourceSurface: safeSurface(sourceSurface),
      browser
    });
    return true;
  }

  window.AthlevoEnv = {
    isEmbeddedBrowser,
    getEmbeddedBrowserName,
    isStandalonePWA,
    isStorageAvailable,
    shouldWarn,
    showNotice,
    guard,
    guardSignupHandoff,
    buildContinuationUrl,
    readContinuation,
    consumeContinuation,
    handoffBrowser,
    canonicalUrl: () => CANONICAL_URL
  };

  /* ═══════════════════ 2 · auth-error mapping ═══════════════════════════ */

  function mapAuthError(error, context) {
    const raw = String((error && error.message) || error || "").toLowerCase();
    const status = error && (error.status || error.code);

    if (
      error && error.__timeout ||
      (error && error.name === "AbortError") ||
      raw.includes("failed to fetch") ||
      raw.includes("networkerror") ||
      raw.includes("network request failed") ||
      raw.includes("load failed") ||
      raw.includes("timeout")
    ) {
      return { code: "AUTH_NETWORK", message: "We couldn’t reach the server. Check your connection and try again." };
    }
    if (raw.includes("already registered") || raw.includes("already exists") || raw.includes("user already")) {
      return { code: "AUTH_EMAIL_EXISTS", message: "An account already exists for this email. Log in instead." };
    }
    if (raw.includes("rate limit") || raw.includes("too many") || status === 429) {
      return { code: "AUTH_RATE_LIMIT", message: "Too many signup attempts. Please wait a minute and try again." };
    }
    if (raw.includes("email not confirmed") || raw.includes("not confirmed") || raw.includes("confirm your email")) {
      return { code: "AUTH_CONFIRM_EMAIL", message: "Check your email to confirm your account, then log in." };
    }
    if (raw.includes("invalid login") || raw.includes("invalid credentials")) {
      return { code: "AUTH_INVALID_LOGIN", message: "That email or password is incorrect." };
    }
    return context === "login"
      ? { code: "AUTH_UNKNOWN", message: "We couldn’t log you in. Please try again." }
      : { code: "AUTH_UNKNOWN", message: "We couldn’t create your account. Nothing was charged or submitted twice." };
  }

  window.AthlevoAuthErrors = { map: mapAuthError };

  /* ═══════════════════ 3 · wait for a valid session ═════════════════════ */

  /*
   * Bounded, backing-off wait for an authenticated session — never an
   * infinite spinner. Prefers the LOCAL getSession() (no network, works when
   * a signup just returned a session) and only falls back to getUser(). On
   * embedded browsers with blocked storage this returns null quickly so the
   * caller can show a clear error instead of hanging.
   */
  async function waitForValidUser(client, options) {
    options = options || {};
    const retries = options.retries || 5;
    const baseDelay = options.baseDelay || 150;
    const timeoutMs = options.timeoutMs || 8000;
    const start = Date.now();

    for (let i = 0; i < retries; i += 1) {
      if (Date.now() - start > timeoutMs) break;
      try {
        const { data } = await client.auth.getSession();
        if (data && data.session && data.session.user) return data.session.user;
      } catch (error) { /* transient — retry */ }
      const delay = Math.min(baseDelay * Math.pow(2, i), 1200);
      await new Promise(r => setTimeout(r, delay));
    }
    // One authoritative getUser() attempt before giving up.
    try {
      const { data } = await client.auth.getUser();
      if (data && data.user) return data.user;
    } catch (error) { /* ignore */ }
    return null;
  }

  window.AthlevoSession = { waitForValidUser };
})();

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

  function copyLink(url, buttonEl) {
    const done = () => { if (buttonEl) buttonEl.textContent = "Link copied ✓"; };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
        return;
      }
    } catch (error) { /* fall through */ }
    fallbackCopy(url, done);
  }

  function fallbackCopy(url, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (error) { /* no-op: user can long-press the URL */ }
  }

  function noticeCopy(context, browserName) {
    const name = browserName || "This app's";
    const base = {
      title: "Open Athlevo in your browser",
      body: `${name === "This app's" ? "This in-app browser" : name + "’s browser"} may interrupt sign-in and Strava connection. Open Athlevo in Safari or Chrome to continue.`
    };
    if (context === "strava") {
      base.body = `Strava must be connected from Safari or Chrome. ${name === "This app's" ? "This in-app browser" : name + "’s browser"} can’t complete the Strava connection.`;
    }
    return base;
  }

  // Renders the notice. opts: { context, allowContinue, onContinue }.
  function showNotice(opts) {
    opts = opts || {};
    const browserName = getEmbeddedBrowserName();
    const copy = noticeCopy(opts.context, browserName);

    let overlay = document.getElementById("athlevoEnvNotice");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "athlevoEnvNotice";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:rgba(20,20,22,.55);" +
      "display:flex;align-items:center;justify-content:center;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

    const iosHint = /iPhone|iPad|iPod/i.test(uaString())
      ? "Tap the ••• or menu icon, then choose “Open in Safari”."
      : "Tap the ⋮ menu, then choose “Open in Chrome” or “Open in browser”.";

    overlay.innerHTML =
      '<div style="background:#fff;max-width:400px;width:calc(100% - 40px);margin:20px;border-radius:22px;padding:26px;box-shadow:0 24px 80px rgba(0,0,0,.18);color:#141416">' +
        '<h2 style="font-size:19px;margin:0 0 8px">' + escapeHtml(copy.title) + "</h2>" +
        '<p style="font-size:14px;line-height:1.55;color:#6d7075;margin:0 0 14px">' + escapeHtml(copy.body) + "</p>" +
        '<p style="font-size:13px;line-height:1.5;color:#6d7075;margin:0 0 16px">' + escapeHtml(iosHint) + "</p>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<button id="athlevoEnvCopy" style="flex:1;min-width:130px;background:#141416;color:#fff;border:none;font-size:14px;font-weight:600;padding:13px 16px;border-radius:100px;cursor:pointer">Copy link</button>' +
          '<a id="athlevoEnvOpen" href="' + escapeHtml(CANONICAL_URL) + '" target="_blank" rel="noopener" style="flex:1;min-width:130px;text-align:center;text-decoration:none;background:#f6f6f4;color:#141416;font-size:14px;font-weight:600;padding:13px 16px;border-radius:100px">Open in browser</a>' +
        "</div>" +
        '<p style="font-size:12px;color:#9a9da3;margin:14px 0 0;text-align:center">' + escapeHtml(CANONICAL_URL) + "</p>" +
        (opts.allowContinue
          ? '<button id="athlevoEnvContinue" style="width:100%;margin-top:14px;background:none;border:none;color:#9a9da3;font-size:13px;cursor:pointer">Continue here anyway</button>'
          : "") +
        '<button id="athlevoEnvClose" style="width:100%;margin-top:8px;background:none;border:none;color:#9a9da3;font-size:13px;cursor:pointer">Close</button>' +
      "</div>";

    document.body.appendChild(overlay);

    const copyBtn = overlay.querySelector("#athlevoEnvCopy");
    if (copyBtn) copyBtn.addEventListener("click", () => copyLink(CANONICAL_URL, copyBtn));

    const closeBtn = overlay.querySelector("#athlevoEnvClose");
    if (closeBtn) closeBtn.addEventListener("click", () => overlay.remove());

    const contBtn = overlay.querySelector("#athlevoEnvContinue");
    if (contBtn) {
      contBtn.addEventListener("click", () => {
        overlay.remove();
        if (typeof opts.onContinue === "function") opts.onContinue();
      });
    }
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
    // If storage is unavailable, continuing cannot persist a session, so we
    // never offer "continue anyway".
    const allowContinue = options.allowContinue === true && isStorageAvailable();
    showNotice({ context, allowContinue, onContinue: options.onContinue });
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

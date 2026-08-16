/*
 * Athlevo runtime environment and native-container bridge.
 *
 * This is the only client module that knows about Capacitor. Browser/PWA
 * code asks this helper what environment it is in and how a URL should be
 * handled. It never contains credentials and never sends callback URLs,
 * authorization codes, or tokens to analytics.
 */
(function (root) {
  "use strict";

  const APP_ORIGIN = "https://athlevo.org";
  const API_ORIGIN = "https://athlevo.org";
  const AUTH_CALLBACK = "athlevo://auth/callback";
  const PROVIDER_CALLBACK = "athlevo://provider/callback";
  const INTERNAL_HOSTS = new Set(["athlevo.org", "www.athlevo.org"]);
  const EXTERNAL_HOSTS = new Set([
    "athlevo.org",
    "www.athlevo.org",
    "hqwdehqsllyvrcnlcytj.supabase.co",
    "accounts.google.com",
    "google.com",
    "www.google.com",
    "strava.com",
    "www.strava.com",
    "intervals.icu",
    "www.intervals.icu",
    "checkout.paymongo.com",
    "whop.com",
    "www.whop.com"
  ]);
  const PROVIDERS = new Set(["strava", "intervals"]);
  const STRAVA_RESULTS = new Set([
    "connected", "cancelled", "invalid_state", "missing_code", "failed"
  ]);
  const INTERVALS_RESULTS = new Set(["pending", "cancelled", "failed"]);
  const AUTH_CODE = /^[A-Za-z0-9._~-]{1,2048}$/;
  const AUTH_ERROR = /^[A-Za-z0-9._~-]{1,128}$/;
  const COMPLETION_VALUE = /^[A-Za-z0-9_-]{43}$/;
  const CALLBACK_URL_MAX_LENGTH = 8192;
  const AUTH_ERROR_DESCRIPTION_MAX_LENGTH = 512;
  const NATIVE_PROVIDER_RETURN_KEY = "athlevo_native_provider_return";
  const OAUTH_RETURN_KEY = "athlevo_oauth_return";
  const seenCallbackUrls = new Set();

  let authClient = null;
  let nativeInitialized = false;
  let nativeOAuthPending = false;
  let originalFetch = null;

  function capacitor() {
    return root.Capacitor || null;
  }

  function plugins() {
    const cap = capacitor();
    return (cap && cap.Plugins) || {};
  }

  function isNative() {
    const cap = capacitor();
    try {
      return Boolean(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
    } catch {
      return false;
    }
  }

  function nativePlatform() {
    const cap = capacitor();
    try {
      return cap && typeof cap.getPlatform === "function" ? cap.getPlatform() : "web";
    } catch {
      return "web";
    }
  }

  function isNativeIOS() {
    return isNative() && nativePlatform() === "ios";
  }

  function isInstalledPWA() {
    if (isNative()) return false;
    try {
      return root.navigator.standalone === true ||
        (typeof root.matchMedia === "function" &&
          root.matchMedia("(display-mode: standalone)").matches) ||
        String(root.document && root.document.referrer || "").startsWith("android-app://");
    } catch {
      return false;
    }
  }

  function userAgent() {
    try {
      return `${root.navigator.userAgent || ""} ${root.navigator.vendor || ""}`;
    } catch {
      return "";
    }
  }

  function browserKind() {
    if (isNativeIOS()) return "native-ios";
    const ua = userAgent();
    if (/\bInstagram\b/i.test(ua)) return "instagram";
    if (/\bFBAN\b|\bFBAV\b|FB_IAB|\bFBIOS\b|Messenger/i.test(ua)) return "facebook";
    if (/CriOS|Chrome/i.test(ua) && !/EdgiOS|OPiOS/i.test(ua)) return "chrome";
    if (/Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)) return "safari";
    return "other";
  }

  function isFacebookInstagramBrowser() {
    if (isNative()) return false;
    const kind = browserKind();
    return kind === "facebook" || kind === "instagram";
  }

  function isEmbeddedBrowser() {
    if (isNative()) return false;
    return /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|Twitter|TikTok|Snapchat|Pinterest|MicroMessenger|;\s?wv\)/i
      .test(userAgent());
  }

  function isAppMode() {
    return isNativeIOS() || isInstalledPWA();
  }

  function shouldShowInstallUI() {
    return !isNative() && !isInstalledPWA();
  }

  function shouldRegisterServiceWorker() {
    return !isNative();
  }

  function shouldHandleInstallRequest() {
    return !isNative();
  }

  function authRedirectUrl() {
    return isNativeIOS() ? AUTH_CALLBACK : null;
  }

  function normalizeInputUrl(value, base) {
    const raw = typeof value === "string"
      ? value
      : value && typeof value.url === "string"
        ? value.url
        : "";
    if (!raw) return null;
    try {
      return new URL(raw, base || (root.location && root.location.href) || APP_ORIGIN);
    } catch {
      return null;
    }
  }

  function isLocalWebViewUrl(url) {
    return Boolean(url && (
      url.protocol === "capacitor:" ||
      url.protocol === "ionic:" ||
      (root.location && url.origin === root.location.origin)
    ));
  }

  function classifyNavigation(value) {
    const url = normalizeInputUrl(value);
    if (!url) return { kind: "blocked", reason: "invalid_url" };
    if (url.protocol === "capacitor:" || url.protocol === "ionic:") {
      return isLocalWebViewUrl(url)
        ? { kind: "internal", url }
        : { kind: "blocked", reason: "untrusted_local_url", url };
    }
    if (url.protocol === "http:") {
      return { kind: "blocked", reason: "cleartext_http", url };
    }
    if (url.protocol !== "https:") {
      return { kind: "blocked", reason: "unsupported_scheme", url };
    }
    if (url.username || url.password || url.port) {
      return { kind: "blocked", reason: "invalid_authority", url };
    }
    if (isLocalWebViewUrl(url)) return { kind: "internal", url };
    const host = url.hostname.toLowerCase();
    if (
      INTERNAL_HOSTS.has(host) &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      return { kind: "internal-athlevo", url };
    }
    if (EXTERNAL_HOSTS.has(host)) return { kind: "external", url };
    return { kind: "blocked", reason: "untrusted_domain", url };
  }

  function nativeApiUrl(value) {
    if (!isNativeIOS()) return value;
    const raw = typeof value === "string"
      ? value
      : value && typeof value.url === "string"
        ? value.url
        : "";
    if (/^\/api(?:\/|\\?|$)/.test(raw)) return API_ORIGIN + raw;
    try {
      const url = new URL(raw);
      if (isLocalWebViewUrl(url) && /^\/api(?:\/|$)/.test(url.pathname)) {
        return API_ORIGIN + url.pathname + url.search;
      }
    } catch {
      // A non-URL input is returned unchanged.
    }
    return value;
  }

  function dispatch(name, detail) {
    try {
      root.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch {
      // Old WebViews/tests may not expose CustomEvent; native behavior stays safe.
    }
  }

  function toastSafe(message) {
    try {
      if (typeof root.toast === "function") root.toast(message);
    } catch {
      // User feedback is best-effort.
    }
  }

  function ensureStateStyles() {
    const doc = root.document;
    if (!doc || !doc.head || doc.getElementById("athlevoNativeStateStyles")) return;
    const style = doc.createElement("style");
    style.id = "athlevoNativeStateStyles";
    style.textContent =
      ".athlevo-native-ios{--athlevo-native-top:env(safe-area-inset-top,0px)}" +
      ".athlevo-native-ios [data-install-cta],.athlevo-native-ios #todayInstallCard," +
      ".athlevo-native-ios #lpInstallNav,.athlevo-native-ios #youInstallRow{display:none!important}" +
      ".athlevo-native-ios body{padding-top:0}" +
      ".athlevo-native-keyboard #tabbar{visibility:hidden}" +
      "#athlevoNativeState{position:fixed;inset:0;z-index:10020;display:none;align-items:center;" +
      "justify-content:center;padding:calc(28px + env(safe-area-inset-top)) 24px " +
      "calc(28px + env(safe-area-inset-bottom));background:var(--paper,#eeeeec);color:var(--text,#141416)}" +
      "#athlevoNativeState.show{display:flex}" +
      "#athlevoNativeState .ans-card{width:min(100%,360px);text-align:center}" +
      "#athlevoNativeState img{width:52px;height:52px;border-radius:14px;margin-bottom:20px}" +
      "#athlevoNativeState h1{font:500 28px/1.1 var(--serif,Georgia,serif);margin:0 0 10px}" +
      "#athlevoNativeState p{font:400 14px/1.5 var(--sans,-apple-system,sans-serif);color:var(--ink2,#666);margin:0}" +
      "#athlevoNativeState button{margin-top:20px;min-height:46px;border:0;border-radius:999px;" +
      "padding:12px 22px;background:var(--ink,#141416);color:#fff;font:650 14px/1 var(--sans,-apple-system,sans-serif)}" +
      "@media(prefers-reduced-motion:reduce){#athlevoNativeState *{animation:none!important;transition:none!important}}";
    doc.head.appendChild(style);
  }

  function ensureStateElement() {
    const doc = root.document;
    if (!doc || !doc.body) return null;
    let element = doc.getElementById("athlevoNativeState");
    if (element) return element;
    element = doc.createElement("div");
    element.id = "athlevoNativeState";
    element.setAttribute("role", "alert");
    element.setAttribute("aria-live", "assertive");
    element.innerHTML =
      '<div class="ans-card">' +
        '<img src="assets/athlevo-icon.png" alt="">' +
        '<h1 id="athlevoNativeStateTitle">Athlevo is offline</h1>' +
        '<p id="athlevoNativeStateBody">Reconnect to continue syncing your training.</p>' +
        '<button id="athlevoNativeRetry" type="button">Try again</button>' +
      "</div>";
    doc.body.appendChild(element);
    const retry = element.querySelector("#athlevoNativeRetry");
    if (retry) retry.addEventListener("click", () => root.location.reload());
    return element;
  }

  function showNativeState(kind) {
    if (!isNativeIOS()) return;
    const element = ensureStateElement();
    if (!element) return;
    const title = element.querySelector("#athlevoNativeStateTitle");
    const body = element.querySelector("#athlevoNativeStateBody");
    const copy = kind === "offline"
      ? ["No internet connection", "Reconnect to continue syncing your training."]
      : kind === "server"
        ? ["Athlevo is unavailable", "The server could not respond. Your saved session is still on this device."]
        : ["That link did not finish", "Return to Athlevo and try the action again."];
    if (title) title.textContent = copy[0];
    if (body) body.textContent = copy[1];
    element.classList.add("show");
  }

  function hideNativeState() {
    const element = root.document && root.document.getElementById("athlevoNativeState");
    if (element) element.classList.remove("show");
  }

  function installFetchBridge() {
    if (!isNativeIOS() || originalFetch || typeof root.fetch !== "function") return;
    originalFetch = root.fetch.bind(root);
    root.fetch = async function athlevoNativeFetch(input, init) {
      let requestInput = input;
      const rewritten = nativeApiUrl(input);
      if (rewritten !== input) {
        if (typeof input === "string") {
          requestInput = rewritten;
        } else if (typeof Request === "function" && input instanceof Request) {
          requestInput = new Request(rewritten, input);
        }
      }
      try {
        const response = await originalFetch(requestInput, init);
        const url = typeof rewritten === "string" ? rewritten : "";
        if (url.startsWith(API_ORIGIN + "/api/")) {
          if ([502, 503, 504].includes(response.status)) showNativeState("server");
          else if (response.ok) hideNativeState();
        }
        return response;
      } catch (error) {
        const online = !root.navigator || root.navigator.onLine !== false;
        showNativeState(online ? "server" : "offline");
        throw error;
      }
    };
  }

  function safeLocalRoute(url) {
    if (!url || !root.location) return false;
    const next = `${url.pathname || "/"}${url.search || ""}${url.hash || ""}`;
    root.location.assign(next);
    return true;
  }

  async function openExternal(value, options) {
    const route = classifyNavigation(value);
    const opts = options || {};
    if (route.kind === "blocked") {
      toastSafe("That link cannot be opened safely.");
      return { ok: false, reason: route.reason };
    }
    if (!isNativeIOS()) {
      root.open(route.url.toString(), "_blank", "noopener");
      return { ok: true, target: "browser" };
    }
    if (route.kind === "internal" || route.kind === "internal-athlevo") {
      return { ok: safeLocalRoute(route.url), target: "app" };
    }
    const Browser = plugins().Browser;
    if (!Browser || typeof Browser.open !== "function") {
      toastSafe("This link is unavailable right now.");
      return { ok: false, reason: "browser_plugin_unavailable" };
    }
    if (opts.oauth === true) nativeOAuthPending = true;
    await Browser.open({ url: route.url.toString(), presentationStyle: "popover" });
    return { ok: true, target: "system-browser" };
  }

  async function openOAuth(value) {
    return openExternal(value, { oauth: true });
  }

  async function startOAuth(value) {
    if (isNativeIOS()) return openOAuth(value);
    const route = classifyNavigation(value);
    if (route.kind === "blocked") {
      toastSafe("That connection could not be opened safely.");
      return { ok: false, reason: route.reason };
    }
    root.location.href = route.url.toString();
    return { ok: true, target: "same-window" };
  }

  function callbackRawValue(value) {
    return typeof value === "string"
      ? value
      : value && typeof value.url === "string"
        ? value.url
        : "";
  }

  function hasMalformedCallbackEncoding(raw) {
    const queryStart = raw.indexOf("?");
    if (queryStart < 0) return false;
    const fragmentStart = raw.indexOf("#", queryStart);
    const query = raw.slice(
      queryStart + 1,
      fragmentStart < 0 ? raw.length : fragmentStart
    );
    for (let index = 0; index < query.length; index += 1) {
      if (query[index] === "%" &&
          !/^[0-9a-f]{2}$/i.test(query.slice(index + 1, index + 3))) {
        return true;
      }
    }
    try {
      decodeURIComponent(query.replace(/\+/g, " "));
      return false;
    } catch {
      return true;
    }
  }

  function validateParameterKeys(params, allowedKeys) {
    const counts = new Map();
    for (const key of params.keys()) {
      if (!allowedKeys.has(key)) return "unknown_parameter";
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > 1) return "duplicate_parameter";
    }
    return null;
  }

  function readableBoundedValue(value, maximumLength) {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximumLength &&
      !/[\u0000-\u001f\u007f\ufffd]/.test(value);
  }

  function parseCallback(value) {
    const raw = callbackRawValue(value);
    if (!raw || raw.length > CALLBACK_URL_MAX_LENGTH) {
      return { ok: false, reason: "invalid_callback_length" };
    }
    if (!/^athlevo:\/\//i.test(raw)) {
      return { ok: false, reason: "invalid_scheme" };
    }
    if (raw.includes("#")) {
      return { ok: false, reason: "fragment_not_allowed" };
    }
    if (hasMalformedCallbackEncoding(raw)) {
      return { ok: false, reason: "malformed_encoding" };
    }

    const url = normalizeInputUrl(raw, AUTH_CALLBACK);
    if (!url || url.protocol !== "athlevo:") {
      return { ok: false, reason: "invalid_scheme" };
    }
    if (url.username || url.password || url.port) {
      return { ok: false, reason: "invalid_callback_authority" };
    }

    if (url.hostname === "auth" && url.pathname === "/callback") {
      const keyError = validateParameterKeys(
        url.searchParams,
        new Set(["code", "error", "error_code", "error_description"])
      );
      if (keyError) return { ok: false, reason: keyError };

      const hasCode = url.searchParams.has("code");
      const hasError = url.searchParams.has("error");
      const hasErrorMetadata = url.searchParams.has("error_code") ||
        url.searchParams.has("error_description");
      if (hasCode && (hasError || hasErrorMetadata)) {
        return { ok: false, reason: "conflicting_auth_parameters" };
      }
      if (!hasCode && !hasError) {
        return { ok: false, reason: "missing_auth_result" };
      }
      if (hasErrorMetadata && !hasError) {
        return { ok: false, reason: "orphaned_auth_error_metadata" };
      }

      const error = url.searchParams.get("error");
      if (hasError) {
        const errorCode = url.searchParams.get("error_code");
        const description = url.searchParams.get("error_description");
        if (
          !AUTH_ERROR.test(error || "") ||
          (errorCode !== null && !AUTH_ERROR.test(errorCode)) ||
          (description !== null &&
            !readableBoundedValue(description, AUTH_ERROR_DESCRIPTION_MAX_LENGTH))
        ) {
          return { ok: false, reason: "invalid_auth_error" };
        }
        return {
          ok: true,
          type: "auth",
          result: /access_denied|cancel|user_denied/i.test(error)
            ? "cancelled"
            : "failed"
        };
      }
      const code = url.searchParams.get("code");
      if (!code || !AUTH_CODE.test(code)) {
        return { ok: false, reason: "invalid_auth_code" };
      }
      return { ok: true, type: "auth", code };
    }

    if (url.hostname === "provider" && url.pathname === "/callback") {
      const keyError = validateParameterKeys(
        url.searchParams,
        new Set(["provider", "result", "completion"])
      );
      if (keyError) return { ok: false, reason: keyError };
      if (!url.searchParams.has("provider") || !url.searchParams.has("result")) {
        return { ok: false, reason: "missing_provider_result" };
      }

      const provider = url.searchParams.get("provider");
      if (!provider || !PROVIDERS.has(provider)) {
        return { ok: false, reason: "invalid_provider" };
      }
      if (provider === "strava") {
        if (url.searchParams.has("completion")) {
          return { ok: false, reason: "unexpected_completion" };
        }
        const result = url.searchParams.get("result");
        return result
          && STRAVA_RESULTS.has(result)
          ? { ok: true, type: "provider", provider, result }
          : { ok: false, reason: "invalid_provider_result" };
      }
      const result = url.searchParams.get("result");
      if (!result || !INTERVALS_RESULTS.has(result)) {
        return { ok: false, reason: "invalid_provider_result" };
      }
      const completion = url.searchParams.get("completion");
      if (result === "pending" && (!completion || !COMPLETION_VALUE.test(completion))) {
        return { ok: false, reason: "invalid_completion" };
      }
      if (result !== "pending" && url.searchParams.has("completion")) {
        return { ok: false, reason: "unexpected_completion" };
      }
      return {
        ok: true,
        type: "provider",
        provider,
        result,
        completion: result === "pending" ? completion : null
      };
    }

    return { ok: false, reason: "unsupported_callback" };
  }

  async function closeBrowser() {
    const Browser = plugins().Browser;
    try {
      if (Browser && typeof Browser.close === "function") await Browser.close();
    } catch {
      // It may already have been dismissed.
    }
  }

  async function handleCallback(value) {
    if (!isNativeIOS() || typeof value !== "string" || seenCallbackUrls.has(value)) return false;
    seenCallbackUrls.add(value);
    const parsed = parseCallback(value);
    if (!parsed.ok) {
      nativeOAuthPending = false;
      await closeBrowser();
      showNativeState("callback");
      dispatch("athlevo:native-link-failed", { reason: parsed.reason });
      return false;
    }

    if (parsed.type === "auth") {
      nativeOAuthPending = false;
      await closeBrowser();
      if (parsed.result === "cancelled") {
        toastSafe("Sign-in cancelled.");
        dispatch("athlevo:native-oauth-cancelled");
        return true;
      }
      if (parsed.result === "failed") {
        showNativeState("callback");
        dispatch("athlevo:native-link-failed", {
          reason: "auth_provider_failed"
        });
        return false;
      }
      if (!authClient || !authClient.auth ||
          typeof authClient.auth.exchangeCodeForSession !== "function") {
        showNativeState("callback");
        dispatch("athlevo:native-link-failed", { reason: "auth_not_ready" });
        return false;
      }
      const { data, error } = await authClient.auth.exchangeCodeForSession(parsed.code);
      if (error || !data || !data.session) {
        showNativeState("callback");
        dispatch("athlevo:native-link-failed", { reason: "auth_exchange_failed" });
        return false;
      }
      hideNativeState();
      dispatch("athlevo:native-auth-complete", { userId: data.session.user.id });
      return true;
    }

    nativeOAuthPending = false;
    await closeBrowser();
    const snapshot = { state: parsed.result, at: Date.now() };
    try {
      if (parsed.provider === "intervals") {
        snapshot.completion = parsed.completion || null;
        snapshot.message = null;
        snapshot.reason = null;
        root.__athlevoOAuthReturn = snapshot;
        root.sessionStorage.setItem(OAUTH_RETURN_KEY, JSON.stringify(snapshot));
      } else {
        root.__athlevoNativeProviderReturn = snapshot;
        root.sessionStorage.setItem(
          NATIVE_PROVIDER_RETURN_KEY,
          JSON.stringify(snapshot)
        );
      }
    } catch {
      showNativeState("callback");
      dispatch("athlevo:native-link-failed", {
        reason: "callback_storage_unavailable"
      });
      return false;
    }
    // Callback values never enter the visible app URL or browser history.
    root.location.replace(root.location.pathname || "/index.html");
    return true;
  }

  function installAnchorGuard() {
    if (!isNativeIOS() || !root.document) return;
    root.document.addEventListener("click", event => {
      const anchor = event.target && typeof event.target.closest === "function"
        ? event.target.closest("a[href]")
        : null;
      if (!anchor) return;
      const route = classifyNavigation(anchor.href);
      if (route.kind === "internal" && anchor.target !== "_blank") return;
      event.preventDefault();
      openExternal(anchor.href).catch(() => {
        toastSafe("That link could not be opened.");
      });
    }, true);
  }

  function setStatusBarAppearance() {
    if (!isNativeIOS()) return;
    const StatusBar = plugins().StatusBar;
    if (!StatusBar) return;
    const theme = root.document && root.document.documentElement &&
      root.document.documentElement.getAttribute
      ? root.document.documentElement.getAttribute("data-theme")
      : "system";
    const dark = theme === "dark" || (
      theme !== "light" &&
      root.matchMedia &&
      root.matchMedia("(prefers-color-scheme: dark)").matches
    );
    try {
      if (typeof StatusBar.setOverlaysWebView === "function") {
        StatusBar.setOverlaysWebView({ overlay: true });
      }
      if (typeof StatusBar.setStyle === "function") {
        StatusBar.setStyle({ style: dark ? "LIGHT" : "DARK" });
      }
    } catch {
      // Status-bar styling must never stop app startup.
    }
  }

  function watchAppearance() {
    if (!isNativeIOS()) return;
    try {
      if (root.MutationObserver && root.document && root.document.documentElement) {
        const observer = new root.MutationObserver(setStatusBarAppearance);
        observer.observe(root.document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"]
        });
      }
      if (root.matchMedia) {
        const media = root.matchMedia("(prefers-color-scheme: dark)");
        if (media && typeof media.addEventListener === "function") {
          media.addEventListener("change", setStatusBarAppearance);
        }
      }
    } catch {
      // Appearance observation is cosmetic and cannot block startup.
    }
  }

  function installNativeStateListeners() {
    const App = plugins().App;
    const Browser = plugins().Browser;
    const Network = plugins().Network;
    const Keyboard = plugins().Keyboard;

    if (App && typeof App.addListener === "function") {
      App.addListener("appUrlOpen", event => {
        handleCallback(event && event.url).catch(() => showNativeState("callback"));
      });
      App.addListener("appStateChange", async event => {
        if (!event || event.isActive !== true) return;
        if (authClient && authClient.auth && typeof authClient.auth.getSession === "function") {
          try { await authClient.auth.getSession(); } catch { /* next API call reports state */ }
        }
        dispatch("athlevo:native-resume");
      });
      if (typeof App.getLaunchUrl === "function") {
        App.getLaunchUrl().then(result => {
          if (result && result.url) return handleCallback(result.url);
          return null;
        }).catch(() => {});
      }
    }

    if (Browser && typeof Browser.addListener === "function") {
      Browser.addListener("browserFinished", () => {
        if (!nativeOAuthPending) return;
        nativeOAuthPending = false;
        toastSafe("Connection cancelled.");
        dispatch("athlevo:native-oauth-cancelled");
      });
    }

    if (Network) {
      if (typeof Network.getStatus === "function") {
        Network.getStatus().then(status => {
          if (status && status.connected === false) showNativeState("offline");
        }).catch(() => {});
      }
      if (typeof Network.addListener === "function") {
        Network.addListener("networkStatusChange", status => {
          if (status && status.connected === false) showNativeState("offline");
          else hideNativeState();
        });
      }
    }

    if (Keyboard && typeof Keyboard.addListener === "function" && root.document) {
      Keyboard.addListener("keyboardWillShow", () =>
        root.document.documentElement.classList.add("athlevo-native-keyboard"));
      Keyboard.addListener("keyboardWillHide", () =>
        root.document.documentElement.classList.remove("athlevo-native-keyboard"));
    }
  }

  function hideSplashWhenReady() {
    const SplashScreen = plugins().SplashScreen;
    if (!SplashScreen || typeof SplashScreen.hide !== "function") return;
    let hidden = false;
    const hide = () => {
      if (hidden) return;
      hidden = true;
      SplashScreen.hide({ fadeOutDuration: 180 }).catch(() => {});
    };
    root.addEventListener("athlevo:app-ready", hide, { once: true });
    root.setTimeout(hide, 6500);
  }

  function initializeNative(client) {
    if (client) authClient = client;
    if (!isNativeIOS() || nativeInitialized) return false;
    nativeInitialized = true;
    if (root.document) {
      root.document.documentElement.classList.add("athlevo-native-ios");
      ensureStateStyles();
      if (root.document.body) ensureStateElement();
      else root.document.addEventListener("DOMContentLoaded", ensureStateElement, { once: true });
    }
    installFetchBridge();
    installAnchorGuard();
    installNativeStateListeners();
    setStatusBarAppearance();
    watchAppearance();
    hideSplashWhenReady();
    return true;
  }

  root.AthlevoRuntime = {
    APP_ORIGIN,
    API_ORIGIN,
    AUTH_CALLBACK,
    PROVIDER_CALLBACK,
    isNative,
    isNativeIOS,
    nativePlatform,
    isInstalledPWA,
    browserKind,
    isFacebookInstagramBrowser,
    isEmbeddedBrowser,
    isAppMode,
    shouldShowInstallUI,
    shouldRegisterServiceWorker,
    shouldHandleInstallRequest,
    authRedirectUrl,
    nativeApiUrl,
    classifyNavigation,
    parseCallback,
    handleCallback,
    openExternal,
    openOAuth,
    startOAuth,
    initializeNative,
    showNativeState,
    hideNativeState
  };

  // Install the API rewrite before any later application script can fetch.
  if (isNativeIOS()) {
    if (root.document) {
      root.document.documentElement.classList.add("athlevo-native-ios");
      ensureStateStyles();
    }
    installFetchBridge();
  }
})(typeof window !== "undefined" ? window : globalThis);

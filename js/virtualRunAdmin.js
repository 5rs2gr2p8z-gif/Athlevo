/*
 * Athlevo staff page for the Sub-1 10k Challenge (/virtual-run/admin).
 *
 * Shows registrations, filters them, and downloads the fulfillment CSV. Everything it shows comes from
 * /api/virtual-run/admin, which checks the sign-in token against the staff list on the server and
 * refuses everyone else. This page only holds the sign-in and the display; hiding it would not protect
 * anything, and nothing here is a secret. It is not indexed (meta robots and the response headers).
 *
 * Sign-in: if this browser is signed in to the Athlevo app, that session is read (never changed). Otherwise
 * the staff member signs in here with email and password; that session lives in this tab only.
 * Every value from the server is put on the page with textContent, never as markup.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ pure helpers */

  function formatPeso(cents) {
    var pesos = (Number(cents) || 0) / 100;
    return "₱" + pesos.toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  var MANILA = typeof Intl !== "undefined" && Intl.DateTimeFormat
    ? new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  /** An ISO timestamp as Manila time, or an empty string. */
  function formatMoment(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    return MANILA ? MANILA.format(date) : date.toISOString();
  }

  /** The query string for a set of filters. Only what is set is sent. */
  function queryString(filters, extra) {
    var parts = [];
    function add(key, value) { parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value)); }
    var f = filters || {};
    if (f.package && f.package !== "all") add("package", f.package);
    if (f.status && f.status !== "all") add("status", f.status);
    if (f.q && String(f.q).trim().length >= 2) add("q", String(f.q).trim());
    if (f.fulfillment) add("fulfillment", "1");
    Object.keys(extra || {}).forEach(function (key) { add(key, extra[key]); });
    return parts.length ? "?" + parts.join("&") : "";
  }

  global.AthlevoVirtualRunAdmin = { formatPeso: formatPeso, formatMoment: formatMoment, queryString: queryString };

  /* ------------------------------------------------------------------ the page */

  var doc = global.document;
  if (!doc || !doc.body || !doc.getElementById("vra-app")) return;

  var body = doc.body;
  var SUPABASE_URL = body.getAttribute("data-supabase-url") || "";
  var SUPABASE_KEY = body.getAttribute("data-supabase-key") || "";
  var APP_STORAGE_KEY = body.getAttribute("data-storage-key") || "";
  var API = body.getAttribute("data-api") || "/api/virtual-run/admin";
  var OWN_KEY = "athlevo.vra.session";

  var statusNode = doc.getElementById("vra-status");
  var signinSection = doc.getElementById("vra-signin");
  var signinForm = doc.getElementById("vra-signin-form");
  var signinError = doc.getElementById("vra-signin-error");
  var signinButton = doc.getElementById("vra-signin-button");
  var appSection = doc.getElementById("vra-app");
  var signoutButton = doc.getElementById("vra-signout");
  var statsNode = doc.getElementById("vra-stats");
  var rowsNode = doc.getElementById("vra-rows");
  var emptyNode = doc.getElementById("vra-empty");
  var countNode = doc.getElementById("vra-count");
  var filtersForm = doc.getElementById("vra-filters");
  var exportButton = doc.getElementById("vra-export");
  var refreshButton = doc.getElementById("vra-refresh");
  var packageSelect = doc.getElementById("vra-package");

  var packageNames = {};
  [].slice.call(packageSelect.options).forEach(function (option) { if (option.value !== "all") packageNames[option.value] = option.text; });

  /* ----- sessions ----- */

  function nowSeconds() { return Math.floor(Date.now() / 1000); }

  function readJson(storage, key) {
    try {
      var raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) { return null; }
  }

  function ownSession() { return readJson(global.sessionStorage, OWN_KEY); }
  function saveOwnSession(session) { try { global.sessionStorage.setItem(OWN_KEY, JSON.stringify(session)); } catch (error) { /* tab only */ } }
  function clearOwnSession() { try { global.sessionStorage.removeItem(OWN_KEY); } catch (error) { /* ignore */ } }

  /** The Athlevo app's session in this browser, if it is still valid. Read only: the app owns it and rotates its tokens. */
  function appSession() {
    var stored = readJson(global.localStorage, APP_STORAGE_KEY);
    if (!stored || typeof stored.access_token !== "string") return null;
    if (typeof stored.expires_at === "number" && stored.expires_at <= nowSeconds() + 30) return null;
    return { access_token: stored.access_token, email: stored.user && stored.user.email, source: "app" };
  }

  function authRequest(grant, payload) {
    return global.fetch(SUPABASE_URL + "/auth/v1/token?grant_type=" + grant, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().then(function (data) { return { ok: response.ok, status: response.status, data: data }; },
        function () { return { ok: response.ok, status: response.status, data: null }; });
    });
  }

  function sessionFrom(data) {
    if (!data || typeof data.access_token !== "string") return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || "",
      expires_at: typeof data.expires_at === "number" ? data.expires_at : nowSeconds() + (Number(data.expires_in) || 3600),
      email: (data.user && data.user.email) || "",
      source: "own"
    };
  }

  function refreshOwn(session) {
    if (!session || !session.refresh_token) return Promise.resolve(null);
    return authRequest("refresh_token", { refresh_token: session.refresh_token }).then(function (result) {
      var next = result.ok ? sessionFrom(result.data) : null;
      if (next) { if (!next.email) next.email = session.email; saveOwnSession(next); }
      else clearOwnSession();
      return next;
    }, function () { return null; });
  }

  /** A usable session or null. Resolves quickly when nothing needs refreshing. */
  function currentSession() {
    var own = ownSession();
    if (own && own.access_token) {
      if (own.expires_at > nowSeconds() + 30) return Promise.resolve(Object.assign({ source: "own" }, own));
      return refreshOwn(own).then(function (next) { return next || appSession(); });
    }
    return Promise.resolve(appSession());
  }

  /* ----- display ----- */

  function setStatus(message) {
    statusNode.textContent = message || "";
    statusNode.hidden = !message;
  }

  function showSignIn(message) {
    appSection.hidden = true;
    signoutButton.hidden = true;
    signinSection.hidden = false;
    setStatus(message || "");
    signinError.textContent = "";
  }

  function showApp(session) {
    signinSection.hidden = true;
    appSection.hidden = false;
    signoutButton.hidden = session.source !== "own";
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderStats(summary) {
    statsNode.textContent = "";
    var by = (summary && summary.byStatus) || {};
    var other = (by.failed || 0) + (by.expired || 0) + (by.cancelled || 0) + (by.refunded || 0) + ((summary && summary.lapsedHolds) || 0);
    [["Paid", by.paid || 0], ["Awaiting payment", by.pending || 0], ["Not completed", other], ["Live revenue", formatPeso(summary && summary.paidCents)]]
      .forEach(function (pair) {
        var box = el("div", "vra-stat");
        box.appendChild(el("span", "", pair[0]));
        box.appendChild(el("strong", "", String(pair[1])));
        statsNode.appendChild(box);
      });
    var lines = Object.keys((summary && summary.byPackage) || {}).map(function (id) {
      var entry = summary.byPackage[id];
      return (packageNames[id] || id) + ": " + entry.paid + " paid, " + entry.pending + " awaiting payment";
    });
    if (lines.length) statsNode.appendChild(el("p", "vra-note vra-packagelines", lines.join("  ·  ")));
  }

  var DETAIL_FIELDS = [
    ["Email", "email"], ["Mobile", "mobile"], ["Date of birth", "dateOfBirth"], ["Gender", "gender"],
    ["5k personal best", "pb5k"], ["10k personal best", "pb10k"], ["Runs per week", "frequency"], ["Goal", "goal"],
    ["Shirt size", "shirtSize"], ["Recipient", "recipient"], ["Address", "address"], ["Barangay", "barangay"],
    ["City or municipality", "city"], ["Province", "province"], ["Postal code", "postal"],
    ["Payment method", "paymentMethod"], ["Confirmation email", "emailStatus"], ["Result", "resultStatus"]
  ];

  function renderRow(row, index) {
    var main = el("tr");
    main.appendChild(el("td", "vra-id", row.registrationId || ""));
    main.appendChild(el("td", "", row.fullName || ""));
    main.appendChild(el("td", "", row.package || ""));
    var pay = el("td");
    pay.appendChild(el("span", "vra-pill vra-pill--" + String(row.status || "").replace(/[^a-z]/g, ""), String(row.status || "")));
    if (row.status === "paid" && row.livemode === false) pay.appendChild(el("span", "vra-pill vra-pill--test", "Test"));
    main.appendChild(pay);
    main.appendChild(el("td", "", formatMoment(row.paidAt)));
    main.appendChild(el("td", "", formatMoment(row.createdAt)));

    var detailId = "vra-detail-" + index;
    var cell = el("td");
    var toggle = el("button", "vra-link", "Details");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", detailId);
    toggle.setAttribute("aria-label", "Details for " + (row.registrationId || "registration"));
    cell.appendChild(toggle);
    main.appendChild(cell);

    var detail = el("tr", "vra-detail");
    detail.id = detailId;
    detail.hidden = true;
    var span = el("td");
    span.colSpan = 7;
    var list = el("dl");
    DETAIL_FIELDS.forEach(function (pair) {
      var value = row[pair[1]];
      if (value === null || value === undefined || value === "") return;
      var wrap = el("div");
      wrap.appendChild(el("dt", "", pair[0]));
      wrap.appendChild(el("dd", "", String(value)));
      list.appendChild(wrap);
    });
    span.appendChild(list);
    detail.appendChild(span);

    toggle.addEventListener("click", function () {
      var open = detail.hidden;
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Hide" : "Details";
    });
    rowsNode.appendChild(main);
    rowsNode.appendChild(detail);
  }

  function render(data) {
    renderStats(data.summary);
    rowsNode.textContent = "";
    var rows = Array.isArray(data.rows) ? data.rows : [];
    rows.forEach(renderRow);
    emptyNode.hidden = rows.length > 0;
    countNode.textContent = rows.length + (rows.length === 1 ? " registration" : " registrations") + " shown." +
      (data.truncated ? " This is the latest part of the list. Narrow it with the filters, or export the CSV." : "") +
      (data.generatedAt ? " Updated " + formatMoment(data.generatedAt) + " (Manila)." : "");
  }

  /* ----- loading ----- */

  function readFilters() {
    return {
      package: packageSelect.value,
      status: doc.getElementById("vra-state").value,
      q: doc.getElementById("vra-search").value,
      fulfillment: doc.getElementById("vra-fulfillment").checked
    };
  }

  function apiGet(session, query) {
    return global.fetch(API + query, { headers: { Authorization: "Bearer " + session.access_token, Accept: "application/json, text/csv" }, cache: "no-store" });
  }

  /** Runs an API call; on 401 it refreshes this tab's own session once and tries again. */
  function authorised(query, session, retried) {
    return apiGet(session, query).then(function (response) {
      if (response.status === 401 && !retried && session.source === "own") {
        return refreshOwn(ownSession()).then(function (next) {
          if (!next) return response;
          return authorised(query, next, true);
        });
      }
      return response;
    });
  }

  function handleDenied(response, session) {
    if (response.status === 401) {
      if (session.source === "own") clearOwnSession();
      showSignIn("Your sign-in has ended. Sign in again.");
      return true;
    }
    if (response.status === 403) {
      appSection.hidden = true;
      signinSection.hidden = true;
      signoutButton.hidden = session.source !== "own";
      setStatus("This account is not on the staff list. Ask the owner to add it, or sign in with a different account.");
      return true;
    }
    return false;
  }

  var loading = false;
  function load() {
    if (loading) return Promise.resolve();
    loading = true;
    setStatus("Loading registrations.");
    return currentSession().then(function (session) {
      if (!session) { showSignIn(""); return null; }
      return authorised(queryString(readFilters()), session, false).then(function (response) {
        if (handleDenied(response, session)) return null;
        if (!response.ok) { showApp(session); setStatus("Registrations could not be loaded. Try Refresh in a moment."); return null; }
        return response.json().then(function (data) { showApp(session); setStatus(""); render(data); });
      });
    }).catch(function () {
      setStatus("Registrations could not be loaded. Check your connection and try Refresh.");
    }).then(function () { loading = false; });
  }

  function downloadCsv() {
    exportButton.disabled = true;
    currentSession().then(function (session) {
      if (!session) { showSignIn("Sign in to export."); return null; }
      return authorised(queryString(readFilters(), { format: "csv" }), session, false).then(function (response) {
        if (handleDenied(response, session)) return null;
        if (!response.ok) { setStatus("The export did not work. Try again in a moment."); return null; }
        var disposition = response.headers.get("content-disposition") || "";
        var match = /filename="?([^";]+)"?/.exec(disposition);
        return response.blob().then(function (blob) {
          var url = global.URL.createObjectURL(blob);
          var link = doc.createElement("a");
          link.href = url;
          link.download = match ? match[1] : "athlevo-sub-1-10k-orders.csv";
          doc.body.appendChild(link);
          link.click();
          link.remove();
          global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);
        });
      });
    }).catch(function () {
      setStatus("The export did not work. Check your connection and try again.");
    }).then(function () { exportButton.disabled = false; });
  }

  /* ----- events ----- */

  signinForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var email = doc.getElementById("vra-email").value.trim();
    var password = doc.getElementById("vra-password").value;
    if (!email || !password) { signinError.textContent = "Enter your email and password."; return; }
    signinButton.disabled = true;
    signinError.textContent = "";
    authRequest("password", { email: email, password: password }).then(function (result) {
      var session = result.ok ? sessionFrom(result.data) : null;
      if (!session) {
        signinError.textContent = result.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "That email and password did not work.";
        return;
      }
      doc.getElementById("vra-password").value = "";
      saveOwnSession(session);
      load();
    }, function () {
      signinError.textContent = "We could not reach the sign-in service. Check your connection and try again.";
    }).then(function () { signinButton.disabled = false; });
  });

  filtersForm.addEventListener("submit", function (event) { event.preventDefault(); load(); });
  refreshButton.addEventListener("click", load);
  exportButton.addEventListener("click", downloadCsv);
  signoutButton.addEventListener("click", function () {
    clearOwnSession();
    rowsNode.textContent = "";
    statsNode.textContent = "";
    showSignIn("You are signed out.");
  });

  load();
})(typeof window !== "undefined" ? window : globalThis);

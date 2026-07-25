/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Internal beta analytics dashboard  (founder-only)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A compact, read-only overlay showing the beta funnel / retention / segments.
 *  It calls /api/providers?action=admin_analytics with the caller's Supabase bearer token; the
 *  SERVER decides (ADMIN_USER_IDS allowlist) whether to return data. A normal
 *  athlete's token gets 403 and this view shows "Not authorized" — the security
 *  is server-side, not the absence of a nav link.
 *
 *  Open with: AthlevoBetaDashboard.open()   (no navigation entry is exposed).
 *  Renders no individual private workout or chat content — aggregates only.
 */
(function (root) {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  async function token() {
    try {
      var s = await root.supabaseClient.auth.getSession();
      return s && s.data && s.data.session ? s.data.session.access_token : null;
    } catch (e) { return null; }
  }

  function mount(html) {
    var el = root.document.getElementById("adminDash");
    if (!el) {
      el = root.document.createElement("div");
      el.id = "adminDash";
      root.document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.style.display = "block";
  }
  function close() { var el = root.document.getElementById("adminDash"); if (el) { el.style.display = "none"; el.innerHTML = ""; } }

  function statRow(label, value) {
    return '<div class="ad-stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }

  function render(d) {
    var t = d.topline || {}, a = d.active || {}, r = d.retention || {}, s = d.segments || {};
    var funnel = (d.funnel && d.funnel.stages || []).map(function (st) {
      return '<div class="ad-fn-row"><span class="ad-fn-label">' + esc(st.label) + '</span>' +
        '<b>' + st.users + '</b>' +
        '<small>' + st.pctFromPrev + '% · ' + st.pctFromStart + '% total</small></div>';
    }).join("");
    var seg = Object.keys(s).map(function (k) {
      return statRow(k.replace(/_/g, " "), s[k]);
    }).join("");
    var fail = ["wearable", "plan", "sync"].map(function (g) {
      var cats = (d.failures && d.failures[g]) || {};
      var parts = Object.keys(cats).map(function (c) { return esc(c) + " " + cats[c]; }).join(", ") || "none";
      return statRow(g + " failures", parts);
    }).join("");

    mount(
      '<div class="ad-sheet">' +
        '<div class="ad-head"><b>Beta analytics</b>' +
          '<button type="button" class="ad-x" onclick="AthlevoBetaDashboard.close()">×</button></div>' +
        '<div class="ad-grid">' +
          statRow("Accounts", t.accounts || 0) + statRow("Verified", t.verified || 0) +
          statRow("Onboarded", t.onboardingCompleted || 0) + statRow("Wearable", t.wearableConnected || 0) +
          statRow("1st activity", t.firstActivityImported || 0) + statRow("1st plan", t.firstPlanGenerated || 0) +
          statRow("Active 1d", a.last1 || 0) + statRow("Active 7d", a.last7 || 0) + statRow("Active 30d", a.last30 || 0) +
        '</div>' +
        '<div class="ad-h">Funnel</div><div class="ad-funnel">' + funnel + '</div>' +
        '<div class="ad-h">Retention</div><div class="ad-grid">' +
          statRow("D1", r.d1 ? r.d1.users + " (" + r.d1.pct + "%)" : "0") +
          statRow("D3", r.d3 ? r.d3.users + " (" + r.d3.pct + "%)" : "0") +
          statRow("D7", r.d7 ? r.d7.users + " (" + r.d7.pct + "%)" : "0") +
          statRow("D14", r.d14 ? r.d14.users + " (" + r.d14.pct + "%)" : "0") +
        '</div>' +
        '<div class="ad-h">Email-ready segments</div><div class="ad-grid">' + seg + '</div>' +
        '<div class="ad-h">Recent failures</div><div class="ad-grid">' + fail + '</div>' +
      '</div>'
    );
  }

  async function open() {
    mount('<div class="ad-sheet"><div class="ad-head"><b>Beta analytics</b>' +
      '<button type="button" class="ad-x" onclick="AthlevoBetaDashboard.close()">×</button></div>' +
      '<p class="ad-loading">Loading…</p></div>');
    var tok = await token();
    if (!tok) { return render403("Sign in required."); }
    try {
      var res = await fetch("/api/providers?action=admin_analytics", { headers: { Authorization: "Bearer " + tok } });
      if (res.status === 403) return render403("Not authorized.");
      var data = await res.json();
      if (res.status === 200 && data && data.ok) render(data);
      else render403((data && data.error) || "Could not load analytics.");
    } catch (e) { render403("Could not load analytics."); }
  }
  function render403(msg) {
    mount('<div class="ad-sheet"><div class="ad-head"><b>Beta analytics</b>' +
      '<button type="button" class="ad-x" onclick="AthlevoBetaDashboard.close()">×</button></div>' +
      '<p class="ad-loading">' + esc(msg) + '</p></div>');
  }

  root.AthlevoBetaDashboard = { open: open, close: close, _render: render };
})(typeof window !== "undefined" ? window : globalThis);

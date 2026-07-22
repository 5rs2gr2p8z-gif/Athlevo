/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Adaptive Smart Plan v2 (client)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Surfaces the server's plan-update PREVIEW as a compact, opt-in card on
 *  Train, plus a review modal that shows current → proposed for every change
 *  with its reason and date. Nothing is applied without the athlete tapping
 *  "Apply changes". "Keep current plan" dismisses that exact proposal so it
 *  does not reappear on every reload.
 *
 *  It only READS/writes via the authenticated /api/training/get-week intents;
 *  it never touches the workout modal, recognition, or the visualization.
 *  Exposed as window.AthlevoAdaptivePlan.
 */
(function (root) {
  "use strict";

  var BUILD = "adaptive-plan-client-v1";
  try { if (root.console) root.console.log("[athlevo] adaptive plan build: " + BUILD); } catch (e) {}

  var state = { preview: null, busy: false };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function $(id) { return root.document ? root.document.getElementById(id) : null; }
  function todayKey() {
    try { return new Date().toISOString().slice(0, 10); } catch (e) { return null; }
  }

  async function token() {
    try {
      var s = await root.supabaseClient.auth.getSession();
      return s && s.data && s.data.session ? s.data.session.access_token : null;
    } catch (e) { return null; }
  }

  async function post(body) {
    var tok = await token();
    if (!tok) return null;
    var res = await fetch("/api/training/get-week", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data };
  }

  // Human one-liner for a single change (current → proposed).
  function describe(c) {
    var b = c.before || {}, a = c.after || {};
    if (a.session_type && a.session_type !== b.session_type) {
      var extra = a.distance_km != null ? " (" + a.distance_km + " km)" : "";
      return esc(b.session_type || "Workout") + " → " + esc(a.session_type) + extra;
    }
    if (a.duration_minutes != null) return esc((b.duration_minutes != null ? b.duration_minutes : "?")) + " → " + esc(a.duration_minutes) + " min";
    if (a.distance_km != null) return esc((b.distance_km != null ? b.distance_km : "?")) + " → " + esc(a.distance_km) + " km";
    return "Updated";
  }

  function niceDate(d) {
    try {
      var dt = new Date(d + "T00:00:00");
      return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    } catch (e) { return d; }
  }

  /* ── the compact card (only when changes exist) ─────────────────────── */
  function renderCard() {
    var el = $("adaptivePlanCard");
    if (!el) return;
    var pv = state.preview;
    var show = pv && pv.hasPlan && !pv.stable && !pv.suppressed && !pv.alreadyApplied &&
      pv.proposedChanges && pv.proposedChanges.length;
    if (!show) { el.innerHTML = ""; return; }
    var n = pv.proposedChanges.length;
    el.innerHTML =
      '<div class="apl-card">' +
        '<div class="apl-card-body">' +
          '<div class="apl-card-h">Plan update available</div>' +
          '<p class="apl-card-p">Athlevo recommends ' + n + ' adjustment' + (n === 1 ? "" : "s") +
            ' based on your recent training.</p>' +
        '</div>' +
        '<button type="button" class="apl-review-btn" onclick="AthlevoAdaptivePlan.openReview()">Review changes</button>' +
      '</div>';
  }

  /* ── the compact weekly review (own small area, not a feed) ─────────── */
  function renderWeeklyReview() {
    var el = $("adaptiveWeeklyReview");
    if (!el) return;
    var r = state.preview && state.preview.weeklyReview;
    if (!r || !r.completedLabel) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<div class="apl-review-week">' +
        '<div class="apl-rw-h">Last week</div>' +
        '<div class="apl-rw-grid">' +
          stat("Completed", r.completedLabel) +
          stat("Quality", r.quality ? r.quality.label : "—") +
          stat("Mileage", (r.mileageKm != null ? r.mileageKm + " km" : "—")) +
          stat("Longest", (r.longestRunKm != null ? r.longestRunKm + " km" : "—")) +
          stat("Consistency", r.consistency || "—") +
        '</div>' +
        (r.takeaway ? '<p class="apl-rw-take">' + esc(r.takeaway) + '</p>' : '') +
      '</div>';
  }
  function stat(label, value) {
    return '<div class="apl-rw-stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }

  /* ── review modal: current vs proposed, reason, date ────────────────── */
  function openReview() {
    var pv = state.preview;
    var m = $("adaptivePlanModal");
    if (!pv || !m) return;
    var rows = pv.proposedChanges.map(function (c) {
      return '<div class="apl-change">' +
        '<div class="apl-change-top"><span class="apl-change-date">' + esc(niceDate(c.date)) + '</span></div>' +
        '<div class="apl-change-diff">' + describe(c) + '</div>' +
        '<div class="apl-change-reason">' + esc(c.reason || "") + '</div>' +
      '</div>';
    }).join("");
    m.innerHTML =
      '<div class="apl-sheet" role="dialog" aria-label="Review plan changes">' +
        '<div class="apl-sheet-h">Review changes</div>' +
        '<div class="apl-sheet-body">' + rows + '</div>' +
        '<div class="apl-msg" id="aplMsg"></div>' +
        '<div class="apl-actions">' +
          '<button type="button" class="apl-keep" onclick="AthlevoAdaptivePlan.keep()">Keep current plan</button>' +
          '<button type="button" class="apl-apply" onclick="AthlevoAdaptivePlan.apply()">Apply changes</button>' +
        '</div>' +
      '</div>';
    m.classList.add("show");
  }
  function closeReview() { var m = $("adaptivePlanModal"); if (m) { m.classList.remove("show"); m.innerHTML = ""; } }
  function msg(text) { var el = $("aplMsg"); if (el) el.textContent = text || ""; }

  async function apply() {
    if (state.busy || !state.preview) return;
    state.busy = true; msg("Applying…");
    var out = await post({ intent: "adaptive_apply", fingerprint: state.preview.fingerprint, today: todayKey() });
    state.busy = false;
    if (out && out.status === 200 && out.data && out.data.success) {
      closeReview();
      state.preview = null;
      renderCard(); renderWeeklyReview();
      if (root.loadWeeklyPlan) { try { await root.loadWeeklyPlan(); } catch (e) {} }
      await refresh();       // re-preview; the applied proposal is now suppressed
    } else if (out && out.status === 409) {
      msg("Your training changed — refreshing the recommendation…");
      await refresh(); closeReview();
    } else {
      msg((out && out.data && out.data.error) || "That could not be applied. Please try again.");
    }
  }

  async function keep() {
    if (state.busy || !state.preview) return;
    state.busy = true; msg("");
    await post({ intent: "adaptive_dismiss", fingerprint: state.preview.fingerprint });
    state.busy = false;
    if (state.preview) state.preview.suppressed = true;
    closeReview(); renderCard();
  }

  /* ── entry point: fetch the preview + render (safe no-op on failure) ── */
  async function refresh() {
    try {
      var out = await post({ intent: "adaptive_preview", today: todayKey() });
      state.preview = (out && out.status === 200 && out.data) ? out.data : null;
    } catch (e) { state.preview = null; }
    renderCard(); renderWeeklyReview();
  }

  root.AthlevoAdaptivePlan = {
    refresh: refresh, openReview: openReview, closeReview: closeReview,
    apply: apply, keep: keep, BUILD: BUILD,
    _state: state, _describe: describe,         // exposed for tests
    _render: function (pv) { state.preview = pv; renderCard(); renderWeeklyReview(); }
  };
})(typeof window !== "undefined" ? window : globalThis);

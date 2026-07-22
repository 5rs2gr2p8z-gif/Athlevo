/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Training Data Status  (sync confidence)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Answers, at a glance, the only two questions a runner has after connecting
 *  a watch: "Did Athlevo receive my workout?" and "Is Garmin actually
 *  connected?" — a premium status card in You, plus a subtle success banner
 *  when a new activity lands.
 *
 *  This is a PRESENTATION layer only. It never changes how data is fetched or
 *  stored: it READS the existing connection status and the already-loaded
 *  activity cache, and every action (connect / reconnect / disconnect / open
 *  partner) DELEGATES to the existing, frozen handlers. Nothing here touches
 *  recognition, the workout modal, the planning engine, onboarding, the API
 *  layer or the schema.
 *
 *  Pure helpers (deriveState / formatRelative / summarizeActivity /
 *  renderCardHTML / renderBannerHTML / detectNewImport) take data and return
 *  data or strings, so the whole surface is unit-testable with no DOM.
 *
 *  Exposed as window.AthlevoSyncStatus.
 */
(function (root) {
  "use strict";

  var BUILD = "sync-status-v1";
  try { if (root.console) root.console.log("[athlevo] sync status build: " + BUILD); } catch (e) {}

  var LASTSEEN_KEY = "athlevo_sync_lastseen";
  var state = { syncing: false, lastModel: null };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function num(v) { var x = Number(v); return isFinite(x) ? x : null; }
  function $(id) { return root.document ? root.document.getElementById(id) : null; }

  /* ── pure: relative time ────────────────────────────────────────────── */
  function formatRelative(ts, now) {
    if (ts == null || ts === "") return null;
    var t = num(ts), n = num(now) || Date.now();
    if (t == null) return null;
    var s = Math.max(0, Math.round((n - t) / 1000));
    if (s < 45) return "Just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.round(h / 24);
    if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
    try { return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
    catch (e) { return d + " days ago"; }
  }

  /* ── pure: a workout one-liner ("Easy Run • 8.2 km • Today") ────────── */
  function summarizeActivity(a, now) {
    if (!a) return null;
    var type = a.workout_type || a.activity_type || a.sport_type || "Activity";
    var km = a.distance_meters != null ? (a.distance_meters / 1000).toFixed(1) + " km"
      : (a.distanceKm != null ? Number(a.distanceKm).toFixed(1) + " km" : null);
    var when = null;
    var ts = Date.parse(a.start_date || a.date || "");
    if (isFinite(ts)) {
      var n = num(now) || Date.now();
      var day0 = new Date(n); day0.setHours(0, 0, 0, 0);
      var yd = new Date(day0.getTime() - 86400000);
      when = ts >= day0.getTime() ? "Today" : (ts >= yd.getTime() ? "Yesterday"
        : new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    }
    return [type, km, when].filter(Boolean).join(" • ");
  }

  /*
   * pure: derive the single canonical sync state from the read-only inputs.
   *   input = { loading, error, available, connected, status, syncing,
   *             count, providers?, lastSyncTs?, latest? }
   */
  function deriveState(input) {
    input = input || {};
    if (input.loading) return { key: "loading" };
    var providers = Array.isArray(input.providers) && input.providers.length
      ? input.providers : (input.connected ? [{ name: input.provider || "Garmin", connected: true }] : []);
    var base = { providers: providers, count: num(input.count) || 0,
      lastSyncTs: input.lastSyncTs || null, latest: input.latest || null };

    if (input.error) return Object.assign(base, { key: "failed" });
    if (input.available === false) return Object.assign(base, { key: "unavailable" });
    if (!input.connected) return Object.assign(base, { key: "none", providers: [] });
    if (input.status === "reconnect_required" || input.status === "disconnected") return Object.assign(base, { key: "lost" });
    if (input.syncing) return Object.assign(base, { key: "syncing" });
    if ((num(input.count) || 0) === 0) return Object.assign(base, { key: "waiting" });
    return Object.assign(base, { key: "connected" });
  }

  // Copy + affordances per state — one clear next action, never a guess.
  var COPY = {
    loading:     {},
    connected:   { dot: "good", title: "Connected", status: "Everything is working normally", statusOk: true },
    syncing:     { dot: "sync", title: "Syncing…", status: "Checking for new workouts" },
    waiting:     { dot: "good", title: "Connected", status: "Waiting for your first workout",
                   hint: "Finish linking your watch in the Sync Partner and your history imports automatically." },
    lost:        { dot: "bad", title: "Connection lost", status: "Reconnect to keep your workouts syncing" },
    failed:      { dot: "bad", title: "Sync failed", status: "We couldn't sync just now — your data is safe" },
    none:        { dot: "idle", title: "No wearable connected", status: "Connect a watch to sync your workouts automatically" },
    unavailable: { dot: "idle", title: "Coming soon", status: "Wearable sync is on the way" }
  };

  function actionsFor(key) {
    switch (key) {
      case "none": case "unavailable":
        return [{ label: "Connect", act: "connect", primary: true }];
      case "lost": case "failed":
        return [{ label: "Reconnect", act: "reconnect", primary: true },
                { label: "Open Sync Partner", act: "openPartner" }];
      case "waiting":
        return [{ label: "Open Sync Partner", act: "openPartner", primary: true },
                { label: "Check now", act: "check" }];
      case "connected":
        return [{ label: "Check now", act: "check" },
                { label: "Disconnect", act: "disconnect" }];
      case "syncing":
        return [];
      default: return [];
    }
  }

  /* ── pure: the card HTML for a model ────────────────────────────────── */
  function skeletonHTML() {
    return '<div class="ss-card ss-skeleton" aria-busy="true" aria-label="Loading training data status">' +
      '<div class="ss-sk-row"><span class="ss-sk ss-sk-dot"></span><span class="ss-sk ss-sk-line"></span></div>' +
      '<div class="ss-sk ss-sk-block"></div><div class="ss-sk ss-sk-block short"></div></div>';
  }

  function renderCardHTML(model, now) {
    if (!model || model.key === "loading") return skeletonHTML();
    var c = COPY[model.key] || COPY.none;
    var provider = (model.providers && model.providers[0] && model.providers[0].name) || "Garmin";
    var title = (model.key === "connected" || model.key === "waiting") ? provider + " connected" : c.title;

    // Connection line + status dot.
    var html = '<div class="ss-card" data-state="' + esc(model.key) + '">' +
      '<div class="ss-head">' +
        '<div class="ss-title-wrap"><span class="ss-eyebrow">Training data</span>' +
        '<span class="ss-conn"><span class="ss-dot ss-dot-' + esc(c.dot || "idle") + '"></span>' + esc(title) + '</span></div>' +
      '</div>';

    // Detail rows — only when connected/healthy or waiting (real numbers only).
    if (model.key === "connected" || model.key === "waiting" || model.key === "syncing") {
      var rows = [];
      if (model.lastSyncTs) rows.push(["Last sync", formatRelative(model.lastSyncTs, now) || "—"]);
      rows.push(["Activities imported", model.key === "waiting" ? "0" : String(model.count)]);
      var latestLine = model.count > 0 ? summarizeActivity(model.latest, now) : null;
      if (latestLine) rows.push(["Latest workout", latestLine]);
      html += '<div class="ss-rows">' + rows.map(function (r) {
        return '<div class="ss-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
      }).join("") + '</div>';
    }

    // Multiple providers → list them.
    if (model.providers && model.providers.length > 1) {
      html += '<div class="ss-providers">' + model.providers.map(function (p) {
        return '<span class="ss-prov"><span class="ss-dot ss-dot-' + (p.connected ? "good" : "bad") + '"></span>' + esc(p.name) + '</span>';
      }).join("") + '</div>';
    }

    // Status line (the reassurance).
    var statusCls = c.statusOk ? " ok" : (c.dot === "bad" ? " bad" : "");
    html += '<div class="ss-status' + statusCls + '">' +
      (c.statusOk ? '<span class="ss-check">✓</span> ' : "") + esc(c.status) + '</div>';
    if (c.hint) html += '<p class="ss-hint">' + esc(c.hint) + '</p>';

    // Actions — one clear next step.
    var acts = actionsFor(model.key);
    if (acts.length) {
      html += '<div class="ss-actions">' + acts.map(function (a) {
        return '<button type="button" class="ss-btn' + (a.primary ? " primary" : "") + '"' +
          ' onclick="AthlevoSyncStatus.action(\'' + a.act + '\')">' + esc(a.label) + '</button>';
      }).join("") + '</div>';
    }

    return html + '</div>';
  }

  /* ── pure: import success banner ────────────────────────────────────── */
  function renderBannerHTML(activity, now) {
    var name = (activity && (activity.workout_type || activity.activity_type || activity.sport_type)) || "Workout";
    return '<div class="ss-banner" role="status">' +
      '<span class="ss-banner-check">✓</span>' +
      '<div class="ss-banner-body"><b>' + esc(name) + ' imported</b>' +
      '<small>Athlevo analyzed your workout.</small></div>' +
      '<button type="button" class="ss-banner-cta" onclick="AthlevoSyncStatus.viewLatest()">View analysis →</button>' +
      '<button type="button" class="ss-banner-x" aria-label="Dismiss" onclick="AthlevoSyncStatus.dismissBanner()">×</button>' +
      '</div>';
  }

  // pure: is the newest activity one we haven't shown a banner for yet?
  function detectNewImport(activities, lastSeenId) {
    if (!Array.isArray(activities) || !activities.length) return null;
    var newest = activities.slice().sort(function (a, b) {
      return Date.parse(b.start_date || b.date || 0) - Date.parse(a.start_date || a.date || 0);
    })[0];
    if (!newest) return null;
    var id = String(newest.id != null ? newest.id : (newest.start_date || newest.date || ""));
    if (!id || id === String(lastSeenId)) return null;
    return { activity: newest, id: id };
  }

  /* ── DOM: render + data loading (read-only) ─────────────────────────── */

  function paintCard(model, now) {
    state.lastModel = model;
    var el = $("syncStatusCard");
    if (el) el.innerHTML = renderCardHTML(model, now);
  }

  async function loadInputs() {
    var status = null, activities = [];
    try { if (root.AthlevoDataSource && root.AthlevoDataSource.status) status = await root.AthlevoDataSource.status(); }
    catch (e) { status = { error: true }; }
    try { if (root.AthlevoBrain && root.AthlevoBrain.loadAthleteActivities) activities = await root.AthlevoBrain.loadAthleteActivities(); }
    catch (e) { activities = []; }
    activities = Array.isArray(activities) ? activities : [];
    var newest = activities.slice().sort(function (a, b) {
      return Date.parse(b.start_date || b.date || 0) - Date.parse(a.start_date || a.date || 0);
    })[0] || null;
    return {
      error: status && status.error,
      available: status ? status.available !== false : true,
      connected: Boolean(status && status.connected),
      status: status && status.status,
      syncing: state.syncing,
      count: activities.length,
      lastSyncTs: status && status.lastSync ? Date.parse(status.lastSync) : (activities.length ? Date.now() : null),
      latest: newest,
      _activities: activities
    };
  }

  async function refresh() {
    // Never a blank area: skeleton first, then the resolved state.
    if (!state.lastModel) paintCard({ key: "loading" });
    var inputs = await loadInputs();
    paintCard(deriveState(inputs), Date.now());
    maybeBanner(inputs._activities);
  }

  function maybeBanner(activities) {
    var lastSeen = null;
    try { lastSeen = root.localStorage && root.localStorage.getItem(LASTSEEN_KEY); } catch (e) {}
    var found = detectNewImport(activities, lastSeen);
    // On the very first observation, record silently (don't announce history).
    if (found && lastSeen == null) { try { root.localStorage.setItem(LASTSEEN_KEY, found.id); } catch (e) {} return; }
    if (found) {
      try { root.localStorage.setItem(LASTSEEN_KEY, found.id); } catch (e) {}
      showBanner(found.activity);
    }
  }

  function showBanner(activity) {
    var el = $("syncBanner");
    if (!el) return;
    el.innerHTML = renderBannerHTML(activity, Date.now());
    el.classList.add("show");
    clearTimeout(state._bannerTimer);
    state._bannerTimer = setTimeout(dismissBanner, 8000);
  }
  function dismissBanner() {
    var el = $("syncBanner");
    if (el) { el.classList.remove("show"); el.innerHTML = ""; }
  }

  // Actions delegate to the existing, frozen handlers — no integration change.
  function action(kind) {
    var B = root.AthlevoBrain || {}, P = root.AthlevoPlan || {};
    if (kind === "connect") return (P.connectTrainingData ? P.connectTrainingData()
      : (root.AthlevoConnect && root.AthlevoConnect.start && root.AthlevoConnect.start()));
    if (kind === "reconnect") return B.connectIntervals && B.connectIntervals();
    if (kind === "disconnect") return B.disconnectIntervals && B.disconnectIntervals();
    if (kind === "openPartner") return B.openSyncPartner && B.openSyncPartner();
    if (kind === "check") return checkNow();
  }

  async function checkNow() {
    state.syncing = true;
    paintCard(deriveState(Object.assign(await peekConnected(), { syncing: true })), Date.now());
    // A brief, honest "checking" state, then the real result.
    setTimeout(async function () { state.syncing = false; await refresh(); }, 900);
  }
  async function peekConnected() {
    // Lightweight inputs for the transient syncing paint (reuses last model).
    var m = state.lastModel || {};
    return { connected: m.key !== "none" && m.key !== "unavailable", count: m.count || 0,
      providers: m.providers, lastSyncTs: m.lastSyncTs, latest: m.latest };
  }

  function viewLatest() {
    dismissBanner();
    try {
      if (typeof root.showScreen === "function") root.showScreen("screen-train");
      if (root.renderLatestWorkoutAnalysis) root.renderLatestWorkoutAnalysis();
    } catch (e) {}
  }

  function init() {
    if (!root.document) return;
    refresh();
    try {
      root.addEventListener("visibilitychange", function () {
        if (root.document.visibilityState === "visible") refresh();
      });
    } catch (e) {}
  }
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  root.AthlevoSyncStatus = {
    refresh: refresh, action: action, viewLatest: viewLatest, dismissBanner: dismissBanner,
    // pure, exported for tests:
    deriveState: deriveState, formatRelative: formatRelative, summarizeActivity: summarizeActivity,
    renderCardHTML: renderCardHTML, renderBannerHTML: renderBannerHTML, detectNewImport: detectNewImport,
    actionsFor: actionsFor, BUILD: BUILD, _state: state
  };
})(typeof window !== "undefined" ? window : globalThis);

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Training status   ·   window.AthlevoTrainingStatus
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Names where an athlete's training is heading (Productive, Peaking,
 *  Maintaining, Recovery, Unproductive, Detraining, Overreaching) from the
 *  Intervals.icu fitness model: fitness (CTL), fatigue (ATL) and form
 *  (CTL - ATL), over the last six weeks. The data comes from the same
 *  provider trends request the Trends screen uses; nothing is invented when
 *  Intervals.icu is not connected or has too little history.
 *
 *  classify(days) is pure and deterministic. Rules run top to bottom and the
 *  first match wins:
 *    Overreaching  form at or below -30, or a fast ramp (+8 CTL in a week)
 *                  with form at or below -20
 *    Peaking       fresh (form +5 to +25), fitness within 10% of its
 *                  six-week high, fatigue falling, fitness not slipping
 *    Productive    fitness rising (about +5% over four weeks, or +0.7 CTL
 *                  in the last week)
 *    Detraining    fitness down 15% or more with fresh legs, or down 20%
 *    Recovery      fresh (form +5 or more) and fitness not rising
 *    Unproductive  heavy (form -10 or lower) while fitness is not rising
 *    Maintaining   everything else: fitness steady, form near neutral
 */
(function (root) {
  "use strict";

  var MIN_DAYS_OF_DATA = 14;
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var STATUS = {
    productive:   { label: "Productive",   tone: "positive" },
    peaking:      { label: "Peaking",      tone: "positive" },
    maintaining:  { label: "Maintaining",  tone: "recovery" },
    recovery:     { label: "Recovery",     tone: "recovery" },
    unproductive: { label: "Unproductive", tone: "warning" },
    detraining:   { label: "Detraining",   tone: "warning" },
    overreaching: { label: "Overreaching", tone: "risk" }
  };

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function dayMs(dateKey) {
    var t = Date.parse(String(dateKey) + "T00:00:00Z");
    return isFinite(t) ? t : null;
  }

  /* Latest day on or before `cutoffMs` that has the field (days are oldest first). */
  function dayOnOrBefore(days, cutoffMs, field) {
    for (var i = days.length - 1; i >= 0; i--) {
      var t = dayMs(days[i].date);
      if (t !== null && t <= cutoffMs && num(days[i][field]) !== null) return days[i];
    }
    return null;
  }

  function signed(n) {
    var r = Math.round(n);
    return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r);
  }

  function building(note) {
    return {
      key: "building", label: "", tone: "missing", fitness: null, form: null,
      progress: 0, note: note || "Not enough data yet", detail: "", available: false
    };
  }

  function classify(input) {
    var days = (Array.isArray(input) ? input : [])
      .filter(function (d) { return d && dayMs(d.date) !== null && num(d.fitness) !== null; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    if (!days.length) return building("Not enough data yet");

    var latest = days[days.length - 1];
    var latestMs = dayMs(latest.date);
    var spanDays = Math.round((latestMs - dayMs(days[0].date)) / 86400000);
    if (days.length < MIN_DAYS_OF_DATA || spanDays < MIN_DAYS_OF_DATA - 1) {
      return building("Needs 2 weeks of data");
    }

    var ctl = num(latest.fitness);
    var atl = num(latest.fatigue);
    var form = num(latest.form);
    if (form === null && atl !== null) form = ctl - atl;
    if (form === null) return building("Fatigue data unavailable");

    var ctl7 = dayOnOrBefore(days, latestMs - 7 * 86400000, "fitness");
    var ctl28 = dayOnOrBefore(days, latestMs - 28 * 86400000, "fitness");
    var atl7 = dayOnOrBefore(days, latestMs - 7 * 86400000, "fatigue");
    var baseline = ctl28 || days[0];
    var baselineSpan = Math.max(1, Math.round((latestMs - dayMs(baseline.date)) / 86400000));
    // With less than four weeks of history, scale the change to a four-week pace.
    var delta28 = (ctl - num(baseline.fitness)) * (28 / Math.min(28, baselineSpan));
    var rel28 = delta28 / Math.max(num(baseline.fitness), 20);
    var rampWeek = ctl7 ? ctl - num(ctl7.fitness) : delta28 / 4;
    var atlFalling = atl !== null && atl7 ? atl - num(atl7.fatigue) < 0 : false;
    var peak = days.reduce(function (max, d) { return Math.max(max, num(d.fitness)); }, 0);

    var key;
    var note;
    if (form <= -30 || (rampWeek >= 8 && form <= -20)) {
      key = "overreaching"; note = "Fatigue far above fitness";
    } else if (form >= 5 && form <= 25 && ctl >= 0.9 * peak && atlFalling && rel28 >= -0.05) {
      key = "peaking"; note = "Fresh, with fitness near its high";
    } else if (rel28 >= 0.05 || rampWeek >= 0.7) {
      key = "productive"; note = "Fitness " + signed(delta28) + " in 4 wks";
    } else if ((rel28 <= -0.15 && form >= 5) || rel28 <= -0.2) {
      key = "detraining"; note = "Fitness " + signed(delta28) + " in 4 wks";
    } else if (form >= 5) {
      key = "recovery"; note = "Shedding fatigue";
    } else if (form <= -10) {
      key = "unproductive"; note = "Heavy load, fitness flat";
    } else {
      key = "maintaining"; note = "Fitness steady";
    }

    return {
      key: key,
      label: STATUS[key].label,
      tone: STATUS[key].tone,
      fitness: Math.round(ctl),
      form: Math.round(form),
      // Ring fill: today's fitness as a share of the six-week high.
      progress: peak > 0 ? Math.max(0, Math.min(100, Math.round(100 * ctl / peak))) : 0,
      note: note,
      detail: "Fitness " + Math.round(ctl) + " · Form " + signed(form),
      available: true
    };
  }

  /* ── Data + rendering (browser only) ──────────────────────────────── */

  var _cache = { at: 0, view: null, userKey: null };
  var _inflight = null;

  async function currentUserKey() {
    try {
      // index.html declares `const supabaseClient`: a global lexical binding, not a
      // window property, so it is read by bare name (see js/fuel.js, js/aiConsent.js).
      var c = typeof supabaseClient !== "undefined" ? supabaseClient : null;
      var r = c && c.auth && await c.auth.getUser();
      return (r && r.data && r.data.user && r.data.user.id) || null;
    } catch (e) { return null; }
  }

  function empty(note, reason) {
    return Object.assign(building(note), { reason: reason });
  }

  /* Resolves to a classify() view, or an empty view carrying the reason. */
  async function load() {
    var userKey = await currentUserKey();
    if (!userKey) return empty("Sign in to see this", "signed_out");
    if (_cache.view && _cache.userKey === userKey && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.view;
    if (_inflight && _inflight.userKey === userKey) return _inflight.promise;

    var promise = (async function () {
      var brain = root.AthlevoBrain;
      if (!brain || typeof brain.loadProviderTrends !== "function") return empty("Unavailable right now", "unavailable");
      try {
        var data = await brain.loadProviderTrends("6w");
        var view = classify(data && data.days);
        if (view.available) _cache = { at: Date.now(), view: view, userKey: userKey };
        return view;
      } catch (error) {
        var code = error && error.code;
        if (code === "NOT_CONNECTED") return empty("Connect training data", "not_connected");
        if (code === "TRENDS_SCOPE_REQUIRED" || code === "RECONNECT_REQUIRED") return empty("Reconnect training data", "reconnect");
        return empty("Unavailable right now", "unavailable");
      }
    })();
    _inflight = { userKey: userKey, promise: promise };
    try { return await promise; } finally { if (_inflight && _inflight.promise === promise) _inflight = null; }
  }

  function invalidate() { _cache = { at: 0, view: null, userKey: null }; }

  /* Paints a view into the first signal of the Home athlete-status card. */
  function paint(view) {
    var doc = root.document;
    if (!doc) return;
    var signal = doc.getElementById("todayTrainingStatusSignal");
    var value = doc.getElementById("todayTrainingStatusSignalValue");
    var note = doc.getElementById("todayTrainingStatusSignalNote");
    var detail = doc.getElementById("todayTrainingStatusSignalDetail");
    if (!signal || !value || !note) return;
    signal.dataset.tone = view.available ? view.tone : "missing";
    signal.dataset.progressKind = view.available ? "fitness-vs-peak" : "missing";
    signal.dataset.status = view.key;
    signal.style.setProperty("--signal-progress", String(view.available ? view.progress : 0));
    value.textContent = view.available ? String(view.fitness) : "";
    value.dataset.long = "false";
    note.textContent = view.available ? view.label : view.note;
    if (detail) detail.textContent = view.available ? view.note : "";
    // Not connected / needs reconnecting: the signal becomes the way to connect.
    var connectable = !view.available && (view.reason === "not_connected" || view.reason === "reconnect");
    signal.dataset.connect = connectable ? "true" : "false";
    if (connectable) { signal.setAttribute("role", "button"); signal.setAttribute("tabindex", "0"); }
    else { signal.removeAttribute("role"); signal.removeAttribute("tabindex"); }
    signal.setAttribute("aria-label", view.available
      ? "Training status: " + view.label + ". " + view.note + ". " + view.detail + ". Based on Intervals.icu."
      : "Training status: " + view.note);
  }

  function connect() {
    var plan = root.AthlevoPlan;
    if (plan && typeof plan.connectTrainingData === "function") plan.connectTrainingData();
  }

  function bindConnect() {
    var doc = root.document;
    var signal = doc && doc.getElementById && doc.getElementById("todayTrainingStatusSignal");
    if (!signal || signal.dataset.bound === "true") return;
    signal.dataset.bound = "true";
    signal.addEventListener("click", function () { if (signal.dataset.connect === "true") connect(); });
    signal.addEventListener("keydown", function (event) {
      if (signal.dataset.connect === "true" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); connect(); }
    });
  }

  async function render() {
    bindConnect();
    var view = await load();
    paint(view);
    return view;
  }

  root.AthlevoTrainingStatus = {
    classify: classify, load: load, paint: paint, render: render, invalidate: invalidate,
    STATUS: STATUS, MIN_DAYS_OF_DATA: MIN_DAYS_OF_DATA
  };
})(typeof window !== "undefined" ? window : globalThis);

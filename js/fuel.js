/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo Fuel V1 — nutrition tracking built around running (client)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Behind the `fuel_tracking_v1` feature flag (default OFF). Enable for one
 *  browser with:  localStorage.setItem("athlevo_ff_fuel_tracking_v1", "1")
 *  or open the app once with  ?ff_fuel_tracking_v1=1  (see js/featureFlags.js).
 *
 *  Principles this file enforces:
 *    · AI NEVER silently logs. A photo produces a SUGGESTION; nothing is
 *      written until the athlete reviews/edits it and taps "Log meal".
 *    · Every number on screen comes from meals the athlete CONFIRMED. The
 *      metric is "logged intake" — a day with no logs is "No logged meals",
 *      never "0 kcal consumed", and missing logs are never read as under-eating.
 *    · No energy data is invented. The only energy Athlevo stores today is
 *      per-activity `raw_data.calories_kcal` (Intervals.icu). It is shown as
 *      "Activity energy … from recorded activities", never as daily burn/TDEE.
 *    · Manual logging never needs AI consent; photo analysis uses the shared
 *      AthlevoAiConsent gate and is disabled (manual stays available) without it.
 *    · Meal photos are not stored: the photo is downsized + re-encoded in the
 *      browser (which drops EXIF/location), sent once for analysis, and kept
 *      only in memory until the sheet closes.
 *
 *  Pure helpers are exported (module.exports / AthlevoFuel._test) so the
 *  totals/week/energy logic can be unit-tested without a DOM.
 */
(function (root) {
  "use strict";

  var FLAG = "fuel_tracking_v1";
  var SCREEN_ID = "screen-fuel";
  var WEEK_DAYS = 7;
  var LOAD_DAYS_BACK = 8;              // today + 7 previous days
  var NOTE_MAX = 500;
  var IMAGE_MAX_EDGE = 1280;
  var IMAGE_TARGET_BYTES = 1_600_000;  // stay far below the 2.5 MB server cap
  var IMAGE_INPUT_MAX_BYTES = 40 * 1024 * 1024;
  var GOAL_LABELS = {
    performance: "Performance",
    maintain: "Maintain",
    weight_management: "Weight management"
  };
  var MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
  var MEAL_TYPE_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", other: "Meal" };

  /* ══════════════════════════ pure helpers ══════════════════════════ */

  function num(v) {
    var n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && isFinite(n) ? n : 0;
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function localDateKey(date) {
    var d = date || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function parseDateKey(key) {
    var p = String(key).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0, 0); // noon: DST-safe
  }
  function addDaysKey(key, delta) {
    var d = parseDateKey(key);
    d.setDate(d.getDate() + delta);
    return localDateKey(d);
  }

  function fmtInt(n) {
    return Math.round(num(n)).toLocaleString("en-US");
  }
  function fmtKcal(n) { return fmtInt(n) + " kcal"; }
  function fmtGrams(n) { return fmtInt(n) + " g"; }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function sumTotals(list) {
    var t = { calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0 };
    (list || []).forEach(function (row) {
      t.calories += num(row.calories);
      t.carbs_g += num(row.carbs_g);
      t.protein_g += num(row.protein_g);
      t.fat_g += num(row.fat_g);
    });
    t.calories = round1(t.calories);
    t.carbs_g = round1(t.carbs_g);
    t.protein_g = round1(t.protein_g);
    t.fat_g = round1(t.fat_g);
    return t;
  }

  /* Meals confirmed for one local calendar day (chronological). */
  function mealsForDay(meals, dayKey) {
    return (meals || [])
      .filter(function (m) { return m && m.local_date === dayKey; })
      .sort(function (a, b) { return String(a.logged_at).localeCompare(String(b.logged_at)); });
  }

  /*
   * Last 7 local days, oldest → newest. `logged` is false for a day with no
   * confirmed meals: such a day has NO totals (null), so it can never be
   * mistaken for — or averaged as — zero intake.
   */
  function buildWeek(meals, todayKey) {
    var out = [];
    for (var i = WEEK_DAYS - 1; i >= 0; i--) {
      var key = addDaysKey(todayKey, -i);
      var dayMeals = mealsForDay(meals, key);
      if (!dayMeals.length) {
        out.push({ date: key, logged: false, mealCount: 0, totals: null, isToday: i === 0 });
      } else {
        out.push({ date: key, logged: true, mealCount: dayMeals.length, totals: sumTotals(dayMeals), isToday: i === 0 });
      }
    }
    return out;
  }

  /* Averages across LOGGED days only (never counts blank days as zero). */
  function weekAverages(week) {
    var logged = (week || []).filter(function (d) { return d.logged; });
    if (!logged.length) return { loggedDays: 0, calories: null, carbs_g: null };
    var t = sumTotals(logged.map(function (d) { return d.totals; }));
    return {
      loggedDays: logged.length,
      calories: t.calories / logged.length,
      carbs_g: t.carbs_g / logged.length
    };
  }

  /*
   * Activity energy from RECORDED ACTIVITIES only. The one verified source is
   * activities.raw_data.calories_kcal (written by the Intervals.icu importer).
   * Returns null when no activity that day carries it — the UI then shows the
   * honest "not available" state. This is never a daily-burn / TDEE figure.
   */
  function activityEnergyForDay(activities, dayKey) {
    var total = 0, count = 0;
    (activities || []).forEach(function (a) {
      if (!a || !a.start_date) return;
      var d = new Date(a.start_date);
      if (isNaN(d.getTime()) || localDateKey(d) !== dayKey) return;
      var raw = a.raw_data && typeof a.raw_data === "object" ? a.raw_data : null;
      var kcal = raw ? num(raw.calories_kcal) : 0;
      if (kcal > 0) { total += kcal; count += 1; }
    });
    return count ? { kcal: Math.round(total), activities: count } : null;
  }

  function defaultMealType(date) {
    var h = (date || new Date()).getHours();
    if (h >= 4 && h < 11) return "breakfast";
    if (h >= 11 && h < 15) return "lunch";
    if (h >= 17 && h < 22) return "dinner";
    return "snack";
  }

  function emptyItem() {
    return { name: "", quantity: null, unit: "", grams: null, calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0, ai_estimated: false };
  }

  /* A fresh editable draft built from an AI suggestion. Nothing is stored. */
  function draftFromSuggestion(suggestion, note, todayKey, now) {
    var items = (suggestion.items || []).map(function (it) {
      return {
        name: it.name, quantity: it.quantity, unit: it.unit || "",
        grams: it.estimated_grams, calories: it.calories, carbs_g: it.carbs_g,
        protein_g: it.protein_g, fat_g: it.fat_g, ai_estimated: true
      };
    });
    return {
      mode: "items", source: "ai_photo", mealId: null,
      name: suggestion.meal_name || "", mealType: defaultMealType(now), note: note || "",
      localDate: todayKey, items: items,
      totals: { calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0 },
      assumptions: suggestion.assumptions || [], uncertainties: suggestion.uncertainties || []
    };
  }

  /* "Log again": an editable draft copied from an earlier meal. */
  function draftFromMeal(meal, kind, todayKey, now) {
    var items = (meal.fuel_meal_items || meal.items || [])
      .slice().sort(function (a, b) { return num(a.position) - num(b.position); })
      .map(function (it) {
        return {
          name: it.name, quantity: it.quantity == null ? null : num(it.quantity), unit: it.unit || "",
          grams: it.grams == null ? null : num(it.grams), calories: num(it.calories),
          carbs_g: num(it.carbs_g), protein_g: num(it.protein_g), fat_g: num(it.fat_g),
          ai_estimated: it.ai_estimated === true
        };
      });
    var editing = kind === "edit";
    return {
      mode: items.length ? "items" : "quick",
      source: editing ? meal.source : "repeated",
      mealId: editing ? meal.id : null,
      name: meal.meal_name || "",
      mealType: editing ? (meal.meal_type || "") : defaultMealType(now),
      note: editing ? (meal.note || "") : "",
      localDate: editing ? meal.local_date : todayKey,
      items: items,
      totals: { calories: num(meal.calories), carbs_g: num(meal.carbs_g), protein_g: num(meal.protein_g), fat_g: num(meal.fat_g) },
      assumptions: [], uncertainties: []
    };
  }

  function draftTotals(draft) {
    return draft.mode === "items" ? sumTotals(draft.items) : sumTotals([draft.totals]);
  }

  /* Client-side mirror of the server's validation, for immediate feedback.
   * The server re-validates everything regardless. */
  function validateDraft(draft) {
    if (!String(draft.name || "").trim()) return "Give the meal a name.";
    var rows = draft.mode === "items" ? draft.items : [draft.totals];
    if (draft.mode === "items") {
      if (!draft.items.length) return "Add at least one food item, or switch to quick entry.";
      for (var i = 0; i < draft.items.length; i++) {
        if (!String(draft.items[i].name || "").trim()) return "Give each food item a name.";
      }
    }
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var fields = ["calories", "carbs_g", "protein_g", "fat_g"];
      for (var f = 0; f < fields.length; f++) {
        var v = row[fields[f]];
        if (typeof v !== "number" || !isFinite(v) || v < 0) return "Calories and macros must be zero or more.";
      }
      if (row.calories > 10000) return "Calories look too high for one meal — please check the number.";
    }
    return null;
  }

  function buildPayload(draft) {
    var payload = {
      source: draft.source,
      local_date: draft.localDate,
      meal_type: draft.mealType || null,
      meal_name: String(draft.name || "").trim(),
      note: String(draft.note || "").trim() || null
    };
    if (draft.mealId) payload.id = draft.mealId;
    if (draft.mode === "items") {
      payload.items = draft.items.map(function (it) {
        return {
          name: String(it.name || "").trim(),
          quantity: it.quantity == null ? null : it.quantity,
          unit: String(it.unit || "").trim() || null,
          grams: it.grams == null ? null : it.grams,
          calories: num(it.calories), carbs_g: num(it.carbs_g),
          protein_g: num(it.protein_g), fat_g: num(it.fat_g),
          ai_estimated: it.ai_estimated === true
        };
      });
    } else {
      var t = draft.totals;
      payload.calories = num(t.calories); payload.carbs_g = num(t.carbs_g);
      payload.protein_g = num(t.protein_g); payload.fat_g = num(t.fat_g);
    }
    return payload;
  }

  /* Blank → null, garbage → NaN, otherwise the number. */
  function parseField(text) {
    var s = String(text == null ? "" : text).trim().replace(/,/g, "");
    if (s === "") return null;
    return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  }

  /* Human wording for an API/network failure. Never blames the athlete. */
  function describeError(err, kind) {
    var code = err && err.code;
    if (code === "OFFLINE") return "You're offline. Reconnect and try again — what you entered is still here.";
    if (code === "AI_CONSENT_REQUIRED") return "Photo analysis is turned off. You can turn AI features on in Settings, or add the meal manually.";
    if (code === "AUTH_REQUIRED") return "Please sign in again to continue.";
    if (code === "RATE_LIMITED") return "You've reached the limit for now. Please try again in a little while, or add the meal manually.";
    if (code === "UNSUPPORTED_IMAGE_TYPE") return "That photo format isn't supported. Try a JPEG or PNG.";
    if (code === "IMAGE_TOO_LARGE") return "That photo is too large. Try a smaller one.";
    if (code === "INVALID_IMAGE") return "We couldn't read that photo. Try another one.";
    if (code === "ANALYSIS_TIMEOUT") return "The analysis is taking longer than usual. Try again, or add the meal manually.";
    if (code === "ANALYSIS_INVALID" || code === "ANALYSIS_FAILED" || code === "ANALYSIS_UNAVAILABLE") {
      return "We couldn't analyze that meal right now. Try again, or add it manually.";
    }
    if (code === "INVALID_MEAL" && err.message) return err.message;
    if (kind === "save") return "We couldn't save that just now. What you entered is still here — please try again.";
    return "Something went wrong. Please try again.";
  }

  var helpers = {
    FLAG: FLAG, num: num, round1: round1, localDateKey: localDateKey, addDaysKey: addDaysKey,
    fmtInt: fmtInt, fmtKcal: fmtKcal, esc: esc, sumTotals: sumTotals, mealsForDay: mealsForDay,
    buildWeek: buildWeek, weekAverages: weekAverages, activityEnergyForDay: activityEnergyForDay,
    defaultMealType: defaultMealType, draftFromSuggestion: draftFromSuggestion,
    draftFromMeal: draftFromMeal, draftTotals: draftTotals, validateDraft: validateDraft,
    buildPayload: buildPayload, parseField: parseField, describeError: describeError,
    emptyItem: emptyItem
  };

  // Pure helpers are reachable without a DOM (unit tests load this file in a
  // bare vm context, or via require()).
  if (root) root.AthlevoFuel = { FLAG: FLAG, _test: helpers };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { _test: helpers, helpers: helpers };
  }
  if (!root || !root.document) return; // no DOM: helpers only.

  /* ══════════════════════════ DOM / runtime ═════════════════════════ */

  var doc = root.document;
  var state = {
    loaded: false, loading: false, loadError: null,
    meals: [], goalMode: null, training: null, energy: null, energyChecked: false,
    weeklyMetric: "calories", returnScreen: "screen-trends",
    weeklyTracked: false, openedTracked: false,
    sheetOpen: false, step: null, draft: null, photo: null,
    busy: false, error: "", detailMeal: null, confirmingDelete: false,
    estimateEdited: false, analysisAbort: null, lastFocus: null, status: ""
  };

  function $(id) { return doc.getElementById(id); }

  /* ── feature flag (existing pattern: js/featureFlags.js) ───────────── */
  function isEnabled() {
    try {
      return !!(root.AthlevoFeatureFlags && root.AthlevoFeatureFlags.isEnabled(FLAG, false));
    } catch (e) { return false; }
  }

  /* ── analytics: categorical metadata only — never meal text, photos,
        calories or macros ───────────────────────────────────────────── */
  function track(name, props) {
    try {
      if (root.AthlevoProductAnalytics && typeof root.AthlevoProductAnalytics.trackAthlevoEvent === "function") {
        root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
      }
    } catch (e) { /* analytics must never break Fuel */ }
  }
  function itemBand(n) { return n <= 0 ? "none" : n === 1 ? "one" : n <= 3 ? "few" : "many"; }

  /* ── supabase / auth ───────────────────────────────────────────────── */
  function sb() { return root.supabaseClient || null; }

  async function currentUserId() {
    if (root.athlevoSessionUserId) return root.athlevoSessionUserId;
    var c = sb();
    if (!c) return null;
    try {
      var r = await c.auth.getUser();
      return (r && r.data && r.data.user && r.data.user.id) || null;
    } catch (e) { return null; }
  }

  async function accessToken() {
    var c = sb();
    if (!c) return null;
    try {
      var r = await c.auth.getSession();
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  async function api(path, method, body, signal) {
    if (root.navigator && root.navigator.onLine === false) throw { code: "OFFLINE" };
    var token = await accessToken();
    if (!token) throw { code: "AUTH_REQUIRED" };
    var res;
    try {
      res = await root.fetch(path, {
        method: method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "ABORTED" };
      throw { code: root.navigator && root.navigator.onLine === false ? "OFFLINE" : "NETWORK" };
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw { status: res.status, code: (data && data.code) || "HTTP_" + res.status, message: data && data.error };
    return data;
  }

  /* ── data loading (reads go through RLS, like the calendar) ───────── */
  async function loadAll() {
    state.loading = true;
    state.loadError = null;
    render();
    var c = sb();
    var uid = await currentUserId();
    if (!c || !uid) { state.loading = false; state.loadError = "Sign in to use Fuel."; render(); return; }
    var today = localDateKey();
    var since = addDaysKey(today, -LOAD_DAYS_BACK + 1);
    var tomorrow = addDaysKey(today, 1);

    var mealsP = c.from("fuel_meals").select("*, fuel_meal_items(*)")
      .eq("user_id", uid).gte("local_date", since).order("logged_at", { ascending: true })
      .then(function (r) { return r; }, function (e) { return { error: e }; });
    var prefP = c.from("fuel_preferences").select("goal_mode").eq("user_id", uid).maybeSingle()
      .then(function (r) { return r; }, function (e) { return { error: e }; });
    var planP = c.from("training_sessions").select("session_type,title,session_date,distance_km,duration_minutes,intensity")
      .eq("user_id", uid).gte("session_date", today).lte("session_date", tomorrow).order("session_date", { ascending: true })
      .then(function (r) { return r; }, function () { return { data: null }; });
    var d0 = parseDateKey(addDaysKey(today, -1)).toISOString();
    var d1 = parseDateKey(tomorrow).toISOString();
    var actP = c.from("activities").select("start_date,raw_data")
      .eq("user_id", uid).gte("start_date", d0).lte("start_date", d1)
      .then(function (r) { return r; }, function () { return { data: null }; });

    var results = await Promise.all([mealsP, prefP, planP, actP]);
    var mealsRes = results[0];
    if (mealsRes && mealsRes.error) {
      state.loadError = "We couldn't load your meals right now.";
    } else {
      state.meals = (mealsRes && mealsRes.data) || [];
    }
    state.goalMode = results[1] && results[1].data ? results[1].data.goal_mode || null : null;

    var sessions = (results[2] && results[2].data) || [];
    state.training = pickTraining(sessions, today, tomorrow);
    state.energy = activityEnergyForDay((results[3] && results[3].data) || [], today);
    state.energyChecked = true;

    state.loaded = true;
    state.loading = false;
    render();
    trackWeeklyOnce();
  }

  /* Real planned training only: today's session, else tomorrow's. */
  function pickTraining(sessions, today, tomorrow) {
    var byDay = function (d) {
      return (sessions || []).filter(function (s) { return s && s.session_date === d; })[0] || null;
    };
    var s = byDay(today), label = "Today's training";
    if (!s) { s = byDay(tomorrow); label = "Tomorrow"; }
    if (!s) return null;
    var type = String(s.session_type || "").replace(/[_-]+/g, " ");
    var title = (s.title && String(s.title).trim()) || type.replace(/\b\w/g, function (ch) { return ch.toUpperCase(); });
    if (!title) return null;
    var bits = [];
    if (num(s.distance_km) > 0) bits.push(num(s.distance_km) + " km");
    else if (num(s.duration_minutes) > 0) bits.push(Math.round(num(s.duration_minutes)) + " min");
    return { label: label, title: title, detail: bits.join(" · "), isToday: label === "Today's training" };
  }

  /* ══════════════════════════ rendering ═════════════════════════════ */

  function macroCell(label, grams) {
    return '<div class="fuel-macro"><span class="fuel-macro-val">' + esc(fmtInt(grams)) +
      '<small> g</small></span><span class="fuel-macro-lbl">' + esc(label) + "</span></div>";
  }

  function mealTypeLabel(m) { return MEAL_TYPE_LABELS[m.meal_type] || MEAL_TYPE_LABELS.other; }

  function mealRowHtml(m) {
    var sub = m.source === "ai_photo" ? "Photo estimate, reviewed by you" : m.source === "repeated" ? "Logged again" : "";
    return '<li><button type="button" class="fuel-meal-row" data-fuel-meal="' + esc(m.id) + '" aria-label="' +
      esc(mealTypeLabel(m) + ": " + m.meal_name + ", " + fmtKcal(m.calories) + ". Open details") + '">' +
      '<span class="fuel-meal-main"><span class="fuel-meal-type">' + esc(mealTypeLabel(m)) + "</span>" +
      '<span class="fuel-meal-name">' + esc(m.meal_name) + "</span>" +
      (sub ? '<span class="fuel-meal-sub">' + esc(sub) + "</span>" : "") + "</span>" +
      '<span class="fuel-meal-kcal">' + esc(fmtKcal(m.calories)) + "</span></button></li>";
  }

  function todayCardHtml(todayKey) {
    var meals = mealsForDay(state.meals, todayKey);
    var t = sumTotals(meals);
    var logged = meals.length > 0;
    return '<article class="fuel-card athlevo-material-card" aria-labelledby="fuelIntakeLbl">' +
      '<span class="eyebrow" id="fuelIntakeLbl">Logged intake</span>' +
      (logged
        ? '<div class="fuel-intake"><span class="fuel-intake-val">' + esc(fmtInt(t.calories)) + "</span><span class=\"fuel-intake-unit\"> kcal</span></div>" +
          '<div class="fuel-macros" role="group" aria-label="Macros from logged meals">' +
            macroCell("Carbohydrate", t.carbs_g) + macroCell("Protein", t.protein_g) + macroCell("Fat", t.fat_g) + "</div>"
        : '<div class="fuel-intake"><span class="fuel-intake-none">No logged meals yet today</span></div>') +
      '<p class="fuel-note">Based on meals you\'ve logged.' +
        (meals.some(function (m) { return m.source === "ai_photo"; }) ? " Photo estimates you reviewed are included." : "") + "</p></article>";
  }

  function energyCardHtml() {
    if (!state.energyChecked) return "";
    if (state.energy) {
      return '<article class="fuel-card" aria-labelledby="fuelEnergyLbl"><span class="eyebrow" id="fuelEnergyLbl">Activity energy</span>' +
        '<div class="fuel-energy-val">~' + esc(fmtKcal(state.energy.kcal)) + "</div>" +
        '<p class="fuel-note">From ' + state.energy.activities + " recorded " + (state.energy.activities === 1 ? "activity" : "activities") +
        " today. This isn’t your total daily energy expenditure, and it isn’t compared with your logged intake.</p></article>";
    }
    return '<article class="fuel-card fuel-card--quiet" aria-labelledby="fuelEnergyLbl"><span class="eyebrow" id="fuelEnergyLbl">Expenditure</span>' +
      '<p class="fuel-note fuel-note--lead">Daily expenditure isn’t available from your current training data.</p></article>';
  }

  function trainingCardHtml(todayKey) {
    if (!state.training) return "";
    var meals = mealsForDay(state.meals, todayKey);
    var t = sumTotals(meals);
    var line = meals.length
      ? esc(fmtInt(t.carbs_g)) + " g carbohydrate logged today"
      : "No meals logged yet today";
    return '<article class="fuel-card" aria-labelledby="fuelTrainLbl"><span class="eyebrow" id="fuelTrainLbl">' + esc(state.training.label) + "</span>" +
      '<div class="fuel-train-title">' + esc(state.training.title) + "</div>" +
      (state.training.detail ? '<div class="fuel-train-detail">' + esc(state.training.detail) + "</div>" : "") +
      '<p class="fuel-train-line">' + line + "</p></article>";
  }

  function historyHtml(todayKey) {
    var todays = mealsForDay(state.meals, todayKey);
    var html = '<section class="fuel-section" aria-labelledby="fuelHistLbl"><h2 class="fuel-h2" id="fuelHistLbl">Today’s meals</h2>';
    html += todays.length
      ? '<ul class="fuel-meal-list">' + todays.map(mealRowHtml).join("") + "</ul>"
      : '<p class="fuel-note">No logged meals today.</p>';
    var earlier = [];
    for (var i = 1; i < WEEK_DAYS; i++) {
      var key = addDaysKey(todayKey, -i);
      var ms = mealsForDay(state.meals, key);
      if (ms.length) earlier.push({ key: key, meals: ms });
    }
    if (earlier.length) {
      html += '<details class="fuel-earlier"><summary>Earlier this week</summary>';
      earlier.forEach(function (g) {
        html += '<h3 class="fuel-day-h">' + esc(dayHeading(g.key, todayKey)) + '</h3><ul class="fuel-meal-list">' + g.meals.map(mealRowHtml).join("") + "</ul>";
      });
      html += "</details>";
    }
    return html + "</section>";
  }

  function dayHeading(key, todayKey) {
    if (key === addDaysKey(todayKey, -1)) return "Yesterday";
    try { return parseDateKey(key).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); }
    catch (e) { return key; }
  }
  function dayInitial(key) {
    try { return parseDateKey(key).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3); }
    catch (e) { return key.slice(8); }
  }

  function weeklyHtml(todayKey) {
    var week = buildWeek(state.meals, todayKey);
    var avg = weekAverages(week);
    var metric = state.weeklyMetric === "carbs" ? "carbs_g" : "calories";
    var unit = metric === "calories" ? "kcal" : "g";
    var max = 0;
    week.forEach(function (d) { if (d.logged) max = Math.max(max, d.totals[metric]); });
    var summaryParts = week.map(function (d) {
      return (d.isToday ? "Today" : dayHeading(d.date, todayKey)) + ": " +
        (d.logged ? fmtInt(d.totals[metric]) + " " + unit + " logged" : "no logged meals");
    });
    var cols = week.map(function (d) {
      var h = d.logged && max > 0 ? Math.max(6, Math.round((d.totals[metric] / max) * 100)) : 0;
      return '<li class="fuel-col' + (d.isToday ? " is-today" : "") + '">' +
        '<span class="fuel-col-val">' + (d.logged ? esc(fmtInt(d.totals[metric])) : "—") + "</span>" +
        '<span class="fuel-col-track" aria-hidden="true">' +
          (d.logged ? '<span class="fuel-bar" style="height:' + h + '%"></span>' : '<span class="fuel-bar-none"></span>') +
        "</span>" +
        '<span class="fuel-col-day">' + (d.isToday ? "Today" : esc(dayInitial(d.date))) + "</span>" +
        (d.logged ? "" : '<span class="fuel-col-nolog">No logs</span>') + "</li>";
    }).join("");
    return '<section class="fuel-section" aria-labelledby="fuelWeekLbl" id="fuelWeekly"><div class="fuel-week-head"><h2 class="fuel-h2" id="fuelWeekLbl">Last 7 days</h2>' +
      '<div class="seg fuel-seg" role="group" aria-label="Chart metric">' +
        '<button type="button" class="seg-btn' + (metric === "calories" ? " on" : "") + '" data-fuel-metric="calories" aria-pressed="' + (metric === "calories") + '">Calories</button>' +
        '<button type="button" class="seg-btn' + (metric === "carbs_g" ? " on" : "") + '" data-fuel-metric="carbs" aria-pressed="' + (metric === "carbs_g") + '">Carbs</button></div></div>' +
      '<div class="fuel-card"><ol class="fuel-week" role="group" aria-label="' + esc("Logged " + (metric === "calories" ? "calories" : "carbohydrate") + " by day") + '">' + cols + "</ol>" +
      (avg.loggedDays
        ? '<p class="fuel-avg"><strong>' + esc(metric === "calories" ? fmtKcal(avg.calories) : fmtInt(avg.carbs_g) + " g") + "</strong> average logged " +
          (metric === "calories" ? "intake" : "carbohydrate") + " across " + avg.loggedDays + " logged " + (avg.loggedDays === 1 ? "day" : "days") + "</p>"
        : '<p class="fuel-avg">No logged meals in the last 7 days.</p>') +
      '<p class="fuel-note">Days with no logged meals are left blank — they aren’t counted as zero intake, and missing logs don’t mean you under-ate.</p>' +
      '<p class="fuel-visually-hidden">' + esc(summaryParts.join(". ")) + ".</p></div></section>";
  }

  function goalHtml() {
    var chips = Object.keys(GOAL_LABELS).map(function (k) {
      return '<button type="button" class="seg-btn' + (state.goalMode === k ? " on" : "") + '" data-fuel-goal="' + k + '" aria-pressed="' + (state.goalMode === k) + '">' + esc(GOAL_LABELS[k]) + "</button>";
    }).join("");
    return '<section class="fuel-section" aria-labelledby="fuelGoalLbl"><h2 class="fuel-h2" id="fuelGoalLbl">Your focus <span class="fuel-optional">Optional</span></h2>' +
      '<div class="seg fuel-seg fuel-seg--goal" role="group" aria-label="Focus">' + chips + "</div>" +
      '<p class="fuel-note">Athlevo never sets a calorie deficit or a target for you. Tap your choice again to clear it.</p></section>';
  }

  function emptyHtml() {
    return '<article class="fuel-card athlevo-material-card fuel-hero"><span class="eyebrow">Fuel</span>' +
      '<h2 class="serif fuel-hero-h">Fuel your training with better context.</h2>' +
      '<p class="fuel-note fuel-note--lead">Log meals manually or photograph what you\'re eating and review Athlevo\'s estimate.</p>' +
      '<button type="button" class="fuel-btn fuel-btn--primary" data-fuel-add="empty">Add your first meal</button></article>';
  }

  function render() {
    var host = $("fuelRoot");
    if (!host) return;
    var today = localDateKey();
    var hasAny = state.meals.length > 0;
    var html = '<header class="fuel-head"><h1 class="serif">Fuel</h1><p class="fuel-sub">Nutrition alongside your training.</p></header>';
    if (state.status) html += '<p class="fuel-status" role="status">' + esc(state.status) + "</p>";
    if (state.loading && !state.loaded) {
      html += '<div class="fuel-card" role="status" aria-label="Loading Fuel"><div class="skel asl-line is-wide"></div><div class="skel asl-line is-medium" style="margin-top:12px"></div></div>';
    } else {
      if (state.loadError) {
        html += '<div class="fuel-card fuel-card--error" role="alert"><p class="fuel-note fuel-note--lead">' + esc(state.loadError) +
          '</p><button type="button" class="fuel-btn" data-fuel-retry="1">Try again</button></div>';
      }
      if (!hasAny && !state.loadError) {
        html += emptyHtml() + trainingCardHtml(today) + energyCardHtml() + goalHtml();
      } else {
        html += todayCardHtml(today) +
          '<button type="button" class="fuel-btn fuel-btn--primary fuel-add" data-fuel-add="main">Add meal</button>' +
          trainingCardHtml(today) + energyCardHtml() + historyHtml(today) + weeklyHtml(today) + goalHtml();
      }
    }
    host.innerHTML = html;
  }

  function trackWeeklyOnce() {
    if (state.weeklyTracked || !state.meals.length) return;
    state.weeklyTracked = true;
    var el = $("fuelWeekly");
    var fire = function () { track("fuel_weekly_viewed", {}); };
    if (el && "IntersectionObserver" in root) {
      var io = new root.IntersectionObserver(function (entries, obs) {
        if (entries.some(function (e) { return e.isIntersecting; })) { obs.disconnect(); fire(); }
      });
      io.observe(el);
    } else { fire(); }
  }

  function flashStatus(text) {
    state.status = text;
    render();
    root.setTimeout(function () { if (state.status === text) { state.status = ""; render(); } }, 3500);
  }

  /* ══════════════════════════ photo handling ════════════════════════ */

  function releasePhoto() {
    if (state.photo && state.photo.previewUrl) {
      try { root.URL.revokeObjectURL(state.photo.previewUrl); } catch (e) { /* ignore */ }
    }
    state.photo = null;
  }

  function decodeImage(file) {
    if (typeof root.createImageBitmap === "function") {
      return root.createImageBitmap(file, { imageOrientation: "from-image" })
        .catch(function () { return root.createImageBitmap(file); })
        .then(function (bmp) { return { source: bmp, width: bmp.width, height: bmp.height, done: function () { try { bmp.close(); } catch (e) { /* ignore */ } } }; })
        .catch(function () { return decodeViaElement(file); });
    }
    return decodeViaElement(file);
  }
  function decodeViaElement(file) {
    return new Promise(function (resolve, reject) {
      var url = root.URL.createObjectURL(file);
      var img = new root.Image();
      img.onload = function () {
        resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, done: function () { root.URL.revokeObjectURL(url); } });
      };
      img.onerror = function () { root.URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", quality); });
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new root.FileReader();
      reader.onload = function () { resolve(String(reader.result).replace(/^data:[^,]*,/, "")); };
      reader.onerror = function () { reject(new Error("read")); };
      reader.readAsDataURL(blob);
    });
  }

  /*
   * Downsizes to ≤1280 px on the long edge and re-encodes as JPEG. Re-encoding
   * through a canvas drops EXIF (including GPS). HEIC/HEIF is accepted as
   * INPUT wherever the browser/WebView can decode it (iOS can), and always
   * leaves here as JPEG — so the server only ever sees JPEG.
   */
  async function prepareImage(file) {
    if (file.size > IMAGE_INPUT_MAX_BYTES) throw { code: "IMAGE_TOO_LARGE" };
    var type = String(file.type || "").toLowerCase();
    if (type && type.indexOf("image/") !== 0) throw { code: "UNSUPPORTED_IMAGE_TYPE" };
    var decoded;
    try { decoded = await decodeImage(file); }
    catch (e) { throw { code: "UNSUPPORTED_IMAGE_TYPE" }; }
    try {
      var attempts = [[IMAGE_MAX_EDGE, 0.82], [1024, 0.7], [800, 0.65]];
      for (var i = 0; i < attempts.length; i++) {
        var edge = attempts[i][0], q = attempts[i][1];
        var scale = Math.min(1, edge / Math.max(decoded.width, decoded.height));
        var w = Math.max(1, Math.round(decoded.width * scale));
        var h = Math.max(1, Math.round(decoded.height * scale));
        var canvas = doc.createElement("canvas");
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(decoded.source, 0, 0, w, h);
        var blob = await canvasToBlob(canvas, q);
        if (!blob) throw { code: "INVALID_IMAGE" };
        if (blob.size <= IMAGE_TARGET_BYTES || i === attempts.length - 1) {
          if (blob.size > IMAGE_TARGET_BYTES) throw { code: "IMAGE_TOO_LARGE" };
          return {
            previewUrl: root.URL.createObjectURL(blob),
            base64: await blobToBase64(blob),
            mime: "image/jpeg",
            bytes: blob.size
          };
        }
      }
    } finally { decoded.done(); }
    throw { code: "INVALID_IMAGE" };
  }

  /* ══════════════════════════ the add/review sheet ══════════════════ */

  var ICON_CAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  var ICON_IMG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 3.5 3L15 13l5 4"/></svg>';
  var ICON_PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';

  function sheetRoot() { return $("fuelSheet"); }
  function sheetBody() { return $("fuelSheetBody"); }

  function openSheet(step) {
    state.sheetOpen = true;
    state.step = step;
    state.error = "";
    state.busy = false;
    state.lastFocus = doc.activeElement;
    var s = sheetRoot();
    if (!s) return;
    s.classList.add("show");
    s.setAttribute("aria-hidden", "false");
    renderSheet();
  }

  function closeSheet() {
    if (state.analysisAbort) { try { state.analysisAbort.abort(); } catch (e) { /* ignore */ } state.analysisAbort = null; }
    releasePhoto();
    state.sheetOpen = false; state.step = null; state.draft = null; state.detailMeal = null;
    state.confirmingDelete = false; state.busy = false; state.error = ""; state.estimateEdited = false;
    state.noteText = "";
    var s = sheetRoot();
    if (s) { s.classList.remove("show"); s.setAttribute("aria-hidden", "true"); }
    var back = state.lastFocus;
    state.lastFocus = null;
    if (back && typeof back.focus === "function" && doc.contains(back)) { try { back.focus(); } catch (e) { /* ignore */ } }
  }

  function errLine() {
    return '<p class="fuel-error" id="fuelSheetErr" role="alert"' + (state.error ? "" : " hidden") + ">" + esc(state.error) + "</p>";
  }

  function chooseHtml() {
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">Add meal</h2>' +
      '<p class="fuel-sheet-sub">Photograph what you’re eating, or enter it yourself.</p>' + errLine() +
      '<div class="fuel-choices">' +
        '<button type="button" class="fuel-choice" data-fuel-act="camera">' + ICON_CAM + '<span><b>Take photo</b><small>Athlevo suggests an estimate — you review it</small></span></button>' +
        '<button type="button" class="fuel-choice" data-fuel-act="library">' + ICON_IMG + '<span><b>Upload photo</b><small>Choose one from your library</small></span></button>' +
        '<button type="button" class="fuel-choice" data-fuel-act="manual">' + ICON_PEN + '<span><b>Add manually</b><small>Enter calories and macros yourself</small></span></button>' +
      '</div><button type="button" class="fuel-btn" data-fuel-act="cancel">Cancel</button>';
  }

  function busyHtml(title, sub, withCancel) {
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">' + esc(title) + "</h2>" +
      '<div class="fuel-busy" role="status" aria-live="polite"><span class="fuel-spinner" aria-hidden="true"></span><p class="fuel-sheet-sub">' + esc(sub) + "</p></div>" +
      (withCancel ? '<button type="button" class="fuel-btn" data-fuel-act="cancel-analysis">Cancel</button>' : "");
  }

  function photoHtml() {
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">Your meal photo</h2>' +
      '<img class="fuel-preview" alt="Preview of your meal photo" src="' + esc(state.photo.previewUrl) + '">' +
      '<label class="fuel-field fuel-field--block" for="fuelNote"><span>Details <em>(optional)</em></span>' +
      '<textarea id="fuelNote" rows="3" maxlength="' + NOTE_MAX + '" data-fuel-note="1" placeholder="Add details that aren’t obvious from the photo…" aria-describedby="fuelNoteHelp">' + esc(state.noteText || "") + "</textarea></label>" +
      '<p class="fuel-help" id="fuelNoteHelp">e.g. two cups of rice, cooked with 1 tbsp oil</p>' + errLine() +
      '<p class="fuel-note">Analyzing uses a third-party AI service (OpenAI). Your photo and note are sent to estimate this meal. Athlevo doesn’t save the photo.</p>' +
      '<button type="button" class="fuel-btn fuel-btn--primary" data-fuel-act="analyze">Analyze meal</button>' +
      '<button type="button" class="fuel-btn" data-fuel-act="manual-from-photo">Add manually instead</button>' +
      '<button type="button" class="fuel-btn fuel-btn--ghost" data-fuel-act="choose">Choose a different photo</button>';
  }

  function errorStepHtml() {
    var consent = state.errorCode === "AI_CONSENT_REQUIRED";
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">' + (consent ? "Photo analysis is off" : "We couldn’t analyze that") + "</h2>" +
      '<p class="fuel-sheet-sub" role="alert">' + esc(state.error) + "</p>" +
      (state.noteText ? '<p class="fuel-note">Your note is saved: “' + esc(state.noteText) + "”</p>" : "") +
      (consent ? "" : '<button type="button" class="fuel-btn fuel-btn--primary" data-fuel-act="analyze">Retry</button>') +
      '<button type="button" class="fuel-btn' + (consent ? " fuel-btn--primary" : "") + '" data-fuel-act="manual-from-photo">Add manually instead</button>' +
      '<button type="button" class="fuel-btn fuel-btn--ghost" data-fuel-act="cancel">Cancel</button>';
  }

  function noFoodHtml() {
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">No food spotted</h2>' +
      '<p class="fuel-sheet-sub">We couldn’t find a meal in that photo. Try another photo, or add the meal manually.</p>' +
      '<button type="button" class="fuel-btn fuel-btn--primary" data-fuel-act="choose">Try another photo</button>' +
      '<button type="button" class="fuel-btn" data-fuel-act="manual-from-photo">Add manually instead</button>' +
      '<button type="button" class="fuel-btn fuel-btn--ghost" data-fuel-act="cancel">Cancel</button>';
  }

  function numVal(v) { return v == null || (typeof v === "number" && !isFinite(v)) ? "" : String(v); }

  function field(label, path, value, extra) {
    extra = extra || {};
    return '<label class="fuel-field"><span>' + esc(label) + "</span><input type=\"text\" " +
      (extra.numeric ? 'inputmode="decimal" autocomplete="off" ' : 'autocomplete="off" maxlength="' + (extra.max || 120) + '" ') +
      'data-fuel-field="' + esc(path) + '" value="' + esc(value) + '"' + (extra.placeholder ? ' placeholder="' + esc(extra.placeholder) + '"' : "") + "></label>";
  }

  function itemHtml(it, i) {
    return '<fieldset class="fuel-item" data-fuel-item="' + i + '"><legend class="fuel-visually-hidden">Food item ' + (i + 1) + "</legend>" +
      '<div class="fuel-item-head">' + (it.ai_estimated ? '<span class="fuel-badge">Estimate</span>' : "<span></span>") +
      '<button type="button" class="fuel-link" data-fuel-act="remove-item" data-idx="' + i + '" aria-label="Remove ' + esc(it.name || "food item " + (i + 1)) + '">Remove</button></div>' +
      field("Food", "items." + i + ".name", it.name) +
      '<div class="fuel-grid3">' + field("Quantity", "items." + i + ".quantity", numVal(it.quantity), { numeric: true }) +
        field("Unit", "items." + i + ".unit", it.unit || "", { max: 30 }) +
        field("Grams", "items." + i + ".grams", numVal(it.grams), { numeric: true }) + "</div>" +
      '<div class="fuel-grid4">' + field("kcal", "items." + i + ".calories", numVal(it.calories), { numeric: true }) +
        field("Carbs g", "items." + i + ".carbs_g", numVal(it.carbs_g), { numeric: true }) +
        field("Protein g", "items." + i + ".protein_g", numVal(it.protein_g), { numeric: true }) +
        field("Fat g", "items." + i + ".fat_g", numVal(it.fat_g), { numeric: true }) + "</div></fieldset>";
  }

  function totalsText(d) {
    var t = draftTotals(d);
    return (d.source === "ai_photo" ? "Estimated total: ~" : "Total: ") + fmtInt(t.calories) + " kcal · " +
      fmtInt(t.carbs_g) + " g carbs · " + fmtInt(t.protein_g) + " g protein · " + fmtInt(t.fat_g) + " g fat";
  }

  function reviewHtml() {
    var d = state.draft;
    var editing = !!d.mealId;
    var title = editing ? "Edit meal" : d.source === "manual" ? "Add a meal" : "Review your meal";
    var sub = editing ? "Changes update your logged intake."
      : d.source === "ai_photo" ? "Estimated from your photo. Adjust anything that doesn’t look right before logging."
      : d.source === "repeated" ? "Based on a meal you logged before. Adjust anything before logging it again."
      : "Enter what you know — you can edit it later.";
    var types = MEAL_TYPES.map(function (t) {
      return '<button type="button" class="seg-btn' + (d.mealType === t ? " on" : "") + '" data-fuel-mealtype="' + t + '" aria-pressed="' + (d.mealType === t) + '">' + esc(MEAL_TYPE_LABELS[t]) + "</button>";
    }).join("");
    var body = d.mode === "items"
      ? '<div class="fuel-items">' + d.items.map(itemHtml).join("") + '</div><button type="button" class="fuel-btn" data-fuel-act="add-item">Add food item</button>'
      : '<div class="fuel-grid2">' + field("Calories (kcal)", "totals.calories", numVal(d.totals.calories), { numeric: true }) +
          field("Carbohydrate (g)", "totals.carbs_g", numVal(d.totals.carbs_g), { numeric: true }) +
          field("Protein (g)", "totals.protein_g", numVal(d.totals.protein_g), { numeric: true }) +
          field("Fat (g)", "totals.fat_g", numVal(d.totals.fat_g), { numeric: true }) + "</div>" +
        '<button type="button" class="fuel-link fuel-link--block" data-fuel-act="to-items">Break this down into foods</button>';
    var assumed = (d.assumptions.length || d.uncertainties.length)
      ? '<details class="fuel-assumed"><summary>What Athlevo assumed</summary><ul>' +
          d.assumptions.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") +
          d.uncertainties.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul></details>" : "";
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">' + esc(title) + '</h2><p class="fuel-sheet-sub">' + esc(sub) + "</p>" +
      field("Meal name", "name", d.name) +
      '<div class="seg fuel-seg fuel-seg--type" role="group" aria-label="Meal type">' + types + "</div>" +
      body +
      '<div class="fuel-totals" id="fuelReviewTotals">' + esc(totalsText(d)) + "</div>" + assumed +
      '<label class="fuel-field fuel-field--block"><span>Note <em>(optional)</em></span><input type="text" maxlength="' + NOTE_MAX + '" data-fuel-field="note" value="' + esc(d.note) + '" autocomplete="off"></label>' +
      errLine() +
      '<button type="button" class="fuel-btn fuel-btn--primary" data-fuel-act="save" id="fuelSaveBtn"' + (state.busy ? " disabled" : "") + ">" + (editing ? "Save changes" : "Log meal") + "</button>" +
      '<button type="button" class="fuel-btn" data-fuel-act="cancel">Cancel</button>';
  }

  function detailHtml() {
    var m = state.detailMeal;
    var items = (m.fuel_meal_items || []).slice().sort(function (a, b) { return num(a.position) - num(b.position); });
    var src = m.source === "ai_photo" ? "Estimated from a photo, reviewed by you." : m.source === "repeated" ? "Logged again from an earlier meal." : "Entered manually.";
    if (state.confirmingDelete) {
      return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">Delete this meal?</h2>' +
        '<p class="fuel-sheet-sub">“' + esc(m.meal_name) + "” will be removed from your logged intake. This can’t be undone.</p>" + errLine() +
        '<button type="button" class="fuel-btn fuel-btn--danger" data-fuel-act="confirm-delete"' + (state.busy ? " disabled" : "") + ">Delete meal</button>" +
        '<button type="button" class="fuel-btn" data-fuel-act="keep">Keep meal</button>';
    }
    return '<h2 class="fuel-sheet-h" id="fuelSheetTitle" tabindex="-1">' + esc(m.meal_name) + "</h2>" +
      '<p class="fuel-sheet-sub">' + esc(mealTypeLabel(m)) + " · " + esc(src) + "</p>" +
      '<div class="fuel-card fuel-card--flat"><div class="fuel-intake"><span class="fuel-intake-val">' + esc(fmtInt(m.calories)) + '</span><span class="fuel-intake-unit"> kcal</span></div>' +
      '<div class="fuel-macros">' + macroCell("Carbohydrate", m.carbs_g) + macroCell("Protein", m.protein_g) + macroCell("Fat", m.fat_g) + "</div></div>" +
      (items.length ? '<ul class="fuel-detail-items">' + items.map(function (it) {
        var qty = it.quantity != null ? num(it.quantity) + (it.unit ? " " + it.unit : "") : (it.grams != null ? num(it.grams) + " g" : "");
        return "<li><span>" + esc(it.name) + (qty ? '<small> · ' + esc(qty) + "</small>" : "") + "</span><span>" + esc(fmtKcal(it.calories)) + "</span></li>";
      }).join("") + "</ul>" : "") +
      (m.note ? '<p class="fuel-note">Note: ' + esc(m.note) + "</p>" : "") + errLine() +
      '<button type="button" class="fuel-btn fuel-btn--primary" data-fuel-act="repeat">Log again</button>' +
      '<button type="button" class="fuel-btn" data-fuel-act="edit">Edit</button>' +
      '<button type="button" class="fuel-btn fuel-btn--danger-ghost" data-fuel-act="delete">Delete</button>' +
      '<button type="button" class="fuel-btn fuel-btn--ghost" data-fuel-act="cancel">Close</button>';
  }

  function renderSheet(focusSel) {
    var body = sheetBody();
    if (!body) return;
    var html = "";
    switch (state.step) {
      case "choose": html = chooseHtml(); break;
      case "preparing": html = busyHtml("Preparing your photo…", "Resizing it for analysis.", false); break;
      case "photo": html = photoHtml(); break;
      case "analyzing": html = busyHtml("Analyzing your meal…", "This can take a few seconds. Nothing is logged until you review it.", true); break;
      case "error": html = errorStepHtml(); break;
      case "nofood": html = noFoodHtml(); break;
      case "review": html = reviewHtml(); break;
      case "detail": html = detailHtml(); break;
      default: html = "";
    }
    body.innerHTML = html;
    var target = focusSel ? body.querySelector(focusSel) : body.querySelector("#fuelSheetTitle");
    if (target && typeof target.focus === "function") { try { target.focus({ preventScroll: !focusSel }); } catch (e) { target.focus(); } }
    if (!focusSel) { var sheet = body.parentElement; if (sheet) sheet.scrollTop = 0; }
  }

  function showFormError(text) {
    state.error = text;
    var el = $("fuelSheetErr");
    if (el) { el.textContent = text; el.hidden = !text; try { el.scrollIntoView({ block: "nearest" }); } catch (e) { /* ignore */ } }
  }

  /* ── flow actions ─────────────────────────────────────────────────── */

  function startManual(fromNote) {
    var now = new Date();
    state.draft = {
      mode: "quick", source: "manual", mealId: null, name: "", mealType: defaultMealType(now),
      note: fromNote || "", localDate: localDateKey(now), items: [],
      totals: { calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0 }, assumptions: [], uncertainties: []
    };
    state.estimateEdited = false;
    state.step = "review";
    state.error = "";
    renderSheet();
  }

  function readNote() {
    var el = $("fuelNote");
    if (el) state.noteText = String(el.value || "").slice(0, NOTE_MAX);
    return state.noteText || "";
  }

  async function onFileChosen(input, method) {
    var file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    track("fuel_photo_selected", { method: method });
    state.step = "preparing"; state.error = "";
    if (!state.sheetOpen) openSheet("preparing"); else renderSheet();
    try {
      releasePhoto();
      state.photo = await prepareImage(file);
      state.step = "photo";
      renderSheet();
    } catch (e) {
      state.step = "choose";
      state.error = describeError(e);
      renderSheet();
    }
  }

  function failureCategory(code) {
    return ({ OFFLINE: "offline", NETWORK: "network", AI_CONSENT_REQUIRED: "consent", ANALYSIS_TIMEOUT: "timeout",
      RATE_LIMITED: "rate_limited", ANALYSIS_INVALID: "malformed", ANALYSIS_UNAVAILABLE: "unavailable",
      UNSUPPORTED_IMAGE_TYPE: "invalid_image", INVALID_IMAGE: "invalid_image", IMAGE_TOO_LARGE: "invalid_image",
      AUTH_REQUIRED: "auth" })[code] || "other";
  }

  async function analyze() {
    if (!state.photo) return;
    var note = readNote();
    // Shared AI-consent gate (js/aiConsent.js). Declining leaves manual logging fully available.
    var allowed = false;
    try {
      allowed = !!(root.AthlevoAiConsent && await root.AthlevoAiConsent.ensure({ authenticated: true, source: "fuel_meal_analysis" }));
    } catch (e) { allowed = false; }
    if (!allowed) {
      state.step = "photo";
      renderSheet();
      showFormError("Photo analysis needs AI features turned on. You can add this meal manually instead — your note is kept.");
      return;
    }
    state.step = "analyzing"; state.error = "";
    renderSheet();
    var controller = typeof root.AbortController === "function" ? new root.AbortController() : null;
    state.analysisAbort = controller;
    track("fuel_analysis_started", {});
    try {
      var data = await api("/api/fuel/analyze-meal", "POST",
        { image: { mime: state.photo.mime, data: state.photo.base64 }, note: note }, controller ? controller.signal : undefined);
      state.analysisAbort = null;
      if (!state.sheetOpen) return;
      var s = data && data.suggestion;
      if (!s || s.is_food_photo === false || !s.items || !s.items.length) {
        track("fuel_analysis_completed", { outcome: "no_food" });
        state.step = "nofood"; renderSheet(); return;
      }
      track("fuel_analysis_completed", { outcome: "food" });
      state.draft = draftFromSuggestion(s, note, localDateKey(), new Date());
      state.estimateEdited = false;
      releasePhoto();                       // the photo is no longer needed once analyzed
      state.step = "review"; renderSheet();
    } catch (e) {
      state.analysisAbort = null;
      if (!state.sheetOpen) return;
      if (e && e.code === "ABORTED") { state.step = "photo"; renderSheet(); return; }
      track("fuel_analysis_failed", { failure_category: failureCategory(e && e.code) });
      state.errorCode = e && e.code; state.error = describeError(e);
      state.step = "error"; renderSheet();
    }
  }

  function setPath(draft, path, raw) {
    var p = path.split(".");
    if (p[0] === "name") { draft.name = raw; return "name"; }
    if (p[0] === "note") { draft.note = raw; return "note"; }
    if (p[0] === "totals") { var v = parseField(raw); draft.totals[p[1]] = v === null ? 0 : v; return "totals"; }
    if (p[0] === "items") {
      var it = draft.items[Number(p[1])]; if (!it) return null;
      var key = p[2];
      if (key === "name" || key === "unit") it[key] = raw;
      else {
        var n = parseField(raw);
        it[key] = (key === "quantity" || key === "grams") ? n : (n === null ? 0 : n);
      }
      return "item";
    }
    return null;
  }

  function onFieldInput(el) {
    var d = state.draft;
    if (!d) return;
    var kind = setPath(d, el.getAttribute("data-fuel-field"), el.value);
    if (!kind) return;
    var bad = kind !== "name" && kind !== "note" && el.getAttribute("inputmode") === "decimal" && el.value.trim() !== "" && isNaN(parseField(el.value));
    if (bad) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
    if ((kind === "item" || kind === "totals") && d.source === "ai_photo" && !state.estimateEdited) {
      state.estimateEdited = true;
      track("fuel_estimate_edited", { edit_type: "changed" });
    }
    var t = $("fuelReviewTotals");
    if (t) t.textContent = totalsText(d);
  }

  async function submitDraft() {
    var d = state.draft;
    if (!d || state.busy) return;
    var problem = validateDraft(d);
    if (problem) { showFormError(problem); return; }
    state.busy = true; showFormError("");
    var btn = $("fuelSaveBtn"); if (btn) btn.disabled = true;
    try {
      // The ONLY place a meal is written — after the athlete's explicit tap.
      await api("/api/fuel/meals", d.mealId ? "PATCH" : "POST", buildPayload(d));
      if (d.mealId) track("fuel_meal_edited", {});
      else {
        track("fuel_meal_logged", { source: d.source === "ai_photo" ? "photo" : d.source, item_count_band: itemBand(d.mode === "items" ? d.items.length : 0) });
        if (d.source === "repeated") track("fuel_meal_repeated", {});
      }
      var wasEdit = !!d.mealId;
      closeSheet();
      await loadAll();
      flashStatus(wasEdit ? "Meal updated." : "Meal logged.");
    } catch (e) {
      state.busy = false;
      if (btn) btn.disabled = false;
      showFormError(describeError(e, "save"));
    }
  }

  async function deleteDetailMeal() {
    var m = state.detailMeal;
    if (!m || state.busy) return;
    state.busy = true; renderSheet();
    try {
      await api("/api/fuel/meals?id=" + encodeURIComponent(m.id), "DELETE", { id: m.id });
      track("fuel_meal_deleted", {});
      closeSheet();
      await loadAll();
      flashStatus("Meal deleted.");
    } catch (e) {
      state.busy = false; renderSheet();
      showFormError(describeError(e, "save"));
    }
  }

  function findMeal(id) {
    return state.meals.filter(function (m) { return String(m.id) === String(id); })[0] || null;
  }

  /* ── goal focus (optional; never a target or a deficit) ───────────── */
  async function setGoal(mode) {
    var next = state.goalMode === mode ? null : mode;
    var prev = state.goalMode;
    state.goalMode = next;
    render();
    var focusBtn = doc.querySelector('[data-fuel-goal="' + mode + '"]');
    if (focusBtn) focusBtn.focus();
    var c = sb(), uid = await currentUserId();
    if (!c || !uid) return;
    try {
      var r = await c.from("fuel_preferences").upsert(
        { user_id: uid, goal_mode: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (r && r.error) throw r.error;
    } catch (e) {
      state.goalMode = prev;
      flashStatus("We couldn’t save that. Please try again.");
    }
  }

  /* ── events ───────────────────────────────────────────────────────── */
  var SELECTOR = "[data-fuel-add],[data-fuel-act],[data-fuel-meal],[data-fuel-retry],[data-fuel-metric],[data-fuel-goal],[data-fuel-mealtype]";

  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
    if (!t) return;
    var d = state.draft;

    if (t.hasAttribute("data-fuel-add")) {
      track("fuel_add_meal_started", { source_surface: t.getAttribute("data-fuel-add") === "empty" ? "fuel_empty" : "fuel_main" });
      state.noteText = "";
      openSheet("choose");
      return;
    }
    if (t.hasAttribute("data-fuel-retry")) { loadAll(); return; }
    if (t.hasAttribute("data-fuel-meal")) {
      var meal = findMeal(t.getAttribute("data-fuel-meal"));
      if (!meal) return;
      state.detailMeal = meal; state.confirmingDelete = false;
      openSheet("detail");
      return;
    }
    if (t.hasAttribute("data-fuel-metric")) {
      state.weeklyMetric = t.getAttribute("data-fuel-metric") === "carbs" ? "carbs" : "calories";
      render();
      var again = doc.querySelector('[data-fuel-metric="' + state.weeklyMetric + '"]');
      if (again) again.focus();
      return;
    }
    if (t.hasAttribute("data-fuel-goal")) { setGoal(t.getAttribute("data-fuel-goal")); return; }
    if (t.hasAttribute("data-fuel-mealtype") && d) {
      var type = t.getAttribute("data-fuel-mealtype");
      d.mealType = d.mealType === type ? "" : type;
      Array.prototype.forEach.call(doc.querySelectorAll("[data-fuel-mealtype]"), function (b) {
        var on = b.getAttribute("data-fuel-mealtype") === d.mealType;
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
      });
      return;
    }

    switch (t.getAttribute("data-fuel-act")) {
      case "camera": var cam = $("fuelCameraInput"); if (cam) cam.click(); break;
      case "library": var lib = $("fuelLibraryInput"); if (lib) lib.click(); break;
      case "manual": startManual(""); break;
      case "manual-from-photo": var carried = readNote(); releasePhoto(); startManual(carried); break;
      case "choose": releasePhoto(); state.step = "choose"; state.error = ""; renderSheet(); break;
      case "cancel": closeSheet(); break;
      case "cancel-analysis": if (state.analysisAbort) state.analysisAbort.abort(); break;
      case "analyze": analyze(); break;
      case "add-item":
        if (!d) break;
        d.items.push(emptyItem());
        track("fuel_estimate_edited", { edit_type: "item_added" });
        renderSheet('[data-fuel-item="' + (d.items.length - 1) + '"] input');
        break;
      case "remove-item":
        if (!d) break;
        d.items.splice(Number(t.getAttribute("data-idx")), 1);
        track("fuel_estimate_edited", { edit_type: "item_removed" });
        renderSheet(d.items.length ? '[data-fuel-act="add-item"]' : null);
        break;
      case "to-items":
        if (!d) break;
        var seed = emptyItem();
        seed.name = d.name || ""; seed.calories = num(d.totals.calories); seed.carbs_g = num(d.totals.carbs_g);
        seed.protein_g = num(d.totals.protein_g); seed.fat_g = num(d.totals.fat_g);
        d.items = [seed]; d.mode = "items";
        renderSheet('[data-fuel-item="0"] input');
        break;
      case "save": submitDraft(); break;
      case "repeat":
        if (!state.detailMeal) break;
        state.draft = draftFromMeal(state.detailMeal, "repeat", localDateKey(), new Date());
        state.detailMeal = null; state.step = "review"; state.estimateEdited = true; renderSheet();
        break;
      case "edit":
        if (!state.detailMeal) break;
        state.draft = draftFromMeal(state.detailMeal, "edit", localDateKey(), new Date());
        state.detailMeal = null; state.step = "review"; state.estimateEdited = true; renderSheet();
        break;
      case "delete": state.confirmingDelete = true; state.error = ""; renderSheet(); break;
      case "keep": state.confirmingDelete = false; state.error = ""; renderSheet(); break;
      case "confirm-delete": deleteDetailMeal(); break;
      default: break;
    }
  }

  function onInput(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    if (el.hasAttribute("data-fuel-note")) { state.noteText = String(el.value || "").slice(0, NOTE_MAX); return; }
    if (el.hasAttribute("data-fuel-field")) onFieldInput(el);
  }

  var FOCUSABLE = 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  function onSheetKeydown(e) {
    if (!state.sheetOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (state.step === "analyzing" && state.analysisAbort) state.analysisAbort.abort(); else closeSheet();
      return;
    }
    if (e.key !== "Tab") return;
    var s = sheetRoot();
    if (!s) return;
    var nodes = Array.prototype.filter.call(s.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null; });
    if (!nodes.length) { e.preventDefault(); return; }
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && (doc.activeElement === first || !s.contains(doc.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ── navigation (same programmatic pattern as Settings / Profile) ── */
  function fuelScreen() { return $(SCREEN_ID); }
  function isFuelActive() { var s = fuelScreen(); return !!(s && s.classList.contains("active")); }

  function open(source) {
    if (!isEnabled() || !fuelScreen()) return false;
    var active = doc.querySelector(".screen.active");
    state.returnScreen = active && active.id && active.id !== SCREEN_ID ? active.id : "screen-trends";
    // Always start from a clean slate so one athlete's meals are never shown to another
    // on a shared device, then load fresh.
    state.loaded = false; state.meals = []; state.training = null; state.energy = null;
    state.energyChecked = false; state.status = ""; state.weeklyTracked = false;
    if (typeof root.showScreen === "function") root.showScreen(SCREEN_ID);
    else {
      Array.prototype.forEach.call(doc.querySelectorAll(".screen"), function (s) { s.classList.remove("active"); });
      fuelScreen().classList.add("active");
    }
    var scr = fuelScreen(); if (scr) scr.scrollTop = 0;
    track("fuel_opened", { source_surface: source || "you_card" });
    loadAll();
    return true;
  }

  function close() {
    if (state.sheetOpen) closeSheet();
    if (typeof root.showScreen === "function") root.showScreen(state.returnScreen || "screen-trends");
  }

  function syncEntryPoints() {
    var entry = $("youFuelEntry");
    if (entry) entry.hidden = !isEnabled();
  }

  function init() {
    var screen = fuelScreen();
    var sheet = sheetRoot();
    if (screen) screen.addEventListener("click", onClick);
    if (sheet) {
      sheet.addEventListener("click", function (e) {
        if (e.target === sheet) { if (state.step !== "analyzing") closeSheet(); return; }
        onClick(e);
      });
      sheet.addEventListener("input", onInput);
      sheet.addEventListener("keydown", onSheetKeydown);
    }
    var cam = $("fuelCameraInput"), lib = $("fuelLibraryInput");
    if (cam) cam.addEventListener("change", function () { onFileChosen(cam, "camera"); });
    if (lib) lib.addEventListener("change", function () { onFileChosen(lib, "library"); });
    root.addEventListener("athlevo:native-back", function (e) {
      if (state.sheetOpen) { e.preventDefault(); if (state.step === "analyzing" && state.analysisAbort) state.analysisAbort.abort(); else closeSheet(); }
      else if (isFuelActive()) { e.preventDefault(); close(); }
    });
    root.addEventListener("athlevo:app-ready", syncEntryPoints);
    syncEntryPoints();
  }

  root.AthlevoFuel = {
    FLAG: FLAG,
    isEnabled: isEnabled,
    open: open,
    close: close,
    syncEntryPoints: syncEntryPoints,
    _test: helpers
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : globalThis);

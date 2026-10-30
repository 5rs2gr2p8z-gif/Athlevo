/*
 * ═════════════════════════════════════════════════
 *  Athlevo — Structured Workout (core, pure)
 * ═════════════════════════════════════════════════
 *
 *  ONE source of truth for the coach workout builder. No DOM, no network.
 *  Loaded as a classic script in the browser (window.AthlevoStructuredWorkout)
 *  and imported by the server through lib/server/structuredWorkout.js.
 *
 *  A structured workout is JSON:
 *    { v: 1, sport: "run", notes?: "…",
 *      steps: [
 *        { type: "warmup"|"work"|"steady"|"recovery"|"cooldown",
 *          duration: { unit: "min"|"km"|"m", value: number },
 *          target:   { kind: "zone", zone } | { kind: "rpe", min, max }
 *                  | { kind: "pace", minSec, maxSec } | { kind: "hr", min, max }
 *                  | { kind: "none" },
 *          note?: string },
 *        { type: "repeat", reps: 2..30, steps: [ …1–6 non-repeat steps ] }
 *      ] }
 *
 *  Targets are stored as zones (or explicit ranges), never as the athlete's
 *  numbers: resolve(structure, paces) turns a zone into THAT athlete's pace,
 *  so one library workout shows every athlete their own paces.
 */
(function (root) {
  "use strict";

  var VERSION = 1;
  var STEP_TYPES = ["warmup", "work", "steady", "recovery", "cooldown"];
  var UNITS = ["min", "km", "m"];
  // Zone keys match js/performance.js (Daniels-style VDOT zones).
  var ZONES = [
    { key: "recovery",   label: "Recovery" },
    { key: "easy",       label: "Easy" },
    { key: "marathon",   label: "Marathon pace" },
    { key: "tempo",      label: "Tempo" },
    { key: "threshold",  label: "Threshold" },
    { key: "vo2",        label: "VO2 / Interval" },
    { key: "repetition", label: "Repetition" }
  ];
  var ZONE_KEYS = ZONES.map(function (z) { return z.key; });
  var DEFAULT_ZONE = { warmup: "easy", work: "threshold", steady: "easy", recovery: "recovery", cooldown: "easy" };
  var STEP_LABEL = { warmup: "Warm up", work: "Work", steady: "Steady", recovery: "Recovery", cooldown: "Cool down" };
  var FALLBACK_SEC_PER_KM = 360; // only for drawing the shape when a distance step has no known pace
  var MAX_TOP_STEPS = 30, MAX_INNER_STEPS = 6, MAX_FLAT_STEPS = 200;

  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function clean(v, max) { var s = v == null ? "" : String(v).replace(/[\u0000-\u001f]/g, " ").trim(); return s ? s.slice(0, max) : ""; }
  function zoneLabel(key) { for (var i = 0; i < ZONES.length; i += 1) if (ZONES[i].key === key) return ZONES[i].label; return key; }

  /* ────────────── validate / sanitize ────────────── */

  function sanitizeTarget(t, stepType) {
    var raw = t && typeof t === "object" ? t : { kind: "zone", zone: DEFAULT_ZONE[stepType] };
    if (raw.kind === "none") return { ok: true, value: { kind: "none" } };
    if (raw.kind === "zone") {
      if (ZONE_KEYS.indexOf(raw.zone) < 0) return { ok: false, error: "Choose a valid zone." };
      return { ok: true, value: { kind: "zone", zone: raw.zone } };
    }
    if (raw.kind === "rpe") {
      var lo = num(raw.min), hi = num(raw.max == null ? raw.min : raw.max);
      if (lo == null || hi == null || lo < 1 || hi > 10 || lo > hi) return { ok: false, error: "RPE must be between 1 and 10." };
      return { ok: true, value: { kind: "rpe", min: lo, max: hi } };
    }
    if (raw.kind === "pace") {
      var a = num(raw.minSec), b = num(raw.maxSec == null ? raw.minSec : raw.maxSec);
      if (a == null || b == null || a < 120 || b > 900 || a > b) return { ok: false, error: "Pace must be between 2:00 and 15:00 per km (fast to slow)." };
      return { ok: true, value: { kind: "pace", minSec: Math.round(a), maxSec: Math.round(b) } };
    }
    if (raw.kind === "hr") {
      var h1 = num(raw.min), h2 = num(raw.max == null ? raw.min : raw.max);
      if (h1 == null || h2 == null || h1 < 40 || h2 > 230 || h1 > h2) return { ok: false, error: "Heart rate must be between 40 and 230 bpm." };
      return { ok: true, value: { kind: "hr", min: Math.round(h1), max: Math.round(h2) } };
    }
    return { ok: false, error: "Unknown target type." };
  }

  function sanitizeStep(s, inRepeat) {
    if (!s || typeof s !== "object") return { ok: false, error: "A step is malformed." };
    if (STEP_TYPES.indexOf(s.type) < 0) return { ok: false, error: "Unknown step type." };
    var d = s.duration && typeof s.duration === "object" ? s.duration : {};
    var value = num(d.value);
    if (UNITS.indexOf(d.unit) < 0 || value == null || value <= 0) return { ok: false, error: "Every step needs a duration or distance." };
    var limits = { min: [0.5, 600], km: [0.05, 100], m: [50, 50000] }[d.unit];
    if (value < limits[0] || value > limits[1]) {
      return { ok: false, error: "A step's " + (d.unit === "min" ? "duration" : "distance") + " is out of range." };
    }
    var target = sanitizeTarget(s.target, s.type);
    if (!target.ok) return target;
    var out = { type: s.type, duration: { unit: d.unit, value: d.unit === "min" ? Math.round(value * 10) / 10 : Math.round(value * 1000) / 1000 }, target: target.value };
    var note = clean(s.note, 200);
    if (note) out.note = note;
    return { ok: true, value: out };
  }

  function validate(input) {
    var raw = input && typeof input === "object" ? input : null;
    if (!raw || !Array.isArray(raw.steps) || !raw.steps.length) return { ok: false, error: "Add at least one step." };
    if (raw.steps.length > MAX_TOP_STEPS) return { ok: false, error: "Too many steps (max " + MAX_TOP_STEPS + ")." };
    var steps = [], flat = 0, i, j, r;
    for (i = 0; i < raw.steps.length; i += 1) {
      var s = raw.steps[i];
      if (s && s.type === "repeat") {
        var reps = num(s.reps);
        if (reps == null || reps < 2 || reps > 30 || Math.floor(reps) !== reps) return { ok: false, error: "Repeats must be a whole number from 2 to 30." };
        if (!Array.isArray(s.steps) || !s.steps.length || s.steps.length > MAX_INNER_STEPS) return { ok: false, error: "A repeat needs 1 to " + MAX_INNER_STEPS + " steps." };
        var inner = [];
        for (j = 0; j < s.steps.length; j += 1) {
          if (s.steps[j] && s.steps[j].type === "repeat") return { ok: false, error: "Repeats cannot be nested." };
          r = sanitizeStep(s.steps[j], true);
          if (!r.ok) return r;
          inner.push(r.value);
        }
        flat += reps * inner.length;
        steps.push({ type: "repeat", reps: reps, steps: inner });
      } else {
        r = sanitizeStep(s, false);
        if (!r.ok) return r;
        flat += 1;
        steps.push(r.value);
      }
      if (flat > MAX_FLAT_STEPS) return { ok: false, error: "This workout is too long to store." };
    }
    var out = { v: VERSION, sport: "run", steps: steps };
    var notes = clean(raw.notes, 1200);
    if (notes) out.notes = notes;
    return { ok: true, value: out };
  }

  /* ────────────── resolve to one athlete's numbers ────────────── */

  // paces: { easy: 330, threshold: 270, … } seconds per km (or {zone:{secPerKm}}). May be null.
  function paceFor(paces, zone) {
    if (!paces || !zone) return null;
    var p = paces[zone];
    var sec = p && typeof p === "object" ? num(p.secPerKm) : num(p);
    return sec && sec > 0 ? sec : null;
  }

  function targetPace(target, paces) {
    if (!target) return null;
    if (target.kind === "zone") return paceFor(paces, target.zone);
    if (target.kind === "pace") return (target.minSec + target.maxSec) / 2;
    return null;
  }

  function fmtPace(sec) {
    if (!sec || !isFinite(sec)) return null;
    var t = Math.round(sec), m = Math.floor(t / 60), s = t - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function resolveStep(step, paces) {
    var pace = targetPace(step.target, paces);
    var seconds, meters, estimated = false;
    if (step.duration.unit === "min") {
      seconds = step.duration.value * 60;
      meters = pace ? seconds / pace * 1000 : null;
    } else {
      meters = step.duration.unit === "km" ? step.duration.value * 1000 : step.duration.value;
      var usePace = pace || null;
      if (!usePace) { usePace = FALLBACK_SEC_PER_KM; estimated = true; }
      seconds = meters / 1000 * usePace;
    }
    return {
      type: step.type, duration: step.duration, target: step.target, note: step.note || null,
      seconds: Math.round(seconds), meters: meters == null ? null : Math.round(meters),
      pace: pace ? Math.round(pace) : null, estimated: estimated
    };
  }

  // Flattens repeats (expanded) into ordered resolved steps, plus totals.
  function resolve(structure, paces) {
    var v = validate(structure);
    if (!v.ok) return { ok: false, error: v.error };
    var flat = [], i, j, k, totalSec = 0, totalM = 0, distanceKnown = true, workSec = 0;
    function push(step, group) {
      var r = resolveStep(step, paces);
      r.group = group;
      flat.push(r);
      totalSec += r.seconds;
      if (r.meters == null) distanceKnown = false; else totalM += r.meters;
      if (step.type === "work") workSec += r.seconds;
    }
    for (i = 0; i < v.value.steps.length; i += 1) {
      var s = v.value.steps[i];
      if (s.type === "repeat") {
        for (k = 0; k < s.reps; k += 1) for (j = 0; j < s.steps.length; j += 1) push(s.steps[j], i);
      } else push(s, null);
    }
    return {
      ok: true, structure: v.value, steps: flat,
      totals: {
        seconds: totalSec, durationMinutes: Math.round(totalSec / 60),
        distanceKm: distanceKnown ? Math.round(totalM / 100) / 10 : null,
        workSeconds: workSec,
        hasEstimates: flat.some(function (f) { return f.estimated; })
      }
    };
  }

  /* ────────────── text for humans and for the athlete calendar parser ────────────── */

  function fmtDuration(d) {
    if (d.unit === "min") return (d.value % 1 === 0 ? d.value : d.value.toFixed(1)) + " min";
    // km everywhere: the athlete calendar's text parser reads a bare "m" as minutes.
    var km = d.unit === "km" ? d.value : d.value / 1000;
    return (Math.round(km * 100) / 100) + " km";
  }

  function fmtTarget(t, paces) {
    if (!t || t.kind === "none") return "";
    if (t.kind === "zone") {
      var p = fmtPace(paceFor(paces, t.zone));
      return zoneLabel(t.zone).toLowerCase() + (p ? " at " + p + " per km" : "");
    }
    if (t.kind === "pace") return "at " + fmtPace(t.minSec) + (t.maxSec !== t.minSec ? " to " + fmtPace(t.maxSec) : "") + " per km";
    if (t.kind === "rpe") return "RPE " + t.min + (t.max !== t.min ? " to " + t.max : "");
    if (t.kind === "hr") return "heart rate " + t.min + (t.max !== t.min ? " to " + t.max : "") + " bpm";
    return "";
  }

  // Deliberately avoids commas, "with", "+" and "/" inside a step: js/trainCalendar.js splits on them.
  function stepText(step, paces) {
    var parts = [fmtDuration(step.duration), fmtTarget(step.target, paces)].filter(Boolean);
    var text = parts.join(" ");
    if (step.type === "warmup") text = "Warm up " + text;
    else if (step.type === "cooldown") text = "Cool down " + text;
    else if (step.type === "recovery") text = fmtDuration(step.duration) + " recovery" + (step.target && step.target.kind !== "none" && step.target.zone !== "recovery" ? " " + fmtTarget(step.target, paces) : "");
    return text;
  }

  // Same shape the AI planner writes: warmup[], main_set[], cooldown[] arrays of strings.
  function toLines(structure, paces) {
    var v = validate(structure);
    if (!v.ok) return { ok: false, error: v.error };
    var warmup = [], main = [], cooldown = [], steps = v.value.steps, seenMain = false;
    steps.forEach(function (s, idx) {
      if (s.type === "warmup" && !seenMain) { warmup.push(stepText(s, paces)); return; }
      if (s.type === "cooldown" && idx >= firstTrailingCooldown(steps)) { cooldown.push(stepText(s, paces)); return; }
      seenMain = true;
      if (s.type === "repeat") {
        if (s.steps.length <= 2 && s.steps[0].type !== "recovery") {
          var line = s.reps + " × " + stepText(s.steps[0], paces);
          if (s.steps[1]) line += " / " + stepText(s.steps[1], paces);
          main.push(line);
        } else {
          main.push(s.reps + " rounds: " + s.steps.map(function (x) { return stepText(x, paces); }).join(" then "));
        }
      } else main.push(stepText(s, paces));
    });
    return { ok: true, warmup: warmup, main_set: main, cooldown: cooldown };
  }

  function firstTrailingCooldown(steps) {
    var i = steps.length;
    while (i > 0 && steps[i - 1].type === "cooldown") i -= 1;
    return i;
  }

  /* ────────────── segments for the athlete workout-shape strip ────────────── */

  function toSegments(structure, paces) {
    var r = resolve(structure, paces);
    if (!r.ok) return [];
    return r.steps.map(function (s) {
      var kind = s.type === "work" ? "work" : s.type;
      return { kind: kind, duration: s.seconds, label: STEP_LABEL[s.type] };
    });
  }

  // Short summary for the coach list / description.
  function summaryLine(resolved) {
    if (!resolved || !resolved.ok) return "";
    var t = resolved.totals, bits = [t.durationMinutes + " min"];
    if (t.distanceKm != null) bits.push(t.distanceKm + " km");
    return bits.join(" · ");
  }

  var api = {
    VERSION: VERSION, STEP_TYPES: STEP_TYPES, UNITS: UNITS, ZONES: ZONES, DEFAULT_ZONE: DEFAULT_ZONE, STEP_LABEL: STEP_LABEL,
    validate: validate, resolve: resolve, toLines: toLines, toSegments: toSegments, summaryLine: summaryLine,
    fmtPace: fmtPace, fmtDuration: fmtDuration, fmtTarget: fmtTarget, zoneLabel: zoneLabel
  };
  root.AthlevoStructuredWorkout = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Canonical Workout Prescription Validator  (client mirror)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ONE source of truth for a prescribed session. The concrete MAIN SET is
 *  authoritative for the training stimulus; the label fields (session_type,
 *  title, intensity, purpose) must AGREE with it. When they contradict —
 *  e.g. a "Foundation Run" whose main set is "3 × 8 min threshold" — we do
 *  NOT invent a new workout; we correct the mislabel so the card summary and
 *  the expanded prescription describe the same session.
 *
 *  Pure + deterministic. Server twin: lib/server/prescription.js (keep in
 *  parity). Exposed as window.AthlevoPrescription. No I/O, no scoring change.
 */
(function (root) {
  "use strict";

  function txt(v) {
    if (Array.isArray(v)) return v.filter(Boolean).join(" · ");
    return v == null ? "" : String(v);
  }
  function norm(v) { return txt(v).toLowerCase(); }

  // Stimulus vocabulary, strongest → weakest. `re` matches concrete prescription
  // text; `label`/`title`/`intensity` are the canonical labels for a repair.
  var STIMULI = [
    { key: "race",          cat: "race",    re: /\brace\b|time ?trial|\btt\b/,                         title: "Race",              intensity: "Race" },
    { key: "vo2",           cat: "quality", re: /\bvo2\b|v\.?o2|max ?aerobic|3 ?[x×] ?3|4 ?[x×] ?4|5 ?[x×] ?3|1000 ?m|1200 ?m|interval/, title: "VO2 Intervals", intensity: "VO2" },
    { key: "threshold",     cat: "quality", re: /threshold|tempo|lactate|comfortably hard|cruise|[0-9] ?[x×] ?[0-9]+ ?min/, title: "Threshold Session", intensity: "Threshold" },
    { key: "marathon_pace", cat: "quality", re: /marathon pace|\bmp\b|goal pace|race pace/,             title: "Marathon-Pace Run", intensity: "Marathon Pace" },
    { key: "hills",         cat: "quality", re: /hill (repeat|sprint|rep)|uphill (rep|effort)/,          title: "Hill Repeats",      intensity: "Hills" },
    { key: "repetition",    cat: "quality", re: /repetition|[0-9] ?[x×] ?(200|300|400|600) ?m|\breps? at\b/, title: "Repetitions",   intensity: "Repetition" },
    { key: "progression",   cat: "easyish", re: /progression|negative split|finish (fast|strong)/,       title: "Progression Run",   intensity: "Progression" },
    { key: "long",          cat: "easyish", re: /long run|long steady/,                                  title: "Long Run",          intensity: "Long Run" },
    { key: "steady",        cat: "easyish", re: /\bsteady\b|moderate aerobic/,                           title: "Steady Run",        intensity: "Steady" },
    { key: "recovery",      cat: "easy",    re: /recovery|shake ?out|very easy/,                         title: "Recovery Run",      intensity: "Recovery" },
    { key: "easy",          cat: "easy",    re: /\beasy\b|aerobic|conversational|foundation|base/,       title: "Easy Run",          intensity: "Easy" }
  ];
  var STRIDES_RE = /strides|pick-?ups|accelerations/;

  // session_type / title → category, for detecting the LABEL's implied type.
  function typeToStimulus(raw) {
    var s = norm(raw).replace(/[\s-]+/g, "_");
    if (!s) return null;
    if (/rest/.test(s)) return { key: "rest", cat: "rest" };
    if (/race|time_trial|tt/.test(s)) return byKey("race");
    if (/vo2|interval/.test(s)) return byKey("vo2");
    if (/threshold|tempo|lt2?/.test(s)) return byKey("threshold");
    if (/marathon_pace|goal_pace/.test(s)) return byKey("marathon_pace");
    if (/hill/.test(s)) return byKey("hills");
    if (/rep(etition)?|speed/.test(s)) return byKey("repetition");
    if (/progression/.test(s)) return byKey("progression");
    if (/long/.test(s)) return byKey("long");
    if (/steady/.test(s)) return byKey("steady");
    if (/recovery/.test(s)) return byKey("recovery");
    if (/easy|aerobic|foundation|base/.test(s)) return byKey("easy");
    return null;
  }
  function byKey(k) { for (var i = 0; i < STIMULI.length; i++) if (STIMULI[i].key === k) return STIMULI[i]; return null; }

  // Strongest structured stimulus present in a block of prescription text.
  function detectStimulus(text) {
    var t = norm(text);
    if (!t) return null;
    for (var i = 0; i < STIMULI.length; i++) if (STIMULI[i].re.test(t)) return STIMULI[i];
    return null;
  }

  // Minutes referenced in a section (best-effort; e.g. "3 x 8 min" → 24, "15 min" → 15).
  function sectionMinutes(list) {
    var total = 0;
    (Array.isArray(list) ? list : [list]).forEach(function (line) {
      var s = txt(line);
      var reps = s.match(/([0-9]+)\s*[x×]\s*([0-9]+)\s*min/i);
      if (reps) { total += Number(reps[1]) * Number(reps[2]); return; }
      var one = s.match(/([0-9]+)\s*min/i);
      if (one) total += Number(one[1]);
    });
    return total;
  }

  var REST = { rest: true };
  function isRest(session) {
    var s = norm(session && session.session_type).replace(/[\s-]+/g, "_");
    return /^(rest|rest_day|off|day_off)$/.test(s) || (session && session.sport && /rest/.test(norm(session.sport)));
  }

  /*
   * Validate a session and return a canonical, self-consistent copy.
   * Returns { session, changed, contradictions[] }. Never mutates input.
   */
  function validate(session) {
    var out = Object.assign({}, session || {});
    var contradictions = [];
    if (!session || isRest(session)) return { session: out, changed: false, contradictions: contradictions };

    var mainStim = detectStimulus(txt(session.main_set));
    var purposeStim = detectStimulus(txt(session.purpose) + " " + txt(session.description));
    var labelStim = typeToStimulus(session.session_type) || typeToStimulus(session.title);

    // Canonical stimulus: the concrete main set wins; fall back to purpose,
    // then the existing label. This is the single source of truth.
    var canonical = mainStim || purposeStim || labelStim;
    if (!canonical) return { session: out, changed: false, contradictions: contradictions };

    var hasStrides = STRIDES_RE.test(norm(session.main_set)) || STRIDES_RE.test(norm(session.title));

    // Contradiction: the label claims a different CATEGORY than the main set.
    // "easy + strides" is a legitimate easy session — never a contradiction.
    var stridesEasy = labelStim && labelStim.cat === "easy" && hasStrides &&
      (canonical.cat === "easy" || canonical.cat === "easyish");
    var contradiction = !!labelStim && labelStim.cat !== canonical.cat && !stridesEasy;
    var needLabel = !labelStim;

    if (contradiction) {
      contradictions.push(
        "Label \"" + txt(session.session_type || session.title) + "\" (" + labelStim.cat +
        ") disagrees with the main set (" + canonical.key + ")."
      );
    }

    // Repair labels ONLY on a real contradiction or when no type is present.
    // A consistent session (e.g. session_type "long_run" with a long main set)
    // is left exactly as authored.
    if (contradiction || needLabel) {
      out.session_type = canonical.key;
      out.title = canonical.title + (hasStrides && canonical.cat === "easy" ? " + Strides" : "");
      out.intensity = canonical.intensity;
      out.__repaired = true;
    }

    // Duration sanity: sections must fit the stated total (+10% tolerance).
    var dur = Number(session.duration_minutes);
    if (Number.isFinite(dur) && dur > 0) {
      var used = sectionMinutes(session.warmup) + sectionMinutes(session.main_set) + sectionMinutes(session.cooldown);
      if (used > 0 && used > dur * 1.1) {
        contradictions.push("Sections total ~" + used + " min but duration says " + dur + " min.");
        out.duration_minutes = used;   // repair to the real prescribed time
        out.__repaired = true;
      }
    }

    return { session: out, changed: !!out.__repaired, contradictions: contradictions };
  }

  // Convenience: return only the repaired session (used by the renderer).
  function repair(session) { return validate(session).session; }

  var api = { validate: validate, repair: repair, detectStimulus: detectStimulus, typeToStimulus: typeToStimulus, sectionMinutes: sectionMinutes, VERSION: "prescription-v1" };
  if (root) root.AthlevoPrescription = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));

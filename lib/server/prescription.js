/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Canonical Workout Prescription Validator  (server twin)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Server-side mirror of js/prescription.js. Runs BEFORE storage so a
 *  generated plan can never persist a session whose label (session_type /
 *  title / intensity) contradicts its concrete main set. The main set is the
 *  authoritative training stimulus; labels are corrected to agree with it.
 *
 *  Pure + deterministic. Keep in parity with the client file.
 */

function txt(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(" · ");
  return v == null ? "" : String(v);
}
function norm(v) { return txt(v).toLowerCase(); }

const STIMULI = [
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
const STRIDES_RE = /strides|pick-?ups|accelerations/;

function byKey(k) { return STIMULI.find(s => s.key === k) || null; }

function typeToStimulus(raw) {
  const s = norm(raw).replace(/[\s-]+/g, "_");
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

export function detectStimulus(text) {
  const t = norm(text);
  if (!t) return null;
  return STIMULI.find(s => s.re.test(t)) || null;
}

export function sectionMinutes(list) {
  let total = 0;
  (Array.isArray(list) ? list : [list]).forEach(line => {
    const s = txt(line);
    const reps = s.match(/([0-9]+)\s*[x×]\s*([0-9]+)\s*min/i);
    if (reps) { total += Number(reps[1]) * Number(reps[2]); return; }
    const one = s.match(/([0-9]+)\s*min/i);
    if (one) total += Number(one[1]);
  });
  return total;
}

function isRest(session) {
  const s = norm(session && session.session_type).replace(/[\s-]+/g, "_");
  return /^(rest|rest_day|off|day_off)$/.test(s) || (session && session.sport && /rest/.test(norm(session.sport)));
}

export function validatePrescription(session) {
  const out = Object.assign({}, session || {});
  const contradictions = [];
  if (!session || isRest(session)) return { session: out, changed: false, contradictions };

  const mainStim = detectStimulus(txt(session.main_set));
  const purposeStim = detectStimulus(txt(session.purpose) + " " + txt(session.description));
  const labelStim = typeToStimulus(session.session_type) || typeToStimulus(session.title);
  const canonical = mainStim || purposeStim || labelStim;
  if (!canonical) return { session: out, changed: false, contradictions };

  const hasStrides = STRIDES_RE.test(norm(session.main_set)) || STRIDES_RE.test(norm(session.title));
  const stridesEasy = labelStim && labelStim.cat === "easy" && hasStrides &&
    (canonical.cat === "easy" || canonical.cat === "easyish");
  const contradiction = !!labelStim && labelStim.cat !== canonical.cat && !stridesEasy;
  const needLabel = !labelStim;

  if (contradiction) {
    contradictions.push(
      `Label "${txt(session.session_type || session.title)}" (${labelStim.cat}) disagrees with the main set (${canonical.key}).`
    );
  }
  if (contradiction || needLabel) {
    out.session_type = canonical.key;
    out.title = canonical.title + (hasStrides && canonical.cat === "easy" ? " + Strides" : "");
    out.intensity = canonical.intensity;
    out.__repaired = true;
  }

  const dur = Number(session.duration_minutes);
  if (Number.isFinite(dur) && dur > 0) {
    const used = sectionMinutes(session.warmup) + sectionMinutes(session.main_set) + sectionMinutes(session.cooldown);
    if (used > 0 && used > dur * 1.1) {
      contradictions.push(`Sections total ~${used} min but duration says ${dur} min.`);
      out.duration_minutes = used;
      out.__repaired = true;
    }
  }

  return { session: out, changed: !!out.__repaired, contradictions };
}

export function repairPrescription(session) { return validatePrescription(session).session; }

export const PRESCRIPTION_VERSION = "prescription-v1";

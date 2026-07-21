console.log("Athlevo Onboarding v2 loaded");

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Onboarding v2  (grouped, premium, under-two-minutes flow)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Beta feedback: the old flow asked ~24 questions one-at-a-time in a chat
 *  ("next nang next"). This redesign keeps essentially the same coaching
 *  information but groups it into SIX fast steps with big tap targets,
 *  chips instead of typing, a progress bar, and instant transitions.
 *
 *  IMPORTANT — no database changes. Every value is written to a profile
 *  column that ALREADY exists. Three grouped concepts that have no column
 *  of their own (current training status, goal distance, preferred long
 *  run day) are folded into existing columns the coach already reads:
 *    · goal distance          → composed into `goal`
 *    · training status        → composed into `coach_notes`
 *    · preferred long run day → composed into `coach_notes`
 *  so the coaching context loses nothing.
 *
 *  Baseline sleep hours and life-stress are no longer asked here — the
 *  Readiness Engine now captures them (more accurately) every day, and
 *  the coach context does not read the profile copies. Allergies fold
 *  into the (coach-read) diet / fueling field. Net: much shorter, same
 *  useful information.
 *
 *  Does NOT touch: Coach, Conversation Memory, Readiness Engine, Workout
 *  Analysis Engine, Subscriptions, Authentication, Garmin, Navigation, or
 *  Legal pages.
 */

/* ─────────────────────────── step definitions ───────────────────────── */

const WEEK_DAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday"
];

const OB_STEPS = [
  {
    key: "about",
    eyebrow: "Step 1 · About you",
    title: "Let's start with you",
    sub: "The basics so your coach knows who it's training.",
    fields: [
      { id: "name", type: "text", label: "Your name", placeholder: "e.g. Dean", required: true },
      {
        id: "age", type: "number", label: "Age", unit: "yrs",
        min: 13, max: 100, integer: true, required: true, placeholder: "28", half: true
      },
      {
        id: "sex", type: "chips", label: "Sex", required: true,
        options: [
          { label: "Male", value: "Male" },
          { label: "Female", value: "Female" }
        ]
      },
      { id: "location", type: "text", label: "Where you train", optional: true,
        placeholder: "City, country — helps with climate" }
    ]
  },
  {
    key: "body",
    eyebrow: "Step 2 · Body metrics",
    title: "Your body metrics",
    sub: "Used to personalise pacing, fuelling and load.",
    unitToggle: true,
    fields: [
      { id: "height", type: "number", label: "Height", unitKey: "height",
        required: true, half: true },
      { id: "weight", type: "number", label: "Weight", unitKey: "weight",
        required: true, half: true }
    ]
  },
  {
    key: "profile",
    eyebrow: "Step 3 · Athlete profile",
    title: "Where you're at",
    sub: "Your current running background and shape.",
    fields: [
      {
        id: "experience", type: "chips", label: "Running experience", required: true,
        options: [
          { label: "New to running", value: 0 },
          { label: "1–2 years", value: 1 },
          { label: "3–5 years", value: 4 },
          { label: "5+ years", value: 8 }
        ]
      },
      {
        id: "mileage", type: "number", label: "Current weekly mileage", unit: "km",
        min: 0, max: 1000, required: true, placeholder: "40", half: true
      },
      {
        id: "hours", type: "number", label: "Weekly training hours", unit: "hrs",
        min: 0, max: 100, optional: true, placeholder: "5", half: true
      },
      {
        id: "status", type: "chips", label: "Current training status", required: true,
        options: [
          { label: "Just starting", value: "Just starting" },
          { label: "Building base", value: "Building base" },
          { label: "In a training block", value: "In a training block" },
          { label: "Returning from a break", value: "Returning from a break" },
          { label: "Maintaining fitness", value: "Maintaining fitness" }
        ]
      },
      {
        id: "injuries", type: "text", label: "Injuries or recurring niggles", optional: true,
        placeholder: "Anything nagging? Leave blank if none"
      }
    ]
  },
  {
    key: "goals",
    eyebrow: "Step 4 · Goals",
    title: "What you're chasing",
    sub: "Give your training a target to build toward.",
    fields: [
      {
        id: "distance", type: "chips", label: "Goal distance", required: true,
        options: [
          { label: "5K", value: "5K" },
          { label: "10K", value: "10K" },
          { label: "Half marathon", value: "Half marathon" },
          { label: "Marathon", value: "Marathon" },
          { label: "Ultra", value: "Ultra" },
          { label: "General fitness", value: "General fitness" },
          { label: "Other", value: "Other" }
        ]
      },
      /*
       * Shown only when "Other" is chosen. Plenty of real goals aren't on a
       * six-item list — 1 mile, 10 mile, 15K, 50K, a local trail race — and
       * forcing those athletes to pick a wrong answer corrupts their plan.
       */
      { id: "customDistance", type: "text", label: "Your distance", optional: true,
        placeholder: "e.g. 10 miles, 15 km, 50 km", showWhen: { distance: "Other" } },
      { id: "race", type: "text", label: "Goal race or event", optional: true,
        placeholder: "e.g. Chicago Marathon" },
      { id: "date", type: "date", label: "Race date", optional: true },
      { id: "time", type: "text", label: "Goal finish time", optional: true,
        placeholder: "e.g. sub-4:00" }
    ]
  },
  {
    key: "performance",
    eyebrow: "Step 5 · Recent performance",
    title: "Your latest result",
    sub: "A recent race sets your starting fitness. Skip it and Athlevo will estimate from your imported runs.",
    fields: [
      {
        id: "recentDist", type: "chips", label: "Recent race distance", optional: true,
        options: [
          { label: "5K", value: 5000 },
          { label: "10K", value: 10000 },
          { label: "Half", value: 21097.5 },
          { label: "Marathon", value: 42195 }
        ]
      },
      { id: "recentDistKm", type: "number", label: "Other distance", unit: "km",
        min: 0.4, max: 500, optional: true, placeholder: "e.g. 15", half: true },
      { id: "recentTime", type: "text", label: "Finish time", optional: true,
        placeholder: "e.g. 22:30 or 1:45:00", half: true },
      { id: "recentDate", type: "date", label: "Date of race", optional: true },
      {
        id: "recentType", type: "chips", label: "Race type", optional: true,
        options: [
          { label: "Official race", value: "official" },
          { label: "Time trial", value: "time_trial" },
          { label: "Training effort", value: "training_effort" }
        ]
      }
    ]
  },
  {
    key: "schedule",
    eyebrow: "Step 6 · Training schedule",
    title: "How your week works",
    sub: "So your plan fits your real life, not the other way around.",
    fields: [
      {
        id: "days", type: "chips", label: "Days you can train each week", required: true,
        options: [1, 2, 3, 4, 5, 6, 7].map(n => ({ label: String(n), value: n }))
      },
      { id: "longRun", type: "days", label: "Preferred long run day", required: true },
      {
        id: "trainTime", type: "chips", label: "Preferred training time", required: true,
        options: [
          { label: "Early morning", value: "Early morning" },
          { label: "Midday", value: "Midday" },
          { label: "After work", value: "After work" },
          { label: "Evening", value: "Evening" },
          { label: "Varies", value: "Varies" }
        ]
      },
      { id: "schedule", type: "text", label: "Work or study schedule", optional: true,
        placeholder: "Shift work, long commute, etc." }
    ]
  },
  {
    key: "setup",
    eyebrow: "Step 7 · Your setup",
    title: "Devices & fuelling",
    sub: "Last one — then your coach gets to work.",
    fields: [
      {
        id: "devices", type: "multichips", label: "What do you use to track?", required: true,
        options: [
          { label: "Garmin", value: "Garmin" },
          { label: "COROS", value: "COROS" },
          { label: "Apple Watch", value: "Apple Watch" },
          { label: "Strava", value: "Strava" },
          { label: "TrainingPeaks", value: "TrainingPeaks" },
          { label: "Other", value: "Other" },
          { label: "None", value: "None", exclusive: true }
        ]
      },
      { id: "diet", type: "text", label: "Diet, allergies or fuelling needs", optional: true,
        placeholder: "e.g. vegetarian, lactose intolerant" },
      { id: "notes", type: "textarea", label: "Anything else your coach should know", optional: true,
        placeholder: "Motivation, health context, responsibilities…" }
    ]
  }
];

/* ───────────────────────────── state ────────────────────────────────── */

let obStepIndex = 0;
let obData = {};          // { fieldId: value }
let obProfile = null;
let obBusy = false;

/* ───────────────────────────── helpers ──────────────────────────────── */

function obEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function obClean(text) {
  return typeof text === "string" ? text.trim() : "";
}

function obMessage(text) {
  const el = document.getElementById("ob2Msg");
  if (el) el.textContent = text || "";
}

function obSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Permanent (do-not-retry) permission failures vs. transient hiccups.
function obIsPermissionError(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();
  return code === "42501" ||
    msg.includes("row-level security") ||
    msg.includes("permission denied") ||
    msg.includes("not allowed");
}
function obIsDuplicateError(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();
  return code === "23505" || msg.includes("duplicate key");
}

// Bounded wait for a valid authenticated user — never assumes the session
// exists immediately after signup, and never hangs forever. Reuses the
// shared session helper (getSession first, so it works even when the auth
// network call is flaky inside an in-app browser).
async function obUser() {
  let user = null;
  if (window.AthlevoSession && window.AthlevoSession.waitForValidUser) {
    user = await window.AthlevoSession.waitForValidUser(supabaseClient, { timeoutMs: 8000 });
  } else {
    try {
      const { data } = await supabaseClient.auth.getUser();
      user = (data && data.user) || null;
    } catch (error) { /* handled below */ }
  }
  if (!user) {
    const err = new Error("NO_SESSION");
    err.code = "NO_SESSION";
    throw err;
  }
  return user;
}

/* ─────────────────────── prefill from an existing profile ───────────── */

function obPrefillFromProfile(profile) {
  const d = {};
  if (!profile) return d;

  if (profile.full_name) d.name = profile.full_name;
  if (profile.age != null) d.age = String(profile.age);
  if (profile.sex) d.sex = profile.sex;
  if (profile.location) d.location = profile.location;
  // Stored metric → displayed in whichever units the athlete prefers.
  const imperialPrefill = obUnits() === "imperial";
  if (profile.height != null) {
    d.height = String(imperialPrefill
      ? Math.round(OB_CONVERT.cmToIn(Number(profile.height)))
      : profile.height);
  }
  if (profile.weight != null) {
    d.weight = String(imperialPrefill
      ? Math.round(OB_CONVERT.kgToLb(Number(profile.weight)))
      : profile.weight);
  }
  if (profile.experience_years != null) {
    const y = Number(profile.experience_years);
    d.experience = y >= 5 ? 8 : y >= 3 ? 4 : y >= 1 ? 1 : 0;
  }
  if (profile.weekly_distance != null) d.mileage = String(profile.weekly_distance);
  if (profile.weekly_hours != null) d.hours = String(profile.weekly_hours);
  if (profile.injury_history) d.injuries = profile.injury_history;
  if (profile.target_race) d.race = profile.target_race;
  if (profile.race_date) d.date = profile.race_date;
  if (profile.target_time) d.time = profile.target_time;
  if (profile.available_days != null) d.days = Number(profile.available_days);
  else if (profile.training_days != null) d.days = Number(profile.training_days);
  if (profile.preferred_training_time) d.trainTime = profile.preferred_training_time;
  if (profile.work_schedule) d.schedule = profile.work_schedule;
  if (profile.diet) d.diet = profile.diet;
  if (profile.device) {
    d.devices = String(profile.device)
      .split(",").map(s => s.trim()).filter(Boolean);
  }

  // Recover the three "composed" fields so resume shows prior answers and
  // re-saving never duplicates the structured prefixes.
  const distances = ["5K", "10K", "Half marathon", "Marathon", "Ultra", "General fitness"];
  if (profile.goal) {
    const g = distances.find(x => profile.goal.startsWith(x));
    if (g) { d.distance = g; }
    else {
      // A custom goal was saved. Restore both the chip and the free text so
      // resuming never silently drops what the athlete told us.
      d.distance = "Other";
      d.customDistance = profile.goal;
    }
  }
  const notes = obClean(profile.coach_notes);
  if (notes) {
    const statusMatch = notes.match(/Training status:\s*([^.]+)\./i);
    if (statusMatch) d.status = statusMatch[1].trim();
    const longMatch = notes.match(/Preferred long run day:\s*([^.]+)\./i);
    if (longMatch) {
      const day = WEEK_DAYS.find(
        w => w.toLowerCase() === longMatch[1].trim().toLowerCase()
      );
      if (day) d.longRun = day;
    }
    // Strip the structured prefixes to recover the athlete's free note.
    const free = notes
      .replace(/Training status:\s*[^.]+\.\s*/i, "")
      .replace(/Preferred long run day:\s*[^.]+\.\s*/i, "")
      .trim();
    if (free) d.notes = free;
  }

  return d;
}

/* ─────────────────── translate answers → profile columns ────────────── */

/*
 * Tidies a free-text distance into a consistent label. Recognised forms are
 * normalised ("10mi" → "10 miles"); anything unrecognised is returned as the
 * athlete typed it, trimmed. We never guess a distance we weren't given.
 */
function obNormalizeDistance(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const m = text.match(/^(\d+(?:\.\d+)?)\s*(k|km|kms|kilometer|kilometre|kilometers|kilometres|mi|mile|miles|m)\b/i);
  if (!m) return text;

  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return text;

  if (/^(mi|mile|miles)$/.test(unit)) {
    return `${value} ${value === 1 ? "mile" : "miles"}`;
  }
  if (unit === "m") return `${value} m`;
  return `${value} km`;
}

/* ── Units (metric / imperial) ─────────────────────────────────────────
 *
 * The athlete enters whatever they think in; we ALWAYS store metric
 * (height_cm, weight_kg), so nothing downstream — pacing, load, the coach —
 * has to know which units were typed.
 */
const OB_UNITS_KEY = "athlevo_units";

function obUnits() {
  try { return localStorage.getItem(OB_UNITS_KEY) === "imperial" ? "imperial" : "metric"; }
  catch (e) { return "metric"; }
}

function obSetUnits(value) {
  try { localStorage.setItem(OB_UNITS_KEY, value === "imperial" ? "imperial" : "metric"); }
  catch (e) {}
  obRenderStep();   // re-render so labels and any typed values follow
}

const OB_CONVERT = {
  cmToIn: cm => cm / 2.54,
  inToCm: inches => inches * 2.54,
  kgToLb: kg => kg * 2.2046226218,
  lbToKg: lb => lb / 2.2046226218,
  kmToMi: km => km * 0.621371,
  miToKm: mi => mi / 0.621371
};

function obBuildUpdates() {
  const d = obData;
  const updates = {};
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  if (obClean(d.name)) updates.full_name = obClean(d.name);
  if (d.age != null && d.age !== "") updates.age = num(d.age);
  if (d.sex) updates.sex = d.sex;
  updates.location = obClean(d.location) || null;

  /*
   * Always store metric, whatever the athlete typed. Everything downstream —
   * pacing, fuelling, load — assumes cm and kg, so the conversion happens
   * once, here, rather than being re-derived in a dozen places.
   */
  const imperial = obUnits() === "imperial";
  if (d.height != null && d.height !== "") {
    const h = num(d.height);
    updates.height = h == null ? null : Math.round((imperial ? OB_CONVERT.inToCm(h) : h) * 10) / 10;
  }
  if (d.weight != null && d.weight !== "") {
    const w = num(d.weight);
    updates.weight = w == null ? null : Math.round((imperial ? OB_CONVERT.lbToKg(w) : w) * 10) / 10;
  }

  if (d.experience != null) updates.experience_years = num(d.experience);
  if (d.mileage != null && d.mileage !== "") updates.weekly_distance = num(d.mileage);
  if (d.hours != null && d.hours !== "") updates.weekly_hours = num(d.hours);
  updates.injury_history = obClean(d.injuries) || null;

  updates.target_race = obClean(d.race) || null;
  updates.race_date = obClean(d.date) || null;
  updates.target_time = obClean(d.time) || null;

  if (d.days != null) {
    updates.available_days = num(d.days);
    updates.training_days = num(d.days);
  }
  if (d.trainTime) updates.preferred_training_time = d.trainTime;
  updates.work_schedule = obClean(d.schedule) || null;

  updates.diet = obClean(d.diet) || null;

  if (Array.isArray(d.devices) && d.devices.length) {
    updates.device = d.devices.join(", ");
  }

  // This is a running-focused onboarding; keep the coach-read column set.
  updates.primary_sport = "Running";

  // Goal distance folds into the coach-read `goal` line.
  if (d.distance) {
    if (d.distance === "General fitness") {
      updates.goal = obClean(d.race) || "General endurance fitness";
    } else if (d.distance === "Other") {
      /*
       * A custom distance is the athlete's own words. We normalise the label
       * where we confidently can (so "10 miles" reads consistently) but never
       * invent a distance we weren't given.
       */
      const custom = obNormalizeDistance(obClean(d.customDistance));
      const base = custom || "Custom distance";
      updates.goal = obClean(d.time) ? `${base} in ${obClean(d.time)}` : base;
    } else {
      updates.goal = obClean(d.time)
        ? `${d.distance} in ${obClean(d.time)}`
        : d.distance;
    }
  }

  // Training status + preferred long run day fold into coach_notes,
  // which the coaching context already reads.
  const noteParts = [];
  if (d.status) noteParts.push(`Training status: ${d.status}.`);
  if (d.longRun) noteParts.push(`Preferred long run day: ${d.longRun}.`);
  const free = obClean(d.notes);
  if (free) noteParts.push(free);
  updates.coach_notes = noteParts.length ? noteParts.join(" ") : null;

  return updates;
}

/* ─────────────────────────── field rendering ────────────────────────── */

/*
 * Unit-aware field spec. The athlete types in their own units; the SAVE path
 * converts back to metric, so storage never varies.
 */
const OB_UNIT_SPEC = {
  height: {
    metric:   { unit: "cm", min: 100, max: 250, placeholder: "175" },
    imperial: { unit: "in", min: 39,  max: 98,  placeholder: "69" }
  },
  weight: {
    metric:   { unit: "kg", min: 25,  max: 300, placeholder: "68" },
    imperial: { unit: "lb", min: 55,  max: 660, placeholder: "150" }
  }
};

function obApplyUnits(field) {
  if (!field.unitKey) return field;
  const spec = OB_UNIT_SPEC[field.unitKey];
  if (!spec) return field;
  return Object.assign({}, field, spec[obUnits()] || spec.metric);
}

function obRenderField(rawField) {
  const field = obApplyUnits(rawField);
  const optTag = field.optional
    ? ` <span class="opt">· optional</span>`
    : "";
  const label = `<label class="ob2-label" for="obf-${field.id}">${obEscape(field.label)}${optTag}</label>`;

  if (field.type === "text" || field.type === "number" || field.type === "date") {
    const value = obData[field.id] != null ? obEscape(obData[field.id]) : "";
    const input =
      field.type === "date"
        ? `<input class="ob2-input" id="obf-${field.id}" type="date" value="${value}">`
        : field.unit
          ? `<div class="ob2-affix"><input class="ob2-input" id="obf-${field.id}" type="${
              field.type === "number" ? "number" : "text"
            }" inputmode="${field.type === "number" ? "decimal" : "text"}" placeholder="${
              obEscape(field.placeholder || "")
            }" value="${value}"><span class="unit">${obEscape(field.unit)}</span></div>`
          : `<input class="ob2-input" id="obf-${field.id}" type="${
              field.type === "number" ? "number" : "text"
            }" inputmode="${field.type === "number" ? "decimal" : "text"}" placeholder="${
              obEscape(field.placeholder || "")
            }" value="${value}" autocomplete="off">`;
    return `<div class="ob2-field${field.half ? " half" : ""}">${label}${input}</div>`;
  }

  if (field.type === "textarea") {
    const value = obData[field.id] != null ? obEscape(obData[field.id]) : "";
    return `<div class="ob2-field">${label}<textarea class="ob2-input" id="obf-${field.id}" placeholder="${obEscape(field.placeholder || "")}">${value}</textarea></div>`;
  }

  if (field.type === "chips" || field.type === "multichips") {
    const selected = obData[field.id];
    const chips = field.options.map(opt => {
      const isSel =
        field.type === "multichips"
          ? Array.isArray(selected) && selected.includes(opt.value)
          : selected != null && String(selected) === String(opt.value);
      return `<button type="button" class="ob2-chip${isSel ? " sel" : ""}" data-field="${field.id}" data-value="${obEscape(opt.value)}" data-multi="${field.type === "multichips" ? "1" : "0"}"${opt.exclusive ? ' data-exclusive="1"' : ""}>${obEscape(opt.label)}</button>`;
    }).join("");
    return `<div class="ob2-field">${label}<div class="ob2-chips">${chips}</div></div>`;
  }

  if (field.type === "days") {
    const selected = obData[field.id];
    const cells = WEEK_DAYS.map(day => {
      const isSel = selected === day;
      return `<button type="button" class="ob2-day${isSel ? " sel" : ""}" data-field="${field.id}" data-value="${obEscape(day)}" data-day="1" title="${obEscape(day)}">${obEscape(day.slice(0, 3))}</button>`;
    }).join("");
    return `<div class="ob2-field">${label}<div class="ob2-days">${cells}</div></div>`;
  }

  return "";
}

function obGroupFields(fields) {
  // Pair consecutive "half" fields into a single row for a tighter grid.
  const out = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    const next = fields[i + 1];
    if (f.half && next && next.half) {
      out.push(
        `<div class="ob2-row">${obRenderField(f)}${obRenderField(next)}</div>`
      );
      i += 2;
    } else {
      out.push(obRenderField(f));
      i += 1;
    }
  }
  return out.join("");
}

/*
 * Conditional fields. A field with `showWhen: { distance: "Other" }` only
 * renders once that answer is chosen, so the form never shows an input that
 * makes no sense yet.
 */
/* Metric / Imperial switch. Purely an input preference — storage is metric. */
function obRenderUnitToggle() {
  const u = obUnits();
  return `
    <div class="ob2-units" role="group" aria-label="Units">
      <button type="button" class="ob2-unit${u === "metric" ? " on" : ""}"
        onclick="AthlevoOnboarding.setUnits('metric')">Metric</button>
      <button type="button" class="ob2-unit${u === "imperial" ? " on" : ""}"
        onclick="AthlevoOnboarding.setUnits('imperial')">Imperial</button>
    </div>`;
}

function obVisibleFields(fields) {
  return (fields || []).filter(f => {
    if (!f.showWhen) return true;
    return Object.keys(f.showWhen).every(k => obData[k] === f.showWhen[k]);
  });
}

function obRenderStep() {
  const step = OB_STEPS[obStepIndex];
  const body = document.getElementById("ob2Body");
  if (!step || !body) return;

  body.innerHTML = `
    <div class="ob2-step">
      <span class="ob2-eyebrow">${obEscape(step.eyebrow)}</span>
      <h2 class="ob2-title">${obEscape(step.title)}</h2>
      <p class="ob2-sub">${obEscape(step.sub)}</p>
      ${step.unitToggle ? obRenderUnitToggle() : ""}
      ${obGroupFields(obVisibleFields(step.fields))}
    </div>
  `;
  body.scrollTop = 0;

  // Progress + chrome.
  const fill = document.getElementById("ob2ProgressFill");
  if (fill) fill.style.width = `${((obStepIndex + 1) / OB_STEPS.length) * 100}%`;

  const count = document.getElementById("ob2Count");
  if (count) count.innerHTML = `${obStepIndex + 1}&nbsp;/&nbsp;${OB_STEPS.length}`;

  const back = document.getElementById("ob2Back");
  if (back) back.disabled = obStepIndex === 0;

  const cont = document.getElementById("ob2Continue");
  if (cont) {
    const last = obStepIndex === OB_STEPS.length - 1;
    cont.textContent = last ? "Finish setup" : "Continue";
    cont.classList.toggle("done", last);
  }

  obMessage("");
  obWireStep();
}

/* Chip / day tap handling (writes straight into obData). */
function obWireStep() {
  const body = document.getElementById("ob2Body");
  if (!body) return;

  body.querySelectorAll("[data-field]").forEach(el => {
    if (!el.dataset || (!el.dataset.value && el.dataset.value !== "0")) return;
    if (el.tagName !== "BUTTON") return;

    el.addEventListener("click", () => {
      const fieldId = el.dataset.field;
      const raw = el.dataset.value;

      // Days: single select toggle.
      if (el.dataset.day === "1") {
        obData[fieldId] = obData[fieldId] === raw ? null : raw;
        obRefreshSelections(fieldId);
        return;
      }

      // Multi-select chips (devices) with an exclusive "None".
      if (el.dataset.multi === "1") {
        const cur = Array.isArray(obData[fieldId]) ? obData[fieldId].slice() : [];
        if (el.dataset.exclusive === "1") {
          obData[fieldId] = cur.includes(raw) ? [] : [raw];
        } else {
          const withoutExclusive = cur.filter(v => v !== "None");
          obData[fieldId] = withoutExclusive.includes(raw)
            ? withoutExclusive.filter(v => v !== raw)
            : withoutExclusive.concat(raw);
        }
        obRefreshSelections(fieldId);
        return;
      }

      // Single-select chips — coerce numeric option values back to number.
      const opt = obFindOption(fieldId, raw);
      obData[fieldId] = opt ? opt.value : raw;
      obRefreshSelections(fieldId);
    });
  });
}

function obFindOption(fieldId, rawValue) {
  const step = OB_STEPS[obStepIndex];
  const field = step.fields.find(f => f.id === fieldId);
  if (!field || !field.options) return null;
  return field.options.find(o => String(o.value) === String(rawValue)) || null;
}

// Re-paint only the selected state for one field (no full re-render, so
// text inputs keep focus / caret while chips update instantly).
function obRefreshSelections(fieldId) {
  const body = document.getElementById("ob2Body");
  if (!body) return;
  const value = obData[fieldId];
  body.querySelectorAll(`[data-field="${fieldId}"]`).forEach(el => {
    const raw = el.dataset.value;
    let on;
    if (Array.isArray(value)) on = value.map(String).includes(raw);
    else on = value != null && String(value) === raw;
    el.classList.toggle("sel", on);
  });
}

/* Pull the current step's text/number/date inputs into obData. */
function obCollectInputs() {
  const step = OB_STEPS[obStepIndex];
  step.fields.forEach(field => {
    if (["text", "number", "date", "textarea"].includes(field.type)) {
      const el = document.getElementById(`obf-${field.id}`);
      if (el) obData[field.id] = el.value;
    }
  });
}

/* ─────────────────────────── validation ─────────────────────────────── */

function obValidateStep() {
  const step = OB_STEPS[obStepIndex];

  for (const field of step.fields) {
    const value = obData[field.id];

    if (field.required) {
      const empty =
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty) {
        return `Please complete "${field.label}" to continue.`;
      }
    }

    if (field.type === "number" && value !== "" && value != null) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        return `Please enter a valid number for "${field.label}".`;
      }
      if (field.min != null && n < field.min) {
        return `"${field.label}" should be at least ${field.min}.`;
      }
      if (field.max != null && n > field.max) {
        return `"${field.label}" should be ${field.max} or less.`;
      }
    }
  }
  return null;
}

/* ─────────────────────────── persistence ────────────────────────────── */

async function obSaveProgress(complete) {
  const user = await obUser();
  const updates = obBuildUpdates();

  updates.onboarding_step = complete ? OB_STEPS.length : obStepIndex + 1;
  updates.updated_at = new Date().toISOString();
  if (complete) updates.onboarding_complete = true;

  const { data, error } = await supabaseClient
    .from("profiles")
    .update(updates)
    .eq("id", user.id)
    .select()
    .single();

  if (error) throw error;
  obProfile = data;
  return data;
}

/* ─────────────────────────── navigation ─────────────────────────────── */

async function obContinue() {
  if (obBusy) return;

  obCollectInputs();

  const problem = obValidateStep();
  if (problem) {
    obMessage(problem);
    return;
  }

  obBusy = true;
  const cont = document.getElementById("ob2Continue");
  const lastStep = obStepIndex === OB_STEPS.length - 1;
  if (cont) {
    cont.disabled = true;
    cont.textContent = lastStep ? "Finishing…" : "Saving…";
  }

  try {
    await obSaveProgress(lastStep);

    if (lastStep) {
      await obFinish();
      return;
    }

    obStepIndex += 1;
    obRenderStep();
  } catch (error) {
    console.error("Could not save onboarding step:", error);
    obMessage("Couldn't save that — check your connection and try again.");
    if (cont) {
      cont.textContent = lastStep ? "Finish setup" : "Continue";
    }
  } finally {
    obBusy = false;
    const c = document.getElementById("ob2Continue");
    if (c) c.disabled = false;
  }
}

function obBack() {
  if (obBusy || obStepIndex === 0) return;
  obCollectInputs();
  obStepIndex -= 1;
  obRenderStep();
}

/*
 * Parse a finish time typed as "mm:ss", "h:mm:ss", or a plain number of
 * minutes into total seconds. Returns null if it can't be understood.
 */
function obParseRaceTime(raw) {
  const text = obClean(raw);
  if (!text) return null;

  if (text.includes(":")) {
    const parts = text.split(":").map(p => Number(p.trim()));
    if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    let seconds = 0;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
    else return null;
    return seconds > 0 ? Math.round(seconds) : null;
  }

  const minutes = Number(text);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null;
}

/*
 * If the athlete gave a recent race in the (optional) performance step,
 * write it as a race_results row (source = 'onboarding'). Stores ONLY raw
 * inputs — VDOT and everything derived is recomputed on demand. Idempotent:
 * replaces any prior onboarding race so re-running onboarding never
 * duplicates. Never throws — a bad/missing entry simply writes nothing.
 */
async function obWriteOnboardingRace() {
  try {
    const d = obData;

    const meters =
      d.recentDistKm != null && d.recentDistKm !== ""
        ? Number(d.recentDistKm) * 1000
        : Number(d.recentDist);
    const seconds = obParseRaceTime(d.recentTime);

    // Need both a distance and a time to be a usable result.
    if (!Number.isFinite(meters) || meters < 400 || !seconds) return;

    const user = await obUser();

    // Replace any previous onboarding race (keep a single one).
    await supabaseClient
      .from("race_results")
      .delete()
      .eq("user_id", user.id)
      .eq("source", "onboarding");

    await supabaseClient.from("race_results").insert({
      user_id: user.id,
      source: "onboarding",
      activity_id: null,
      race_type: d.recentType || "training_effort",
      distance_meters: Math.round(meters * 100) / 100,
      duration_seconds: seconds,
      race_date: obClean(d.recentDate) || null
    });
  } catch (error) {
    // race_results table may not exist yet, or the entry was incomplete —
    // never block onboarding completion on it.
    console.warn("Onboarding race not saved:", error?.message || error);
  }
}

async function obFinish() {
  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.style.display = "flex";

  // Persist the optional recent race BEFORE refreshing, so the Athlevo
  // Score card reflects it immediately.
  await obWriteOnboardingRace();

  try {
    await AthlevoBrain.refreshAthleteUI();
  } catch (error) {
    console.error("Could not refresh athlete UI after onboarding:", error);
  }

  if (window.AthlevoAnalytics) window.AthlevoAnalytics.track("profile_completed");

  /*
   * The athlete profile is done; now bring in their training. Athlevo cannot
   * personalize coaching without real workouts, so the guided connect flow is
   * the next step rather than an optional card — it educates, connects,
   * detects and imports automatically.
   */
  if (window.AthlevoConnect && typeof window.AthlevoConnect.start === "function") {
    try { await window.AthlevoConnect.start(); return; }
    catch (e) { console.warn("Guided setup could not start:", e); }
  }

  // Fallbacks, unchanged, if the guided flow is unavailable for any reason.
  if (window.AthlevoPlan && typeof window.AthlevoPlan.maybeLaunchAfterOnboarding === "function") {
    try { await window.AthlevoPlan.maybeLaunchAfterOnboarding(); return; }
    catch (e) { console.warn("Plan setup launch failed:", e); }
  }
  showScreen("screen-today");
}

/* Find the first step still missing a required answer (post-prefill). */
function obFirstIncompleteStep() {
  for (let i = 0; i < OB_STEPS.length; i += 1) {
    const missing = OB_STEPS[i].fields.some(field => {
      if (!field.required) return false;
      const v = obData[field.id];
      return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    });
    if (missing) return i;
  }
  return 0;
}

/* ─────────────────────────── profile loading ────────────────────────── */

async function obLoadProfile() {
  const user = await obUser();

  // Read the athlete's own row, retrying transient failures a few times.
  // A permission (RLS) error is permanent and reported as such.
  let lastReadError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (!error) {
      if (data) return data;
      break; // No row yet → fall through to idempotent creation.
    }
    if (obIsPermissionError(error)) {
      const e = new Error("PROFILE_RLS");
      e.code = "PROFILE_RLS";
      e.detail = error.message;
      throw e;
    }
    lastReadError = error;
    await obSleep(250 * (attempt + 1));
  }
  if (lastReadError) {
    const e = new Error("PROFILE_READ");
    e.code = "PROFILE_READ";
    throw e;
  }

  // No row exists → create the minimum row ONCE. A plain insert (not upsert)
  // so an existing profile is never overwritten; a duplicate-key race is
  // resolved by re-reading the row that now exists (idempotent, no dupes).
  const { data: created, error: createError } = await supabaseClient
    .from("profiles")
    .insert({
      id: user.id,
      email: user.email,
      full_name: user.user_metadata?.full_name || "",
      onboarding_complete: false,
      onboarding_step: 0
    })
    .select()
    .single();

  if (!createError) return created;

  if (obIsDuplicateError(createError)) {
    const { data: after } = await supabaseClient
      .from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (after) return after;
  }
  if (obIsPermissionError(createError)) {
    const e = new Error("PROFILE_RLS");
    e.code = "PROFILE_RLS";
    e.detail = createError.message;
    throw e;
  }
  const e = new Error("PROFILE_CREATE");
  e.code = "PROFILE_CREATE";
  throw e;
}

/* Renders a clear, actionable error in place of the "Loading…" spinner —
   never an indefinite spinner, and the Continue button can't bypass it. */
function obProfileErrorReason(code, embedded) {
  if (code === "NO_SESSION") {
    return embedded
      ? "Your sign-in didn't carry over in this in-app browser. Open Athlevo in Safari or Chrome, then log in."
      : "We couldn't confirm your sign-in. Please log in again.";
  }
  if (code === "PROFILE_RLS") {
    return "We couldn't access your athlete profile. Please log in again — if this keeps happening, contact the Athlevo team.";
  }
  return "We couldn't reach the server. Check your connection and try again.";
}

function obRenderProfileError(code) {
  const body = document.getElementById("ob2Body");
  if (!body) return;
  const embedded = !!(window.AthlevoEnv && window.AthlevoEnv.shouldWarn && window.AthlevoEnv.shouldWarn());

  body.innerHTML = `
    <div class="ob2-step">
      <span class="ob2-eyebrow">Athlete profile</span>
      <h2 class="ob2-title">Couldn't load your profile</h2>
      <p class="ob2-sub">${obEscape(obProfileErrorReason(code, embedded))}</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:22px">
        ${embedded ? '<button class="ob2-continue done" id="obErrBrowser" type="button">Open in Safari or Chrome</button>' : ''}
        <button class="ob2-continue" id="obErrRetry" type="button">Try again</button>
        <button id="obErrLogin" type="button" style="background:none;border:none;color:var(--ink3);font-size:13px;font-weight:700;cursor:pointer;padding:10px">Log in again</button>
      </div>
    </div>`;

  const retry = body.querySelector("#obErrRetry");
  if (retry) retry.addEventListener("click", () => startAthlevoOnboarding());
  const login = body.querySelector("#obErrLogin");
  if (login) login.addEventListener("click", obLogInAgain);
  const browser = body.querySelector("#obErrBrowser");
  if (browser && window.AthlevoEnv) browser.addEventListener("click", () => window.AthlevoEnv.showNotice({ context: "signup" }));
}

async function obLogInAgain() {
  try { await supabaseClient.auth.signOut(); } catch (error) { /* ignore */ }
  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.style.display = "none";
  if (typeof showScreen === "function") showScreen("screen-welcome");
  if (typeof window.openLogin === "function") window.openLogin();
}

async function startAthlevoOnboarding() {
  showScreen("screen-onboard");
  obMessage("");

  const body = document.getElementById("ob2Body");
  if (body) {
    body.innerHTML =
      `<div class="ob2-step"><p class="ob2-sub">Loading your profile…</p></div>`;
  }

  try {
    obProfile = await obLoadProfile();

    if (obProfile.onboarding_complete) {
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "flex";
      await AthlevoBrain.refreshAthleteUI();
      showScreen("screen-today");
      return;
    }

    obData = obPrefillFromProfile(obProfile);
    obStepIndex = obFirstIncompleteStep();
    obRenderStep();
  } catch (error) {
    // Log the safe internal code only — never tokens, email, or RLS details.
    const code = (error && error.code) ? error.code : "PROFILE_READ";
    console.warn("Onboarding profile load failed:", code);
    obRenderProfileError(code);
  }
}

/* ─────────────────────────── wiring ─────────────────────────────────── */

function setupOnboardingInterface() {
  const cont = document.getElementById("ob2Continue");
  const back = document.getElementById("ob2Back");
  if (cont) cont.addEventListener("click", obContinue);
  if (back) back.addEventListener("click", obBack);
}

window.startOnboarding = startAthlevoOnboarding;
window.startAthlevoOnboarding = startAthlevoOnboarding;
window.AthlevoOnboarding = { setUnits: obSetUnits, units: obUnits,
  normalizeDistance: obNormalizeDistance, convert: OB_CONVERT };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupOnboardingInterface);
} else {
  setupOnboardingInterface();
}

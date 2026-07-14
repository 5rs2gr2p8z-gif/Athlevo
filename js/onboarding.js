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
    fields: [
      {
        id: "height", type: "number", label: "Height", unit: "cm",
        min: 100, max: 250, required: true, placeholder: "175", half: true
      },
      {
        id: "weight", type: "number", label: "Weight", unit: "kg",
        min: 25, max: 300, required: true, placeholder: "68", half: true
      }
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
          { label: "General fitness", value: "General fitness" }
        ]
      },
      { id: "race", type: "text", label: "Goal race or event", optional: true,
        placeholder: "e.g. Chicago Marathon" },
      { id: "date", type: "date", label: "Race date", optional: true },
      { id: "time", type: "text", label: "Goal finish time", optional: true,
        placeholder: "e.g. sub-4:00" }
    ]
  },
  {
    key: "schedule",
    eyebrow: "Step 5 · Training schedule",
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
    eyebrow: "Step 6 · Your setup",
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

async function obUser() {
  const {
    data: { user },
    error
  } = await supabaseClient.auth.getUser();
  if (error) throw error;
  if (!user) throw new Error("You must be logged in to continue.");
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
  if (profile.height != null) d.height = String(profile.height);
  if (profile.weight != null) d.weight = String(profile.weight);
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
    if (g) d.distance = g;
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

  if (d.height != null && d.height !== "") updates.height = num(d.height);
  if (d.weight != null && d.weight !== "") updates.weight = num(d.weight);

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

function obRenderField(field) {
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

function obRenderStep() {
  const step = OB_STEPS[obStepIndex];
  const body = document.getElementById("ob2Body");
  if (!step || !body) return;

  body.innerHTML = `
    <div class="ob2-step">
      <span class="ob2-eyebrow">${obEscape(step.eyebrow)}</span>
      <h2 class="ob2-title">${obEscape(step.title)}</h2>
      <p class="ob2-sub">${obEscape(step.sub)}</p>
      ${obGroupFields(step.fields)}
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

async function obFinish() {
  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.style.display = "flex";

  try {
    await AthlevoBrain.refreshAthleteUI();
  } catch (error) {
    console.error("Could not refresh athlete UI after onboarding:", error);
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

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

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

  if (createError) throw createError;
  return created;
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
    console.error("Could not start onboarding:", error);
    obMessage("Couldn't load your profile. Please refresh and try again.");
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupOnboardingInterface);
} else {
  setupOnboardingInterface();
}

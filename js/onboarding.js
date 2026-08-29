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

/* ─────────────────── role-selection (athlete vs coach) ─────────────── */

/*
 * The very first onboarding screen asks "What brings you to Athlevo?"
 * with two cards: Athlete and Coach.
 *
 * SECURITY: this is a client-side INTENT indicator only.
 *  · Selecting "I'm a coach" does NOT set profiles.role.
 *  · It does NOT unlock Coach Workspace.
 *  · It does NOT grant any server-side permissions.
 *  · The server-authoritative role (profiles.role) is unchanged.
 *  · Coach access requires admin approval via a separate reviewed path.
 *
 * Intent is stored in sessionStorage (transient — clears on tab close
 * and explicit logout). Never in localStorage or profiles.
 */
const OB_ROLE_KEY = "athlevo_onboarding_intent";

/*
 * Public-release availability gate. This controls only whether an ordinary
 * user may start the coach-application onboarding path. It never grants
 * Coach Workspace access; that remains tied to the server-owned profile role.
 * Flip this single value when public coach applications are ready to reopen.
 */
const COACH_PUBLIC_ACCESS_ENABLED = false;

function obCoachPublicAccessEnabled() {
  return COACH_PUBLIC_ACCESS_ENABLED === true;
}

function obReadIntent() {
  try { return sessionStorage.getItem(OB_ROLE_KEY) || null; } catch (e) { return null; }
}
function obWriteIntent(intent) {
  try { sessionStorage.setItem(OB_ROLE_KEY, intent); } catch (e) {}
}
function obClearIntent() {
  try { sessionStorage.removeItem(OB_ROLE_KEY); } catch (e) {}
}

/* ─── Current flow flag (athlete | coach) ─── */
let _obCurrentFlow = "athlete";

/* ─── Coach onboarding step definitions ─── */

const COACH_OB_STEPS = [
  {
    key: "coach_name",
    eyebrow: "Step 1 · About you",
    title: "Tell us about yourself",
    sub: "The basics for your coaching profile.",
    fields: [
      { id: "coachName", type: "text", label: "Full name",
        placeholder: "e.g. Jane Smith", required: true }
    ]
  },
  {
    key: "coach_brand",
    eyebrow: "Step 2 · Your coaching",
    title: "Your coaching practice",
    sub: "Help us understand your coaching background.",
    fields: [
      { id: "coachBrand", type: "text", label: "Coaching brand or business name",
        optional: true, placeholder: "e.g. Smith Endurance Coaching" },
      {
        id: "coachSports", type: "multichips",
        label: "Primary coaching sports", required: true,
        options: [
          { label: "Running",   value: "Running" },
          { label: "Cycling",   value: "Cycling" },
          { label: "Triathlon", value: "Triathlon" },
          { label: "Strength",  value: "Strength" },
          { label: "Other",     value: "Other" }
        ]
      },
      {
        id: "coachExperience", type: "chips",
        label: "Coaching experience", required: true,
        options: [
          { label: "New coach",       value: "new" },
          { label: "Under 2 years",   value: "under_2" },
          { label: "2–5 years",       value: "2_5" },
          { label: "5+ years",        value: "5_plus" }
        ]
      }
    ]
  },
  {
    key: "coach_setup",
    eyebrow: "Step 3 · Your setup",
    title: "How you coach",
    sub: "So we can tailor Athlevo to your workflow.",
    fields: [
      {
        id: "coachAthleteCount", type: "chips",
        label: "Approximate current athlete count", required: true,
        options: [
          { label: "0",     value: "0" },
          { label: "1–5",   value: "1_5" },
          { label: "6–15",  value: "6_15" },
          { label: "16–30", value: "16_30" },
          { label: "31+",   value: "31_plus" }
        ]
      },
      {
        id: "coachSetup", type: "chips",
        label: "Preferred coaching setup", required: true,
        options: [
          { label: "Online",    value: "online" },
          { label: "In person", value: "in_person" },
          { label: "Hybrid",    value: "hybrid" }
        ]
      }
    ]
  }
];

let coachObStepIndex = 0;
let coachObData = {};

/* ─────────────────────────── step definitions ───────────────────────── */

const WEEK_DAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday"
];

/*
 * ── Onboarding v3 — phase / screen model ──────────────────────────────
 *
 * v2 grouped ~24 questions into six dense steps. v3 keeps EVERY field and the
 * exact same field specs (so obBuildUpdates / obPrefillFromProfile / validation
 * and every profile column are untouched) but re-organises them into a
 * one-primary-question-per-screen flow across five phases. Only genuinely
 * paired, low-friction fields share a screen. Nothing about the data model,
 * persistence, or resume semantics changes — this is a presentation refactor.
 *
 * Four INPUT phases drive the milestone progress; the fifth ("payoff") is the
 * reward and is rendered separately, so the athlete always sees a finite path.
 */
const OB_PHASES = [
  { key: "identity", label: "Goal" },
  { key: "ability",  label: "Ability" },
  { key: "reality",  label: "Schedule" },
  { key: "personal", label: "You" }
];

/* Field specs — identical ids/types/options/validation to v2. */
const F = {
  name:    { id: "name", type: "text", label: "Your name", placeholder: "e.g. Dean", required: true },
  age:     { id: "age", type: "number", label: "Age", unit: "yrs", min: 13, max: 100, integer: true, required: true, placeholder: "28", half: true },
  sex:     { id: "sex", type: "chips", label: "Sex", required: true,
             options: [{ label: "Male", value: "Male" }, { label: "Female", value: "Female" }] },
  location:{ id: "location", type: "text", label: "Where you train", optional: true,
             placeholder: "City, country — helps with climate" },
  height:  { id: "height", type: "number", label: "Height", unitKey: "height", required: true, half: true },
  weight:  { id: "weight", type: "number", label: "Weight", unitKey: "weight", required: true, half: true },
  experience: { id: "experience", bare: true, type: "chips", label: "Running experience", required: true, layout: "cards",
             options: [
               { label: "New to running", value: 0 },
               { label: "1–2 years", value: 1 },
               { label: "3–5 years", value: 4 },
               { label: "5+ years", value: 8 }
             ] },
  mileage: { id: "mileage", type: "number", label: "Current weekly mileage", unit: "km",
             min: 0, max: 1000, required: true, placeholder: "40", half: true },
  hours:   { id: "hours", type: "number", label: "Weekly training hours", unit: "hrs",
             min: 0, max: 100, optional: true, placeholder: "5", half: true },
  status:  { id: "status", bare: true, type: "chips", label: "Current training status", required: true, layout: "cards",
             options: [
               { label: "Just starting", value: "Just starting" },
               { label: "Building base", value: "Building base" },
               { label: "In a training block", value: "In a training block" },
               { label: "Returning from a break", value: "Returning from a break" },
               { label: "Maintaining fitness", value: "Maintaining fitness" }
             ] },
  injuries:{ id: "injuries", type: "text", label: "Injuries or recurring niggles", optional: true,
             placeholder: "Anything nagging? Leave blank if none" },
  distance:{ id: "distance", bare: true, type: "chips", label: "Goal distance", required: true, layout: "cards",
             options: [
               { label: "5K", value: "5K" },
               { label: "10K", value: "10K" },
               { label: "Half marathon", value: "Half marathon" },
               { label: "Marathon", value: "Marathon" },
               { label: "Ultra", value: "Ultra" },
               { label: "General fitness", value: "General fitness" },
               { label: "Other", value: "Other" }
             ] },
  /*
   * Shown only when "Other" is chosen. Plenty of real goals aren't on a
   * six-item list — 1 mile, 10 mile, 15K, 50K, a local trail race — and
   * forcing those athletes to pick a wrong answer corrupts their plan.
   */
  customDistance: { id: "customDistance", type: "text", label: "Your distance", optional: true,
             placeholder: "e.g. 10 miles, 15 km, 50 km", showWhen: { distance: "Other" } },
  race:    { id: "race", type: "text", label: "Goal race or event", optional: true,
             placeholder: "e.g. Chicago Marathon" },
  date:    { id: "date", type: "date", label: "Race date", optional: true },
  time:    { id: "time", type: "text", label: "Goal finish time", optional: true,
             placeholder: "e.g. sub-4:00" },
  recentDist: { id: "recentDist", type: "chips", label: "Recent race distance", optional: true,
             options: [
               { label: "5K", value: 5000 },
               { label: "10K", value: 10000 },
               { label: "Half", value: 21097.5 },
               { label: "Marathon", value: 42195 }
             ] },
  recentDistKm: { id: "recentDistKm", type: "number", label: "Other distance", unit: "km",
             min: 0.4, max: 500, optional: true, placeholder: "e.g. 15", half: true },
  recentTime: { id: "recentTime", type: "text", label: "Finish time", optional: true,
             placeholder: "e.g. 22:30 or 1:45:00", half: true },
  recentDate: { id: "recentDate", type: "date", label: "Date of race", optional: true },
  recentType: { id: "recentType", type: "chips", label: "Race type", optional: true,
             options: [
               { label: "Official race", value: "official" },
               { label: "Time trial", value: "time_trial" },
               { label: "Training effort", value: "training_effort" }
             ] },
  days:    { id: "days", bare: true, type: "chips", label: "Days you can train each week", required: true,
             options: [1, 2, 3, 4, 5, 6, 7].map(n => ({ label: String(n), value: n })) },
  longRun: { id: "longRun", bare: true, type: "days", label: "Preferred long run day", required: true },
  trainTime: { id: "trainTime", type: "chips", label: "Preferred training time", required: true,
             options: [
               { label: "Early morning", value: "Early morning" },
               { label: "Midday", value: "Midday" },
               { label: "After work", value: "After work" },
               { label: "Evening", value: "Evening" },
               { label: "Varies", value: "Varies" }
             ] },
  schedule:{ id: "schedule", type: "text", label: "Work or study schedule", optional: true,
             placeholder: "Shift work, long commute, etc." },
  devices: { id: "devices", type: "multichips", label: "What do you use to track?", required: true,
             options: [
               { label: "Garmin", value: "Garmin" },
               { label: "COROS", value: "COROS" },
               { label: "Apple Watch", value: "Apple Watch" },
               { label: "Strava", value: "Strava" },
               { label: "TrainingPeaks", value: "TrainingPeaks" },
               { label: "Other", value: "Other" },
               { label: "None", value: "None", exclusive: true }
             ] },
  diet:    { id: "diet", type: "text", label: "Diet, allergies or fuelling needs", optional: true,
             placeholder: "e.g. vegetarian, lactose intolerant" },
  notes:   { id: "notes", type: "textarea", label: "Anything else your coach should know", optional: true,
             placeholder: "Motivation, health context, responsibilities…" }
};

/*
 * The v3 screen list. `autoAdvance` marks a single-choice screen that moves on
 * by itself once answered (never on multi-select or grouped-review screens, and
 * never when the answer opens a conditional field). `insightAfter` attaches a
 * short, skippable "Athlevo is learning" beat shown after the screen.
 */
const OB_SCREENS = [
  // ── Phase 1 · Athlete identity ──
  { key: "goal", phase: "identity",
    eyebrow: "Your goal",
    title: "What are you training for?",
    sub: "Pick the distance you want to build toward.",
    fields: [F.distance, F.customDistance], autoAdvance: true },
  { key: "race", phase: "identity",
    eyebrow: "Your goal",
    title: "Have a race in mind?",
    sub: "Optional — a date and target sharpen your plan.",
    fields: [F.race, F.date, F.time] },
  { key: "experience", phase: "identity",
    eyebrow: "Your background",
    title: "How long have you been running?",
    sub: "This sets how quickly Athlevo builds you up.",
    fields: [F.experience], autoAdvance: true },
  { key: "status", phase: "identity",
    eyebrow: "Your background",
    title: "Where's your training right now?",
    sub: "So we meet you exactly where you are.",
    fields: [F.status], autoAdvance: true },

  // ── Phase 2 · Current ability ──
  { key: "basics", phase: "ability",
    eyebrow: "About you",
    title: "The basics",
    sub: "A few details so your coaching is truly yours.",
    fields: [F.name, F.age, F.sex, F.location] },
  { key: "body", phase: "ability",
    eyebrow: "About you",
    title: "Your body metrics",
    sub: "Used to personalise pacing, fuelling and load.",
    unitToggle: true,
    fields: [F.height, F.weight] },
  { key: "volume", phase: "ability",
    eyebrow: "Current ability",
    title: "How much are you running now?",
    sub: "Your current week — roughly is fine.",
    fields: [F.mileage, F.hours],
    insightAfter: "Your recent mileage helps Athlevo set a safe starting load and avoid progressing too aggressively." },
  { key: "recent", phase: "ability",
    eyebrow: "Current ability",
    title: "Your latest result",
    sub: "A recent race sets your starting fitness — skip it if you don't have one.",
    fields: [F.recentDist, F.recentDistKm, F.recentTime, F.recentDate, F.recentType] },

  // ── Phase 3 · Training reality ──
  { key: "days", phase: "reality",
    eyebrow: "Your week",
    title: "How many days can you train?",
    sub: "Be honest — consistency beats ambition.",
    fields: [F.days], autoAdvance: true },
  { key: "longRun", phase: "reality",
    eyebrow: "Your week",
    title: "Where does your long run fit best?",
    sub: "The anchor of your training week.",
    fields: [F.longRun] },
  { key: "when", phase: "reality",
    eyebrow: "Your week",
    title: "When do you usually train?",
    sub: "And what you use to track it.",
    fields: [F.trainTime, F.schedule, F.devices],
    insightAfter: "Your schedule shapes how Athlevo places quality sessions and recovery days." },

  // ── Phase 4 · Personalization ──
  { key: "personal", phase: "personal",
    eyebrow: "Personalise",
    title: "Anything Athlevo should know?",
    sub: "All optional — it helps tailor your plan and keep you healthy.",
    fields: [F.injuries, F.diet, F.notes] }
];

/* ───────────────────────────── state ────────────────────────────────── */

let obStepIndex = 0;
let obData = {};          // { fieldId: value }
let obProfile = null;
let obBusy = false;

function obFailureCategory(error) {
  const value = String(error && (error.code || error.name || error.message) || "")
    .toLowerCase();
  if (/rls|permission|forbidden/.test(value)) return "permission";
  if (/no_session|auth|session/.test(value)) return "auth";
  if (/timeout|abort/.test(value)) return "timeout";
  if (/network|fetch|profile_read/.test(value)) return "network";
  if (/validation|required/.test(value)) return "validation";
  return "server";
}

function obTrackFailure(stage, error) {
  const props = {
    stage,
    failure_category: obFailureCategory(error),
    source_surface: "onboarding"
  };
  try {
    if (window.AthlevoProductAnalytics) {
      AthlevoProductAnalytics.trackAthlevoEvent(
        "onboarding_failed",
        props
      );
    }
  } catch (e) {}
  try {
    if (window.AthlevoAnalytics) {
      AthlevoAnalytics.track("onboarding_failed", props);
    }
  } catch (e) {}
}

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
  // Single-question screens set `bare` so the field label doesn't repeat the
  // headline — typography carries the hierarchy instead of a boxed label.
  const label = field.bare
    ? ""
    : `<label class="ob2-label" for="obf-${field.id}">${obEscape(field.label)}${optTag}</label>`;

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

  // Large stacked answer cards for high-impact single-choice screens.
  if (field.type === "chips" && field.layout === "cards") {
    const selected = obData[field.id];
    const cards = field.options.map(opt => {
      const isSel = selected != null && String(selected) === String(opt.value);
      return `<button type="button" class="ob2-card${isSel ? " sel" : ""}" data-field="${field.id}" data-value="${obEscape(opt.value)}" data-multi="0">` +
        `<span class="ob2-card-label">${obEscape(opt.label)}</span>` +
        `<span class="ob2-card-tick" aria-hidden="true"></span></button>`;
    }).join("");
    return `<div class="ob2-field">${label}<div class="ob2-cards-choice">${cards}</div></div>`;
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

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Motion layer — built on the SAME WAAPI + pointer primitives proven in
 *  js/sheet.js (interruptible animation, presentation-state reads, pointer
 *  velocity, projection, edge resistance). No new dependency. Every screen
 *  transition and the swipe gesture are interruptible and never lock input.
 * ══════════════════════════════════════════════════════════════════════
 */

let obMode = "screen";          // "screen" | "role" | "coach" | "insight" | "payoff"
let obTransition = null;        // { anims:[...], outgoing, incoming } — active screen transition
let obAdvanceTimer = null;      // pending auto-advance timer
let obInsightTimer = null;      // pending insight dwell timer

const OB_EASE = "cubic-bezier(.2,.7,.2,1)";      // matches --ease-standard
const OB_EASE_OUT = "cubic-bezier(.22,.8,.28,1)"; // decelerating settle

function obReducedMotion() {
  return Boolean(window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function obCanAnimate(el) {
  return !obReducedMotion() && el && typeof el.animate === "function";
}

// Read the element's ACTUAL on-screen X (presentation state), so an
// interrupted/retargeted animation continues from where it really is.
function obPresentationX(el) {
  if (!el || !window.getComputedStyle) return 0;
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  if (window.DOMMatrixReadOnly) {
    try { return new DOMMatrixReadOnly(t).m41 || 0; } catch (e) {}
  }
  const m = t.match(/matrix\(([^)]+)\)/);
  if (m) return Number(m[1].split(",")[4]) || 0;
  const m3 = t.match(/matrix3d\(([^)]+)\)/);
  if (m3) return Number(m3[1].split(",")[12]) || 0;
  return 0;
}

// Velocity projection (UIScrollView-style) — where a flick is headed.
function obProject(velocity, decel) {
  decel = decel == null ? 0.99 : decel;
  return (velocity / 1000) * decel / (1 - decel);
}

// Progressive rubber-band for dragging past a boundary — asymptotic, so the
// UI reads "responsive, but there's no more content" rather than "frozen".
function obRubber(delta, dim) {
  const d = Math.abs(delta);
  const max = Math.max(1, dim) * 0.55;
  const damped = max * (1 - Math.exp(-d / Math.max(1, dim)));
  return delta < 0 ? -damped : damped;
}

/* ─────────────────────────── field rendering ────────────────────────── */

function obStepHTML(index) {
  const screen = OB_SCREENS[index];
  return `<div class="ob2-step" data-screen="${obEscape(screen.key)}">
      <span class="ob2-eyebrow">${obEscape(screen.eyebrow)}</span>
      <h2 class="ob2-title">${obEscape(screen.title)}</h2>
      <p class="ob2-sub">${obEscape(screen.sub)}</p>
      ${screen.unitToggle ? obRenderUnitToggle() : ""}
      ${obGroupFields(obVisibleFields(screen.fields))}
    </div>`;
}

function obBuildStepEl(index) {
  const tpl = document.createElement("template");
  tpl.innerHTML = obStepHTML(index).trim();
  return tpl.content.firstElementChild;
}

/*
 * One thin continuous progress line — deliberately understated so it recedes
 * while the athlete reads the question. A single fill grows via scaleX, easing
 * from its current value, so it never jumps between states.
 */
function obSetProgress(fraction) {
  const container = document.getElementById("ob2Progress");
  if (!container) return;
  let fill = container.firstElementChild;
  if (!fill || !fill.classList.contains("ob2-fill")) {
    container.innerHTML = `<i class="ob2-fill"></i>`;
    fill = container.firstElementChild;
  }
  const x = Math.max(0.0001, Math.min(1, fraction));
  fill.style.transform = `scaleX(${x})`;
}

// Toggle the Continue button between its muted (inactive) and Athlevo-red
// (actionable) states based on live validity — a responsive, satisfying flip.
function obUpdateContinueState() {
  if (obMode !== "screen") return;
  const cont = document.getElementById("ob2Continue");
  if (!cont) return;
  const last = obStepIndex === OB_SCREENS.length - 1;
  cont.classList.toggle("ready", last || !obValidateStep());
}

function obApplyChrome(index) {
  obSetProgress((index + 1) / OB_SCREENS.length);

  const back = document.getElementById("ob2Back");
  if (back) back.disabled = index === 0;

  const cont = document.getElementById("ob2Continue");
  if (cont) {
    const last = index === OB_SCREENS.length - 1;
    cont.textContent = last ? "See my profile" : "Continue";
    cont.classList.toggle("done", last);
    cont.disabled = false;
  }
  obUpdateContinueState();
}

/* Instant (non-animated) render of the current screen. Used for the first
   screen, unit-toggle re-render, conditional-field reveal and reduced motion. */
function obRenderStep() {
  const body = document.getElementById("ob2Body");
  const screen = OB_SCREENS[obStepIndex];
  if (!screen || !body) return;
  obFinalizeTransition();
  obMode = "screen";
  body.innerHTML = obStepHTML(obStepIndex);
  body.scrollTop = 0;
  obApplyChrome(obStepIndex);
  obMessage("");
  obWireStep(body.querySelector(".ob2-step"));
}

/* Finish any in-flight transition immediately (cancel anims, drop the
   outgoing element, settle the incoming one) so a new navigation can start
   cleanly from the real current state. */
function obFinalizeTransition() {
  if (!obTransition) return;
  const t = obTransition;
  obTransition = null;
  (t.anims || []).forEach(a => { try { a.cancel(); } catch (e) {} });
  const body = document.getElementById("ob2Body");
  if (body) {
    body.classList.remove("ob2-transitioning");
    // Keep only the newest incoming step; strip the rest.
    Array.from(body.querySelectorAll(".ob2-step")).forEach(el => {
      if (el !== t.incoming) el.remove();
    });
    if (t.incoming) {
      t.incoming.style.position = "";
      t.incoming.style.inset = "";
      t.incoming.style.transform = "";
      t.incoming.style.opacity = "";
      t.incoming.style.willChange = "";
    }
  }
}

/*
 * Animated navigation to a screen index. `dir` = +1 forward, -1 back.
 * Interruptible: if a transition is already running it is finalized first,
 * and the incoming step animates from its current presentation X.
 */
function obGoToScreen(nextIndex, dir) {
  const body = document.getElementById("ob2Body");
  if (!body) return;
  if (nextIndex < 0 || nextIndex >= OB_SCREENS.length) return;

  obClearAdvanceTimer();
  obFinalizeTransition();

  const outgoing = body.querySelector(".ob2-step");
  obStepIndex = nextIndex;
  obMode = "screen";
  obApplyChrome(nextIndex);
  obMessage("");

  const incoming = obBuildStepEl(nextIndex);

  if (!obCanAnimate(incoming) || !outgoing) {
    body.innerHTML = "";
    body.appendChild(incoming);
    body.scrollTop = 0;
    obWireStep(incoming);
    return;
  }

  const width = body.clientWidth || 360;
  const travel = Math.round(Math.min(width, 480) * 0.16);
  const outTo = dir >= 0 ? -travel : travel;
  const inFrom = dir >= 0 ? travel : -travel;

  body.classList.add("ob2-transitioning");
  outgoing.style.position = "absolute";
  outgoing.style.inset = "0";
  outgoing.style.willChange = "transform, opacity";
  incoming.style.position = "absolute";
  incoming.style.inset = "0";
  incoming.style.willChange = "transform, opacity";
  body.appendChild(incoming);
  body.scrollTop = 0;
  obWireStep(incoming);

  const outAnim = outgoing.animate(
    [{ transform: "translateX(0)", opacity: 1 },
     { transform: `translateX(${outTo}px)`, opacity: 0 }],
    { duration: 240, easing: OB_EASE, fill: "both" });
  const inAnim = incoming.animate(
    [{ transform: `translateX(${inFrom}px)`, opacity: 0 },
     { transform: "translateX(0)", opacity: 1 }],
    { duration: 300, easing: OB_EASE, fill: "both" });

  const t = { anims: [outAnim, inAnim], outgoing, incoming };
  obTransition = t;
  inAnim.onfinish = () => { if (obTransition === t) obFinalizeTransition(); };
}

// Subtle spring pop on a freshly-selected control — the tactile "it took"
// moment. Reads/writes transform only, respects reduced motion.
function obPop(el) {
  if (!obCanAnimate(el)) return;
  el.animate(
    [{ transform: "scale(.97)" }, { transform: "scale(1.015)" }, { transform: "scale(1)" }],
    { duration: 240, easing: OB_EASE_OUT });
}

/* Chip / day / card tap handling (writes straight into obData). Scoped to the
   passed root so two screens can briefly coexist during a transition. */
function obWireStep(root) {
  root = root || document.getElementById("ob2Body");
  if (!root) return;

  root.querySelectorAll("[data-field]").forEach(el => {
    if (!el.dataset || (!el.dataset.value && el.dataset.value !== "0")) return;
    if (el.tagName !== "BUTTON") return;

    el.addEventListener("click", () => {
      const fieldId = el.dataset.field;
      const raw = el.dataset.value;
      const scope = el.closest(".ob2-step") || root;
      obClearAdvanceTimer();

      // Days: single select toggle.
      if (el.dataset.day === "1") {
        const selecting = obData[fieldId] !== raw;
        obData[fieldId] = selecting ? raw : null;
        obRefreshSelections(fieldId, scope);
        if (selecting) obPop(el);
        obUpdateContinueState();
        const screen = OB_SCREENS[obStepIndex];
        if (selecting && screen && screen.autoAdvance && !obValidateStep()) obScheduleAutoAdvance();
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
        obRefreshSelections(fieldId, scope);
        if (el.classList.contains("sel")) obPop(el);
        obUpdateContinueState();
        return;
      }

      // Single-select chips / cards — coerce numeric option values back to number.
      const opt = obFindOption(fieldId, raw);
      const value = opt ? opt.value : raw;
      const prevValue = obData[fieldId];
      obData[fieldId] = value;

      // A field can gate a conditional field (distance → customDistance). Only
      // re-render when that conditional's VISIBILITY actually changes — so
      // ordinary re-selections stay instant (no entrance replay, keeps the pop).
      const screen = OB_SCREENS[obStepIndex];
      const revealsNow = screen && screen.fields.some(
        f => f.showWhen && String(f.showWhen[fieldId]) === String(value));
      const revealedBefore = screen && screen.fields.some(
        f => f.showWhen && String(f.showWhen[fieldId]) === String(prevValue));

      if (revealsNow !== revealedBefore) {
        obRenderStep();                       // visibility changed → rebuild
      } else {
        obRefreshSelections(fieldId, scope);
        obPop(el);
        obUpdateContinueState();
      }

      // Auto-advance single-choice screens once satisfied — never when a
      // conditional field just opened (the athlete still has to fill it).
      if (screen && screen.autoAdvance && !revealsNow && !obValidateStep()) {
        obScheduleAutoAdvance();
      }
    });
  });

  // Live CTA state: as text/number/date inputs change, keep obData current and
  // flip the Continue button between muted and actionable.
  root.querySelectorAll("input, textarea").forEach(el => {
    const sync = () => { obCollectInputs(); obUpdateContinueState(); };
    el.addEventListener("input", sync);
    el.addEventListener("change", sync);
  });
}

function obScheduleAutoAdvance() {
  obClearAdvanceTimer();
  // Long enough that the selected state + spring are clearly seen, short enough
  // to feel immediate. Faster (but still visible) under reduced motion.
  const delay = obReducedMotion() ? 140 : 300;
  obAdvanceTimer = setTimeout(() => {
    obAdvanceTimer = null;
    if (obMode === "screen") obContinue();
  }, delay);
}
function obClearAdvanceTimer() {
  if (obAdvanceTimer) { clearTimeout(obAdvanceTimer); obAdvanceTimer = null; }
}

function obFindOption(fieldId, rawValue) {
  const screen = OB_SCREENS[obStepIndex];
  const field = screen.fields.find(f => f.id === fieldId);
  if (!field || !field.options) return null;
  return field.options.find(o => String(o.value) === String(rawValue)) || null;
}

// Re-paint only the selected state for one field (no full re-render, so text
// inputs keep focus / caret while chips update instantly).
function obRefreshSelections(fieldId, scope) {
  scope = scope || document.getElementById("ob2Body");
  if (!scope) return;
  const value = obData[fieldId];
  scope.querySelectorAll(`[data-field="${fieldId}"]`).forEach(el => {
    const raw = el.dataset.value;
    let on;
    if (Array.isArray(value)) on = value.map(String).includes(raw);
    else on = value != null && String(value) === raw;
    el.classList.toggle("sel", on);
  });
}

/* Pull the current screen's text/number/date inputs into obData. */
function obCollectInputs() {
  const screen = OB_SCREENS[obStepIndex];
  if (!screen) return;
  screen.fields.forEach(field => {
    if (["text", "number", "date", "textarea"].includes(field.type)) {
      const el = document.getElementById(`obf-${field.id}`);
      if (el) obData[field.id] = el.value;
    }
  });
}

/* ─────────────────────────── validation ─────────────────────────────── */

function obValidateStep() {
  const screen = OB_SCREENS[obStepIndex];

  for (const field of screen.fields) {
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

  // Screen-level persistence keeps resume rock-solid (every answer is saved
  // before advancing). onboarding_step tracks the furthest screen reached;
  // onboarding_complete stays the authoritative "questions finished" flag.
  updates.onboarding_step = complete ? OB_SCREENS.length : obStepIndex + 1;
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
  obClearAdvanceTimer();
  obCollectInputs();

  const problem = obValidateStep();
  if (problem) {
    obMessage(problem);
    return;
  }

  const lastStep = obStepIndex === OB_SCREENS.length - 1;
  obBusy = true;
  const cont = document.getElementById("ob2Continue");
  if (cont) {
    cont.disabled = true;
    cont.textContent = lastStep ? "Building…" : "Saving…";
  }

  try {
    await obSaveProgress(lastStep);

    if (lastStep) {
      obShowPayoff();
      return;
    }

    const screen = OB_SCREENS[obStepIndex];
    // Skip forward past screens whose required fields are already satisfied
    // (diagnostic prefill covers goal, experience, volume, days, etc.).
    const next = obNextIncompleteStep(obStepIndex + 1);
    if (next >= OB_SCREENS.length) {
      // All remaining screens are satisfied — go straight to payoff.
      obShowPayoff();
      return;
    }
    if (screen.insightAfter) {
      obShowInsight(screen.insightAfter, () => obGoToScreen(next, 1));
    } else {
      obGoToScreen(next, 1);
    }
  } catch (error) {
    obTrackFailure("profile_save", error);
    console.warn("Could not save onboarding step:", obFailureCategory(error));
    obMessage("Couldn't save that — check your connection and try again.");
    if (cont) cont.textContent = lastStep ? "See my profile" : "Continue";
  } finally {
    obBusy = false;
    const c = document.getElementById("ob2Continue");
    if (c) c.disabled = false;
  }
}

function obBack() {
  if (obBusy || obStepIndex === 0) return;
  obClearAdvanceTimer();
  obCollectInputs();
  obGoToScreen(obStepIndex - 1, -1);
}

/* ════════════════════════ "Athlevo is learning" beats ════════════════════
 * A short, skippable interstitial that shows causality between an answer and
 * what Athlevo does with it. Auto-continues, or tap / Continue to skip. */
function obShowInsight(text, done) {
  const body = document.getElementById("ob2Body");
  if (!body) { done && done(); return; }
  obMode = "insight";
  obClearAdvanceTimer();
  if (obInsightTimer) { clearTimeout(obInsightTimer); obInsightTimer = null; }
  const foot = document.getElementById("ob2-foot");
  if (foot) foot.style.display = "none";      // the beat owns the screen

  body.innerHTML = `
    <div class="ob2-insight" id="obInsight">
      <span class="ob2-insight-mark" aria-hidden="true"></span>
      <p class="ob2-insight-text">${obEscape(text)}</p>
      <span class="ob2-insight-hint">Tap to continue</span>
    </div>`;
  body.scrollTop = 0;

  const el = document.getElementById("obInsight");
  if (obCanAnimate(el)) {
    el.animate([{ opacity: 0, transform: "translateY(12px)" },
                { opacity: 1, transform: "none" }],
      { duration: 340, easing: OB_EASE, fill: "both" });
  }

  let finished = false;
  const proceed = () => {
    if (finished) return;
    finished = true;
    if (obInsightTimer) { clearTimeout(obInsightTimer); obInsightTimer = null; }
    if (el) el.removeEventListener("click", proceed);
    const ft = document.getElementById("ob2-foot");
    if (ft) ft.style.display = "";             // restore for the next screen
    obMode = "screen";
    done && done();
  };
  if (el) el.addEventListener("click", proceed);
  const dwell = obReducedMotion() ? 500 : 1600;
  obInsightTimer = setTimeout(proceed, dwell);
}

/* ════════════════════════════ profile payoff ════════════════════════════
 * Phase 5. A synthesis moment ("Building your athlete profile…") followed by a
 * concise summary derived ONLY from the athlete's real answers, then the CTA
 * into the existing training-data / plan pipeline. No fabricated analysis. */

// Human labels for the summary, all sourced from what the athlete entered.
function obPayoffModel() {
  const d = obData;
  const updates = obBuildUpdates();   // same values that were just persisted

  // Primary goal — the composed goal line the coach actually reads.
  const goal = updates.goal || (d.distance && d.distance !== "Other" ? d.distance : null)
    || "General endurance fitness";

  // Current level — from experience band + current status (real inputs).
  const expMap = { 0: "New runner", 1: "Developing runner", 4: "Experienced runner", 8: "Seasoned runner" };
  const level = expMap[Number(d.experience)] || (d.status ? d.status : "Getting started");

  // Recommended starting frequency = the days they told us they can train.
  const days = Number(d.days);
  const freq = Number.isFinite(days) && days > 0
    ? `${days} day${days === 1 ? "" : "s"} / week` : null;

  // Starting weekly volume = their current weekly distance (the safe baseline
  // Athlevo builds from). Shown in the athlete's preferred units.
  let volume = null;
  const km = Number(updates.weekly_distance);
  if (Number.isFinite(km) && km > 0) {
    volume = obUnits() === "imperial"
      ? `${Math.round(OB_CONVERT.kmToMi(km))} mi / week`
      : `${Math.round(km)} km / week`;
  }

  return { goal, level, freq, volume, status: d.status || null };
}

function obShowPayoff() {
  const body = document.getElementById("ob2Body");
  if (!body) { obFinish(); return; }
  obMode = "payoff";
  obClearAdvanceTimer();
  obFinalizeTransition();

  // Hide the question chrome — the payoff is the reward, not another step.
  const progress = document.getElementById("ob2Progress");
  const foot = document.getElementById("ob2-foot");
  const back = document.getElementById("ob2Back");
  if (progress) progress.style.visibility = "hidden";
  if (foot) foot.style.display = "none";
  if (back) back.disabled = true;

  const model = obPayoffModel();

  const buildLines = [
    "Reading your goal and experience",
    "Setting a safe starting load",
    "Shaping your training week"
  ];

  body.innerHTML = `
    <div class="ob2-payoff" id="obPayoff">
      <div class="ob2-build" id="obBuild">
        <div class="ob2-build-ring" aria-hidden="true"><span></span></div>
        <h2 class="ob2-title">Building your athlete profile…</h2>
        <ul class="ob2-build-lines">
          ${buildLines.map(l => `<li><i></i>${obEscape(l)}</li>`).join("")}
        </ul>
      </div>

      <div class="ob2-summary" id="obSummary" hidden>
        <span class="ob2-eyebrow">Your Athlevo profile</span>
        <h2 class="ob2-title">Your profile is ready.</h2>
        <p class="ob2-sub">Built from what you told us. This is where your training starts.</p>
        <dl class="ob2-summary-list">
          ${obSummaryRow("Primary goal", model.goal)}
          ${obSummaryRow("Current level", model.level)}
          ${model.freq ? obSummaryRow("Recommended frequency", model.freq) : ""}
          ${model.volume ? obSummaryRow("Starting weekly volume", model.volume) : ""}
        </dl>
        <button type="button" class="ob2-continue done" id="obBuildPlan">Build my training plan</button>
      </div>
    </div>`;
  body.scrollTop = 0;

  const buildEl = document.getElementById("obBuild");
  const summaryEl = document.getElementById("obSummary");
  const lines = buildEl ? Array.from(buildEl.querySelectorAll(".ob2-build-lines li")) : [];

  const reveal = () => {
    if (buildEl) buildEl.hidden = true;
    if (summaryEl) {
      summaryEl.hidden = false;
      if (obCanAnimate(summaryEl)) {
        summaryEl.animate([{ opacity: 0, transform: "translateY(14px)" },
                           { opacity: 1, transform: "none" }],
          { duration: 420, easing: OB_EASE, fill: "both" });
      }
    }
    if (progress) progress.style.visibility = "";
    const cta = document.getElementById("obBuildPlan");
    if (cta) cta.addEventListener("click", obPayoffContinue);
  };

  if (obReducedMotion()) {
    // No theatre for reduced motion — show the result immediately.
    reveal();
  } else {
    // Progressive "learning" tick, then reveal the synthesised summary.
    lines.forEach((li, i) => setTimeout(() => li.classList.add("on"), 260 + i * 360));
    setTimeout(reveal, 260 + lines.length * 360 + 360);
  }
}

// Editorial summary row — a quiet label above a strong value, separated by
// spacing and a hairline divider. No card, no accent bar.
function obSummaryRow(label, value) {
  return `<div class="ob2-sumrow">
      <dt class="ob2-sumlabel">${obEscape(label)}</dt>
      <dd class="ob2-sumvalue">${obEscape(value)}</dd>
    </div>`;
}

async function obPayoffContinue() {
  if (obBusy) return;
  obBusy = true;
  const cta = document.getElementById("obBuildPlan");
  if (cta) { cta.disabled = true; cta.textContent = "Getting things ready…"; }
  // Restore chrome defaults the connect flow expects, then hand off exactly as
  // the previous flow did (recent-race write, UI refresh, connect wizard).
  const foot = document.getElementById("ob2-foot");
  if (foot) foot.style.display = "";
  try {
    await obFinish();
  } catch (error) {
    console.warn("Payoff handoff failed:", error);
    if (cta) { cta.disabled = false; cta.textContent = "Build my training plan"; }
  } finally {
    obBusy = false;
  }
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
  await obWriteOnboardingRace();

  if (window.AthlevoAnalytics) window.AthlevoAnalytics.track("onboarding_completed");
  try {
    if (window.AthlevoProductAnalytics) {
      AthlevoProductAnalytics.trackUserMilestone(
        "onboarding_completed",
        obProfile && obProfile.id,
        null
      );
    }
  } catch(e){}

  try {
    if (window.AthlevoDiagnosticAcquisition &&
        typeof window.AthlevoDiagnosticAcquisition.completePostPaymentOnboarding === "function") {
      await window.AthlevoDiagnosticAcquisition.completePostPaymentOnboarding(supabaseClient);
    }
  } catch (e) {}

  if (await obOfferIfUnpaid()) return;

  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.style.display = "flex";

  try {
    await AthlevoBrain.refreshAthleteUI();
  } catch (error) {
    console.error("Could not refresh athlete UI after onboarding:", error);
  }

  if (window.AthlevoConnect && typeof window.AthlevoConnect.start === "function") {
    try { await window.AthlevoConnect.start(); return; }
    catch (e) { console.warn("Training-data setup failed:", e); }
  }
  showScreen("screen-today");
}

async function obOfferIfUnpaid() {
  if (window.AthlevoDiagnosticAcquisition &&
      typeof window.AthlevoDiagnosticAcquisition.gateUnpaidAthlete === "function") {
    try {
      const gate = await window.AthlevoDiagnosticAcquisition.gateUnpaidAthlete(
        obProfile && obProfile.id, supabaseClient, obProfile
      );
      return !(gate && gate.allowed);
    } catch (e) {
      return true;
    }
  }
  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.style.display = "none";
  return true;
}

/**
 * Returns true when every required field on a screen is already populated
 * in obData. A screen with no required fields is always "complete".
 */
function obScreenComplete(screenIndex) {
  const screen = OB_SCREENS[screenIndex];
  if (!screen) return false;
  return screen.fields.every(field => {
    if (!field.required) return true;
    const v = obData[field.id];
    if (v == null || v === "") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
}

/* Find the first screen still missing a required answer (post-prefill), so a
   resumed athlete lands exactly where they left off. */
function obFirstIncompleteStep() {
  for (let i = 0; i < OB_SCREENS.length; i += 1) {
    if (!obScreenComplete(i)) return i;
  }
  // Everything required is already answered → resume on the last screen so they
  // can review and finish rather than being dropped straight into the payoff.
  return OB_SCREENS.length - 1;
}

/**
 * From a given index, find the next screen with missing required data.
 * Used during forward navigation so diagnostic-prefilled screens are
 * skipped automatically. Returns the payoff index (OB_SCREENS.length)
 * when everything remaining is satisfied.
 */
function obNextIncompleteStep(fromIndex) {
  for (let i = fromIndex; i < OB_SCREENS.length; i += 1) {
    if (!obScreenComplete(i)) return i;
  }
  return OB_SCREENS.length; // all done → trigger payoff
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

  if (!createError) {
    // Non-persisted marker used only to distinguish a first onboarding start
    // from a later resume when the auth redirect opened in a new tab.
    if (created) created.__athlevoNewProfile = true;
    return created;
  }

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
  try { if (window.AthlevoProductAnalytics) AthlevoProductAnalytics.resetAthleteAnalytics(); } catch (error) {}
  try { if (window.AthlevoAnalytics) AthlevoAnalytics.resetIdentity(); } catch (error) {}
  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.style.display = "none";
  if (typeof showScreen === "function") showScreen("screen-welcome");
  if (typeof window.openLogin === "function") window.openLogin();
}

/* ═══════════════════════════════════════════════════════════════════════
 *  Role-choice screen, coach flow, and dispatcher logic
 * ═══════════════════════════════════════════════════════════════════════ */

/* ─── Categorical-only analytics helper ─── */

const OB_ALLOWED_ANALYTICS_KEYS = {
  selected_role: { athlete: true, coach: true },
  application_status: { pending: true },
  source_surface: { onboarding: true }
};

function obTrackOnboardingEvent(eventName, props) {
  try {
    const safe = {};
    if (props && typeof props === "object") {
      for (const key of Object.keys(props)) {
        const whitelist = OB_ALLOWED_ANALYTICS_KEYS[key];
        if (!whitelist) continue;
        const val = String(props[key] || "").trim();
        if (whitelist[val]) safe[key] = val;
      }
    }
    if (window.AthlevoAnalytics) {
      window.AthlevoAnalytics.track(eventName, safe);
    }
    if (window.AthlevoProductAnalytics) {
      window.AthlevoProductAnalytics.trackAthlevoEvent(eventName, safe);
    }
  } catch (e) {}
}

/* ─── Role-choice rendering ─── */

function obRenderRoleChoice() {
  const body = document.getElementById("ob2Body");
  if (!body) return;
  obMode = "role";
  obClearAdvanceTimer();
  obFinalizeTransition();
  const coachLocked = !obCoachPublicAccessEnabled();

  // Hide progress bar and footer during role choice
  const progress = document.getElementById("ob2Progress");
  const foot = document.getElementById("ob2-foot");
  if (progress) progress.style.display = "none";
  if (foot) foot.style.display = "none";
  const back = document.getElementById("ob2Back");
  if (back) back.disabled = true;

  body.innerHTML = `
    <div class="ob2-step" style="text-align:center">
      <h2 class="ob2-title">Are you an athlete or a coach?</h2>
      <p class="ob2-sub">Choose how you'll use the app.</p>
      <div style="display:flex;flex-direction:column;gap:14px;margin-top:28px;max-width:340px;margin-left:auto;margin-right:auto">
        <button type="button" id="obRoleAthlete" class="ob2-role-card" style="
          display:flex;align-items:center;gap:14px;padding:20px 22px;
          border-radius:14px;border:2px solid var(--ink1,#e0e0e0);
          background:var(--bg2,#fff);cursor:pointer;text-align:left;
          transition:border-color .15s,box-shadow .15s;font-family:inherit">
          <span style="font-size:28px" aria-hidden="true">&#127939;</span>
          <span>
            <span style="display:block;font-weight:700;font-size:16px;color:var(--ink5,#111)">Athlete</span>
            <span style="display:block;font-size:13px;color:var(--ink3,#666);margin-top:2px">Get a personalised training plan</span>
          </span>
        </button>
        <button type="button" id="obRoleCoach" class="ob2-role-card" aria-disabled="${coachLocked ? "true" : "false"}" style="
          display:flex;align-items:center;gap:14px;padding:20px 22px;
          border-radius:14px;border:2px solid var(--ink1,#e0e0e0);
          background:var(--bg2,#fff);cursor:${coachLocked ? "default" : "pointer"};text-align:left;
          transition:border-color .15s,box-shadow .15s;font-family:inherit">
          <span style="font-size:24px" aria-hidden="true">${coachLocked ? "&#128274;" : "&#128203;"}</span>
          <span style="min-width:0;flex:1">
            <span style="display:flex;align-items:center;justify-content:space-between;gap:10px">
              <span style="font-weight:700;font-size:16px;color:var(--ink5,#111)">Coach</span>
              ${coachLocked ? '<span style="flex:0 0 auto;border:1px solid var(--ink1,#e0e0e0);border-radius:999px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--ink3,#666);text-transform:uppercase">Coming soon</span>' : ''}
            </span>
            <span style="display:block;font-size:13px;color:var(--ink3,#666);margin-top:3px">Manage athletes and coaching workflows</span>
          </span>
        </button>
      </div>
    </div>
  `;

  obTrackOnboardingEvent("onboarding_role_choice_viewed", {
    source_surface: "onboarding"
  });

  body.querySelector("#obRoleAthlete").addEventListener("click", () => {
    obTrackOnboardingEvent("onboarding_role_selected", {
      selected_role: "athlete", source_surface: "onboarding"
    });
    obWriteIntent("athlete");
    obStartAthleteFlow();
  });

  body.querySelector("#obRoleCoach").addEventListener("click", () => {
    if (!obCoachPublicAccessEnabled()) {
      obClearIntent();
      if (typeof window.toast === "function") window.toast("Coach tools are coming soon.");
      else obMessage("Coach tools are coming soon.");
      return;
    }
    obTrackOnboardingEvent("onboarding_role_selected", {
      selected_role: "coach", source_surface: "onboarding"
    });
    obWriteIntent("coach");
    obStartCoachFlow();
  });
}

/* ─── Restore progress bar + footer after role choice ─── */

function obRestoreChrome() {
  const progress = document.getElementById("ob2Progress");
  const foot = document.getElementById("ob2-foot");
  if (progress) { progress.style.display = ""; progress.style.visibility = ""; }
  if (foot) foot.style.display = "";
}

/* ─── Athlete flow entry ─── */

function obStartAthleteFlow() {
  _obCurrentFlow = "athlete";
  obRestoreChrome();
  obData = obPrefillFromProfile(obProfile);
  obStepIndex = obFirstIncompleteStep();
  // Fire post-payment onboarding analytics if this is a diagnostic-acquisition user.
  if (window.AthlevoDiagnosticAcquisition &&
      typeof window.AthlevoDiagnosticAcquisition.markOnboardingStarted === "function") {
    try { window.AthlevoDiagnosticAcquisition.markOnboardingStarted(); } catch (e) {}
  }
  obRenderStep();
}

/* ─── Coach flow ─── */

function obStartCoachFlow() {
  if (!obCoachPublicAccessEnabled()) {
    obClearIntent();
    obRenderRoleChoice();
    obMessage("Coach tools are coming soon.");
    return false;
  }
  _obCurrentFlow = "coach";
  obRestoreChrome();
  coachObStepIndex = 0;
  coachObData = {};

  // Prefill name from profile if available
  if (obProfile && obProfile.full_name) {
    coachObData.coachName = obProfile.full_name;
  }

  obTrackOnboardingEvent("coach_application_started", {
    source_surface: "onboarding"
  });

  obRenderCoachStep();
  return true;
}

function obRenderCoachStep() {
  const step = COACH_OB_STEPS[coachObStepIndex];
  const body = document.getElementById("ob2Body");
  if (!step || !body) return;

  // Render using the same field rendering as athlete flow
  const visibleFields = (step.fields || []).filter(f => {
    if (!f.showWhen) return true;
    return Object.keys(f.showWhen).every(k => coachObData[k] === f.showWhen[k]);
  });

  body.innerHTML = `
    <div class="ob2-step">
      <span class="ob2-eyebrow">${obEscape(step.eyebrow)}</span>
      <h2 class="ob2-title">${obEscape(step.title)}</h2>
      <p class="ob2-sub">${obEscape(step.sub)}</p>
      ${obGroupCoachFields(visibleFields)}
    </div>
  `;
  body.scrollTop = 0;
  obMode = "coach";

  // Progress — coach flow reuses the same continuous line.
  obSetProgress((coachObStepIndex + 1) / COACH_OB_STEPS.length);

  const back = document.getElementById("ob2Back");
  if (back) back.disabled = false; // Back always enabled — goes to role choice from step 0

  const cont = document.getElementById("ob2Continue");
  if (cont) {
    const last = coachObStepIndex === COACH_OB_STEPS.length - 1;
    cont.textContent = last ? "Submit application" : "Continue";
    cont.classList.toggle("done", last);
    // Coach steps validate on submit; keep the CTA in its actionable red state
    // rather than the athlete flow's live-muted treatment.
    cont.classList.add("ready");
  }

  obMessage("");
  obWireCoachStep();
}

/* Render a single coach field — reuses obRenderField but sources from coachObData */
function obRenderCoachField(field) {
  const optTag = field.optional
    ? ` <span class="opt">· optional</span>`
    : "";
  const label = `<label class="ob2-label" for="obf-${field.id}">${obEscape(field.label)}${optTag}</label>`;

  if (field.type === "text" || field.type === "number") {
    const value = coachObData[field.id] != null ? obEscape(coachObData[field.id]) : "";
    const input = `<input class="ob2-input" id="obf-${field.id}" type="${
      field.type === "number" ? "number" : "text"
    }" inputmode="${field.type === "number" ? "decimal" : "text"}" placeholder="${
      obEscape(field.placeholder || "")
    }" value="${value}" autocomplete="off">`;
    return `<div class="ob2-field${field.half ? " half" : ""}">${label}${input}</div>`;
  }

  if (field.type === "chips" || field.type === "multichips") {
    const selected = coachObData[field.id];
    const chips = field.options.map(opt => {
      const isSel =
        field.type === "multichips"
          ? Array.isArray(selected) && selected.includes(opt.value)
          : selected != null && String(selected) === String(opt.value);
      return `<button type="button" class="ob2-chip${isSel ? " sel" : ""}" data-field="${field.id}" data-value="${obEscape(opt.value)}" data-multi="${field.type === "multichips" ? "1" : "0"}">${obEscape(opt.label)}</button>`;
    }).join("");
    return `<div class="ob2-field">${label}<div class="ob2-chips">${chips}</div></div>`;
  }

  return "";
}

function obGroupCoachFields(fields) {
  const out = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    const next = fields[i + 1];
    if (f.half && next && next.half) {
      out.push(`<div class="ob2-row">${obRenderCoachField(f)}${obRenderCoachField(next)}</div>`);
      i += 2;
    } else {
      out.push(obRenderCoachField(f));
      i += 1;
    }
  }
  return out.join("");
}

/* Chip handling for coach fields — writes into coachObData */
function obWireCoachStep() {
  const body = document.getElementById("ob2Body");
  if (!body) return;

  body.querySelectorAll("[data-field]").forEach(el => {
    if (!el.dataset || (!el.dataset.value && el.dataset.value !== "0")) return;
    if (el.tagName !== "BUTTON") return;

    el.addEventListener("click", () => {
      const fieldId = el.dataset.field;
      const raw = el.dataset.value;

      if (el.dataset.multi === "1") {
        const cur = Array.isArray(coachObData[fieldId]) ? coachObData[fieldId].slice() : [];
        coachObData[fieldId] = cur.includes(raw)
          ? cur.filter(v => v !== raw)
          : cur.concat(raw);
      } else {
        coachObData[fieldId] = coachObData[fieldId] === raw ? null : raw;
      }

      // Refresh chip selection states
      const value = coachObData[fieldId];
      body.querySelectorAll(`[data-field="${fieldId}"]`).forEach(btn => {
        const v = btn.dataset.value;
        let on;
        if (Array.isArray(value)) on = value.includes(v);
        else on = value != null && String(value) === v;
        btn.classList.toggle("sel", on);
      });
    });
  });
}

/* Collect text/number inputs from coach step */
function obCollectCoachInputs() {
  const step = COACH_OB_STEPS[coachObStepIndex];
  step.fields.forEach(field => {
    if (["text", "number"].includes(field.type)) {
      const el = document.getElementById(`obf-${field.id}`);
      if (el) coachObData[field.id] = el.value;
    }
  });
}

/* Validate current coach step */
function obValidateCoachStep() {
  const step = COACH_OB_STEPS[coachObStepIndex];

  for (const field of step.fields) {
    if (field.optional) continue;
    const value = coachObData[field.id];

    if (field.required) {
      const empty =
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty) {
        return `Please complete "${field.label}" to continue.`;
      }
    }
  }
  return null;
}

/* Coach continue */
async function obCoachContinue() {
  if (obBusy) return;

  obCollectCoachInputs();

  const problem = obValidateCoachStep();
  if (problem) {
    obMessage(problem);
    return;
  }

  obBusy = true;
  const cont = document.getElementById("ob2Continue");
  const lastStep = coachObStepIndex === COACH_OB_STEPS.length - 1;

  if (cont) {
    cont.disabled = true;
    cont.textContent = lastStep ? "Submitting…" : "Saving…";
  }

  try {
    if (lastStep) {
      await obSubmitCoachApplication();
      return;
    }
    coachObStepIndex += 1;
    obRenderCoachStep();
  } catch (error) {
    obTrackFailure("profile_save", error);
    console.warn("Coach onboarding error:", obFailureCategory(error));
    obMessage("Couldn't save that — check your connection and try again.");
    if (cont) {
      cont.textContent = lastStep ? "Submit application" : "Continue";
    }
  } finally {
    obBusy = false;
    const c = document.getElementById("ob2Continue");
    if (c) c.disabled = false;
  }
}

/* Coach back */
function obCoachBack() {
  if (obBusy) return;
  obCollectCoachInputs();

  if (coachObStepIndex === 0) {
    // Go back to role choice
    _obCurrentFlow = "athlete"; // reset
    obClearIntent();
    obRenderRoleChoice();
    return;
  }
  coachObStepIndex -= 1;
  obRenderCoachStep();
}

/* ─── Coach application submission ─── */

async function obSubmitCoachApplication() {
  const user = await obUser();

  // 1. Save the coach's name to profiles (never touches role)
  const coachName = obClean(coachObData.coachName);
  if (coachName) {
    try {
      await supabaseClient
        .from("profiles")
        .update({
          full_name: coachName,
          updated_at: new Date().toISOString()
        })
        .eq("id", user.id);
    } catch (e) {
      console.warn("Could not save coach name:", e?.message || e);
    }
  }

  // 2. Build the application row.
  //    SECURITY: user_id comes from auth session, NOT from client payload.
  //    Status is always "pending" — the DB CHECK + RLS enforce this, but we
  //    also set it explicitly for defence-in-depth.
  const applicationRow = {
    user_id: user.id,
    status: "pending",
    coaching_brand: obClean(coachObData.coachBrand) || null,
    coaching_sports: Array.isArray(coachObData.coachSports)
      ? coachObData.coachSports.join(", ")
      : null,
    experience_band: coachObData.coachExperience || null,
    athlete_count_band: coachObData.coachAthleteCount || null,
    coaching_setup: coachObData.coachSetup || null
  };

  // 3. Upsert-safe insertion: unique partial index on (user_id) WHERE
  //    status = 'pending' prevents duplicates. On conflict, update the
  //    application data (idempotent resubmission).
  const { error } = await supabaseClient
    .from("coach_applications")
    .upsert(applicationRow, {
      onConflict: "user_id",
      ignoreDuplicates: false
    });

  if (error) {
    // If it's a duplicate key (fallback if upsert isn't available),
    // update instead.
    if (obIsDuplicateError(error)) {
      const { error: updateError } = await supabaseClient
        .from("coach_applications")
        .update({
          coaching_brand: applicationRow.coaching_brand,
          coaching_sports: applicationRow.coaching_sports,
          experience_band: applicationRow.experience_band,
          athlete_count_band: applicationRow.athlete_count_band,
          coaching_setup: applicationRow.coaching_setup
        })
        .eq("user_id", user.id)
        .eq("status", "pending");

      if (updateError) throw updateError;
    } else {
      throw error;
    }
  }

  // 4. Mark profiles.onboarding_complete so the user isn't prompted again.
  //    NEVER sets profiles.role.
  try {
    await supabaseClient
      .from("profiles")
      .update({
        onboarding_complete: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", user.id);
  } catch (e) {
    console.warn("Could not mark onboarding complete:", e?.message || e);
  }

  obTrackOnboardingEvent("coach_application_submitted", {
    application_status: "pending",
    source_surface: "onboarding"
  });

  obRenderCoachPending();
}

/* ─── Pending approval screen ─── */

function obRenderCoachPending() {
  const body = document.getElementById("ob2Body");
  if (!body) return;

  // Hide progress bar
  const progress = document.getElementById("ob2Progress");
  const foot = document.getElementById("ob2-foot");
  if (progress) progress.style.display = "none";
  if (foot) foot.style.display = "none";

  body.innerHTML = `
    <div class="ob2-step" style="text-align:center">
      <div style="font-size:48px;margin-bottom:16px" aria-hidden="true">&#9993;</div>
      <h2 class="ob2-title">Application submitted</h2>
      <p class="ob2-sub" style="margin-bottom:24px">
        Your coach application is under review. We'll notify you once it's approved.
        In the meantime, you can explore Athlevo as an athlete.
      </p>
      <button type="button" id="obCoachPendingContinue" class="ob2-continue done"
        style="max-width:300px;margin:0 auto">
        Continue to My Training
      </button>
    </div>
  `;

  body.querySelector("#obCoachPendingContinue").addEventListener("click", async () => {
    obClearIntent();
    if (await obOfferIfUnpaid()) return;
    const tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "flex";
    try { await AthlevoBrain.refreshAthleteUI(); } catch (e) {}
    showScreen("screen-today");
  });
}

/* ─── Dispatchers — route Continue/Back based on current flow ─── */

function obContinueDispatch() {
  if (_obCurrentFlow === "coach") {
    obCoachContinue();
  } else {
    obContinue();
  }
}

function obBackDispatch() {
  if (_obCurrentFlow === "coach") {
    obCoachBack();
  } else {
    if (obBusy || obStepIndex === 0) {
      // Back from athlete step 0 → role choice
      if (obStepIndex === 0 && !obBusy) {
        _obCurrentFlow = "athlete";
        obClearIntent();
        obRenderRoleChoice();
      }
      return;
    }
    obCollectInputs();
    obStepIndex -= 1;
    obRenderStep();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 *  Entry point (replaces original startAthlevoOnboarding)
 * ═══════════════════════════════════════════════════════════════════════ */

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

    // ── Already-onboarded: still require paid entitlement for athletes ──
    if (obProfile.onboarding_complete) {
      if (await obOfferIfUnpaid()) return;
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "flex";
      await AthlevoBrain.refreshAthleteUI();
      showScreen("screen-today");
      return;
    }

    // ── Coach/admin role bypass: existing coaches/admins skip athlete
    //    onboarding (their role was granted server-side) ──
    const role = obProfile.role;
    if (role === "coach" || role === "admin") {
      // Mark onboarding complete so they don't see this again
      try {
        await supabaseClient
          .from("profiles")
          .update({
            onboarding_complete: true,
            updated_at: new Date().toISOString()
          })
          .eq("id", obProfile.id);
      } catch (e) {}
      const tabbar = document.getElementById("tabbar");
      if (tabbar) tabbar.style.display = "flex";
      await AthlevoBrain.refreshAthleteUI();
      showScreen("screen-today");
      return;
    }

    // Starts only after the authenticated athlete's incomplete profile has
    // loaded successfully. The user-scoped milestone guard prevents refresh,
    // resume, and rerender duplicates.
    try {
      const newlyRegistered = Boolean(
        obProfile.__athlevoNewProfile ||
        (
          window.AthlevoProductAnalytics &&
          window.AthlevoProductAnalytics.isNewRegistration(obProfile.id)
        )
      );
      if (newlyRegistered && window.AthlevoAnalytics) {
        window.AthlevoAnalytics.track("onboarding_started");
      }
      if (newlyRegistered && window.AthlevoProductAnalytics) {
        window.AthlevoProductAnalytics.trackUserMilestone(
          "onboarding_started",
          obProfile && obProfile.id,
          null
        );
      }
    } catch (e) {}

    // ── Check saved intent and resume the right flow ──
    const savedIntent = obReadIntent();

    if (savedIntent === "coach" && obCoachPublicAccessEnabled()) {
      // Resume the coach application flow only when public access reopens.
      obStartCoachFlow();
      return;
    }

    if (savedIntent === "coach") obClearIntent();

    if (savedIntent === "athlete") {
      // Resume athlete flow
      obStartAthleteFlow();
      return;
    }

    // Acquisition users already completed the diagnostic. Skip the
    // athlete/coach role choice and start the short remaining setup.
    if (window.AthlevoDiagnosticAcquisition &&
        typeof window.AthlevoDiagnosticAcquisition.current === "function" &&
        window.AthlevoDiagnosticAcquisition.current()) {
      obWriteIntent("athlete");
      obStartAthleteFlow();
      return;
    }

    // ── No saved intent → show role choice ──
    obRenderRoleChoice();

  } catch (error) {
    // Log the safe internal code only — never tokens, email, or RLS details.
    const code = (error && error.code) ? error.code : "PROFILE_READ";
    obTrackFailure("profile_load", { code });
    console.warn("Onboarding profile load failed:", code);
    obRenderProfileError(code);
  }
}

/* ══════════════════════════ swipe gesture ════════════════════════════════
 * Horizontal drag on the question body. BACK gets a full live preview with
 * velocity, projection and edge resistance — dragging right progressively
 * exposes the previous screen and the release velocity is carried into the
 * settle (no seam). FORWARD is a flick that hands off to obContinue(), so the
 * server save + validation are never bypassed. Vertical drags fall through to
 * native scroll. Never locks input; always reads the real on-screen position.
 */
let obDrag = null;

function obGestureEligible(target) {
  if (obMode !== "screen" || obBusy) return false;
  if (!target || !target.closest) return true;
  // Let taps, carets and scrolls own their targets.
  return !target.closest(
    'input, textarea, select, button, [contenteditable="true"], .ob2-units');
}

function obGestureStart(e) {
  if (obDrag || !e.isPrimary) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (!obGestureEligible(e.target)) return;

  const body = document.getElementById("ob2Body");
  const dragEl = body && body.querySelector(".ob2-step");
  if (!body || !dragEl) return;
  obFinalizeTransition();

  obDrag = {
    id: e.pointerId, body, dragEl, preview: null,
    startX: e.clientX, startY: e.clientY,
    lastX: e.clientX, lastT: e.timeStamp || Date.now(),
    vx: 0, intent: null, dir: 0, allowed: false,
    width: body.clientWidth || 360
  };
  body.addEventListener("pointermove", obGestureMove, { passive: false });
  body.addEventListener("pointerup", obGestureEnd);
  body.addEventListener("pointercancel", obGestureCancel);
}

function obGestureMove(e) {
  const g = obDrag;
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.startX;
  const dy = e.clientY - g.startY;

  if (!g.intent) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
    if (Math.abs(dx) <= Math.abs(dy) * 1.2) { obGestureTeardown(); return; } // vertical → scroll
    g.intent = "horizontal";
    g.dir = dx > 0 ? -1 : 1;                 // right = back, left = forward
    try { g.body.setPointerCapture(g.id); } catch (err) {}
    obCollectInputs();                        // keep any typed text before we move
    if (g.dir === -1 && obStepIndex > 0) {
      g.allowed = true;
      g.body.classList.add("ob2-transitioning");
      g.dragEl.style.position = "absolute"; g.dragEl.style.inset = "0";
      g.dragEl.style.willChange = "transform";
      const prev = obBuildStepEl(obStepIndex - 1);
      prev.style.position = "absolute"; prev.style.inset = "0";
      prev.style.transform = `translateX(${-g.width}px)`;
      prev.style.willChange = "transform";
      g.body.appendChild(prev);
      obWireStep(prev);
      g.preview = prev;
    }
  }

  e.preventDefault();
  const now = e.timeStamp || Date.now();
  const dt = Math.max(1, now - g.lastT);
  g.vx = (e.clientX - g.lastX) / dt;          // px per ms
  g.lastX = e.clientX; g.lastT = now;
  g.lastDx = dx;

  if (g.dir === -1 && g.allowed) {
    const off = Math.max(0, dx);              // only rightward reveals prev
    g.dragEl.style.transform = `translateX(${off}px)`;
    if (g.preview) g.preview.style.transform = `translateX(${-g.width + off}px)`;
  } else {
    // No target that way (first screen, or forward pending validation): resist.
    g.dragEl.style.transform = `translateX(${obRubber(dx, g.width)}px)`;
  }
}

function obGestureEnd(e) {
  const g = obDrag;
  if (!g || e.pointerId !== g.id) return;
  const dx = g.lastDx || 0;
  const vSec = g.vx * 1000;                    // px per second
  const projected = dx + obProject(vSec, 0.99);
  const dir = g.dir;
  const width = g.width;
  const dragEl = g.dragEl;
  const preview = g.preview;
  const allowed = g.allowed;
  obGestureTeardown();

  if (dir === -1 && allowed) {
    const commit = projected > width * 0.3 || vSec > 550;
    if (commit) obGestureCommitBack(dragEl, preview, vSec);
    else obGestureSettleBack(dragEl, preview, vSec);
    return;
  }

  // Reset any rubber-band offset.
  obGestureReset(dragEl);
  if (dir === 1) {
    const commit = projected < -width * 0.3 || vSec < -550;
    if (commit) obContinue();                 // validated + saved handoff
  }
}

function obGestureCancel(e) {
  const g = obDrag;
  if (!g || e.pointerId !== g.id) return;
  const dragEl = g.dragEl, preview = g.preview, allowed = g.allowed, dir = g.dir;
  obGestureTeardown();
  if (dir === -1 && allowed) obGestureSettleBack(dragEl, preview, 0);
  else obGestureReset(dragEl);
}

// Remove listeners / release capture but leave any presentation to the settle.
function obGestureTeardown() {
  const g = obDrag;
  if (!g) return;
  g.body.removeEventListener("pointermove", obGestureMove);
  g.body.removeEventListener("pointerup", obGestureEnd);
  g.body.removeEventListener("pointercancel", obGestureCancel);
  try { g.body.releasePointerCapture(g.id); } catch (err) {}
  obDrag = null;
}

// Velocity-aware duration so the settle starts at ~the release speed (no seam).
function obSettleDuration(remaining, vSec) {
  const speed = Math.max(Math.abs(vSec), 60);
  return Math.max(140, Math.min(460, Math.abs(remaining) / speed * 1000));
}

function obGestureReset(dragEl) {
  if (!dragEl) return;
  const body = document.getElementById("ob2Body");
  const from = obPresentationX(dragEl);
  const finish = () => {
    dragEl.style.transform = ""; dragEl.style.position = "";
    dragEl.style.inset = ""; dragEl.style.willChange = "";
    if (body) body.classList.remove("ob2-transitioning");
  };
  if (!obCanAnimate(dragEl) || Math.abs(from) < 1) { finish(); return; }
  const anim = dragEl.animate(
    [{ transform: `translateX(${from}px)` }, { transform: "translateX(0)" }],
    { duration: obSettleDuration(from, 0), easing: OB_EASE_OUT, fill: "both" });
  anim.onfinish = () => { try { anim.cancel(); } catch (e) {} finish(); };
}

// Release near the start → spring both back to the original screen.
function obGestureSettleBack(dragEl, preview, vSec) {
  const body = document.getElementById("ob2Body");
  const fromEl = obPresentationX(dragEl);
  const fromPrev = preview ? obPresentationX(preview) : 0;
  const width = body ? (body.clientWidth || 360) : 360;
  const cleanup = () => {
    if (preview && preview.parentNode) preview.remove();
    if (dragEl) {
      dragEl.style.transform = ""; dragEl.style.position = "";
      dragEl.style.inset = ""; dragEl.style.willChange = "";
    }
    if (body) body.classList.remove("ob2-transitioning");
  };
  if (!obCanAnimate(dragEl)) { cleanup(); return; }
  const dur = obSettleDuration(fromEl, vSec);
  const a1 = dragEl.animate(
    [{ transform: `translateX(${fromEl}px)` }, { transform: "translateX(0)" }],
    { duration: dur, easing: OB_EASE_OUT, fill: "both" });
  if (preview) preview.animate(
    [{ transform: `translateX(${fromPrev}px)` }, { transform: `translateX(${-width}px)` }],
    { duration: dur, easing: OB_EASE_OUT, fill: "both" });
  a1.onfinish = () => { try { a1.cancel(); } catch (e) {} cleanup(); };
}

// Release past threshold → complete the back navigation from the current spot.
function obGestureCommitBack(dragEl, preview, vSec) {
  const body = document.getElementById("ob2Body");
  const width = body ? (body.clientWidth || 360) : 360;
  const fromEl = obPresentationX(dragEl);
  const fromPrev = preview ? obPresentationX(preview) : -width;

  const settleIndex = obStepIndex - 1;
  const finalize = () => {
    obStepIndex = settleIndex;
    if (dragEl && dragEl.parentNode) dragEl.remove();
    if (preview) {
      preview.style.transform = ""; preview.style.position = "";
      preview.style.inset = ""; preview.style.willChange = "";
    }
    if (body) body.classList.remove("ob2-transitioning");
    obMode = "screen";
    obApplyChrome(settleIndex);
    obMessage("");
  };
  if (!obCanAnimate(preview)) { finalize(); return; }
  const remaining = width - fromEl;
  const dur = obSettleDuration(remaining, vSec);
  dragEl.animate(
    [{ transform: `translateX(${fromEl}px)`, opacity: 1 },
     { transform: `translateX(${width}px)`, opacity: 0 }],
    { duration: dur, easing: OB_EASE_OUT, fill: "both" });
  const a = preview.animate(
    [{ transform: `translateX(${fromPrev}px)` }, { transform: "translateX(0)" }],
    { duration: dur, easing: OB_EASE_OUT, fill: "both" });
  a.onfinish = () => { try { a.cancel(); } catch (e) {} finalize(); };
}

function obInstallGesture() {
  const body = document.getElementById("ob2Body");
  if (!body || body.dataset.obGesture === "1") return;
  body.dataset.obGesture = "1";
  body.addEventListener("pointerdown", obGestureStart);
}

/* ─────────────────────────── wiring ─────────────────────────────────── */

function setupOnboardingInterface() {
  const cont = document.getElementById("ob2Continue");
  const back = document.getElementById("ob2Back");
  // Use dispatchers so the same buttons work for both flows
  if (cont) cont.addEventListener("click", obContinueDispatch);
  if (back) back.addEventListener("click", obBackDispatch);
  obInstallGesture();
}

window.startOnboarding = startAthlevoOnboarding;
window.startAthlevoOnboarding = startAthlevoOnboarding;
window.AthlevoOnboarding = { setUnits: obSetUnits, units: obUnits,
  normalizeDistance: obNormalizeDistance, convert: OB_CONVERT,
  clearIntent: obClearIntent,
  coachPublicAccessEnabled: obCoachPublicAccessEnabled };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupOnboardingInterface);
} else {
  setupOnboardingInterface();
}

console.log("Athlevo Readiness Loaded");

/*
 * Daily Readiness — coaching input the athlete gives before training.
 * Stored directly in the user-owned daily_readiness table via the verified
 * Supabase session and RLS (no service credential in the browser). One record
 * per Manila calendar day; a repeated submit upserts.
 * Nothing here fabricates a readiness/HRV/recovery score — it only
 * captures and reflects the athlete's own answers.
 */

const READINESS_SLEEP_OPTIONS = [
  { value: 1, label: "Very poor" },
  { value: 2, label: "Poor" },
  { value: 3, label: "Fair" },
  { value: 4, label: "Good" },
  { value: 5, label: "Excellent" }
];

const READINESS_SLEEP_LABELS = {
  1: "Very poor",
  2: "Poor",
  3: "Fair",
  4: "Good",
  5: "Excellent"
};

const READINESS_SCALES = [
  { key: "energy", label: "Energy", low: "Empty", high: "Full" },
  { key: "muscle_soreness", label: "Muscle soreness", low: "None", high: "Severe" },
  { key: "mental_stress", label: "Mental stress", low: "Calm", high: "Very high" }
];

let readinessDraft = {};
let readinessSubmitting = false;
let todayReadinessRecord = null;
let readinessOpenContext = null;

function readinessEscape(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* Asia/Manila calendar day (YYYY-MM-DD), shared with AthlevoCalendar. */
function readinessTodayKey(now = new Date()) {
  try {
    if (
      window.AthlevoCalendar &&
      typeof window.AthlevoCalendar.localCivil === "function"
    ) {
      const civil = window.AthlevoCalendar.localCivil(now, "Asia/Manila");
      return (
        `${civil.y}-` +
        `${String(civil.m).padStart(2, "0")}-` +
        `${String(civil.d).padStart(2, "0")}`
      );
    }
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
  } catch (error) {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/*
 * Authoritative daily lookup. `getUser()` verifies the current JWT with
 * Supabase; the RLS query is additionally scoped to that verified user.
 * Callers can distinguish "no row" from "not verified", so the automatic
 * prompt never flashes during a failed or still-pending lookup.
 */
async function verifyTodayReadiness(dayKey = readinessTodayKey()) {
  try {
    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return {
        verified: false,
        user: null,
        dayKey,
        record: null,
        reason: userError ? "auth_error" : "signed_out"
      };
    }

    const { data, error } = await supabaseClient
      .from("daily_readiness")
      .select("*")
      .eq("user_id", user.id)
      .eq("readiness_date", dayKey)
      .maybeSingle();

    if (error) {
      console.error("Could not load today's readiness:", error);
      return {
        verified: false,
        user,
        dayKey,
        record: null,
        reason: "query_error"
      };
    }

    // Authentication can change while the network query is in flight (logout
    // or account switch in another tab). Confirm the same verified owner
    // before exposing the result to the prompt coordinator.
    const {
      data: { user: currentUser },
      error: currentUserError
    } = await supabaseClient.auth.getUser();
    if (
      currentUserError ||
      !currentUser ||
      currentUser.id !== user.id
    ) {
      return {
        verified: false,
        user: null,
        dayKey,
        record: null,
        reason: "session_changed"
      };
    }

    todayReadinessRecord = data || null;
    return {
      verified: true,
      user,
      dayKey,
      record: todayReadinessRecord,
      reason: data ? "completed" : "incomplete"
    };
  } catch (error) {
    console.error("Readiness load failed:", error);
    return {
      verified: false,
      user: null,
      dayKey,
      record: null,
      reason: "query_error"
    };
  }
}

async function loadTodayReadiness() {
  const result = await verifyTodayReadiness(readinessTodayKey());
  if (!result.verified) {
    return null;
  }
  return result.record;
}

/* Factual one-line summary of the athlete's own answers (no score). */
function readinessSummaryLine(record) {
  if (!record) {
    return "";
  }

  const bits = [];

  const sleep = Number(record.sleep_quality);
  if (READINESS_SLEEP_LABELS[sleep]) {
    bits.push(`Sleep ${READINESS_SLEEP_LABELS[sleep]}`);
  }

  const energy = Number(record.energy);
  if (Number.isFinite(energy) && energy > 0) bits.push(`Energy ${energy}/10`);

  const soreness = Number(record.muscle_soreness);
  if (Number.isFinite(soreness) && soreness > 0) {
    bits.push(`Soreness ${soreness}/10`);
  }

  const stress = Number(record.mental_stress);
  if (Number.isFinite(stress) && stress > 0) bits.push(`Stress ${stress}/10`);

  if (record.pain_present === true) {
    const location =
      typeof record.pain_location === "string" && record.pain_location.trim()
        ? record.pain_location.trim()
        : "";
    bits.push(location ? `Pain: ${location}` : "Pain reported");
  }

  return bits.join(" · ");
}

/* ─── readiness score (client mirror of lib/server/readiness.js) ── */

const READINESS_STATUS_META = {
  low: { label: "Low", color: "var(--bad,#c0272d)" },
  moderate: { label: "Moderate", color: "var(--warn,#c98a1e)" },
  good: { label: "Good", color: "#d4a318" },
  optimal: { label: "Optimal", color: "var(--good,#1f9d5b)" }
};

function rdClamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function readinessStatusFromScore(score) {
  if (!Number.isFinite(Number(score))) return "insufficient";
  const s = Number(score);
  if (s < 40) return "low";
  if (s < 60) return "moderate";
  if (s < 80) return "good";
  return "optimal";
}

/* Identical math to computeReadinessScore in lib/server/readiness.js. */
function computeReadinessScore(inputs) {
  const i = inputs || {};
  const components = [];

  const sleep = rdClamp(i.sleep, 1, 5);
  if (sleep !== null) components.push({ key: "sleep", good: (sleep - 1) / 4, weight: 0.3 });

  const energy = rdClamp(i.energy, 1, 10);
  if (energy !== null) components.push({ key: "energy", good: (energy - 1) / 9, weight: 0.25 });

  const soreness = rdClamp(i.soreness, 1, 10);
  if (soreness !== null) components.push({ key: "soreness", good: (10 - soreness) / 9, weight: 0.25 });

  const stress = rdClamp(i.stress, 1, 10);
  if (stress !== null) components.push({ key: "stress", good: (10 - stress) / 9, weight: 0.2 });

  if (components.length < 2) {
    return {
      sufficient: false,
      score: null,
      status: "insufficient",
      color: null,
      explanation:
        "Complete today's morning check-in so Athlevo can calculate your readiness.",
      drivers: { positive: [], negative: [] }
    };
  }

  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const base = components.reduce((a, c) => a + c.good * c.weight, 0) / totalWeight;

  const painPresent = i.painPresent === true;
  let painPenalty = 0;
  if (painPresent) {
    const severity = rdClamp(i.painSeverity, 1, 10);
    painPenalty = Math.min(0.35, 0.1 + (severity === null ? 5 : severity) * 0.025);
  }

  let adjustment = 0;
  const negativeDrivers = [];
  const positiveDrivers = [];

  if (i.yesterdayHard === true) {
    adjustment -= 0.08;
    negativeDrivers.push("yesterday's hard session");
  }
  const completion = rdClamp(i.recentCompletionRate, 0, 1);
  if (completion !== null && completion >= 0.85 && !painPresent) {
    adjustment += 0.04;
    positiveDrivers.push("consistent recent training");
  }
  const skips = rdClamp(i.recentSkips, 0, 100);
  if (skips !== null && skips >= 2) {
    adjustment -= 0.04;
    negativeDrivers.push("missed sessions recently");
  }
  if (i.acuteSpike === true) {
    adjustment -= 0.06;
    negativeDrivers.push("a sharp jump in recent load");
  }

  const score = Math.round(
    Math.min(1, Math.max(0, base - painPenalty + adjustment)) * 100
  );

  const label = {
    sleep: { pos: "good sleep", neg: "poor sleep" },
    energy: { pos: "strong energy", neg: "low energy" },
    soreness: { pos: "low soreness", neg: "high soreness" },
    stress: { pos: "low stress", neg: "high stress" }
  };

  components
    .slice()
    .sort((a, b) => b.good - a.good)
    .forEach(c => {
      if (c.good >= 0.7) positiveDrivers.unshift(label[c.key].pos);
      else if (c.good <= 0.4) negativeDrivers.unshift(label[c.key].neg);
    });

  if (painPresent) negativeDrivers.unshift("reported pain (handled cautiously)");

  const status = readinessStatusFromScore(score);
  const pos = positiveDrivers.slice(0, 2);
  const neg = negativeDrivers.slice(0, 2);
  const cap = t => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  const join = arr => (arr.length === 2 ? `${arr[0]} and ${arr[1]}` : arr[0]);

  let explanation;
  if (pos.length && neg.length) explanation = `${cap(join(pos))} help today; ${join(neg)} pull it down.`;
  else if (pos.length) explanation = `${cap(join(pos))} carry today's readiness.`;
  else if (neg.length) explanation = `${cap(join(neg))} weigh on today's readiness.`;
  else {
    explanation = {
      optimal: "Your check-in points to a fresh, ready day.",
      good: "Your check-in points to a solid day.",
      moderate: "Your check-in shows a middling day — train, but stay honest.",
      low: "Your check-in shows you're under-recovered today."
    }[status];
  }

  return {
    sufficient: true,
    score,
    status,
    color: READINESS_STATUS_META[status].color,
    drivers: { positive: pos, negative: neg },
    explanation
  };
}

/* ─── objective training signals (real data only) ─────────────── */

function readinessDateKeyOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

function localDateKey(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

async function gatherTrainingSignals() {
  const signals = {
    yesterdayHard: false,
    recentCompletionRate: null,
    recentSkips: 0
  };

  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) return signals;

    const { data, error } = await supabaseClient
      .from("workout_execution_records")
      .select(
        "status,actual_rpe,completed_at,updated_at,original_session_snapshot"
      )
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (error || !Array.isArray(data)) return signals;

    const yesterdayKey = readinessDateKeyOffset(-1);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

    let completed = 0;
    let planned = 0;

    data.forEach(r => {
      const snap = r.original_session_snapshot || {};
      const when = r.completed_at || r.updated_at;
      const whenKey = localDateKey(when);

      if (snap.session_date === yesterdayKey || whenKey === yesterdayKey) {
        const rpe = Number(r.actual_rpe);
        const dur = Number(snap.duration_minutes);
        const type = String(snap.session_type || "").toLowerCase();
        if (
          (r.status === "completed" || r.status === "modified") &&
          (rpe >= 8 ||
            dur >= 90 ||
            /long|threshold|interval|tempo/.test(type))
        ) {
          signals.yesterdayHard = true;
        }
      }

      const when2 = when ? new Date(when) : null;
      if (when2 && when2 >= sevenDaysAgo) {
        if (r.status === "completed" || r.status === "modified") {
          completed += 1;
          planned += 1;
        } else if (r.status === "skipped") {
          signals.recentSkips += 1;
          planned += 1;
        }
      }
    });

    signals.recentCompletionRate = planned ? completed / planned : null;
  } catch (error) {
    console.error("Could not gather training signals:", error);
  }

  return signals;
}

/*
 * Computes today's readiness from the athlete's check-in + real training
 * signals. Returns an "insufficient" result (no invented number) when the
 * morning check-in has not been logged.
 */
async function computeTodayReadiness(record) {
  if (!record) {
    return computeReadinessScore({});
  }

  const signals = await gatherTrainingSignals();

  return computeReadinessScore({
    sleep: record.sleep_quality,
    energy: record.energy,
    soreness: record.muscle_soreness,
    stress: record.mental_stress,
    painPresent: record.pain_present === true,
    painSeverity: record.pain_severity,
    yesterdayHard: signals.yesterdayHard,
    recentCompletionRate: signals.recentCompletionRate,
    recentSkips: signals.recentSkips
  });
}

/* Drives the Today ring: score, smooth animation, and colour by status. */
function updateReadinessRing(scored) {
  const root = document.getElementById("readinessEmptyState");
  if (!root) return;

  const fill = root.querySelector(".ring .fill");
  const centerNum = root.querySelector(".ring .center b");
  const centerLabel = root.querySelector(".ring .center i");

  if (scored && scored.sufficient) {
    if (fill) {
      fill.dataset.value = String(scored.score);
      fill.style.stroke = scored.color;
    }
    if (centerNum) centerNum.textContent = String(scored.score);
    if (centerLabel) centerLabel.textContent = "Readiness";
  } else {
    if (fill) {
      delete fill.dataset.value;
      fill.style.stroke = "";
      fill.style.strokeDashoffset = "326.7";
    }
    if (centerNum) centerNum.textContent = "—";
    if (centerLabel) centerLabel.textContent = "Readiness";
  }

  if (typeof animateRing === "function") {
    animateRing();
  }
}

let todayReadinessScored = null;

/*
 * Renders the Today readiness card: the calculated ring, status,
 * short explanation, and an Edit/Start button. Never a fabricated number.
 */
async function renderReadinessCard() {
  const record = await loadTodayReadiness();
  const scored = await computeTodayReadiness(record);
  todayReadinessScored = scored;

  updateReadinessRing(scored);

  const cta = document.getElementById("readinessCta");
  if (!cta) return scored;

  const title = document.getElementById("readinessTitle");
  const copy = document.getElementById("readinessCopy");

  if (record && scored.sufficient) {
    const meta = READINESS_STATUS_META[scored.status];
    if (title) title.textContent = "Today's readiness";
    if (copy) {
      copy.innerHTML =
        `<b class="rd-status" style="color:${meta.color}">${readinessEscape(meta.label)}</b>` +
        ` — ${readinessEscape(scored.explanation)}`;
    }
    cta.innerHTML =
      '<button class="readiness-btn" type="button" onclick="openReadinessCheck()">Edit today’s readiness</button>';
  } else {
    if (title) title.textContent = "Daily readiness";
    if (copy) {
      copy.textContent =
        "A 30-second check so Athlevo can coach today using how you actually feel — not just your watch.";
    }
    cta.innerHTML =
      '<button class="readiness-btn primary" type="button" onclick="openReadinessCheck()">Start readiness check</button>';
  }
}

/*
 * Today's readiness shaped for the coach: the athlete's answers plus the
 * calculated score/status/explanation (or null when not logged). No
 * fabricated HRV or recovery values.
 */
async function getReadinessForCoach() {
  const record = await loadTodayReadiness();
  if (!record) return null;

  const scored = todayReadinessScored || (await computeTodayReadiness(record));

  const sleepLabels = READINESS_SLEEP_LABELS;
  const out = { date: record.readiness_date || null };

  if (sleepLabels[record.sleep_quality]) {
    out.sleepQuality = sleepLabels[record.sleep_quality];
    out.sleepQuality1to5 = Number(record.sleep_quality);
  }
  if (Number(record.energy) > 0) out.energy1to10 = Number(record.energy);
  if (Number(record.muscle_soreness) > 0) out.muscleSoreness1to10 = Number(record.muscle_soreness);
  if (Number(record.mental_stress) > 0) out.mentalStress1to10 = Number(record.mental_stress);
  if (record.pain_present === true) {
    out.painPresent = true;
    if (record.pain_location) out.painLocation = record.pain_location;
    if (Number(record.pain_severity) > 0) out.painSeverity1to10 = Number(record.pain_severity);
  }
  if (record.notes) out.notes = record.notes;

  if (scored.sufficient) {
    out.readinessScore = scored.score;
    out.readinessStatus = READINESS_STATUS_META[scored.status].label;
    out.readinessExplanation = scored.explanation;
  }

  return out;
}

function readinessFirstName(fallback) {
  const explicit = String(fallback || "").trim();
  if (explicit) return explicit.split(/\s+/)[0];
  const todayName = document.getElementById("todayAthleteName");
  const visible = todayName ? String(todayName.textContent || "").trim() : "";
  return visible && visible.toLowerCase() !== "athlete"
    ? visible.split(/\s+/)[0]
    : "Athlete";
}

function openReadinessCheck(options = {}) {
  const modal = document.getElementById("readinessModal");

  if (!modal || !window.AthlevoSheet) {
    return false;
  }
  const sheetPhase = window.AthlevoSheet.phase(modal);
  if (sheetPhase === "opening" || sheetPhase === "open") return false;
  if (sheetPhase === "closing") {
    window.AthlevoSheet.open({ root: modal });
    return true;
  }

  const existing = todayReadinessRecord || null;
  const automatic = options.automatic === true;
  const firstName = readinessFirstName(options.firstName);
  readinessOpenContext = {
    automatic,
    source: options.source || (automatic ? "morning_prompt" : "manual"),
    onDismiss: typeof options.onDismiss === "function"
      ? options.onDismiss
      : null,
    dismissed: false
  };

  readinessSubmitting = false;
  readinessDraft = {
    sleep_quality: Number(existing?.sleep_quality) || null,
    energy: Number(existing?.energy) || null,
    muscle_soreness: Number(existing?.muscle_soreness) || null,
    mental_stress: Number(existing?.mental_stress) || null,
    pain_present: existing?.pain_present === true,
    pain_severity: Number(existing?.pain_severity) || null
  };

  const sleepChips = READINESS_SLEEP_OPTIONS.map(
    option =>
      `<button class="ob-chip" type="button" data-rd="sleep_quality" data-value="${option.value}" aria-pressed="${
        readinessDraft.sleep_quality === option.value ? "true" : "false"
      }"${
        readinessDraft.sleep_quality === option.value ? ' data-sel="1"' : ""
      }>${readinessEscape(option.label)}</button>`
  ).join("");

  const scaleRows = READINESS_SCALES.map(scale => {
    const labelId = `rd-${scale.key}-label`;
    const dots = [];
    for (let value = 1; value <= 10; value += 1) {
      dots.push(
        `<button class="ci-dot" type="button" data-rd="${scale.key}" data-value="${value}" aria-label="${readinessEscape(scale.label)} ${value} of 10" aria-pressed="${
          readinessDraft[scale.key] === value ? "true" : "false"
        }"${
          readinessDraft[scale.key] === value ? ' data-sel="1"' : ""
        }>${value}</button>`
      );
    }
    return `
      <div class="ci-row">
        <div class="ci-label" id="${labelId}">${readinessEscape(scale.label)}</div>
        <div class="ci-scale rd-scale" role="group" aria-labelledby="${labelId}">${dots.join("")}</div>
        <div class="ci-hints"><span>${readinessEscape(scale.low)}</span><span>${readinessEscape(scale.high)}</span></div>
      </div>
    `;
  }).join("");

  const painLocation = readinessEscape(existing?.pain_location || "");

  modal.innerHTML = `
    <div class="lesson rd-sheet" role="dialog" aria-modal="true" aria-labelledby="rdTitle" aria-describedby="rdDescription">
      <p class="rd-greeting">Good morning, ${readinessEscape(firstName)}</p>
      <h3 class="serif" id="rdTitle" tabindex="-1">How are you feeling today?</h3>
      <p class="rd-why" id="rdDescription">Your answers help Athlevo adjust today’s recommendation.</p>

      <div class="ci-row">
        <div class="ci-label" id="rd-sleep-label">Sleep quality</div>
        <div class="ci-chips" role="group" aria-labelledby="rd-sleep-label">${sleepChips}</div>
      </div>

      ${scaleRows}

      <div class="ci-row">
        <div class="ci-label" id="rd-pain-label">Any pain?</div>
        <div class="ci-chips" role="group" aria-labelledby="rd-pain-label">
          <button class="ob-chip" type="button" data-rd="pain_present" data-value="no" aria-pressed="${
            readinessDraft.pain_present ? "false" : "true"
          }"${
            readinessDraft.pain_present ? "" : ' data-sel="1"'
          }>No</button>
          <button class="ob-chip" type="button" data-rd="pain_present" data-value="yes" aria-pressed="${
            readinessDraft.pain_present ? "true" : "false"
          }"${
            readinessDraft.pain_present ? ' data-sel="1"' : ""
          }>Yes</button>
        </div>
        <div id="rdPainDetail" style="${readinessDraft.pain_present ? "" : "display:none"}">
          <label class="ci-label rd-field-label" for="rdPainLocation">Pain location</label>
          <input id="rdPainLocation" class="ci-input" type="text" placeholder="Where does it hurt?" value="${painLocation}">
          <div class="ci-label" id="rd-pain-severity-label" style="margin-top:10px">Severity (1–10)</div>
          <div class="ci-scale rd-scale rd-pain-scale" role="group" aria-labelledby="rd-pain-severity-label"></div>
        </div>
      </div>

      <div class="ci-row">
        <label class="ci-label" for="rdNotes">Anything important today?</label>
        <textarea id="rdNotes" class="ci-input" placeholder="e.g. traveling, race today, bad stomach, busy at work">${readinessEscape(existing?.notes || "")}</textarea>
      </div>

      <p class="ci-msg" id="rdMsg" role="alert" aria-live="polite"></p>

      <div class="rd-actions">
        <button class="lesson-done" type="button" id="rdSubmit">Save check-in</button>
        <button class="rd-secondary" type="button" id="rdDismiss">${automatic ? "Not now" : "Cancel"}</button>
      </div>
    </div>
  `;

  renderReadinessPainScale(modal);
  wireReadinessSheet(modal);

  window.AthlevoSheet.open({
    root: modal,
    sheet: ".rd-sheet",
    draggable: true,
    initialFocus: '[data-rd="sleep_quality"]',
    closeOnEscape: true,
    closeOnBackdrop: true,
    fallbackFocus: ".rd-settings-link, #tabbar .tab.on",
    onRequestClose: () => {
      closeReadinessCheck({ dismiss: Boolean(readinessOpenContext?.automatic) });
      return false;
    },
    onAfterClose: () => {
      modal.innerHTML = "";
      readinessSubmitting = false;
      readinessOpenContext = null;
    }
  });
  return true;
}

function renderReadinessPainScale(modal) {
  const container = modal.querySelector(".rd-pain-scale");
  if (!container) {
    return;
  }

  const dots = [];
  for (let value = 1; value <= 10; value += 1) {
    dots.push(
      `<button class="ci-dot" type="button" data-rd="pain_severity" data-value="${value}" aria-label="Pain severity ${value} of 10" aria-pressed="${
        readinessDraft.pain_severity === value ? "true" : "false"
      }"${
        readinessDraft.pain_severity === value ? ' data-sel="1"' : ""
      }>${value}</button>`
    );
  }
  container.innerHTML = dots.join("");
  applyReadinessSelection(modal);
}

function applyReadinessSelection(modal) {
  modal
    .querySelectorAll(".ci-dot[data-sel], .ob-chip[data-sel]")
    .forEach(el => el.classList.add("sel"));
}

function wireReadinessSheet(modal) {
  applyReadinessSelection(modal);

  modal.querySelectorAll("[data-rd]").forEach(el => {
    el.addEventListener("click", () => {
      const key = el.dataset.rd;
      const raw = el.dataset.value;

      if (key === "pain_present") {
        const hasPain = raw === "yes";
        readinessDraft.pain_present = hasPain;
        const detail = modal.querySelector("#rdPainDetail");
        if (detail) {
          detail.style.display = hasPain ? "block" : "none";
        }
      } else {
        readinessDraft[key] = Number(raw);
      }

      modal
        .querySelectorAll(`[data-rd="${key}"]`)
        .forEach(other => {
          const selected = other === el;
          other.classList.toggle("sel", selected);
          other.setAttribute("aria-pressed", selected ? "true" : "false");
        });
    });
  });

  const submit = modal.querySelector("#rdSubmit");
  if (submit) {
    submit.addEventListener("click", submitReadiness);
  }
  const dismiss = modal.querySelector("#rdDismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      closeReadinessCheck({
        dismiss: Boolean(readinessOpenContext?.automatic)
      });
    });
  }
}

function closeReadinessCheck(options = {}) {
  const modal = document.getElementById("readinessModal");
  const context = readinessOpenContext;
  if (
    options.dismiss === true &&
    context?.automatic &&
    context.dismissed !== true
  ) {
    context.dismissed = true;
    if (typeof context.onDismiss === "function") {
      try {
        context.onDismiss();
      } catch (error) {
        console.warn("Readiness dismissal could not be recorded.");
      }
    }
  }
  if (!modal || !window.AthlevoSheet) return;
  window.AthlevoSheet.close(modal, {
    immediate: options.immediate === true,
    onAfterClose: () => {
      modal.innerHTML = "";
      readinessSubmitting = false;
      readinessOpenContext = null;
    }
  });
}

async function submitReadiness() {
  if (readinessSubmitting) {
    return;
  }

  const message = document.getElementById("rdMsg");
  const submit = document.getElementById("rdSubmit");

  const required = ["sleep_quality", "energy", "muscle_soreness", "mental_stress"];
  const missing = required.filter(
    key => !Number.isFinite(readinessDraft[key])
  );

  if (missing.length || readinessDraft.pain_present == null) {
    if (message) {
      message.textContent = "Please answer the quick questions first.";
    }
    return;
  }

  const painPresent = readinessDraft.pain_present === true;
  const painLocationEl = document.getElementById("rdPainLocation");
  const notesEl = document.getElementById("rdNotes");

  readinessSubmitting = true;
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Saving...";
  }
  if (message) {
    message.textContent = "";
  }

  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      throw new Error("Please log in again to save your readiness.");
    }

    const row = {
      user_id: user.id,
      readiness_date: readinessTodayKey(),
      sleep_quality: readinessDraft.sleep_quality,
      energy: readinessDraft.energy,
      muscle_soreness: readinessDraft.muscle_soreness,
      mental_stress: readinessDraft.mental_stress,
      pain_present: painPresent,
      pain_location:
        painPresent && painLocationEl
          ? painLocationEl.value.trim() || null
          : null,
      pain_severity:
        painPresent && Number.isFinite(readinessDraft.pain_severity)
          ? readinessDraft.pain_severity
          : null,
      notes: notesEl ? notesEl.value.trim() || null : null,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseClient
      .from("daily_readiness")
      .upsert(row, { onConflict: "user_id,readiness_date" });

    if (error) {
      throw new Error(error.message || "Your readiness could not be saved.");
    }

    todayReadinessRecord = row;
    const submissionSource = readinessOpenContext?.source || "manual";
    if (
      window.AthlevoMorningCheckIn &&
      typeof window.AthlevoMorningCheckIn.markCompleted === "function"
    ) {
      window.AthlevoMorningCheckIn.markCompleted(
        user.id,
        row.readiness_date
      );
    }

    try {
      if (window.AthlevoProductAnalytics) {
        window.AthlevoProductAnalytics.trackAthlevoEvent(
          "readiness_check_completed",
          {
            source: submissionSource,
            completion_status: "completed"
          }
        );
      }
    } catch (error) {}

    closeReadinessCheck();

    if (typeof toast === "function") {
      toast("Readiness saved");
    }

    await renderReadinessCard();
    if (typeof window.renderTodayPassiveStatus === "function") {
      await window.renderTodayPassiveStatus(null);
    }
    if (typeof window.refreshTodayAfterPlanChange === "function") {
      await window.refreshTodayAfterPlanChange("readiness-check");
    }
    try {
      window.dispatchEvent(
        new CustomEvent("athlevo:readiness-completed", {
          detail: {
            source: submissionSource,
            completionStatus: "completed"
          }
        })
      );
    } catch (error) {}
  } catch (error) {
    console.error("Readiness submit failed:", error);
    readinessSubmitting = false;

    if (message) {
      message.textContent =
        error.message || "Your readiness could not be saved.";
    }
    if (submit) {
      submit.disabled = false;
      submit.textContent = "Save check-in";
    }
  }
}

window.renderReadinessCard = renderReadinessCard;
window.openReadinessCheck = openReadinessCheck;
window.closeReadinessCheck = closeReadinessCheck;
window.loadTodayReadiness = loadTodayReadiness;
window.verifyTodayReadiness = verifyTodayReadiness;
window.readinessTodayKey = readinessTodayKey;
window.getReadinessForCoach = getReadinessForCoach;

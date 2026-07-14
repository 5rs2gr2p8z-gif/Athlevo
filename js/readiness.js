console.log("Athlevo Readiness Loaded");

/*
 * Daily Readiness — coaching input the athlete gives before training.
 * Stored directly in the user-owned daily_readiness table via RLS (no API
 * endpoint). One record per calendar day; a repeated submit upserts.
 * Nothing here fabricates a readiness/HRV/recovery score — it only
 * captures and reflects the athlete's own answers.
 */

const READINESS_PHILOSOPHY =
  "Your watch measures your body. Only you know how your body actually " +
  "feels. Daily Readiness combines objective training data with how you " +
  "actually feel today so Athlevo can make better coaching decisions.";

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

function readinessEscape(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* Local calendar day (YYYY-MM-DD) — matches the athlete's "today". */
function readinessTodayKey() {
  const d = new Date();
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

async function loadTodayReadiness() {
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      return null;
    }

    const { data, error } = await supabaseClient
      .from("daily_readiness")
      .select("*")
      .eq("user_id", user.id)
      .eq("readiness_date", readinessTodayKey())
      .maybeSingle();

    if (error) {
      console.error("Could not load today's readiness:", error);
      return null;
    }

    todayReadinessRecord = data || null;
    return todayReadinessRecord;
  } catch (error) {
    console.error("Readiness load failed:", error);
    return null;
  }
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

/*
 * Renders the readiness entry point on the Today card: a Start button, or
 * the logged summary + an Edit button. Never shows a fabricated number.
 */
async function renderReadinessCard() {
  const cta = document.getElementById("readinessCta");

  if (!cta) {
    return;
  }

  const record = await loadTodayReadiness();

  const title = document.getElementById("readinessTitle");
  const copy = document.getElementById("readinessCopy");

  if (record) {
    if (title) title.textContent = "Today's readiness";
    if (copy) {
      copy.textContent =
        readinessSummaryLine(record) || "Logged for today.";
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

function openReadinessCheck() {
  const modal = document.getElementById("readinessModal");

  if (!modal) {
    return;
  }

  const existing = todayReadinessRecord || null;

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
      `<button class="ob-chip" type="button" data-rd="sleep_quality" data-value="${option.value}"${
        readinessDraft.sleep_quality === option.value ? ' data-sel="1"' : ""
      }>${readinessEscape(option.label)}</button>`
  ).join("");

  const scaleRows = READINESS_SCALES.map(scale => {
    const dots = [];
    for (let value = 1; value <= 10; value += 1) {
      dots.push(
        `<button class="ci-dot" type="button" data-rd="${scale.key}" data-value="${value}"${
          readinessDraft[scale.key] === value ? ' data-sel="1"' : ""
        }>${value}</button>`
      );
    }
    return `
      <div class="ci-row">
        <div class="ci-label">${readinessEscape(scale.label)}</div>
        <div class="ci-scale rd-scale">${dots.join("")}</div>
        <div class="ci-hints"><span>${readinessEscape(scale.low)}</span><span>${readinessEscape(scale.high)}</span></div>
      </div>
    `;
  }).join("");

  const painLocation = readinessEscape(existing?.pain_location || "");

  modal.innerHTML = `
    <div class="lesson">
      <span class="eyebrow">Daily readiness · under 30 seconds</span>
      <h3 class="serif">How does your body feel today?</h3>
      <p class="rd-why">${readinessEscape(READINESS_PHILOSOPHY)}</p>

      <div class="ci-row">
        <div class="ci-label">Sleep quality</div>
        <div class="ci-chips">${sleepChips}</div>
      </div>

      ${scaleRows}

      <div class="ci-row">
        <div class="ci-label">Any pain?</div>
        <div class="ci-chips">
          <button class="ob-chip" type="button" data-rd="pain_present" data-value="no"${
            readinessDraft.pain_present ? "" : ' data-sel="1"'
          }>No</button>
          <button class="ob-chip" type="button" data-rd="pain_present" data-value="yes"${
            readinessDraft.pain_present ? ' data-sel="1"' : ""
          }>Yes</button>
        </div>
        <div id="rdPainDetail" style="${readinessDraft.pain_present ? "" : "display:none"}">
          <input id="rdPainLocation" class="ci-input" type="text" placeholder="Where does it hurt?" value="${painLocation}">
          <div class="ci-label" style="margin-top:10px">Severity (1–10)</div>
          <div class="ci-scale rd-scale rd-pain-scale"></div>
        </div>
      </div>

      <div class="ci-row">
        <div class="ci-label">Anything important today?</div>
        <textarea id="rdNotes" class="ci-input" placeholder="e.g. traveling, race today, bad stomach, busy at work">${readinessEscape(existing?.notes || "")}</textarea>
      </div>

      <p class="ci-msg" id="rdMsg"></p>

      <button class="lesson-done" type="button" id="rdSubmit">
        ${existing ? "Update readiness" : "Save readiness"}
      </button>
    </div>
  `;

  renderReadinessPainScale(modal);
  wireReadinessSheet(modal);

  modal.onclick = event => {
    if (event.target === modal) {
      closeReadinessCheck();
    }
  };

  modal.classList.add("show");
}

function renderReadinessPainScale(modal) {
  const container = modal.querySelector(".rd-pain-scale");
  if (!container) {
    return;
  }

  const dots = [];
  for (let value = 1; value <= 10; value += 1) {
    dots.push(
      `<button class="ci-dot" type="button" data-rd="pain_severity" data-value="${value}"${
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
        .forEach(other => other.classList.toggle("sel", other === el));
    });
  });

  const submit = modal.querySelector("#rdSubmit");
  if (submit) {
    submit.addEventListener("click", submitReadiness);
  }
}

function closeReadinessCheck() {
  const modal = document.getElementById("readinessModal");
  if (modal) {
    modal.classList.remove("show");
    modal.innerHTML = "";
  }
  readinessSubmitting = false;
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

    closeReadinessCheck();

    if (typeof toast === "function") {
      toast("Readiness saved");
    }

    await renderReadinessCard();
  } catch (error) {
    console.error("Readiness submit failed:", error);
    readinessSubmitting = false;

    if (message) {
      message.textContent =
        error.message || "Your readiness could not be saved.";
    }
    if (submit) {
      submit.disabled = false;
      submit.textContent = todayReadinessRecord
        ? "Update readiness"
        : "Save readiness";
    }
  }
}

window.renderReadinessCard = renderReadinessCard;
window.openReadinessCheck = openReadinessCheck;
window.closeReadinessCheck = closeReadinessCheck;
window.loadTodayReadiness = loadTodayReadiness;

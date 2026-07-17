async function loadWeeklyPlan() {

    const {
        data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session) {
        return;
    }

    const res = await fetch(
        "/api/training/get-week",
        {
            headers: {
                Authorization:
                    `Bearer ${session.access_token}`
            }
        }
    );

    const data = await res.json();

    // PRIMARY Train experience: the date-first calendar. It owns the week
    // strip + single selected-date panel. The old vertical per-session list
    // (renderSessions) is no longer part of the production Train layout.
    if (window.AthlevoTrainCalendar && typeof window.AthlevoTrainCalendar.open === "function") {
        window.AthlevoTrainCalendar.open(data);
    }

    // SECONDARY (collapsible "Training context" section): phase/goal header.
    if (!data.hasPlan) {
        renderNoPlan();
    } else {
        renderWeekHeader(data.plan);
    }

    currentPlanAdaptation =
        data.plan?.adaptation || null;

    loadWeeklyLoop(session.access_token);

    // Proactive coaching loop: any time the plan reloads (including right
    // after a workout is saved, modified, or auto-imported), refresh the
    // Today "Latest Workout Analysis" card in place — no page reload.
    if (typeof window.renderLatestWorkoutAnalysis === "function") {
        window.renderLatestWorkoutAnalysis();
    }

}

function renderNoPlan() {

    // Premium empty state → routes into the guided "Build My Coach" flow
    // (Athlevo sets itself up) rather than a bare "generate" button.
    const build = "window.AthlevoPlan ? AthlevoPlan.start() : generateWeek()";
    document.getElementById("trainHeader").innerHTML = `
        <div class="train-empty">
            <div class="train-empty-art"><img src="assets/athlevo-icon.png" alt="" width="56" height="56"></div>
            <h3>No training plan yet.</h3>
            <p>Let Athlevo turn your profile into a personalized, adapting plan.</p>
            <button class="primary-btn" type="button" onclick="${build}">Build My Plan</button>
        </div>
    `;

    document.getElementById("weekSessions").innerHTML = "";

}

function renderWeekHeader(plan){

    document.getElementById("trainHeader").innerHTML = `

        <div class="plan-header">

            <div class="plan-race">

                ${plan.target_race || "Training"}

            </div>

            <div class="plan-phase">

                ${plan.weeks_until_race ?? "-"} weeks until race

            </div>

            <h2>

                ${capitalize(plan.phase)}

            </h2>

            <p>

                Week ${plan.phase_week}
                of
                ${plan.phase_length_weeks}

            </p>

            <div class="week-focus">

                ${plan.week_focus}

            </div>

        </div>

    `;

}

/* ══════════════ session rendering helpers ══════════════ */

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

/*
 * Returns a clean display string, or "" when the value is
 * missing, empty, or not renderable as text. Guarantees the UI
 * never prints undefined, null, or [object Object].
 */
function cleanText(value) {

    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : "";
    }

    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();

    if (
        !trimmed ||
        trimmed === "null" ||
        trimmed === "undefined"
    ) {
        return "";
    }

    return trimmed;
}

/*
 * Converts any stored shape of warmup / main_set / cooldown /
 * adjustment_rules / instructions into a flat array of display
 * strings:
 *   - new format: array of strings
 *   - old format: object blocks like
 *     { duration_minutes, instructions } or
 *     { description, repetitions, work_duration_minutes,
 *       recovery_duration_minutes, instructions }
 *   - JSON stored as a string, or plain multi-line strings
 * Empty / meaningless values produce an empty array.
 */
function normalizeList(value) {

    if (value === null || value === undefined) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.flatMap(item => normalizeList(item));
    }

    if (typeof value === "string") {

        const trimmed = value.trim();

        if (!trimmed) {
            return [];
        }

        if (
            trimmed.startsWith("[") ||
            trimmed.startsWith("{")
        ) {
            try {
                return normalizeList(JSON.parse(trimmed));
            } catch (error) {
                /* not JSON — treat as plain text */
            }
        }

        return trimmed
            .split("\n")
            .map(line => cleanText(line))
            .filter(Boolean);
    }

    if (typeof value === "object") {
        return describeWorkoutBlock(value);
    }

    const text = cleanText(String(value));

    return text ? [text] : [];
}

/* Renders a legacy object block as human-readable lines. */
function describeWorkoutBlock(block) {

    const lines = [];

    const description = cleanText(block.description);

    if (description) {
        lines.push(description);
    }

    const repetitions = Number(block.repetitions);
    const workMinutes = Number(block.work_duration_minutes);
    const recoveryMinutes = Number(block.recovery_duration_minutes);

    if (repetitions > 0 && workMinutes > 0) {

        let structure =
            `${repetitions} × ${workMinutes} min`;

        if (recoveryMinutes > 0) {
            structure +=
                ` with ${recoveryMinutes} min recovery`;
        }

        lines.push(structure);
    }

    const durationMinutes = Number(block.duration_minutes);

    if (durationMinutes > 0) {
        lines.push(`${durationMinutes} min`);
    }

    if (Array.isArray(block.instructions)) {

        block.instructions.forEach(item => {

            const text = cleanText(item);

            if (text) {
                lines.push(text);
            }
        });
    }

    return lines;
}

/* "2026-07-14" → "Tue · Jul 14" (local, no UTC shift). */
function formatSessionDate(value) {

    const match =
        String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);

    if (!match) {
        return cleanText(value);
    }

    const date = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
    );

    const weekday = date.toLocaleDateString(
        undefined,
        { weekday: "short" }
    );

    const monthDay = date.toLocaleDateString(
        undefined,
        { month: "short", day: "numeric" }
    );

    return `${weekday} · ${monthDay}`;
}

/* "long_run" → "Long Run". */
function formatSessionType(value) {

    const text = cleanText(value);

    if (!text) {
        return "";
    }

    return text
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map(word =>
            word.charAt(0).toUpperCase() +
            word.slice(1).toLowerCase()
        )
        .join(" ");
}

/*
 * The ONE canonical workout type for a session. Everything the card
 * shows — title, badge, rest state, and which execution controls appear
 * — derives from this. We deliberately read only session_type (the
 * field a Coach action updates), never stale sport/intensity fields, so
 * a run that replaced a rest day can never keep rest identity.
 */
const REST_TYPES = new Set(["rest", "rest_day", "restday", "off", "day_off"]);

function normalizeSessionType(session) {
    const raw = cleanText(session?.session_type)
        .toLowerCase()
        .replace(/[\s-]+/g, "_");

    return raw;
}

/*
 * A session is REST only when its canonical type explicitly says so.
 * Missing/invalid type is NOT silently treated as rest — it falls back
 * to non-rest (so the athlete still gets Complete/Modify/Skip) and logs
 * a non-sensitive diagnostic.
 */
function isRestSession(session) {

    const type = normalizeSessionType(session);

    if (!type) {
        console.warn(
            "Train: session has no canonical session_type; " +
            "treating as non-rest.",
            { id: session?.id || null, date: session?.session_date || null }
        );
        return false;
    }

    return REST_TYPES.has(type);
}

function shortenText(text, maxLength = 96) {

    if (text.length <= maxLength) {
        return text;
    }

    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");

    return (
        cut.slice(0, lastSpace > 40 ? lastSpace : maxLength)
            .replace(/[,;.\s]+$/, "") + "…"
    );
}

/*
 * Builds the ordered list of expanded sections. Sections with no
 * real content are skipped entirely, so rest days and older
 * sparse sessions never show empty blocks.
 */
function buildDetailSections(session) {

    const sections = [];

    const addText = (label, value, modifier) => {

        const text = cleanText(value);

        if (text) {
            sections.push({
                label,
                text,
                items: [],
                modifier: modifier || ""
            });
        }
    };

    const addList = (label, value) => {

        const items = normalizeList(value);

        if (items.length) {
            sections.push({
                label,
                text: "",
                items,
                modifier: ""
            });
        }
    };

    addText("Purpose", session.purpose);
    addList("Warm-up", session.warmup);
    addList("Main set", session.main_set);
    addList("Cooldown", session.cooldown);
    addText("Pace guidance", session.pace_guidance);
    addText("Heart-rate guidance", session.heart_rate_guidance);
    addText("RPE", session.target_rpe);
    addText("Fueling", session.fueling_guidance);

    const notesText = cleanText(session.notes);
    const instructionItems = normalizeList(session.instructions);

    if (notesText || instructionItems.length) {
        sections.push({
            label: "Execution notes",
            text: notesText,
            items: instructionItems,
            modifier: ""
        });
    }

    addList("Adjustment rules", session.adjustment_rules);
    addText("Coach reasoning", session.coach_reasoning, "reasoning");

    return sections;
}

function renderDetailSection(section) {

    const body = [];

    if (section.text) {
        body.push(
            `<p>${escapeHtml(section.text)}</p>`
        );
    }

    if (section.items.length) {
        body.push(
            `<ul class="sc-list">` +
            section.items
                .map(item => `<li>${escapeHtml(item)}</li>`)
                .join("") +
            `</ul>`
        );
    }

    const modifierClass =
        section.modifier
            ? ` sc-section-${section.modifier}`
            : "";

    return `
        <div class="sc-section${modifierClass}">
            <div class="sc-section-label">
                ${escapeHtml(section.label)}
            </div>
            ${body.join("")}
        </div>
    `;
}

/* ══════════════ session cards ══════════════ */

let currentSessions = [];

function findSessionById(sessionId) {
    return currentSessions.find(
        session => String(session.id) === String(sessionId)
    ) || null;
}

/* Visual + label mapping for an execution status. */
function getStatusMeta(status) {
    switch (status) {
        case "completed":
            return { label: "Completed", cls: "done", glyph: "✓" };
        case "modified":
            return { label: "Modified", cls: "mod", glyph: "↺" };
        case "skipped":
            return { label: "Skipped", cls: "skip", glyph: "⊘" };
        default:
            return null;
    }
}

/*
 * Rest-aware execution state. Derived ONLY from the authoritative saved
 * record's status (never from CSS or local flags). Rest days rename the
 * generic labels so a logged rest reads "Rest completed" and a rest day
 * the athlete trained on reads "Trained instead".
 */
function getExecutionState(record, rest) {
    if (!record || !record.status) {
        return null;
    }

    switch (record.status) {
        case "completed":
            return {
                status: "completed",
                cls: "done",
                glyph: "✓",
                label: rest ? "Rest completed" : "Completed"
            };
        case "modified":
            return {
                status: "modified",
                cls: "mod",
                glyph: "↺",
                label: rest ? "Trained instead" : "Modified"
            };
        case "skipped":
            return {
                status: "skipped",
                cls: "skip",
                glyph: "⊘",
                label: "Skipped"
            };
        default:
            return null;
    }
}

function renderSessions(sessions) {

    const container =
        document.getElementById("weekSessions");

    container.innerHTML = "";

    currentSessions = Array.isArray(sessions) ? sessions : [];

    sessions.forEach(rawSession => {

        // Canonical prescription: repair any label/main-set contradiction
        // (e.g. a "Foundation Run" whose main set is "3 × 8 min threshold")
        // BEFORE rendering, so the summary card and the expanded prescription
        // always describe the same session. Existing contradictory saved
        // plans are corrected here at render time (no DB write required).
        const session = (window.AthlevoPrescription && typeof window.AthlevoPrescription.repair === "function")
            ? window.AthlevoPrescription.repair(rawSession)
            : rawSession;

        const rest = isRestSession(session);
        const sections = buildDetailSections(session);
        const description = cleanText(session.description);
        const record = session.execution || null;
        const statusMeta = record
            ? getExecutionState(record, rest)
            : null;

        const hasDetail =
            sections.length > 0 || description.length > 0;

        const dateLabel =
            formatSessionDate(session.session_date);

        const typeLabel =
            rest
                ? "Rest"
                : formatSessionType(session.session_type);

        // ONE source of truth: the title derives from the canonical
        // session_type (same field that drives the badge, rest state and the
        // expanded detail). The free-text session.title is only a fallback for
        // rows with no canonical type — otherwise a stale title (e.g. "Easy +
        // Strides") could contradict an expanded "3 × 8 min Threshold".
        const title =
            typeLabel ||
            cleanText(session.title) ||
            "Session";

        const durationMinutes =
            Number(session.duration_minutes);

        const metaParts = [];

        if (durationMinutes > 0) {
            metaParts.push(
                `<b>${Math.round(durationMinutes)}</b> min`
            );
        }

        const distanceKm = Number(session.distance_km);

        if (distanceKm > 0) {
            metaParts.push(
                `<b>${distanceKm}</b> km`
            );
        }

        const purposeText = cleanText(session.purpose);

        const card = document.createElement("div");

        card.className =
            "session-card" +
            (rest ? " rest" : "") +
            (statusMeta ? ` status-${statusMeta.cls}` : "");

        card.dataset.sessionId = session.id || "";

        const headTag = hasDetail ? "button" : "div";

        card.innerHTML = `
            <${headTag}
                class="sc-head${hasDetail ? "" : " static"}"
                ${hasDetail ? 'type="button" aria-expanded="false"' : ""}>

                <div class="sc-top">
                    <span class="sc-date">${escapeHtml(dateLabel)}</span>
                    ${
                        typeLabel
                            ? `<span class="sc-badge${rest ? " rest" : ""}">${escapeHtml(typeLabel)}</span>`
                            : ""
                    }
                    ${
                        statusMeta
                            ? `<span class="sc-status ${statusMeta.cls}">${statusMeta.glyph} ${escapeHtml(statusMeta.label)}</span>`
                            : ""
                    }
                </div>

                <h3 class="sc-title serif">${escapeHtml(title)}</h3>

                ${
                    metaParts.length
                        ? `<div class="sc-meta">${metaParts.join("<span class='sc-dot'>·</span>")}</div>`
                        : ""
                }

                ${
                    purposeText
                        ? `<p class="sc-purpose">${escapeHtml(shortenText(purposeText))}</p>`
                        : ""
                }

                ${
                    hasDetail
                        ? `<span class="sc-toggle">
                               <span class="sc-toggle-text">View workout</span>
                               <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                           </span>`
                        : ""
                }

            </${headTag}>

            ${
                hasDetail
                    ? `<div class="sc-detail">
                           <div class="sc-detail-inner">
                               ${
                                   description
                                       ? `<p class="sc-lead">${escapeHtml(description)}</p>`
                                       : ""
                               }
                               ${sections.map(renderDetailSection).join("")}
                           </div>
                       </div>`
                    : ""
            }
        `;

        if (hasDetail) {

            card
                .querySelector(".sc-head")
                .addEventListener("click", () =>
                    toggleSessionCard(card, container)
                );
        }

        if (session.id) {
            card.insertAdjacentHTML(
                "beforeend",
                buildSessionActions(session, rest, record)
            );

            wireSessionActions(card, session);
        }

        container.appendChild(card);

    });

}

/* ══════════════ execution feedback ══════════════ */

const SKIP_REASONS = [
    { key: "fatigue", label: "Fatigue" },
    { key: "pain", label: "Pain / injury" },
    { key: "illness", label: "Illness" },
    { key: "schedule", label: "Schedule" },
    { key: "weather", label: "Weather" },
    { key: "travel", label: "Travel" },
    { key: "motivation", label: "Motivation" },
    { key: "other", label: "Other" }
];

const FEELING_OPTIONS = [
    { key: "easier", label: "Easier than expected" },
    { key: "as_expected", label: "As expected" },
    { key: "harder", label: "Harder than expected" }
];

/*
 * The action row under each card. Non-rest days offer Complete / Modify
 * / Skip. Rest days offer Rest completed / Trained instead. When
 * feedback already exists, an Edit affordance is shown alongside so the
 * athlete can revise it.
 */
function buildSessionActions(session, rest, record) {

    const state = getExecutionState(record, rest);

    // ── Already recorded ──────────────────────────────────────────
    // The session has an authoritative saved execution record. Show a
    // clear confirmation state and a SINGLE "Edit feedback" action —
    // never the entry buttons (Complete / Modify / Skip / Rest
    // completed / Trained instead), which would imply it is still
    // unrecorded and invite duplicate/conflicting submissions.
    if (state) {
        const timestamp = buildRecordTimestamp(record);
        const metrics = buildRecordMetrics(record);

        return `
            <div class="sc-actions recorded">
                <div class="sc-recorded">
                    <div class="sc-recorded-head">
                        <span class="sc-recorded-badge ${state.cls}">${state.glyph} ${escapeHtml(state.label)}</span>
                        ${
                            timestamp
                                ? `<span class="sc-recorded-time">${escapeHtml(timestamp)}</span>`
                                : ""
                        }
                    </div>
                    ${
                        metrics
                            ? `<p class="sc-recorded-metrics">${escapeHtml(metrics)}</p>`
                            : ""
                    }
                    <button class="sc-act-edit-btn" type="button" data-action="edit">Edit feedback</button>
                </div>
            </div>
        `;
    }

    // ── Unrecorded ────────────────────────────────────────────────
    const buttons = rest
        ? [
              `<button class="sc-act" type="button" data-action="rest_done">Rest completed</button>`,
              `<button class="sc-act" type="button" data-action="rest_alt">Trained instead</button>`
          ]
        : [
              `<button class="sc-act primary" type="button" data-action="complete">Complete</button>`,
              `<button class="sc-act" type="button" data-action="modify">Modify</button>`,
              `<button class="sc-act" type="button" data-action="skip">Skip</button>`
          ];

    return `
        <div class="sc-actions">
            <div class="sc-act-row">${buttons.join("")}</div>
        </div>
    `;
}

/* "logged Jul 13, 2:40 PM" from the record's submission time. */
function buildRecordTimestamp(record) {
    const raw =
        record?.updated_at || record?.completed_at || null;

    if (!raw) {
        return "";
    }

    const date = new Date(raw);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return "logged " + date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });
}

/* Maps the stored perceived-difficulty value to a human phrase. */
function feelingLabel(value) {
    switch (value) {
        case "easier":
            return "felt easier";
        case "as_expected":
            return "as expected";
        case "harder":
            return "felt harder";
        default:
            return "";
    }
}

/*
 * A metrics-only summary of the SAVED record (no status label — the
 * status is shown separately as a badge). Surfaces the latest saved
 * values: duration, distance, pace, HR, RPE, perceived difficulty,
 * pain response, skip reason, and a notes indicator. Reads only from
 * the authoritative record, never from local state.
 */
function buildRecordMetrics(record) {

    if (!record) {
        return "";
    }

    const parts = [];

    const duration = Number(record.actual_duration_minutes);

    if (Number.isFinite(duration) && duration > 0) {
        parts.push(`${Math.round(duration)} min`);
    }

    const distance = Number(record.actual_distance_km);

    if (Number.isFinite(distance) && distance > 0) {
        parts.push(`${distance} km`);
    }

    const pace = cleanText(record.actual_average_pace);

    if (pace) {
        parts.push(pace);
    }

    const hr = Number(record.actual_average_hr);

    if (Number.isFinite(hr) && hr > 0) {
        parts.push(`${Math.round(hr)} bpm`);
    }

    const rpe = Number(record.actual_rpe);

    if (Number.isFinite(rpe) && rpe > 0) {
        parts.push(`RPE ${rpe}`);
    }

    const feeling = feelingLabel(record.overall_feeling);

    if (feeling) {
        parts.push(feeling);
    }

    if (record.pain_present === true) {
        const location = cleanText(record.pain_location);
        parts.push(location ? `pain: ${location}` : "pain reported");
    }

    if (record.skip_reason) {
        parts.push(formatSessionType(record.skip_reason).toLowerCase());
    }

    if (cleanText(record.athlete_notes)) {
        parts.push("notes added");
    }

    return parts.filter(Boolean).join(" · ");
}

function wireSessionActions(card, session) {

    card.querySelectorAll("[data-action]").forEach(button => {
        button.addEventListener("click", event => {

            event.stopPropagation();

            const action = button.dataset.action;
            const record = session.execution || null;

            if (action === "rest_done") {
                submitRestCompleted(session, record);
                return;
            }

            if (action === "edit") {
                // Reopen the flow that matches the saved status, prefilled
                // with the current record so editing replaces it cleanly.
                let mode;

                if (record?.status === "skipped") {
                    mode = "skip";
                } else if (isRestSession(session)) {
                    // Rest completed OR trained-instead both edit through
                    // the "Trained instead" sheet so the athlete can log
                    // (or revise) what they actually did.
                    mode = "rest_alt";
                } else if (record?.status === "modified") {
                    mode = "modify";
                } else {
                    mode = "complete";
                }

                openFeedbackSheet(session, mode, record);
                return;
            }

            const mode =
                action === "rest_alt" ? "rest_alt" : action;

            openFeedbackSheet(session, mode, record);
        });
    });
}

function toggleSessionCard(card, container) {

    const isOpen =
        card.classList.contains("open");

    /* only one card open at a time */
    container
        .querySelectorAll(".session-card.open")
        .forEach(openCard => {
            if (openCard !== card) {
                closeSessionCard(openCard);
            }
        });

    if (isOpen) {
        closeSessionCard(card);
    } else {
        openSessionCard(card);
    }

}

function openSessionCard(card) {

    card.classList.add("open");

    const detail =
        card.querySelector(".sc-detail");

    if (detail) {
        detail.style.maxHeight =
            detail.scrollHeight + "px";
    }

    setSessionCardToggle(card, true);

}

function closeSessionCard(card) {

    card.classList.remove("open");

    const detail =
        card.querySelector(".sc-detail");

    if (detail) {
        detail.style.maxHeight = "0px";
    }

    setSessionCardToggle(card, false);

}

function setSessionCardToggle(card, expanded) {

    const head =
        card.querySelector(".sc-head");

    if (head && head.tagName === "BUTTON") {
        head.setAttribute(
            "aria-expanded",
            expanded ? "true" : "false"
        );
    }

    const toggleText =
        card.querySelector(".sc-toggle-text");

    if (toggleText) {
        toggleText.textContent =
            expanded
                ? "Hide workout"
                : "View workout";
    }

}

/* ══════════════ weekly adaptive loop UI ══════════════ */

let currentPlanAdaptation = null;
let weeklyCheckinAnswers = {};

const CHECKIN_SCALES = [
    { key: "overall_fatigue", label: "Overall fatigue", low: "Fresh", high: "Exhausted", max: 5 },
    { key: "sleep_quality", label: "Sleep quality", low: "Poor", high: "Excellent", max: 5 },
    { key: "muscle_soreness", label: "Muscle soreness", low: "None", high: "Severe", max: 5 },
    { key: "motivation", label: "Motivation", low: "Low", high: "High", max: 5 },
    { key: "stress_level", label: "Life stress", low: "Calm", high: "Very high", max: 5 },
    { key: "perceived_training_load", label: "How hard was this week overall?", low: "Very easy", high: "Maximal", max: 10 },
    { key: "confidence_for_next_week", label: "Confidence for next week", low: "Low", high: "High", max: 5 }
];

const CHECKIN_FELT_OPTIONS = [
    "Mostly easy",
    "About right",
    "Mostly hard",
    "Mixed"
];

async function loadWeeklyLoop(token) {

    const container =
        document.getElementById("weeklyProgress");

    if (!container) {
        return;
    }

    try {

        const headers = {
            Authorization: `Bearer ${token}`
        };

        const [analysisRes, checkinRes] =
            await Promise.all([
                fetch("/api/training/weekly-analysis", { headers }),
                fetch("/api/training/check-in", { headers })
            ]);

        const analysis =
            analysisRes.ok ? await analysisRes.json() : null;

        const checkin =
            checkinRes.ok ? await checkinRes.json() : null;

        renderWeeklyProgress(container, analysis, checkin);

    } catch (error) {
        console.error("Weekly loop unavailable:", error);
        container.innerHTML = "";
    }

}

function formatRaceDate(value) {

    const match =
        String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);

    if (!match) {
        return "";
    }

    const date = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
    );

    return date.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric"
    });
}

function renderWeeklyProgress(container, analysis, checkin) {

    if (!analysis) {
        container.innerHTML = "";
        return;
    }

    const parts = [];

    parts.push(renderGoalCard(analysis));
    parts.push(renderProgressCard(analysis, checkin));

    container.innerHTML = parts.filter(Boolean).join("");

    const toggle =
        container.querySelector(".wp-toggle");

    if (toggle) {
        toggle.addEventListener("click", () =>
            toggleProgressDetail(
                toggle.closest(".wp-card")
            )
        );
    }

    const cta =
        container.querySelector(".checkin-btn");

    if (cta) {
        cta.addEventListener("click", openWeeklyCheckin);
    }

}

function renderGoalCard(analysis) {

    const countdown = analysis.countdown || {};
    const trajectory = analysis.trajectory || null;

    const hasRace =
        countdown.targetRace || countdown.raceDate;

    if (!hasRace && !trajectory) {
        return "";
    }

    const pieces = [];

    pieces.push(`<span class="eyebrow">Goal</span>`);

    pieces.push(
        `<div class="wp-goal-race">${escapeHtml(
            cleanText(countdown.targetRace) || "Current training block"
        )}</div>`
    );

    const readableDate =
        formatRaceDate(countdown.raceDate);

    if (readableDate) {
        pieces.push(
            `<div class="wp-goal-date">${escapeHtml(readableDate)}</div>`
        );
    }

    const weeks = Number(countdown.weeksUntilRace);
    const days = Number(countdown.daysUntilRace);

    if (Number.isFinite(days) && days >= 0) {

        const countBlocks = [];

        if (Number.isFinite(weeks) && weeks >= 0) {
            countBlocks.push(
                `<div><b class="num">${weeks}</b><small>Weeks</small></div>`
            );
        }

        countBlocks.push(
            `<div><b class="num">${days}</b><small>Days</small></div>`
        );

        pieces.push(
            `<div class="wp-count">${countBlocks.join("")}</div>`
        );
    }

    const phase =
        formatSessionType(countdown.phase);

    if (phase) {

        const week =
            Number(countdown.phaseWeek);

        const length =
            Number(countdown.phaseLengthWeeks);

        const progress =
            Number.isFinite(week) && Number.isFinite(length)
                ? ` — week ${week} of ${length}`
                : "";

        pieces.push(
            `<div class="wp-phase">${escapeHtml(phase + progress)} phase</div>`
        );
    }

    if (trajectory && trajectory.status) {

        const statusClass = String(trajectory.status)
            .replace(/[^a-z_]/g, "");

        const confidence =
            cleanText(trajectory.confidenceLabel);

        pieces.push(`
            <div class="wp-traj">
                <div class="wp-traj-row">
                    <span class="traj-chip ${statusClass}">${escapeHtml(
                        cleanText(trajectory.label) || "—"
                    )}</span>
                    ${
                        confidence
                            ? `<span class="wp-traj-conf">${escapeHtml(confidence)} confidence</span>`
                            : ""
                    }
                </div>
                ${
                    cleanText(trajectory.explanation)
                        ? `<p>${escapeHtml(trajectory.explanation)}</p>`
                        : ""
                }
            </div>
        `);
    }

    return `<div class="wp-goal">${pieces.join("")}</div>`;
}

function renderProgressCard(analysis, checkin) {

    const summary = analysis.summary || null;
    const needsCheckin = Boolean(checkin?.needed);

    if (!summary && !needsCheckin) {
        return "";
    }

    const pieces = [];

    pieces.push(`<span class="eyebrow">Weekly progress</span>`);

    if (summary) {

        const narrative =
            cleanText(summary.progress_narrative);

        if (narrative) {
            pieces.push(
                `<p class="wp-narrative">${escapeHtml(narrative)}</p>`
            );
        }

        const rate = Number(summary.completion_rate);

        if (
            Number.isFinite(rate) &&
            Number(summary.planned_sessions) > 0
        ) {

            const percent =
                Math.round(rate * 100);

            pieces.push(`
                <div class="wp-bar"><i style="width:${Math.min(100, percent)}%"></i></div>
                <div class="wp-bar-label">
                    <span>Session completion</span>
                    <b>${summary.completed_sessions}/${summary.planned_sessions} · ${percent}%</b>
                </div>
            `);
        }

        const wins = Array.isArray(summary.key_wins)
            ? summary.key_wins.map(cleanText).filter(Boolean)
            : [];

        const concerns = Array.isArray(summary.key_concerns)
            ? summary.key_concerns.map(cleanText).filter(Boolean)
            : [];

        if (wins.length) {
            pieces.push(
                `<div class="wp-line"><span class="wp-tag win">Win</span><span>${escapeHtml(wins[0])}</span></div>`
            );
        }

        if (concerns.length) {
            pieces.push(
                `<div class="wp-line"><span class="wp-tag concern">Watch</span><span>${escapeHtml(concerns[0])}</span></div>`
            );
        }

        const detailSections =
            buildProgressDetailSections(summary, wins, concerns);

        if (detailSections) {
            pieces.push(`
                <button class="wp-toggle" type="button">
                    <span>Details</span>
                    <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                </button>
                <div class="wp-detail">
                    <div class="wp-detail-inner">${detailSections}</div>
                </div>
            `);
        }
    }

    if (needsCheckin) {
        pieces.push(
            `<button class="checkin-btn" type="button">Complete weekly check-in</button>`
        );
    }

    return `<div class="wp-card">${pieces.join("")}</div>`;
}

function buildProgressDetailSections(summary, wins, concerns) {

    const sections = [];

    const listSection = (label, items) => {

        if (!items.length) {
            return;
        }

        sections.push(`
            <div class="sc-section">
                <div class="sc-section-label">${escapeHtml(label)}</div>
                <ul class="sc-list">${items
                    .map(item => `<li>${escapeHtml(item)}</li>`)
                    .join("")}</ul>
            </div>
        `);
    };

    listSection("Wins", wins);
    listSection("Concerns", concerns);

    const priorities =
        Array.isArray(summary.next_week_priorities)
            ? summary.next_week_priorities
                  .map(cleanText)
                  .filter(Boolean)
            : [];

    listSection("Next week priorities", priorities);

    const numbers = [];

    const plannedMin =
        Number(summary.planned_duration_minutes);

    const completedMin =
        Number(summary.completed_duration_minutes);

    if (plannedMin > 0 || completedMin > 0) {
        numbers.push(
            `Duration: ${completedMin > 0 ? completedMin : 0} of ${plannedMin > 0 ? plannedMin : "—"} planned minutes`
        );
    }

    const plannedKm =
        Number(summary.planned_distance_km);

    const completedKm =
        Number(summary.completed_distance_km);

    if (plannedKm > 0 || completedKm > 0) {
        numbers.push(
            `Distance: ${completedKm > 0 ? completedKm : 0} of ${plannedKm > 0 ? plannedKm : "—"} planned km`
        );
    }

    const loadDirection =
        formatSessionType(summary.training_load_direction);

    if (
        loadDirection &&
        loadDirection !== "Insufficient Data"
    ) {
        numbers.push(`Training load: ${loadDirection.toLowerCase()}`);
    }

    listSection("This week in numbers", numbers);

    /* plan adaptation — what changed and why */
    if (currentPlanAdaptation) {

        const adaptation = [
            ["What changed", currentPlanAdaptation.what_changed],
            ["Why", currentPlanAdaptation.why_it_changed],
            ["Kept stable", currentPlanAdaptation.kept_stable]
        ]
            .map(([label, value]) => [label, cleanText(value)])
            .filter(([, value]) => value);

        adaptation.forEach(([label, value]) => {
            sections.push(`
                <div class="sc-section">
                    <div class="sc-section-label">${escapeHtml(label)}</div>
                    <p>${escapeHtml(value)}</p>
                </div>
            `);
        });
    }

    return sections.join("");
}

function toggleProgressDetail(card) {

    if (!card) {
        return;
    }

    const detail =
        card.querySelector(".wp-detail");

    if (!detail) {
        return;
    }

    const isOpen =
        card.classList.contains("open");

    card.classList.toggle("open", !isOpen);

    detail.style.maxHeight = isOpen
        ? "0px"
        : detail.scrollHeight + "px";

}

/* ══════════════ weekly check-in modal ══════════════ */

function openWeeklyCheckin() {

    weeklyCheckinAnswers = {
        pain_or_injury: null
    };

    const modal =
        document.getElementById("checkinModal");

    if (!modal) {
        return;
    }

    const scaleRows = CHECKIN_SCALES.map(scale => {

        const dots = [];

        for (let value = 1; value <= scale.max; value += 1) {
            dots.push(
                `<button class="ci-dot" type="button" data-key="${scale.key}" data-value="${value}">${value}</button>`
            );
        }

        return `
            <div class="ci-row">
                <div class="ci-label">${escapeHtml(scale.label)}</div>
                <div class="ci-scale">${dots.join("")}</div>
                <div class="ci-hints">
                    <span>${escapeHtml(scale.low)}</span>
                    <span>${escapeHtml(scale.high)}</span>
                </div>
            </div>
        `;
    }).join("");

    const feltChips = CHECKIN_FELT_OPTIONS.map(
        option =>
            `<button class="ob-chip" type="button" data-felt="${escapeHtml(option)}">${escapeHtml(option)}</button>`
    ).join("");

    modal.innerHTML = `
        <div class="lesson">
            <span class="eyebrow">Weekly check-in · 1 minute</span>
            <h3 class="serif">How did this week actually feel?</h3>
            <p>Honest answers shape next week's plan. Nothing here is judged.</p>

            ${scaleRows}

            <div class="ci-row">
                <div class="ci-label">How did the sessions feel?</div>
                <div class="ci-chips">${feltChips}</div>
            </div>

            <div class="ci-row">
                <div class="ci-label">Any pain or injury?</div>
                <div class="ci-chips">
                    <button class="ob-chip" type="button" data-pain="no">No</button>
                    <button class="ob-chip" type="button" data-pain="yes">Yes</button>
                </div>
                <textarea
                    id="ciPainDetails"
                    class="ci-input"
                    placeholder="Where, when, and how bad?"
                    style="display:none"></textarea>
            </div>

            <div class="ci-row">
                <div class="ci-label">Anything else your coach should know?</div>
                <textarea
                    id="ciNotes"
                    class="ci-input"
                    placeholder="Optional"></textarea>
            </div>

            <p class="ci-msg" id="ciMsg"></p>

            <button class="lesson-done" type="button" id="ciSubmit">
                Submit check-in
            </button>
        </div>
    `;

    modal.querySelectorAll(".ci-dot").forEach(dot => {
        dot.addEventListener("click", () => {

            const key = dot.dataset.key;

            weeklyCheckinAnswers[key] =
                Number(dot.dataset.value);

            modal
                .querySelectorAll(`.ci-dot[data-key="${key}"]`)
                .forEach(other =>
                    other.classList.toggle("sel", other === dot)
                );
        });
    });

    modal.querySelectorAll("[data-felt]").forEach(chip => {
        chip.addEventListener("click", () => {

            weeklyCheckinAnswers.sessions_felt =
                chip.dataset.felt;

            modal
                .querySelectorAll("[data-felt]")
                .forEach(other =>
                    other.classList.toggle("sel", other === chip)
                );
        });
    });

    modal.querySelectorAll("[data-pain]").forEach(chip => {
        chip.addEventListener("click", () => {

            const hasPain =
                chip.dataset.pain === "yes";

            weeklyCheckinAnswers.pain_or_injury = hasPain;

            modal
                .querySelectorAll("[data-pain]")
                .forEach(other =>
                    other.classList.toggle("sel", other === chip)
                );

            document.getElementById(
                "ciPainDetails"
            ).style.display = hasPain ? "block" : "none";
        });
    });

    modal
        .querySelector("#ciSubmit")
        .addEventListener("click", submitWeeklyCheckin);

    modal.onclick = event => {
        if (event.target === modal) {
            closeWeeklyCheckin();
        }
    };

    modal.classList.add("show");

}

function closeWeeklyCheckin() {

    const modal =
        document.getElementById("checkinModal");

    if (modal) {
        modal.classList.remove("show");
        modal.innerHTML = "";
    }

}

async function submitWeeklyCheckin() {

    const message =
        document.getElementById("ciMsg");

    const unanswered = CHECKIN_SCALES.filter(
        scale =>
            !Number.isFinite(
                weeklyCheckinAnswers[scale.key]
            )
    );

    if (
        unanswered.length ||
        !weeklyCheckinAnswers.sessions_felt ||
        weeklyCheckinAnswers.pain_or_injury === null
    ) {
        if (message) {
            message.textContent =
                "Please answer the remaining questions first.";
        }
        return;
    }

    const painDetails =
        document.getElementById("ciPainDetails");

    const notes =
        document.getElementById("ciNotes");

    const body = {
        ...weeklyCheckinAnswers,
        pain_details:
            weeklyCheckinAnswers.pain_or_injury && painDetails
                ? painDetails.value.trim()
                : null,
        athlete_notes:
            notes ? notes.value.trim() || null : null
    };

    const submitButton =
        document.getElementById("ciSubmit");

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Saving...";
    }

    try {

        const {
            data: { session }
        } = await supabaseClient.auth.getSession();

        const res = await fetch("/api/training/check-in", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(
                data.error || "The check-in could not be saved."
            );
        }

        closeWeeklyCheckin();

        if (typeof toast === "function") {
            toast("Check-in saved — thank you");
        }

        // refresh the section so the prompt disappears
        loadWeeklyLoop(session.access_token);

    } catch (error) {

        console.error("Check-in submit failed:", error);

        if (message) {
            message.textContent =
                error.message ||
                "The check-in could not be saved.";
        }

        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = "Submit check-in";
        }
    }

}

let feedbackDraft = {};
let feedbackContext = null;
let feedbackReplacePending = false;

function fbNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : "";
}

/* Builds a 1–10 RPE dot scale. */
function buildRpeScale(selected) {
    const dots = [];

    for (let value = 1; value <= 10; value += 1) {
        dots.push(
            `<button class="ci-dot" type="button" data-fb="actual_rpe" data-value="${value}"${
                Number(selected) === value ? ' data-sel="1"' : ""
            }>${value}</button>`
        );
    }

    return `
        <div class="ci-row">
            <div class="ci-label">Effort (RPE 1–10)</div>
            <div class="ci-scale fb-rpe">${dots.join("")}</div>
            <div class="ci-hints"><span>Very easy</span><span>Maximal</span></div>
        </div>
    `;
}

function buildFeelingChips(selected) {
    const chips = FEELING_OPTIONS.map(
        option =>
            `<button class="ob-chip" type="button" data-fb="overall_feeling" data-value="${option.key}"${
                selected === option.key ? " data-sel=\"1\"" : ""
            }>${escapeHtml(option.label)}</button>`
    ).join("");

    return `
        <div class="ci-row">
            <div class="ci-label">How did it feel?</div>
            <div class="ci-chips">${chips}</div>
        </div>
    `;
}

function buildPainBlock(record) {
    const hasPain = record?.pain_present === true;

    return `
        <div class="ci-row">
            <div class="ci-label">Any pain?</div>
            <div class="ci-chips">
                <button class="ob-chip" type="button" data-fb="pain_present" data-value="no"${
                    hasPain ? "" : " data-sel=\"1\""
                }>No</button>
                <button class="ob-chip" type="button" data-fb="pain_present" data-value="yes"${
                    hasPain ? " data-sel=\"1\"" : ""
                }>Yes</button>
            </div>
            <div id="fbPainDetail" style="${hasPain ? "" : "display:none"}">
                <input
                    id="fbPainLocation"
                    class="ci-input"
                    type="text"
                    placeholder="Where does it hurt?"
                    value="${escapeHtml(cleanText(record?.pain_location))}">
                <div class="ci-label" style="margin-top:10px">Severity (1–10)</div>
                <div class="ci-scale fb-pain-scale"></div>
            </div>
        </div>
    `;
}

function buildDurationDistance(record, matched) {
    const duration =
        fbNumber(record?.actual_duration_minutes) ||
        fbNumber(matched?.actual_duration_minutes);

    const distance =
        fbNumber(record?.actual_distance_km) ||
        fbNumber(matched?.actual_distance_km);

    const hr =
        fbNumber(record?.actual_average_hr) ||
        fbNumber(matched?.average_heartrate);

    const pace =
        cleanText(record?.actual_average_pace) ||
        cleanText(matched?.average_pace);

    // Strava match banner. It is only a suggestion — the athlete can
    // reject it, which flags a manual override and unlinks the activity.
    const prefillNote = matched
        ? `<div class="fb-matched" id="fbMatched">
               <p class="fb-prefill">Prefilled from your Strava activity${
                   matched.name ? ` “${escapeHtml(matched.name)}”` : ""
               }${
                   matched.activity_type
                       ? ` (${escapeHtml(formatSessionType(matched.activity_type))})`
                       : ""
               } — edit anything below.</p>
               <button class="fb-unmatch" type="button" id="fbUnmatch">Not this activity?</button>
           </div>`
        : "";

    return `
        ${prefillNote}
        <div class="ci-row fb-grid">
            <div>
                <div class="ci-label">Duration (min)</div>
                <input id="fbDuration" class="ci-input" type="number" inputmode="numeric" min="0" placeholder="—" value="${duration}">
            </div>
            <div>
                <div class="ci-label">Distance (km)</div>
                <input id="fbDistance" class="ci-input" type="number" inputmode="decimal" min="0" step="0.1" placeholder="Optional" value="${distance}">
            </div>
        </div>
        <div class="ci-row fb-grid">
            <div>
                <div class="ci-label">Avg pace</div>
                <input id="fbPace" class="ci-input" type="text" inputmode="text" placeholder="e.g. 5:30/km" value="${escapeHtml(pace)}">
            </div>
            <div>
                <div class="ci-label">Avg HR (bpm)</div>
                <input id="fbHR" class="ci-input" type="number" inputmode="numeric" min="0" placeholder="Optional" value="${hr}">
            </div>
        </div>
    `;
}

function feedbackSheetTitle(mode) {
    switch (mode) {
        case "complete":
            return { eyebrow: "Log workout", title: "How did it go?" };
        case "modify":
            return { eyebrow: "Modify workout", title: "What did you change?" };
        case "skip":
            return { eyebrow: "Skip workout", title: "No problem — what happened?" };
        case "rest_alt":
            return { eyebrow: "Trained instead", title: "What did you do?" };
        default:
            return { eyebrow: "Feedback", title: "Update your session" };
    }
}

function openFeedbackSheet(session, mode, existingRecord) {

    const modal = document.getElementById("feedbackModal");

    if (!modal) {
        return;
    }

    feedbackReplacePending = false;

    feedbackContext = {
        session,
        mode,
        existingRecord: existingRecord || null
    };

    const record = existingRecord || null;
    const matched =
        mode === "complete" || mode === "rest_alt"
            ? session.matched_activity || null
            : null;

    feedbackDraft = {
        overall_feeling: record?.overall_feeling || null,
        actual_rpe: Number(record?.actual_rpe) || null,
        pain_present: record?.pain_present === true,
        pain_severity: Number(record?.pain_severity) || null,
        skip_reason: record?.skip_reason || null,
        adjust_remaining_week: record?.adjust_remaining_week === true,
        as_prescribed: record?.as_prescribed !== false
    };

    const heading = feedbackSheetTitle(mode);

    const blocks = [];

    if (mode === "complete") {
        blocks.push(`
            <div class="ci-row">
                <div class="ci-label">Did you complete it as prescribed?</div>
                <div class="ci-chips">
                    <button class="ob-chip" type="button" data-fb="as_prescribed" data-value="yes"${
                        feedbackDraft.as_prescribed ? " data-sel=\"1\"" : ""
                    }>Yes</button>
                    <button class="ob-chip" type="button" data-fb="as_prescribed" data-value="no"${
                        feedbackDraft.as_prescribed ? "" : " data-sel=\"1\""
                    }>Not quite</button>
                </div>
            </div>
        `);
        blocks.push(buildDurationDistance(record, matched));
        blocks.push(buildRpeScale(feedbackDraft.actual_rpe));
        blocks.push(buildFeelingChips(feedbackDraft.overall_feeling));
        blocks.push(buildPainBlock(record));
        blocks.push(notesField(record, "Anything else worth noting?"));
    } else if (mode === "modify") {
        blocks.push(textField("fbWhatChanged", "What changed?", cleanText(record?.athlete_notes), "e.g. cut the intervals short, ran easy instead"));
        blocks.push(textField("fbWhy", "Why was it modified?", cleanText(record?.modification_reason), "e.g. legs felt heavy"));
        blocks.push(buildDurationDistance(record, matched));
        blocks.push(buildRpeScale(feedbackDraft.actual_rpe));
        blocks.push(buildFeelingChips(feedbackDraft.overall_feeling));
        blocks.push(buildPainBlock(record));
    } else if (mode === "skip") {
        const reasonChips = SKIP_REASONS.map(
            reason =>
                `<button class="ob-chip" type="button" data-fb="skip_reason" data-value="${reason.key}"${
                    feedbackDraft.skip_reason === reason.key ? " data-sel=\"1\"" : ""
                }>${escapeHtml(reason.label)}</button>`
        ).join("");

        blocks.push(`
            <div class="ci-row">
                <div class="ci-label">Main reason</div>
                <div class="ci-chips">${reasonChips}</div>
            </div>
        `);
        blocks.push(notesField(record, "Optional — anything to add?"));
        blocks.push(`
            <div class="ci-row">
                <div class="ci-label">Adjust the rest of this week?</div>
                <div class="ci-chips">
                    <button class="ob-chip" type="button" data-fb="adjust_remaining_week" data-value="no"${
                        feedbackDraft.adjust_remaining_week ? "" : " data-sel=\"1\""
                    }>Keep the plan</button>
                    <button class="ob-chip" type="button" data-fb="adjust_remaining_week" data-value="yes"${
                        feedbackDraft.adjust_remaining_week ? " data-sel=\"1\"" : ""
                    }>Please adjust</button>
                </div>
            </div>
        `);
    } else if (mode === "rest_alt") {
        blocks.push(textField("fbWhatChanged", "What did you do instead?", cleanText(record?.athlete_notes), "e.g. easy 30 min swim"));
        blocks.push(buildDurationDistance(record, matched));
        blocks.push(buildRpeScale(feedbackDraft.actual_rpe));
        blocks.push(buildFeelingChips(feedbackDraft.overall_feeling));
        blocks.push(buildPainBlock(record));
    }

    modal.innerHTML = `
        <div class="lesson">
            <span class="eyebrow">${escapeHtml(heading.eyebrow)}</span>
            <h3 class="serif">${escapeHtml(heading.title)}</h3>
            <p>${escapeHtml(cleanText(session.title) || "This session")} · ${escapeHtml(formatSessionDate(session.session_date))}</p>

            ${blocks.join("")}

            <p class="ci-msg" id="fbMsg"></p>

            <button class="lesson-done" type="button" id="fbSubmit">
                ${existingRecord ? "Replace saved feedback" : "Save feedback"}
            </button>
        </div>
    `;

    wireFeedbackSheet(modal, record);

    modal.onclick = event => {
        if (event.target === modal) {
            closeFeedbackSheet();
        }
    };

    modal.classList.add("show");
}

function notesField(record, placeholder) {
    return textField(
        "fbNotes",
        "Notes",
        cleanText(record?.athlete_notes),
        placeholder
    );
}

function textField(id, label, value, placeholder) {
    return `
        <div class="ci-row">
            <div class="ci-label">${escapeHtml(label)}</div>
            <textarea id="${id}" class="ci-input" placeholder="${escapeHtml(placeholder || "")}">${escapeHtml(value || "")}</textarea>
        </div>
    `;
}

function renderPainSeverityScale(modal) {
    const container = modal.querySelector(".fb-pain-scale");

    if (!container) {
        return;
    }

    const dots = [];

    for (let value = 1; value <= 10; value += 1) {
        dots.push(
            `<button class="ci-dot" type="button" data-fb="pain_severity" data-value="${value}"${
                feedbackDraft.pain_severity === value ? " data-sel=\"1\"" : ""
            }>${value}</button>`
        );
    }

    container.innerHTML = dots.join("");
    applyDotSelection(modal);
}

function applyDotSelection(modal) {
    modal.querySelectorAll(".ci-dot[data-sel], .ob-chip[data-sel]").forEach(el => {
        el.classList.add("sel");
    });
}

function wireFeedbackSheet(modal, record) {

    renderPainSeverityScale(modal);
    applyDotSelection(modal);

    // Single-select chips and dots (grouped by data-fb).
    modal.querySelectorAll("[data-fb]").forEach(el => {
        el.addEventListener("click", () => {

            const key = el.dataset.fb;
            const rawValue = el.dataset.value;

            if (key === "pain_present") {
                const hasPain = rawValue === "yes";
                feedbackDraft.pain_present = hasPain;

                const detail =
                    modal.querySelector("#fbPainDetail");

                if (detail) {
                    detail.style.display = hasPain ? "block" : "none";
                }
            } else if (key === "adjust_remaining_week") {
                feedbackDraft.adjust_remaining_week = rawValue === "yes";
            } else if (key === "as_prescribed") {
                feedbackDraft.as_prescribed = rawValue === "yes";
            } else if (key === "actual_rpe" || key === "pain_severity") {
                feedbackDraft[key] = Number(rawValue);
            } else {
                feedbackDraft[key] = rawValue;
            }

            // Update selection styling within the same group.
            modal
                .querySelectorAll(`[data-fb="${key}"]`)
                .forEach(other =>
                    other.classList.toggle("sel", other === el)
                );
        });
    });

    // "Not this activity?" — reject the auto-suggested Strava match so
    // we never silently trust the wrong workout. Flags a manual override
    // and clears the prefilled numbers for the athlete to fill in.
    const unmatch = modal.querySelector("#fbUnmatch");

    if (unmatch) {
        unmatch.addEventListener("click", () => {
            feedbackDraft.manual_activity_override = true;

            ["fbDuration", "fbDistance", "fbPace", "fbHR"].forEach(id => {
                const field = modal.querySelector(`#${id}`);
                if (field) {
                    field.value = "";
                }
            });

            const banner = modal.querySelector("#fbMatched");
            if (banner) {
                banner.innerHTML =
                    '<p class="fb-prefill">Not linked to a Strava activity — enter your own numbers.</p>';
            }
        });
    }

    modal
        .querySelector("#fbSubmit")
        .addEventListener("click", submitFeedback);
}

function closeFeedbackSheet() {
    const modal = document.getElementById("feedbackModal");

    if (modal) {
        modal.classList.remove("show");
        modal.innerHTML = "";
    }

    feedbackContext = null;
    feedbackDraft = {};
    feedbackReplacePending = false;
}

function readValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
}

async function submitFeedback() {

    if (!feedbackContext) {
        return;
    }

    const { session, mode, existingRecord } = feedbackContext;
    const message = document.getElementById("fbMsg");
    const submit = document.getElementById("fbSubmit");

    // Build the payload for the chosen flow.
    const body = {
        training_session_id: session.id
    };

    const durationValue = readValue("fbDuration");
    const distanceValue = readValue("fbDistance");

    if (mode === "skip") {
        if (!feedbackDraft.skip_reason) {
            if (message) {
                message.textContent = "Please pick a main reason.";
            }
            return;
        }

        body.status = "skipped";
        body.skip_reason = feedbackDraft.skip_reason;
        body.adjust_remaining_week =
            feedbackDraft.adjust_remaining_week === true;
        body.athlete_notes = readValue("fbNotes") || null;

        // A pain-related skip still records pain so injury memory sees it.
        if (feedbackDraft.skip_reason === "pain") {
            body.pain_present = true;
            body.pain_location = readValue("fbPainLocation") || null;
        }
    } else {
        // complete / modify / rest_alt all report actuals.
        body.status =
            mode === "complete" ? "completed" : "modified";

        if (durationValue) {
            body.actual_duration_minutes = Number(durationValue);
        }

        if (distanceValue) {
            body.actual_distance_km = Number(distanceValue);
        }

        if (feedbackDraft.actual_rpe) {
            body.actual_rpe = feedbackDraft.actual_rpe;
        }

        if (feedbackDraft.overall_feeling) {
            body.overall_feeling = feedbackDraft.overall_feeling;
        }

        const paceValue = readValue("fbPace");
        const hrValue = readValue("fbHR");

        if (paceValue) {
            body.actual_average_pace = paceValue;
        }

        if (hrValue) {
            body.actual_average_hr = Number(hrValue);
        }

        body.pain_present = feedbackDraft.pain_present === true;

        if (body.pain_present) {
            body.pain_location = readValue("fbPainLocation") || null;
            body.pain_severity = feedbackDraft.pain_severity || null;
        }

        if (mode === "complete") {
            body.as_prescribed = feedbackDraft.as_prescribed !== false;
            body.athlete_notes = readValue("fbNotes") || null;
        } else {
            // modify / rest_alt
            body.modification_reason = readValue("fbWhy") || null;
            body.athlete_notes = readValue("fbWhatChanged") || null;
        }

        // Link the auto-suggested Strava activity unless the athlete
        // rejected it ("Not this activity?"), which flags a manual
        // override so the wrong workout is never silently trusted.
        const overrode = feedbackDraft.manual_activity_override === true;

        body.manual_activity_override = overrode;

        const matched =
            !overrode &&
            (mode === "complete" || mode === "rest_alt") &&
            session.matched_activity
                ? session.matched_activity
                : null;

        if (matched?.id) {
            body.imported_activity_id = matched.id;
        }
    }

    // Confirm before permanently replacing existing feedback.
    if (existingRecord && !feedbackReplacePending) {
        feedbackReplacePending = true;

        if (message) {
            message.textContent =
                "This replaces your saved feedback. Tap again to confirm.";
        }

        if (submit) {
            submit.textContent = "Replace saved feedback";
        }

        return;
    }

    if (submit) {
        submit.disabled = true;
        submit.textContent = "Saving...";
    }

    try {
        const {
            data: { session: authSession }
        } = await supabaseClient.auth.getSession();

        const res = await fetch("/api/training/get-week", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authSession.access_token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(
                data.error || "That feedback could not be saved."
            );
        }

        closeFeedbackSheet();

        if (typeof toast === "function") {
            // Clear, state-aware confirmation so the athlete never has to
            // guess whether the save landed.
            const confirmation = existingRecord
                ? "Feedback updated."
                : body.status === "skipped"
                ? "Workout skipped."
                : body.status === "modified"
                ? "Workout updated."
                : "Workout recorded.";
            toast(confirmation);
        }

        // Refetch the authoritative week (rerenders the Train card from the
        // saved record) and refresh the Latest Workout Analysis, which
        // depends on this record. loadWeeklyPlan() triggers both.
        await loadWeeklyPlan();

    } catch (error) {
        console.error("Feedback submit failed:", error);

        // Keep the sheet OPEN with the athlete's entered values intact,
        // show the error, and re-enable the button. No false success.
        feedbackReplacePending = false;

        if (message) {
            message.textContent =
                error.message || "That feedback could not be saved.";
        }

        if (submit) {
            submit.disabled = false;
            submit.textContent = existingRecord
                ? "Replace saved feedback"
                : "Save feedback";
        }
    }
}

/* Rest day marked complete — no sheet needed, but confirm a replace. */
async function submitRestCompleted(session, existingRecord) {

    if (
        existingRecord &&
        !window.confirm("Replace your saved feedback for this day?")
    ) {
        return;
    }

    try {
        const {
            data: { session: authSession }
        } = await supabaseClient.auth.getSession();

        const res = await fetch("/api/training/get-week", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${authSession.access_token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                training_session_id: session.id,
                status: "completed",
                as_prescribed: true
            })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Could not update.");
        }

        if (typeof toast === "function") {
            toast(existingRecord ? "Rest updated." : "Rest logged.");
        }

        await loadWeeklyPlan();

    } catch (error) {
        console.error("Rest completion failed:", error);

        if (typeof toast === "function") {
            toast("Could not save — please try again");
        }
    }
}

async function generateWeek(){

    const {
        data:{session}
    } =
    await supabaseClient.auth.getSession();

    const button =
        event.target;

    button.disabled=true;

    button.innerText="Generating...";

    // Refresh last week's analysis so the new plan adapts to the
    // freshest truth about what actually happened. Best effort.
    try {
        await fetch("/api/training/weekly-analysis", {
            headers: {
                Authorization:
                    `Bearer ${session.access_token}`
            }
        });
    } catch (error) {
        console.error(
            "Pre-generation analysis refresh failed:",
            error
        );
    }

    await fetch(
        "/api/training/generate-plan",
        {
            method:"POST",

            headers:{
                Authorization:
                    `Bearer ${session.access_token}`
            }
        }
    );

    await loadWeeklyPlan();

}

function capitalize(text){

    return text
        ? text.charAt(0).toUpperCase() +
          text.slice(1).replaceAll("_"," ")
        : "";

}

window.loadWeeklyPlan =
    loadWeeklyPlan;

window.generateWeek =
    generateWeek;

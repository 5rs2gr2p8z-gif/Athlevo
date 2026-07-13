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

    if (!data.hasPlan) {
        renderNoPlan();
    } else {
        renderWeekHeader(data.plan);
        renderSessions(data.sessions);
    }

    currentPlanAdaptation =
        data.plan?.adaptation || null;

    loadWeeklyLoop(session.access_token);

}

function renderNoPlan() {

    document.getElementById("trainHeader").innerHTML = `
        <div class="empty-card">
            <h3>No training plan yet</h3>

            <p>
                Generate your first Athlevo week.
            </p>

            <button
                class="primary-btn"
                onclick="generateWeek()">

                Generate My Week

            </button>
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

function isRestSession(session) {

    const type =
        cleanText(session.session_type).toLowerCase();

    const sport =
        cleanText(session.sport).toLowerCase();

    const intensity =
        cleanText(session.intensity).toLowerCase();

    return (
        type === "rest" ||
        type === "rest_day" ||
        sport === "rest" ||
        intensity === "rest"
    );
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

function renderSessions(sessions) {

    const container =
        document.getElementById("weekSessions");

    container.innerHTML = "";

    sessions.forEach(session => {

        const rest = isRestSession(session);
        const sections = buildDetailSections(session);
        const description = cleanText(session.description);

        const hasDetail =
            sections.length > 0 || description.length > 0;

        const dateLabel =
            formatSessionDate(session.session_date);

        const typeLabel =
            rest
                ? "Rest"
                : formatSessionType(session.session_type);

        const title =
            cleanText(session.title) ||
            typeLabel ||
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
            "session-card" + (rest ? " rest" : "");

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

        container.appendChild(card);

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

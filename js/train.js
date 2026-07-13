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
        return;
    }

    renderWeekHeader(data.plan);

    renderSessions(data.sessions);

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

async function generateWeek(){

    const {
        data:{session}
    } =
    await supabaseClient.auth.getSession();

    const button =
        event.target;

    button.disabled=true;

    button.innerText="Generating...";

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

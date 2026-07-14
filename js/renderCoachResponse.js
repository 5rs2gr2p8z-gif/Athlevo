console.log("Athlevo Coach Response Renderer Loaded");

function cleanCoachText(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .trim();
}

function createCoachElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text) {
    element.textContent = cleanCoachText(text);
  }

  return element;
}

/*
 * Appends inline text with **bold** support, built with DOM nodes (no
 * innerHTML) so it stays injection-safe. Markdown heading hashes are
 * stripped; everything else renders as plain text with emphasis.
 */
function appendInlineText(element, rawText) {
  const text = String(rawText == null ? "" : rawText)
    .replace(/^\s*#{1,6}\s*/gm, "");

  const parts = text.split(/\*\*(.+?)\*\*/g);

  parts.forEach((part, index) => {
    if (!part) {
      return;
    }

    if (index % 2 === 1) {
      const strong = document.createElement("strong");
      strong.textContent = part;
      element.appendChild(strong);
    } else {
      element.appendChild(document.createTextNode(part));
    }
  });
}

/*
 * Renders a coaching text field as short, well-spaced blocks:
 *   - blank-line-separated blocks become their own paragraphs
 *   - a block whose lines are all "- " / "• " becomes a bullet list
 *   - the first paragraph can carry a lead class (the decision line)
 * This is what lets a reply breathe on a phone instead of being one wall.
 */
function appendCoachProse(container, rawText, leadClassName) {
  const text = String(rawText == null ? "" : rawText).trim();

  if (!text) {
    return;
  }

  const blocks = text
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean);

  blocks.forEach((block, blockIndex) => {
    const lines = block
      .split(/\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const isBulletBlock =
      lines.length > 0 &&
      lines.every(line => /^([-*•])\s+/.test(line));

    if (isBulletBlock) {
      const list = document.createElement("ul");
      list.className = "coach-response-list";

      lines.forEach(line => {
        const item = document.createElement("li");
        appendInlineText(item, line.replace(/^([-*•])\s+/, ""));
        list.appendChild(item);
      });

      container.appendChild(list);
      return;
    }

    const paragraph = document.createElement("p");

    paragraph.className =
      blockIndex === 0 && leadClassName
        ? leadClassName
        : "coach-response-direct";

    // Join soft-wrapped lines within a paragraph with spaces.
    appendInlineText(paragraph, lines.join(" "));
    container.appendChild(paragraph);
  });
}

function parseCoachResponse(response) {
  if (!response) return null;

  if (typeof response === "object") {
    return response;
  }

  if (typeof response !== "string") {
    return null;
  }

  const trimmed = response.trim();

  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      console.warn(
        "Coach response was not valid JSON. Using plain-text fallback.",
        error
      );
    }
  }

  return {
    response_type: "standard",
    headline: null,
    direct_answer: trimmed,
    compliment: null,
    sections: [],
    mission: null,
    confidence: null,
    closing: null
  };
}

function createCoachCallout(type, text) {
  if (!text) return null;

  const callout = createCoachElement(
    "div",
    `coach-callout coach-callout-${type}`
  );

  const labels = {
    success: "What you did well",
    warning: "Watch carefully",
    tip: "Coach’s note",
    decision: "Decision"
  };

  callout.appendChild(
    createCoachElement(
      "span",
      "coach-callout-label",
      labels[type] || "Coach’s note"
    )
  );

  callout.appendChild(
    createCoachElement(
      "p",
      "coach-callout-text",
      text
    )
  );

  return callout;
}

function createCoachSection(section) {
  if (!section) return null;

  const wrapper = createCoachElement(
    "section",
    "coach-response-section"
  );

  if (section.title) {
    wrapper.appendChild(
      createCoachElement(
        "h4",
        "coach-response-section-title",
        section.title
      )
    );
  }

  if (section.body) {
    const body = document.createElement("p");
    body.className = "coach-response-section-body";
    appendInlineText(body, section.body);
    wrapper.appendChild(body);
  }

  if (
    Array.isArray(section.bullets) &&
    section.bullets.length > 0
  ) {
    const list = createCoachElement(
      "ul",
      "coach-response-list"
    );

    section.bullets.forEach(item => {
      if (
        typeof item !== "string" ||
        !item.trim()
      ) {
        return;
      }

      const listItem = document.createElement("li");
      appendInlineText(listItem, item);
      list.appendChild(listItem);
    });

    wrapper.appendChild(list);
  }

  if (section.callout) {
    const callout = createCoachCallout(
      section.style || "tip",
      section.callout
    );

    if (callout) {
      wrapper.appendChild(callout);
    }
  }

  return wrapper;
}

function renderCoachResponse(
  target,
  rawResponse
) {
  const container =
    typeof target === "string"
      ? document.querySelector(target)
      : target;

  if (!container) {
    console.error(
      "Coach response container was not found."
    );

    return;
  }

  const response =
    parseCoachResponse(rawResponse);

  container.innerHTML = "";
  container.classList.add(
    "coach-rich-response"
  );

  if (!response) {
    container.textContent =
      "Athlevo could not display this response.";

    return;
  }

  // Compact "Coach Context" summary — what the coach actually reviewed
  // before answering. Only truthful items (assembled client-side from
  // the real context) are shown; nothing is fabricated.
  if (
    Array.isArray(response.coach_context) &&
    response.coach_context.length > 0
  ) {
    const contextBlock = createCoachElement(
      "div",
      "coach-context"
    );

    contextBlock.appendChild(
      createCoachElement(
        "span",
        "coach-context-label",
        "Coach Context"
      )
    );

    const contextList = createCoachElement(
      "ul",
      "coach-context-list"
    );

    response.coach_context.forEach(item => {
      if (typeof item !== "string" || !item.trim()) {
        return;
      }

      contextList.appendChild(
        createCoachElement("li", "", item)
      );
    });

    if (contextList.childElementCount > 0) {
      contextBlock.appendChild(contextList);
      container.appendChild(contextBlock);
    }
  }

  if (response.headline) {
    container.appendChild(
      createCoachElement(
        "h3",
        "coach-response-headline",
        response.headline
      )
    );
  }

  if (response.direct_answer) {
    // The opening line is the coaching decision — render it prominently,
    // then let the reasoning flow as short paragraphs beneath it.
    appendCoachProse(
      container,
      response.direct_answer,
      "coach-response-lead"
    );
  }

  if (response.compliment) {
    const compliment =
      createCoachCallout(
        "success",
        response.compliment
      );

    if (compliment) {
      container.appendChild(compliment);
    }
  }

  if (Array.isArray(response.sections)) {
    response.sections.forEach(section => {
      const sectionElement =
        createCoachSection(section);

      if (sectionElement) {
        container.appendChild(
          sectionElement
        );
      }
    });
  }

  if (response.mission) {
    const mission =
      createCoachElement(
        "div",
        "coach-mission"
      );

    mission.appendChild(
      createCoachElement(
        "span",
        "coach-mission-label",
        "Your next move"
      )
    );

    const missionText = document.createElement("p");
    missionText.className = "coach-mission-text";
    appendInlineText(missionText, response.mission);
    mission.appendChild(missionText);

    container.appendChild(mission);
  }

  // Note: response.confidence is intentionally NOT rendered. It may be
  // returned internally, but athletes should never see AI decision
  // confidence, scoring, or other implementation metadata.

  if (response.closing) {
    container.appendChild(
      createCoachElement(
        "p",
        "coach-response-closing",
        response.closing
      )
    );
  }

  // Structured proposals (plan changes / activity corrections) render as
  // confirmable cards beneath the reply. Nothing is applied until Apply.
  if (Array.isArray(response.actions) && response.actions.length > 0) {
    renderCoachActions(container, response.actions);
  }
}

/* Label for each action type, athlete-facing. */
function coachActionKindLabel(type) {
  const labels = {
    modify_workout: "Proposed workout change",
    move_workout: "Proposed reschedule",
    skip_workout: "Proposed skip",
    replace_workout: "Proposed replacement",
    adjust_remaining_week: "Proposed week adjustment",
    update_temporary_availability: "Proposed availability update",
    update_training_preference: "Proposed preference update",
    create_activity_override: "Proposed data correction",
    update_race_details: "Proposed race update"
  };

  return labels[type] || "Proposed change";
}

function appendCoachActionRow(parent, label, value) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }

  const row = document.createElement("div");
  row.className = "ca-row";

  const name = document.createElement("span");
  name.className = "ca-row-label";
  name.textContent = label;

  const val = document.createElement("span");
  val.className = "ca-row-value";
  val.textContent = value.trim();

  row.appendChild(name);
  row.appendChild(val);
  parent.appendChild(row);
}

function buildCoachActionCard(action) {
  const card = document.createElement("div");
  card.className = "coach-action";
  card.dataset.status = "pending";

  const isCorrection = action.type === "create_activity_override";

  const head = document.createElement("div");
  head.className = "ca-head";

  const kind = document.createElement("span");
  kind.className = "ca-kind";
  kind.textContent = coachActionKindLabel(action.type);

  const status = document.createElement("span");
  status.className = "ca-status";
  status.textContent = "Pending";

  head.appendChild(kind);
  head.appendChild(status);
  card.appendChild(head);

  const title = document.createElement("h4");
  title.className = "ca-title";
  title.textContent =
    typeof action.title === "string" && action.title.trim()
      ? action.title.trim()
      : "Coaching change";
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "ca-body";

  const affectedDate = action.to_date || action.from_date || null;
  appendCoachActionRow(body, "Affected date", affectedDate);

  if (isCorrection) {
    appendCoachActionRow(body, "Imported value", action.original_summary);
    appendCoachActionRow(body, "Corrected value", action.proposed_summary);
  } else {
    appendCoachActionRow(body, "Now", action.original_summary);
    appendCoachActionRow(body, "Proposed", action.proposed_summary);
  }

  appendCoachActionRow(body, "Why", action.reason);

  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "ca-actions";

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "ca-apply";
  applyBtn.textContent = "Apply changes";
  applyBtn.addEventListener("click", () => {
    if (typeof window.applyCoachAction === "function") {
      window.applyCoachAction(action.id, card);
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ca-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    if (typeof window.cancelCoachAction === "function") {
      window.cancelCoachAction(action.id, card);
    }
  });

  actions.appendChild(applyBtn);
  actions.appendChild(cancelBtn);
  card.appendChild(actions);

  const message = document.createElement("p");
  message.className = "ca-msg";
  card.appendChild(message);

  return card;
}

function renderCoachActions(container, actions) {
  actions.forEach(action => {
    if (!action || typeof action !== "object" || !action.id) {
      return;
    }

    // Register the full proposal so the Apply handler can send it
    // without stuffing raw JSON into DOM attributes.
    if (typeof window !== "undefined") {
      window.__coachProposals = window.__coachProposals || {};
      window.__coachProposals[action.id] = action;
    }

    container.appendChild(buildCoachActionCard(action));
  });
}

function renderSuggestedReplies(replies) {
  const chipsContainer =
    document.getElementById("chips");

  if (!chipsContainer) {
    return;
  }

  chipsContainer.innerHTML = "";

  if (
    !Array.isArray(replies) ||
    replies.length === 0
  ) {
    chipsContainer.style.display = "none";
    return;
  }

  replies.slice(0, 3).forEach(reply => {
    if (
      typeof reply !== "string" ||
      !reply.trim()
    ) {
      return;
    }

    const button =
      document.createElement("button");

    button.type = "button";
    button.className = "chip";
    button.textContent = reply.trim();

    button.addEventListener("click", () => {
      const input =
        document.getElementById("chatInput");

      if (!input) {
        return;
      }

      input.value = reply.trim();
      input.focus();

      if (
        typeof window.sendMsg === "function"
      ) {
        window.sendMsg();
      }
    });

    chipsContainer.appendChild(button);
  });

  chipsContainer.style.display = "flex";
}

window.renderCoachResponse =
  renderCoachResponse;

window.parseCoachResponse =
  parseCoachResponse;

  window.renderSuggestedReplies =
  renderSuggestedReplies;
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
    wrapper.appendChild(
      createCoachElement(
        "p",
        "coach-response-section-body",
        section.body
      )
    );
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

      list.appendChild(
        createCoachElement(
          "li",
          "",
          item
        )
      );
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
    container.appendChild(
      createCoachElement(
        "p",
        "coach-response-direct",
        response.direct_answer
      )
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

    mission.appendChild(
      createCoachElement(
        "p",
        "coach-mission-text",
        response.mission
      )
    );

    container.appendChild(mission);
  }

  if (
    Number.isFinite(
      Number(response.confidence)
    )
  ) {
    const confidence = Math.min(
      100,
      Math.max(
        0,
        Math.round(
          Number(response.confidence)
        )
      )
    );

    const confidenceWrapper =
      createCoachElement(
        "div",
        "coach-confidence"
      );

    confidenceWrapper.appendChild(
      createCoachElement(
        "span",
        "coach-confidence-label",
        "Decision confidence"
      )
    );

    confidenceWrapper.appendChild(
      createCoachElement(
        "strong",
        "coach-confidence-value",
        `${confidence}%`
      )
    );

    container.appendChild(
      confidenceWrapper
    );
  }

  if (response.closing) {
    container.appendChild(
      createCoachElement(
        "p",
        "coach-response-closing",
        response.closing
      )
    );
  }
}

window.renderCoachResponse =
  renderCoachResponse;

window.parseCoachResponse =
  parseCoachResponse;
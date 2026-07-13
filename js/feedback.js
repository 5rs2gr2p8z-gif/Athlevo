console.log("Athlevo Feedback Loaded");

/*
 * Private beta feedback & suggestions.
 *
 * Submissions are written directly to the user-owned `beta_feedback`
 * table via the Supabase client (RLS restricts each athlete to their
 * own rows), so no API route is required. Nothing here is public and no
 * other athlete's feedback is ever read.
 */

const BETA_FEEDBACK_CATEGORIES = [
  { key: "bug", label: "Bug" },
  { key: "coaching", label: "Coaching feedback" },
  { key: "feature", label: "Feature request" },
  { key: "confusing", label: "Confusing experience" },
  { key: "other", label: "Other" }
];

const BETA_FEEDBACK_SCREENS = [
  "Today",
  "Coach",
  "Train",
  "Trends",
  "You",
  "Other"
];

let betaFeedbackDraft = { category: null };
let betaFeedbackSubmitting = false;

function escapeFeedbackText(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* Best-effort guess of the screen the athlete is on right now. */
function detectActiveScreenLabel() {
  const active = document.querySelector(".screen.active");

  if (!active || !active.id) {
    return "";
  }

  const map = {
    "screen-today": "Today",
    "screen-coachai": "Coach",
    "screen-train": "Train",
    "screen-trends": "Trends",
    "screen-you": "You"
  };

  return map[active.id] || "";
}

function openBetaFeedback() {
  const modal = document.getElementById("betaFeedbackModal");

  if (!modal) {
    return;
  }

  betaFeedbackDraft = { category: null };
  betaFeedbackSubmitting = false;

  const categoryChips = BETA_FEEDBACK_CATEGORIES.map(
    option =>
      `<button class="ob-chip" type="button" data-category="${option.key}">${escapeFeedbackText(
        option.label
      )}</button>`
  ).join("");

  const activeScreen = detectActiveScreenLabel();

  const screenOptions = ['<option value="">Not specific / not sure</option>']
    .concat(
      BETA_FEEDBACK_SCREENS.map(
        name =>
          `<option value="${escapeFeedbackText(name)}"${
            name === activeScreen ? " selected" : ""
          }>${escapeFeedbackText(name)}</option>`
      )
    )
    .join("");

  modal.innerHTML = `
    <div class="lesson">
      <span class="eyebrow">Feedback &amp; Suggestions</span>
      <h3 class="serif">Tell us what's on your mind</h3>
      <p>Report a bug, share an idea, or tell us what felt confusing. This is private — only the Athlevo team sees it.</p>

      <div class="ci-row">
        <div class="ci-label">Category</div>
        <div class="ci-chips">${categoryChips}</div>
      </div>

      <div class="ci-row">
        <div class="ci-label">Subject <span class="fb-optional">(optional)</span></div>
        <input id="bfSubject" class="ci-input" type="text" maxlength="120" placeholder="A short title">
      </div>

      <div class="ci-row">
        <div class="ci-label">Message</div>
        <textarea id="bfMessage" class="ci-input" maxlength="4000" placeholder="What happened, or what would make Athlevo better?"></textarea>
      </div>

      <div class="ci-row">
        <div class="ci-label">Affected screen <span class="fb-optional">(optional)</span></div>
        <select id="bfScreen" class="ci-input">${screenOptions}</select>
      </div>

      <label class="fb-check">
        <input id="bfFollowUp" type="checkbox" checked>
        <span>It's okay to follow up with me about this</span>
      </label>

      <p class="ci-msg" id="bfMsg"></p>

      <button class="lesson-done" type="button" id="bfSubmit">Send feedback</button>
    </div>
  `;

  modal.querySelectorAll("[data-category]").forEach(chip => {
    chip.addEventListener("click", () => {
      betaFeedbackDraft.category = chip.dataset.category;

      modal
        .querySelectorAll("[data-category]")
        .forEach(other =>
          other.classList.toggle("sel", other === chip)
        );
    });
  });

  modal
    .querySelector("#bfSubmit")
    .addEventListener("click", submitBetaFeedback);

  modal.onclick = event => {
    if (event.target === modal) {
      closeBetaFeedback();
    }
  };

  modal.classList.add("show");
}

function closeBetaFeedback() {
  const modal = document.getElementById("betaFeedbackModal");

  if (modal) {
    modal.classList.remove("show");
    modal.innerHTML = "";
  }

  betaFeedbackDraft = { category: null };
  betaFeedbackSubmitting = false;
}

async function submitBetaFeedback() {
  // Guard against duplicate submissions from repeated taps.
  if (betaFeedbackSubmitting) {
    return;
  }

  const message = document.getElementById("bfMsg");
  const submit = document.getElementById("bfSubmit");

  const messageValue = document
    .getElementById("bfMessage")
    .value.trim();

  if (!betaFeedbackDraft.category) {
    if (message) {
      message.textContent = "Please choose a category.";
    }
    return;
  }

  if (!messageValue) {
    if (message) {
      message.textContent = "Please add a short message.";
    }
    return;
  }

  const subjectValue = document
    .getElementById("bfSubject")
    .value.trim();

  const screenValue = document.getElementById("bfScreen").value;
  const allowFollowUp =
    document.getElementById("bfFollowUp").checked === true;

  betaFeedbackSubmitting = true;

  if (submit) {
    submit.disabled = true;
    submit.textContent = "Sending...";
  }

  if (message) {
    message.textContent = "";
  }

  try {
    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error("Please log in again to send feedback.");
    }

    const { error } = await supabaseClient
      .from("beta_feedback")
      .insert([
        {
          user_id: user.id,
          category: betaFeedbackDraft.category,
          subject: subjectValue || null,
          message: messageValue,
          affected_screen: screenValue || null,
          allow_follow_up: allowFollowUp,
          app_version: window.ATHLEVO_BUILD || null
        }
      ]);

    if (error) {
      throw new Error(
        error.message || "Your feedback could not be sent."
      );
    }

    showBetaFeedbackConfirmation();
  } catch (error) {
    console.error("Beta feedback submit failed:", error);

    betaFeedbackSubmitting = false;

    if (message) {
      message.textContent =
        error.message || "Your feedback could not be sent.";
    }

    if (submit) {
      submit.disabled = false;
      submit.textContent = "Send feedback";
    }
  }
}

/* Calm confirmation. Replacing the sheet body also clears the form. */
function showBetaFeedbackConfirmation() {
  const modal = document.getElementById("betaFeedbackModal");

  if (!modal) {
    return;
  }

  betaFeedbackSubmitting = false;

  modal.innerHTML = `
    <div class="lesson">
      <span class="eyebrow">Thank you</span>
      <h3 class="serif">Your feedback is with the team</h3>
      <p>We read every note from beta athletes. Thank you for helping make Athlevo better.</p>
      <button class="lesson-done" type="button" id="bfDone">Done</button>
    </div>
  `;

  modal
    .querySelector("#bfDone")
    .addEventListener("click", closeBetaFeedback);
}

window.openBetaFeedback = openBetaFeedback;
window.closeBetaFeedback = closeBetaFeedback;

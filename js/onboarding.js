console.log("Athlevo Onboarding Loaded");

const ATHLEVO_ONBOARDING_QUESTIONS = [
  {
    field: "full_name",
    question: "First, what should I call you?",
    acknowledgement: answer => `Got it, ${answer}. Let’s build your athlete profile properly.`
  },
  {
    field: "age",
    question: "How old are you?",
    type: "number",
    minimum: 13,
    maximum: 100,
    acknowledgement: answer => `Noted — ${answer} years old.`
  },
  {
    field: "sex",
    question:
      "What sex were you assigned at birth? This helps with physiological context, but it will never define your potential.",
    acknowledgement: () => "Understood."
  },
  {
    field: "height",
    question: "What is your height in centimeters?",
    type: "number",
    minimum: 100,
    maximum: 250,
    acknowledgement: answer => `Height recorded: ${answer} cm.`
  },
  {
    field: "weight",
    question: "What is your current weight in kilograms?",
    type: "number",
    minimum: 25,
    maximum: 300,
    acknowledgement: answer => `Weight recorded: ${answer} kg.`
  },
  {
    field: "location",
    question:
      "Where do you usually live and train? City and country are enough. This helps me account for climate and environment.",
    acknowledgement: answer => `Noted. I’ll consider the conditions around ${answer}.`
  },
  {
    field: "primary_sport",
    question:
      "What is your primary sport right now? For example: running, cycling, triathlon, or HYROX.",
    acknowledgement: answer => `${answer} will be the primary focus of your system.`
  },
  {
    field: "goal",
    question:
      "What is the main outcome you want from training? Be specific where possible.",
    acknowledgement: answer => `Your main goal is clear: ${answer}`
  },
  {
    field: "target_race",
    question:
      'Are you preparing for a specific race or event? Type the event name, or type "none".',
    nullable: true,
    acknowledgement: answer =>
      answer === null
        ? "No fixed race yet. We’ll build around long-term development."
        : `Target event recorded: ${answer}`
  },
  {
    field: "race_date",
    question:
      'What is the race date? Use YYYY-MM-DD, or type "none" if there is no confirmed date.',
    type: "date",
    nullable: true,
    acknowledgement: answer =>
      answer === null
        ? "No confirmed race date yet."
        : `Race date recorded: ${answer}`
  },
  {
    field: "target_time",
    question:
      'Do you have a target result or finish time? Type it naturally, or type "none".',
    nullable: true,
    acknowledgement: answer =>
      answer === null
        ? "No performance target locked in yet."
        : `Target performance recorded: ${answer}`
  },
  {
    field: "experience_years",
    question:
      "How many years have you trained consistently in your primary sport?",
    type: "number",
    minimum: 0,
    maximum: 80,
    acknowledgement: answer => `${answer} years of experience — noted.`
  },
  {
    field: "weekly_distance",
    question:
      'What is your current average weekly training distance in kilometers? Type a number, or "none" if distance is not useful for your sport.',
    type: "number",
    nullable: true,
    minimum: 0,
    maximum: 1000,
    acknowledgement: answer =>
      answer === null
        ? "We’ll use training time and session history instead of distance."
        : `Current weekly distance: approximately ${answer} km.`
  },
  {
  field: "weekly_hours",
  question:
    "Approximately how many total hours do you currently train each week? You can enter one number or a range, such as 5 or 4-6.",
  type: "number",
  minimum: 0,
  maximum: 100,
  rangeStrategy: "average",
  acknowledgement: answer =>
    `Current training load: approximately ${answer} hours per week.`
},
  {
    field: "injury_history",
    question:
      'Tell me about current pain, previous injuries, or recurring problem areas. Type "none" if there are no known issues.',
    nullable: true,
    acknowledgement: answer =>
      answer === null
        ? "No known injury concerns reported."
        : `I’ll treat this as an important constraint: ${answer}`
  },
  {
  field: "available_days",
  question:
    "How many days per week can you realistically train—not ideally, but consistently? You can enter one number or a range, such as 4 or 4-5.",
  type: "number",
  minimum: 1,
  maximum: 7,
  rangeStrategy: "minimum",
  integer: true,
  acknowledgement: answer =>
    `${answer} reliable training days gives us a realistic weekly structure.`
},
  {
    field: "preferred_training_time",
    question:
      "When do you usually train? For example: early morning, after work, evenings, or variable.",
    acknowledgement: answer => `Preferred training time recorded: ${answer}`
  },
  {
    field: "work_schedule",
    question:
      "Describe your work or school schedule. Include night shifts, rotating schedules, long commutes, or unusually demanding days.",
    acknowledgement: answer =>
      `That schedule matters. I’ll treat it as part of your training load: ${answer}`
  },
  {
    field: "sleep_hours",
    question:
      "How many hours do you usually sleep per night on average?",
    type: "number",
    minimum: 1,
    maximum: 16,
    acknowledgement: answer => `Average sleep recorded: ${answer} hours.`
  },
  {
    field: "stress_level",
    question:
      "How would you describe your normal life stress: low, moderate, high, or highly variable? Add context if useful.",
    acknowledgement: answer => `Life-stress context recorded: ${answer}`
  },
  {
    field: "diet",
    question:
      'Do you follow a particular diet or eating pattern? Examples include vegetarian, vegan, halal, intermittent fasting, or no restrictions.',
    acknowledgement: answer => `Nutrition context recorded: ${answer}`
  },
  {
    field: "allergies",
    question:
      'Do you have food allergies, intolerances, or fueling limitations? Type "none" if not applicable.',
    nullable: true,
    acknowledgement: answer =>
      answer === null
        ? "No food allergies or intolerances reported."
        : `Fueling limitation recorded: ${answer}`
  },
  {
    field: "device",
    question:
      'What training device or watch do you currently use? Include the model if you know it, or type "none".',
    nullable: true,
    acknowledgement: answer =>
      answer === null
        ? "No device yet. Manual training data will still work."
        : `Device recorded: ${answer}`
  },
  {
    field: "coach_notes",
    question:
      "Finally, what else should your coach understand about your life, health, preferences, motivation, responsibilities, or training? This can include anything the previous questions missed.",
    acknowledgement: () =>
      "Thank you. That context will help Athlevo coach the person—not just the workouts."
  }
];

let athlevoOnboardingStep = 0;
let athlevoOnboardingProfile = null;
let athlevoOnboardingBusy = false;

function addOnboardingMessage(role, text) {
  const log = document.getElementById("obLog");

  if (!log) {
    console.error("Onboarding log was not found.");
    return;
  }

  const message = document.createElement("div");
  message.className = `msg ${role}`;

  const label = document.createElement("span");
  label.className = "call";
  label.textContent = role === "user" ? "You" : "Athlevo Coach";

  const content = document.createElement("div");
  content.className = "change";
  content.textContent = text;

  message.appendChild(label);
  message.appendChild(content);
  log.appendChild(message);

  log.scrollTop = log.scrollHeight;
}

function normalizeOnboardingAnswer(question, rawAnswer) {
  const trimmedAnswer = rawAnswer.trim();

  if (!trimmedAnswer) {
    throw new Error("Please enter an answer before continuing.");
  }

  const lowercaseAnswer = trimmedAnswer.toLowerCase();

  if (
    question.nullable &&
    [
      "none",
      "n/a",
      "na",
      "not applicable",
      "no",
      "not sure",
      "unknown"
    ].includes(lowercaseAnswer)
  ) {
    return null;
  }

  if (question.type === "number") {
    const cleanedAnswer = lowercaseAnswer
      .replace(/approximately/g, "")
      .replace(/approx\./g, "")
      .replace(/approx/g, "")
      .replace(/around/g, "")
      .replace(/about/g, "")
      .replace(/roughly/g, "")
      .replace(/hours?/g, "")
      .replace(/hrs?/g, "")
      .replace(/days?/g, "")
      .replace(/kilometers?/g, "")
      .replace(/kilometres?/g, "")
      .replace(/kms?/g, "")
      .trim();

    const rangeMatch = cleanedAnswer.match(
      /^(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)$/
    );

    let number;

    if (rangeMatch) {
      const minimumValue = Number(rangeMatch[1]);
      const maximumValue = Number(rangeMatch[2]);

      if (
        !Number.isFinite(minimumValue) ||
        !Number.isFinite(maximumValue)
      ) {
        throw new Error("Please enter a valid number or range.");
      }

      if (minimumValue > maximumValue) {
        throw new Error(
          "Please enter the lower number first, such as 4-5."
        );
      }

      if (question.rangeStrategy === "minimum") {
        number = minimumValue;
      } else if (question.rangeStrategy === "maximum") {
        number = maximumValue;
      } else {
        number = (minimumValue + maximumValue) / 2;
      }
    } else {
      const numberMatch = cleanedAnswer.match(/\d+(?:\.\d+)?/);

      if (!numberMatch) {
        throw new Error(
          "Please enter a number or range, such as 5 or 4-5."
        );
      }

      number = Number(numberMatch[0]);
    }

    if (!Number.isFinite(number)) {
      throw new Error("Please enter a valid number.");
    }

    if (
      typeof question.minimum === "number" &&
      number < question.minimum
    ) {
      throw new Error(
        `Please enter a value of at least ${question.minimum}.`
      );
    }

    if (
      typeof question.maximum === "number" &&
      number > question.maximum
    ) {
      throw new Error(
        `Please enter a value no higher than ${question.maximum}.`
      );
    }

    if (question.integer === true) {
      number = Math.floor(number);
    }

    return number;
  }

  if (question.type === "date") {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    if (!datePattern.test(trimmedAnswer)) {
      throw new Error("Please use the date format YYYY-MM-DD.");
    }

    const parsedDate = new Date(`${trimmedAnswer}T00:00:00`);

    if (Number.isNaN(parsedDate.getTime())) {
      throw new Error("Please enter a valid date.");
    }

    return trimmedAnswer;
  }

  return trimmedAnswer;
}

async function getAuthenticatedOnboardingUser() {
  const {
    data: { user },
    error
  } = await supabaseClient.auth.getUser();

  if (error) {
    throw error;
  }

  if (!user) {
    throw new Error("You must be logged in before completing onboarding.");
  }

  return user;
}

async function loadOnboardingProfile() {
  const user = await getAuthenticatedOnboardingUser();

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const { data: createdProfile, error: createError } = await supabaseClient
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

    if (createError) {
      throw createError;
    }

    return createdProfile;
  }

  return data;
}

async function saveOnboardingAnswer(question, answer) {
  const user = await getAuthenticatedOnboardingUser();
  const nextStep = athlevoOnboardingStep + 1;

  const updates = {
    [question.field]: answer,
    onboarding_step: nextStep,
    updated_at: new Date().toISOString()
  };

  if (question.field === "available_days") {
    updates.training_days = answer;
  }

  const { data, error } = await supabaseClient
    .from("profiles")
    .update(updates)
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  athlevoOnboardingProfile = data;
  return data;
}

function getOnboardingAcknowledgement(question, answer) {
  if (typeof question.acknowledgement === "function") {
    return question.acknowledgement(answer);
  }

  return "Understood. I’ve saved that.";
}

function askCurrentOnboardingQuestion() {
  const question = ATHLEVO_ONBOARDING_QUESTIONS[athlevoOnboardingStep];

  if (!question) {
    finishAthlevoOnboarding();
    return;
  }

  addOnboardingMessage("ai", question.question);

  const input = document.getElementById("obInput");

  if (input) {
    input.value = "";
    input.disabled = false;
    input.focus();
  }
}

async function submitOnboardingAnswer() {
  if (athlevoOnboardingBusy) {
    return;
  }

  const input = document.getElementById("obInput");

  if (!input) {
    console.error("Onboarding input was not found.");
    return;
  }

  const question = ATHLEVO_ONBOARDING_QUESTIONS[athlevoOnboardingStep];

  if (!question) {
    return;
  }

  let answer;

  try {
    answer = normalizeOnboardingAnswer(question, input.value);
  } catch (error) {
    addOnboardingMessage("ai", error.message);
    input.focus();
    return;
  }

  athlevoOnboardingBusy = true;
  input.disabled = true;

  const displayedAnswer = answer === null ? "None" : String(answer);
  addOnboardingMessage("user", displayedAnswer);

  try {
    await saveOnboardingAnswer(question, answer);

    const acknowledgement = getOnboardingAcknowledgement(question, answer);
    addOnboardingMessage("ai", acknowledgement);

    athlevoOnboardingStep += 1;

    window.setTimeout(() => {
      askCurrentOnboardingQuestion();
    }, 350);
  } catch (error) {
    console.error("Could not save onboarding answer:", error);

    addOnboardingMessage(
      "ai",
      "I couldn’t save that answer. Please check your connection and try again."
    );

    input.disabled = false;
    input.focus();
  } finally {
    athlevoOnboardingBusy = false;
  }
}

async function finishAthlevoOnboarding() {
  athlevoOnboardingBusy = true;

  try {
    const user = await getAuthenticatedOnboardingUser();

    const { data, error } = await supabaseClient
      .from("profiles")
      .update({
        onboarding_complete: true,
        onboarding_step: ATHLEVO_ONBOARDING_QUESTIONS.length,
        updated_at: new Date().toISOString()
      })
      .eq("id", user.id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    athlevoOnboardingProfile = data;

    addOnboardingMessage(
      "ai",
      "Your athlete profile is complete. I now have enough context to begin coaching you responsibly."
    );

    window.setTimeout(async () => {
      const tabbar = document.getElementById("tabbar");

     if (tabbar) {
    tabbar.style.display = "flex";
}

await AthlevoBrain.refreshAthleteUI();
showScreen("screen-today");
    }, 900);
  } catch (error) {
    console.error("Could not complete onboarding:", error);

    addOnboardingMessage(
      "ai",
      "I saved your answers, but I couldn’t finalize the profile. Please try again."
    );
  } finally {
    athlevoOnboardingBusy = false;
  }
}

async function startAthlevoOnboarding() {
  const log = document.getElementById("obLog");
  const input = document.getElementById("obInput");

  if (!log || !input) {
    console.error("New onboarding interface was not found.");
    return;
  }

  showScreen("screen-onboard");

  log.innerHTML = "";
  input.disabled = true;

  addOnboardingMessage(
    "ai",
    "I’m loading your athlete profile so we can continue from the right place."
  );

  try {
    athlevoOnboardingProfile = await loadOnboardingProfile();

    if (athlevoOnboardingProfile.onboarding_complete) {
      const tabbar = document.getElementById("tabbar");

     if (tabbar) {
    tabbar.style.display = "flex";
}

await AthlevoBrain.refreshAthleteUI();
showScreen("screen-today");
return;
    }

    const savedStep = Number(
      athlevoOnboardingProfile.onboarding_step || 0
    );

    athlevoOnboardingStep = Math.min(
      Math.max(savedStep, 0),
      ATHLEVO_ONBOARDING_QUESTIONS.length
    );

    log.innerHTML = "";

    if (athlevoOnboardingStep > 0) {
      addOnboardingMessage(
        "ai",
        "Welcome back. I saved your previous answers, so we’ll continue where you stopped."
      );
    } else {
      addOnboardingMessage(
        "ai",
        "Before I build your training system, I need to understand you as an athlete and as a person."
      );
    }

    askCurrentOnboardingQuestion();
  } catch (error) {
    console.error("Could not start onboarding:", error);

    addOnboardingMessage(
      "ai",
      "I couldn’t load your athlete profile. Please refresh and try again."
    );
  }
}

function setupOnboardingInterface() {
  const sendButton = document.getElementById("obSend");
  const input = document.getElementById("obInput");

  if (!sendButton || !input) {
    return;
  }

  sendButton.addEventListener("click", submitOnboardingAnswer);

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitOnboardingAnswer();
    }
  });
}

window.startOnboarding = startAthlevoOnboarding;
window.startAthlevoOnboarding = startAthlevoOnboarding;
window.submitOnboardingAnswer = submitOnboardingAnswer;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupOnboardingInterface);
} else {
  setupOnboardingInterface();
}
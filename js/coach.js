console.log("Athlevo Coach Loaded");

function addChatMessage(role, text) {
  const chatlog = document.getElementById("chatlog");

  if (!chatlog) {
    console.error("Chat log not found.");
    return null;
  }

  const message = document.createElement("div");
  message.className = `msg ${role}`;

  if (role === "user") {
    message.innerHTML = `
      <span class="call">You</span>
      <div class="change"></div>
    `;
  } else {
    message.innerHTML = `
      <span class="call">Athlevo Coach</span>
      <div class="change"></div>
    `;
  }

  message.querySelector(".change").textContent = text;
  chatlog.appendChild(message);
  chatlog.scrollTop = chatlog.scrollHeight;

  return message;
}
async function saveConversationMessage(role, message) {
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError || !user) {
    console.error("Cannot save message: no authenticated user.", userError);
    return;
  }

  console.log("Saving conversation for:", user.id, role, message);

const { data, error } = await supabaseClient
  .from("coach_conversations")
  .insert([
    {
      user_id: user.id,
      role,
      message
    }
  ])
  .select();

if (error) {
  console.error("Could not save conversation message:", error);
  return;
}

console.log("Conversation saved successfully:", data);
}

async function loadConversationHistory() {
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError || !user) {
    console.error("Cannot load history: no authenticated user.", userError);
    return [];
  }

  const { data, error } = await supabaseClient
    .from("coach_conversations")
    .select("role, message, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Could not load conversation history:", error);
    return [];
  }

  return data || [];
}
async function renderConversationHistory() {
  const chatlog = document.getElementById("chatlog");

  if (!chatlog) {
    console.error("Chat log not found.");
    return;
  }

  const history = await loadConversationHistory();

  if (!history.length) return;

  chatlog.innerHTML = "";

  history.forEach(item => {
    const role = item.role === "assistant" ? "ai" : "user";
    addChatMessage(role, item.message);
  });

  chatlog.scrollTop = chatlog.scrollHeight;
}
async function extractAthleteMemoryFromMessage(message) {
  try {
    const {
      data: { session },
      error: sessionError
    } = await supabaseClient.auth.getSession();

    if (sessionError) {
      throw sessionError;
    }

    if (!session?.access_token) {
      console.log(
        "Memory extraction skipped: no authenticated session."
      );

      return {
        memories: [],
        extractedCount: 0
      };
    }

    const response = await fetch(
      "/api/memory/extract",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization:
            `Bearer ${session.access_token}`
        },

        body: JSON.stringify({
          message
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result?.error ||
        "Could not extract athlete memory."
      );
    }

    console.log(
      "Athlete memory extraction:",
      result
    );

    return result;
  } catch (error) {
    /*
     * Memory extraction must never prevent the
     * athlete from receiving a coaching response.
     */
    console.error(
      "Athlete memory extraction failed:",
      error
    );

    return {
      memories: [],
      extractedCount: 0,
      error:
        error?.message ||
        "Memory extraction failed."
    };
  }
}
async function askCoach(question) {
  const cleanQuestion = question?.trim();

  if (!cleanQuestion) return;

  addChatMessage("user", cleanQuestion);
  await saveConversationMessage("user", cleanQuestion);
  await extractAthleteMemoryFromMessage(
  cleanQuestion
);

  const loadingMessage = addChatMessage(
    "ai",
    "Reviewing your athlete profile and training context..."
  );

  try {
    const profile =
  await AthlevoBrain.loadAthleteProfile();

if (!profile) {
  throw new Error(
    "No athlete profile was found."
  );
}

const activities =
  await AthlevoBrain.loadAthleteActivities(200);

const activitySummary =
  AthlevoBrain.buildActivitySummary(activities);

const athleteMemory =
  await AthlevoMemory.loadAthleteMemory();

const context =
  AthlevoBrain.buildCoachingContext(
    profile,
    activities,
    activitySummary
  );

if (!context) {
  throw new Error(
    "The athlete coaching context could not be created."
  );
}

context.longTermMemory = athleteMemory.map(memory => ({
  id: memory.id,
  category: memory.category,
  content: memory.content,
  importance: memory.importance,
  updatedAt: memory.updated_at
}));
    const response = await fetch("/api/coach", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        question: cleanQuestion,
        context
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Coach request failed.");
    }

    const answer = data.answer || "I could not generate a response.";

loadingMessage.querySelector(".change").textContent = answer;

await saveConversationMessage("assistant", answer);
  } catch (error) {
    console.error("Athlevo Coach error:", error);

    loadingMessage.querySelector(".change").textContent =
      "I couldn’t complete that request. Please try again.";
  }

  const chatlog = document.getElementById("chatlog");
  chatlog.scrollTop = chatlog.scrollHeight;
}

function ask(question) {
  askCoach(question);
}

function sendMsg() {
  const input = document.getElementById("chatInput");

  if (!input) {
    console.error("Chat input not found.");
    return;
  }

  const question = input.value.trim();

  if (!question) return;

  input.value = "";
  askCoach(question);
}

window.askCoach = askCoach;
window.ask = ask;
window.sendMsg = sendMsg;
window.loadConversationHistory = loadConversationHistory;
window.saveConversationMessage = saveConversationMessage;
window.renderConversationHistory = renderConversationHistory;
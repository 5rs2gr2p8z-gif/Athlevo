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
async function askCoach(question) {
  const cleanQuestion = question?.trim();

  if (!cleanQuestion) return;

  addChatMessage("user", cleanQuestion);
  await saveConversationMessage("user", cleanQuestion);

  const loadingMessage = addChatMessage(
    "ai",
    "Reviewing your athlete profile and training context..."
  );

  try {
    const profile = await AthlevoBrain.loadAthleteProfile();
AthlevoBrain.updateTodayDashboard(profile);

    if (!profile) {
      throw new Error("No athlete profile was found.");
    }

    const context = AthlevoBrain.buildCoachingContext(profile);

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
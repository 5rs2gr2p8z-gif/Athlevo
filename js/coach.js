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

async function askCoach(question) {
  const cleanQuestion = question?.trim();

  if (!cleanQuestion) return;

  addChatMessage("user", cleanQuestion);

  const loadingMessage = addChatMessage(
    "ai",
    "Reviewing your athlete profile and training context..."
  );

  try {
    const profile = await AthlevoBrain.loadAthleteProfile();

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

    loadingMessage.querySelector(".change").textContent =
      data.answer || "I could not generate a response.";
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
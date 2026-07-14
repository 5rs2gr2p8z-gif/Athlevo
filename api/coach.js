import { buildAthlevoMethodPrompt } from "../lib/server/athlevoMethod.js";

// Coach-chat-only voice & formatting rules. Layered on top of the shared
// Athlevo Method prompt so the daily brief and plan generator are
// unaffected. The goal is to read like a real elite coach texting an
// athlete — not an AI assistant.
const COACH_CHAT_STYLE = `
YOU ARE THE ATHLETE'S COACH

You are an elite endurance coach speaking directly to your athlete — not
an assistant, not a chatbot. The athlete should feel that you already
understand their situation before they finish reading.

VOICE
- Calm. Precise. Decisive. Professional.
- Never overly friendly. Never motivational. Never robotic. Never verbose.
- No praise, cheerleading, or exclamation. Confidence comes from judgment,
  not enthusiasm.

LEAD WITH THE DECISION
Open with the decision in one short sentence, stated first. For example:
"Yes." / "Not today." / "Keep the session." / "Reduce the duration to 40
minutes." Then, in flowing short paragraphs, explain — in this order and
without printed headings — why, what matters most, what to watch, and what
happens next.

Follow the Athlevo Method: protect the next key session, train the whole
cost (heat, work, sleep, life load), keep easy days genuinely easy, and
never chase a missed day.

Match the example's texture:
"""
Today's priority is protecting Thursday's quality session.
Yesterday already became a moderate day after the extra strides and
strength work. Today's easy run is not where fitness is built — it's where
yesterday's work becomes useful.
Run by feel. If your legs suddenly feel great, resist speeding up; finish
wanting more.
After today's run I'll use your execution feedback to decide whether
Thursday stays unchanged.
"""

DISCIPLINE
- One strong insight, not five weak ones.
- Do not restate the athlete's question. Do not repeat obvious information.
- Prioritize the decision over education, judgment over explanation, and
  their specific context over generic advice.
- Every reply answers one thing: what is the single most important
  coaching decision right now?

WHEN DATA IS MISSING
- Never invent numbers, workouts, sleep, HRV, pain, or history.
- Say plainly: "I don't have enough information yet." Then ask exactly ONE
  high-value follow-up — only a question whose answer would change the
  coaching decision. Ask fewer questions, not more.

NEVER USE AI LANGUAGE
Do not write: "I analyzed", "Based on my reasoning", "I considered", "My
recommendation", "the confidence is", "the AI", or any reference to models,
processing, scoring, or your own internals. Speak as a human coach.

HOW TO USE THE RESPONSE FIELDS
- direct_answer: the whole reply — the one-sentence decision first, then
  the reasoning as short paragraphs separated by blank lines. Use **bold**
  only for the few things that matter most. Use "- " bullets only when a
  genuine list helps.
- mission: the single next action ("what happens next"), one short line.
  Leave null if the next step is already clear in the reply.
- sections: use rarely, only when a real list or steps genuinely help;
  give a short plain title. Do not manufacture sections.
- headline, compliment, closing: leave null in almost all cases. Never use
  compliment for praise.
- suggested_replies: 0–3 short follow-ups in the athlete's voice, or none.
- confidence: internal only; never mention or imply it.

FORMAT FOR A PHONE
Short paragraphs. Breathing room between ideas. No walls of text. Minimal,
clean markdown.
`.trim();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { question, context } = req.body || {};
    const athlevoMethodPrompt = buildAthlevoMethodPrompt();

    if (!question) {
      return res.status(400).json({
        error: "Question is required"
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is not configured"
      });
    }

    const openAIResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: {
            effort: "low"
          },
          input: [
            {
    role: "developer",
    content: `${athlevoMethodPrompt}\n\n${COACH_CHAT_STYLE}`
},
            {
              role: "user",
              content: `
ATHLETE CONTEXT:
${JSON.stringify(context, null, 2)}

ATHLETE QUESTION:
${question}
              `.trim()
            }
          ],
          text: {
  format: {
    type: "json_schema",
    name: "athlevo_coaching_response",
    strict: true,

    schema: {
      type: "object",
      additionalProperties: false,

      properties: {
        response_type: {
          type: "string",
          enum: [
            "decision",
            "explanation",
            "lesson",
            "review",
            "standard"
          ]
        },

        headline: {
          type: ["string", "null"]
        },

        direct_answer: {
          type: "string"
        },

        compliment: {
          type: ["string", "null"]
        },

        sections: {
          type: "array",
          maxItems: 5,

          items: {
            type: "object",
            additionalProperties: false,

            properties: {
              title: {
                type: "string"
              },

              body: {
                type: ["string", "null"]
              },

              bullets: {
                type: "array",
                maxItems: 6,
                items: {
                  type: "string"
                }
              },

              style: {
                type: "string",
                enum: [
                  "normal",
                  "success",
                  "warning",
                  "tip",
                  "decision"
                ]
              },

              callout: {
                type: ["string", "null"]
              }
            },

            required: [
              "title",
              "body",
              "bullets",
              "style",
              "callout"
            ]
          }
        },

        mission: {
          type: ["string", "null"]
        },

        confidence: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 100
        },

        closing: {
          type: ["string", "null"]
        },
        suggested_replies: {
  type: "array",
  minItems: 0,
  maxItems: 3,
  items: {
    type: "string"
  }
}
      },

      required: [
  "response_type",
  "headline",
  "direct_answer",
  "compliment",
  "sections",
  "mission",
  "confidence",
  "closing",
  "suggested_replies"
]
    }
  }
}
        })
      }
    );

    const data = await openAIResponse.json();
    console.log(JSON.stringify(data, null, 2));

    if (!openAIResponse.ok) {
      console.error("OpenAI error:", data);

      const answer =
  data.output_text ||
  data.output?.[0]?.content?.[0]?.text ||
  "No response generated";

return res.status(200).json({
  answer
});
    }

    const answer =
  data.output_text ||
  data.output
    ?.flatMap(item => item.content || [])
    .find(content => content.type === "output_text")
    ?.text ||
  "No response generated";

let structuredAnswer;

try {
  structuredAnswer = JSON.parse(answer);
} catch {
  structuredAnswer = {
    response_type: "standard",
    headline: null,
    direct_answer: answer,
    compliment: null,
    sections: [],
    mission: null,
    confidence: null,
    closing: null,
    suggested_replies: []
  };
}

return res.status(200).json({
  answer: structuredAnswer
});

  } catch (error) {
    console.error("Coach API error:", error);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
}
import { buildAthlevoMethodPrompt } from "../lib/server/athlevoMethod.js";

// Coach-chat-only voice & formatting rules. Layered on top of the shared
// Athlevo Method prompt so the daily brief and plan generator are
// unaffected. The goal is to read like a real elite coach texting an
// athlete — not an AI assistant.
const COACH_CHAT_STYLE = `
COACH CHAT VOICE & FORMAT

You are the athlete's coach speaking directly to them. Warm, direct, and
concrete — never robotic.

Structure every reply to naturally follow this arc, but only include the
parts that add value and NEVER print the arc labels as literal headings
unless a heading genuinely helps:
1. Short answer — lead with the actual answer in the first 1–2 sentences
   (put this in direct_answer).
2. Why — the brief reasoning, in the athlete's terms.
3. Recommendation — what to actually do.
4. What to watch — the signal that would change the plan.
5. Next step — one clear action (put this in mission).

Use the response sections for Why / Recommendation / What to watch when
they help; give each a short, plain title (e.g. "Why", "Do this",
"Watch for"). Keep each section to a few short sentences or a few bullets.

FORMATTING
- Write for a phone screen. Short paragraphs. No walls of text.
- Prefer bullets for lists and numbered steps for sequences.
- Use bold only for the few things that matter most.
- Leave breathing room between ideas.
- Clean, minimal markdown only.

NEVER SHOW IMPLEMENTATION METADATA
- Do not mention AI, models, processing, tokens, scoring, reasoning
  depth, or "confidence" anywhere in athlete-facing text.
- The confidence field is internal only; never reference it in words.
- Speak as a human coach would, not as a system describing itself.
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
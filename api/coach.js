import { randomUUID } from "node:crypto";
import { buildAthlevoMethodPrompt } from "../lib/server/athlevoMethod.js";
import {
  ACTION_TYPES,
  validateProposedActions
} from "../lib/server/coachActions.js";

// Guidance for when the coach should propose a structured change in
// addition to answering. The change is only ever a PROPOSAL — it is
// applied elsewhere, after the athlete confirms.
const COACH_ACTIONS_INSTRUCTION = `
PROPOSING STRUCTURED CHANGES

When the athlete's message implies their stored plan or activity data
should change, populate the "actions" array with one or more proposals in
addition to your normal reply. Otherwise leave "actions" empty.

Map intent to action type:
- "I'm out of town tomorrow / can't run tomorrow" -> move_workout or skip_workout on that date.
- "Move my long run to Sunday" -> move_workout.
- "Remove tomorrow's intervals" / "my calf hurts, drop the session" -> skip_workout or modify_workout (conservative).
- "Make it easier / shorter" -> modify_workout.
- "Replace it with an easy run" -> replace_workout.
- "I can only train three days this week" / "I'm traveling next week" -> adjust_remaining_week or update_temporary_availability.
- "I prefer long runs on Sunday" -> update_training_preference.
- "My treadmill pace was actually 6:00/km, not 3:00/km" / "that run was intervals, not easy" -> create_activity_override.
- "My race date changed" -> update_race_details.

Rules:
- When you propose a workout change (modify_workout or replace_workout),
  the "changes" object IS the new workout. Fill every field you are
  changing so the plan and your proposal cannot diverge: title,
  description, purpose, duration_minutes, distance_km, session_type,
  intensity, target_rpe, warmup, main_set, cooldown, and notes. If a part
  of the workout stays the same, you may leave that field null and it is
  kept as-is. Your proposed_summary must match what "changes" actually
  sets — never describe a session you did not put in "changes".
- Use target_session_id / target_activity_id taken ONLY from the ids in
  the supplied athlete context. Never invent ids.
- Put the affected date in from_date/to_date (YYYY-MM-DD).
- Fill original_summary (what it is now) and proposed_summary (what it
  becomes) in plain language for the athlete.
- Give a short coaching reason.
- For pain or illness: be conservative, do not diagnose, do not shove the
  missed intensity into the next day, and suggest professional assessment
  when it sounds serious.
- Your text reply stays decisive and short: state the decision, then tell
  the athlete to review the proposal below. NEVER claim the change is
  already done — it needs their confirmation.
- If you lack the id or date needed, do not fabricate an action; instead
  ask one precise clarifying question in your reply and leave actions empty.

Supported action types: ${ACTION_TYPES.join(", ")}.
`.trim();

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

USING TODAY'S READINESS
- The context may include todayReadiness — the athlete's own morning
  check-in (sleep, energy, soreness, stress, pain) plus a calculated
  readinessScore (0–100), readinessStatus (Low/Moderate/Good/Optimal),
  and a short readinessExplanation. Treat all of it as real input and let
  it shape the decision and any workout modification (protect quality or
  ease off when readiness is Low/Moderate or pain is present; a strong
  score supports normal training). You may reference the score and the
  athlete's actual answers, but never invent HRV, recovery, or any value
  not present. If todayReadiness is absent, note it's not logged rather
  than inventing one.

MEMORY & CONTINUITY
- The context may include recentConversation (the last few turns, as
  athlete/coach) and longTermMemory (durable facts: goals, race date,
  recurring injuries, preferred days, zones, equipment, corrections).
  Use them to sound like a coach who has worked with this athlete over
  time — continue naturally, do not restart or repeat yourself.
- Reference a memory ONLY when it improves the decision, and phrase it
  naturally: "the same right-shin tightness you mentioned last week", not
  "according to memory record 14". Do not announce that you remember
  things, and do not over-reference old information.
- If a memory is flagged unverified, or a durable fact (injury, race
  date, weight, schedule, training zones) may be stale and materially
  affects safety or planning, briefly ask the athlete to confirm rather
  than assuming it is still current.
- Treat a temporary statement ("out of town tomorrow") as a one-off, not
  a permanent change to the athlete's normal preferences.

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
    content: `${athlevoMethodPrompt}\n\n${COACH_CHAT_STYLE}\n\n${COACH_ACTIONS_INSTRUCTION}`
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
},
        actions: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ACTION_TYPES },
              title: { type: "string" },
              target_session_id: { type: ["string", "null"] },
              target_activity_id: { type: ["string", "null"] },
              from_date: { type: ["string", "null"] },
              to_date: { type: ["string", "null"] },
              reason: { type: ["string", "null"] },
              original_summary: { type: ["string", "null"] },
              proposed_summary: { type: ["string", "null"] },
              changes: {
                type: "object",
                additionalProperties: false,
                properties: {
                  duration_minutes: { type: ["integer", "null"] },
                  distance_km: { type: ["number", "null"] },
                  session_type: { type: ["string", "null"] },
                  sport: { type: ["string", "null"] },
                  title: { type: ["string", "null"] },
                  description: { type: ["string", "null"] },
                  purpose: { type: ["string", "null"] },
                  intensity: { type: ["string", "null"] },
                  target_rpe: { type: ["string", "null"] },
                  pace_guidance: { type: ["string", "null"] },
                  heart_rate_guidance: { type: ["string", "null"] },
                  fueling_guidance: { type: ["string", "null"] },
                  coach_reasoning: { type: ["string", "null"] },
                  notes: { type: ["string", "null"] },
                  warmup: {
                    type: ["array", "null"],
                    items: { type: "string" }
                  },
                  main_set: {
                    type: ["array", "null"],
                    items: { type: "string" }
                  },
                  cooldown: {
                    type: ["array", "null"],
                    items: { type: "string" }
                  },
                  instructions: {
                    type: ["array", "null"],
                    items: { type: "string" }
                  },
                  adjustment_rules: {
                    type: ["array", "null"],
                    items: { type: "string" }
                  }
                },
                required: [
                  "duration_minutes",
                  "distance_km",
                  "session_type",
                  "sport",
                  "title",
                  "description",
                  "purpose",
                  "intensity",
                  "target_rpe",
                  "pace_guidance",
                  "heart_rate_guidance",
                  "fueling_guidance",
                  "coach_reasoning",
                  "notes",
                  "warmup",
                  "main_set",
                  "cooldown",
                  "instructions",
                  "adjustment_rules"
                ]
              },
              corrected_values: {
                type: "object",
                additionalProperties: false,
                properties: {
                  distance_km: { type: ["number", "null"] },
                  duration_minutes: { type: ["integer", "null"] },
                  average_pace: { type: ["string", "null"] },
                  activity_type: { type: ["string", "null"] },
                  workout_structure: { type: ["string", "null"] },
                  perceived_effort: { type: ["integer", "null"] },
                  notes: { type: ["string", "null"] }
                },
                required: [
                  "distance_km",
                  "duration_minutes",
                  "average_pace",
                  "activity_type",
                  "workout_structure",
                  "perceived_effort",
                  "notes"
                ]
              },
              race_details: {
                type: "object",
                additionalProperties: false,
                properties: {
                  target_race: { type: ["string", "null"] },
                  race_date: { type: ["string", "null"] },
                  target_time: { type: ["string", "null"] }
                },
                required: ["target_race", "race_date", "target_time"]
              },
              availability_note: { type: ["string", "null"] },
              preference_note: { type: ["string", "null"] }
            },
            required: [
              "type",
              "title",
              "target_session_id",
              "target_activity_id",
              "from_date",
              "to_date",
              "reason",
              "original_summary",
              "proposed_summary",
              "changes",
              "corrected_values",
              "race_details",
              "availability_note",
              "preference_note"
            ]
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
  "suggested_replies",
  "actions"
]
    }
  }
}
        })
      }
    );

    const data = await openAIResponse.json();

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
    suggested_replies: [],
    actions: []
  };
}

// Never trust raw model actions. Re-validate the shape server-side,
// strip unsupported fields, and attach a stable id so a later "Apply"
// tap is idempotent. Deep validation (ownership, existence, dates,
// duplicates, load) happens when the athlete confirms, in the training
// endpoint. Only well-formed actions are exposed to the client.
structuredAnswer.actions = validateProposedActions(
  structuredAnswer.actions
).map(action => ({ ...action, id: randomUUID() }));

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
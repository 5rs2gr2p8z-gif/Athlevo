const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function getBearerToken(req) {
  const authorization =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice(7).trim();
}

async function getAuthenticatedUser(accessToken) {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      method: "GET",

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function supabaseRequest(
  path,
  {
    method = "GET",
    body,
    headers = {}
  } = {}
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method,

      headers: {
        apikey:
          SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type": "application/json",

        ...headers
      },

      body:
        body === undefined
          ? undefined
          : JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Supabase request failed: ` +
      `${response.status} ${errorText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  return text
    ? JSON.parse(text)
    : null;
}

function extractResponseText(data) {
  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const output =
    Array.isArray(data.output)
      ? data.output
      : [];

  for (const item of output) {
    const content =
      Array.isArray(item.content)
        ? item.content
        : [];

    for (const part of content) {
      if (
        part.type === "output_text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
    }
  }

  return null;
}

function normalizeMemoryKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || null;
}

function normalizeImportance(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 5;
  }

  return Math.min(
    10,
    Math.max(1, Math.round(number))
  );
}

async function loadExistingMemories(userId) {
  const rows = await supabaseRequest(
    [
      "athlete_memory",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=category,memory_key,content,importance,is_active,updated_at",
      "&order=importance.desc,updated_at.desc",
      "&limit=50"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function extractMemories({
  message,
  existingMemories
}) {
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${OPENAI_API_KEY}`
      },

      body: JSON.stringify({
        model: "gpt-5.5",

        reasoning: {
          effort: "low"
        },

        input: [
          {
            role: "developer",

            content: `
You are the private memory extractor for Athlevo Coach.

Analyze only the athlete's latest message.

Extract information only when it is likely to remain useful in future endurance-coaching conversations.

Suitable memory categories include:

goal
race
injury
pain
health_constraint
training_preference
schedule
work_schedule
availability
equipment
nutrition
diet
fueling
sleep_pattern
environment
location
experience
training_history
personal_constraint
coach_preference

Classify before saving. Only PERSISTENT facts belong in memory:
- persistent training preference ("I prefer long runs on Sunday") -> save (training_preference)
- chronic/recurring injury ("my left achilles flares up") -> save (injury)
- durable device caveat ("my treadmill usually overestimates pace") -> save (equipment)
- diet/equipment/schedule that is ongoing -> save

TEMPORARY constraints are NOT memory — return action "none" for them. They
are handled by the coach's structured actions, not long-term memory:
- "I can't train Wednesday this week" -> none (temporary availability)
- "I'm traveling next week" -> none (temporary schedule)
- "my calf hurts today" / "I'm sick this week" -> none (temporary health)
- any statement scoped to today / this week / next week / a single date

Do not save:

greetings
casual conversation
temporary emotions
temporary or single-week availability, schedule, or health constraints
questions without a durable fact
facts already available from imported workout data
assistant statements
medical diagnoses
speculation
information the athlete did not clearly state

Use a stable memory_key.

Examples:

injury:left_achilles
race:clark_marathon_2026
schedule:night_shift
training_preference:long_run_day
nutrition:vegetarian
equipment:garmin_forerunner_165

When the athlete updates an existing fact, use the same memory_key and provide the updated content.

If the athlete says a previous fact is no longer true, return that same memory_key with action set to deactivate.

Use action "upsert" for a new or updated durable fact.

Use action "none" when nothing should be saved.

Keep content concise, factual, and written in third person.

Never include sensitive access credentials, passwords, tokens, payment details, or unrelated private information.
            `.trim()
          },

          {
            role: "user",

            content: JSON.stringify(
              {
                latestAthleteMessage:
                  message,

                existingMemories:
                  existingMemories.map(
                    memory => ({
                      category:
                        memory.category,

                      memory_key:
                        memory.memory_key,

                      content:
                        memory.content,

                      importance:
                        memory.importance,

                      is_active:
                        memory.is_active
                    })
                  )
              },
              null,
              2
            )
          }
        ],

        text: {
          format: {
            type: "json_schema",

            name:
              "athlete_memory_extraction",

            strict: true,

            schema: {
              type: "object",

              additionalProperties:
                false,

              properties: {
                memories: {
                  type: "array",

                  maxItems: 5,

                  items: {
                    type: "object",

                    additionalProperties:
                      false,

                    properties: {
                      action: {
                        type: "string",

                        enum: [
                          "upsert",
                          "deactivate",
                          "none"
                        ]
                      },

                      category: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      memory_key: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      content: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      importance: {
                        type: [
                          "integer",
                          "null"
                        ],

                        minimum: 1,
                        maximum: 10
                      }
                    },

                    required: [
                      "action",
                      "category",
                      "memory_key",
                      "content",
                      "importance"
                    ]
                  }
                }
              },

              required: [
                "memories"
              ]
            }
          }
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "Memory extraction OpenAI error:",
      data
    );

    throw new Error(
      data?.error?.message ||
      "Could not analyze athlete memory."
    );
  }

  const outputText =
    extractResponseText(data);

  if (!outputText) {
    throw new Error(
      "The memory extraction response was empty."
    );
  }

  return JSON.parse(outputText);
}

async function upsertMemory({
  userId,
  memory
}) {
  const memoryKey =
    normalizeMemoryKey(
      memory.memory_key
    );

  if (!memoryKey) {
    return null;
  }

  const category =
    typeof memory.category === "string"
      ? memory.category
          .trim()
          .toLowerCase()
      : "general";

  const content =
    typeof memory.content === "string"
      ? memory.content.trim()
      : "";

  if (!content) {
    return null;
  }

  const rows = await supabaseRequest(
    [
      "athlete_memory",
      "?on_conflict=user_id,memory_key"
    ].join(""),
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },

      body: {
        user_id: userId,
        category,
        memory_key: memoryKey,
        content,

        importance:
          normalizeImportance(
            memory.importance
          ),

        source:
          "coach_conversation",

        is_active: true,

        last_confirmed_at:
          new Date().toISOString(),

        updated_at:
          new Date().toISOString()
      }
    }
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : rows;
}

async function deactivateMemory({
  userId,
  memoryKey
}) {
  const normalizedKey =
    normalizeMemoryKey(memoryKey);

  if (!normalizedKey) {
    return null;
  }

  const rows = await supabaseRequest(
    [
      "athlete_memory",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&memory_key=eq.${encodeURIComponent(normalizedKey)}`
    ].join(""),
    {
      method: "PATCH",

      headers: {
        Prefer:
          "return=representation"
      },

      body: {
        is_active: false,

        last_confirmed_at:
          new Date().toISOString(),

        updated_at:
          new Date().toISOString()
      }
    }
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : rows;
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      error: "Method not allowed"
    });
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return sendJson(res, 500, {
      error:
        "Supabase server configuration is missing."
    });
  }

  if (!OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error:
        "OPENAI_API_KEY is not configured."
    });
  }

  try {
    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (!message) {
      return sendJson(res, 400, {
        error:
          "Athlete message is required."
      });
    }

    if (message.length > 5000) {
      return sendJson(res, 400, {
        error:
          "Athlete message is too long."
      });
    }

    const accessToken =
      getBearerToken(req);

    if (!accessToken) {
      return sendJson(res, 401, {
        error:
          "Authentication required"
      });
    }

    const user =
      await getAuthenticatedUser(
        accessToken
      );

    if (!user?.id) {
      return sendJson(res, 401, {
        error:
          "The authenticated user could not be verified."
      });
    }

    const existingMemories =
      await loadExistingMemories(
        user.id
      );

    const extraction =
      await extractMemories({
        message,
        existingMemories
      });

    const proposedMemories =
      Array.isArray(
        extraction?.memories
      )
        ? extraction.memories
        : [];

    const saved = [];

    for (
      const memory of proposedMemories
    ) {
      if (
        !memory ||
        memory.action === "none"
      ) {
        continue;
      }

      if (
        memory.action ===
        "deactivate"
      ) {
        const result =
          await deactivateMemory({
            userId: user.id,

            memoryKey:
              memory.memory_key
          });

        if (result) {
          saved.push(result);
        }

        continue;
      }

      if (
        memory.action === "upsert"
      ) {
        const result =
          await upsertMemory({
            userId: user.id,
            memory
          });

        if (result) {
          saved.push(result);
        }
      }
    }

    return sendJson(res, 200, {
      memories: saved,

      extractedCount:
        saved.length
    });
  } catch (error) {
    console.error(
      "Memory extraction API error:",
      error
    );

    return sendJson(res, 500, {
      error:
        error.message ||
        "Could not update athlete memory."
    });
  }
}
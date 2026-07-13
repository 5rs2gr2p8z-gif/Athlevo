import { buildAthlevoMethodPrompt } from "../lib/server/athlevoMethod.js";
import { summarizeExecutionRecord } from "../lib/server/executionRecords.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
        Authorization: `Bearer ${accessToken}`
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
        apikey: SUPABASE_SERVICE_ROLE_KEY,
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
    const errorText = await response.text();

    throw new Error(
      `Supabase request failed: ` +
      `${response.status} ${errorText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  return text ? JSON.parse(text) : null;
}

async function loadProfile(userId) {
  const rows = await supabaseRequest(
    `profiles?id=eq.${encodeURIComponent(
      userId
    )}&select=*`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadMemories(userId) {
  const rows = await supabaseRequest(
    [
      "athlete_memory",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&is_active=eq.true",
      "&select=id,category,memory_key,content,importance,updated_at",
      "&order=importance.desc,updated_at.desc",
      "&limit=30"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

async function loadActivities(userId) {
  const rows = await supabaseRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=*",
      "&order=start_date.desc",
      "&limit=200"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

// Recent explicit workout feedback. Optional: the table may not exist
// yet, so a failure must never block the daily brief.
async function loadRecentExecution(userId) {
  try {
    const rows = await supabaseRequest(
      [
        "workout_execution_records",
        `?user_id=eq.${encodeURIComponent(userId)}`,
        "&select=*",
        "&order=updated_at.desc",
        "&limit=14"
      ].join("")
    );

    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error(
      "Execution records unavailable for brief:",
      error?.message
    );
    return [];
  }
}

function buildFeedbackContext(records) {
  return (records || [])
    .map(record => {
      const summary = summarizeExecutionRecord(record);

      if (!summary) {
        return null;
      }

      const snapshot =
        record.original_session_snapshot &&
        typeof record.original_session_snapshot === "object"
          ? record.original_session_snapshot
          : {};

      return {
        session_date: snapshot.session_date || null,
        prescribed: snapshot.title || snapshot.session_type || null,
        ...summary
      };
    })
    .filter(Boolean);
}

function getDateKey(date = new Date()) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(date);
}

function getActivityDate(activity) {
  const value =
    activity.start_date ||
    activity.start_date_local ||
    activity.created_at;

  const date = value ? new Date(value) : null;

  return date &&
    !Number.isNaN(date.getTime())
      ? date
      : null;
}

function getDistanceMeters(activity) {
  return Number(
    activity.distance_meters ??
    activity.distance ??
    0
  );
}

function getMovingTimeSeconds(activity) {
  return Number(
    activity.moving_time_seconds ??
    activity.moving_time ??
    0
  );
}

function getAverageHeartRate(activity) {
  const value = Number(
    activity.average_heartrate ??
    activity.average_heart_rate ??
    0
  );

  return value > 0 ? value : null;
}

function createActivityFingerprint(activities) {
  return activities
    .slice(0, 20)
    .map(activity => {
      return [
        activity.external_activity_id ||
          activity.strava_activity_id ||
          activity.id ||
          "",
        activity.start_date ||
          activity.start_date_local ||
          "",
        getDistanceMeters(activity),
        getMovingTimeSeconds(activity)
      ].join(":");
    })
    .join("|");
}

function calculateActivityContext(activities) {
  const now = new Date();

  const sevenDaysAgo =
    new Date(now.getTime() - 7 * 86400000);

  const fourteenDaysAgo =
    new Date(now.getTime() - 14 * 86400000);

  const fortyTwoDaysAgo =
    new Date(now.getTime() - 42 * 86400000);

  const validActivities = activities.filter(
    activity => getActivityDate(activity)
  );

  const currentSevenDays =
    validActivities.filter(activity => {
      const date = getActivityDate(activity);

      return date >= sevenDaysAgo &&
        date <= now;
    });

  const previousSevenDays =
    validActivities.filter(activity => {
      const date = getActivityDate(activity);

      return date >= fourteenDaysAgo &&
        date < sevenDaysAgo;
    });

  const sixWeekActivities =
    validActivities.filter(activity => {
      const date = getActivityDate(activity);

      return date >= fortyTwoDaysAgo &&
        date <= now;
    });

  const summarize = list => {
    const distanceMeters = list.reduce(
      (total, activity) =>
        total + getDistanceMeters(activity),
      0
    );

    const movingTimeSeconds = list.reduce(
      (total, activity) =>
        total +
        getMovingTimeSeconds(activity),
      0
    );

    const heartRates = list
      .map(getAverageHeartRate)
      .filter(Boolean);

    return {
      activityCount: list.length,

      distanceKilometers:
        Number(
          (distanceMeters / 1000).toFixed(1)
        ),

      trainingHours:
        Number(
          (
            movingTimeSeconds / 3600
          ).toFixed(1)
        ),

      averageHeartRate:
        heartRates.length
          ? Math.round(
              heartRates.reduce(
                (sum, value) => sum + value,
                0
              ) / heartRates.length
            )
          : null
    };
  };

  const current = summarize(currentSevenDays);
  const previous = summarize(previousSevenDays);

  const weekOverWeekPercent =
    previous.distanceKilometers > 0
      ? Math.round(
          (
            (
              current.distanceKilometers -
              previous.distanceKilometers
            ) /
            previous.distanceKilometers
          ) * 100
        )
      : null;

  const recentActivities =
    validActivities
      .slice(0, 5)
      .map(activity => ({
        id:
          activity.external_activity_id ||
          activity.strava_activity_id ||
          activity.id ||
          null,

        name:
          activity.name ||
          activity.sport_type ||
          activity.activity_type ||
          "Activity",

        sportType:
          activity.sport_type ||
          activity.activity_type ||
          null,

        startDate:
          activity.start_date ||
          activity.start_date_local ||
          null,

        distanceKilometers:
          Number(
            (
              getDistanceMeters(activity) /
              1000
            ).toFixed(2)
          ),

        durationMinutes:
          Math.round(
            getMovingTimeSeconds(activity) /
            60
          ),

        averageHeartRate:
          getAverageHeartRate(activity)
            ? Math.round(
                getAverageHeartRate(activity)
              )
            : null
      }));

  return {
    currentSevenDays: current,
    previousSevenDays: previous,
    weekOverWeekPercent,

    sixWeekActivityCount:
      sixWeekActivities.length,

    latestActivity:
      recentActivities[0] || null,

    recentActivities
  };
}

async function loadCachedBriefing(
  userId,
  briefingDate
) {
  const rows = await supabaseRequest(
    [
      "daily_coach_briefings",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&briefing_date=eq.${briefingDate}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

function extractResponseText(data) {
  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const output = Array.isArray(data.output)
    ? data.output
    : [];

  for (const item of output) {
    const content = Array.isArray(item.content)
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

async function generateBriefing({
  profile,
  memories,
  activityContext,
  feedbackContext,
  briefingDate
}) {
  const methodPrompt =
    buildAthlevoMethodPrompt();

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
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
${methodPrompt}

DAILY COACH BRIEFING RULES

Create a concise daily coaching briefing.

Use only facts contained in the supplied athlete data.

Do not invent sleep, HRV, readiness, pain, soreness, schedule, weather, or recovery information.

Do not diagnose medical conditions.

Do not output Markdown.

Do not use asterisks, headings, bullet symbols, or decorative formatting.

The headline should be brief and specific.

The training summary must describe recorded training only.

The coach observation should identify the most important defensible pattern.

The recommendation must be conservative when recovery information is missing.

The reasoning must explain why the recommendation follows from the available evidence.

Data limitations should explicitly name important missing inputs.

If there are no imported activities, say that there is not enough recent activity data and do not create a workout recommendation.

The athlete data may include sessionFeedback: the athlete's own reports of recently planned sessions (completed, skipped, or modified, with RPE, feeling, and pain). Use it as recorded fact. Never shame a skipped or modified session. If pain was reported, be cautious and conservative about intensity near the affected area, and do not diagnose. If a session was skipped for schedule reasons, treat it as a scheduling matter, not lost fitness. Do not invent feedback that is not present.
            `.trim()
          },

          {
            role: "user",
            content: JSON.stringify(
              {
                briefingDate,
                athleteProfile: profile,
                athleteMemories: memories,
                importedTraining:
                  activityContext,
                sessionFeedback:
                  feedbackContext && feedbackContext.length
                    ? feedbackContext
                    : null
              },
              null,
              2
            )
          }
        ],

        text: {
          format: {
            type: "json_schema",
            name: "daily_coach_briefing",
            strict: true,

            schema: {
              type: "object",
              additionalProperties: false,

              properties: {
                headline: {
                  type: "string"
                },

                training_summary: {
                  type: "string"
                },

                coach_observation: {
                  type: "string"
                },

                recommendation: {
                  type: "string"
                },

                reasoning: {
                  type: "string"
                },

                data_limitations: {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              },

              required: [
                "headline",
                "training_summary",
                "coach_observation",
                "recommendation",
                "reasoning",
                "data_limitations"
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
      "Daily briefing OpenAI error:",
      data
    );

    throw new Error(
      data?.error?.message ||
      "Could not generate daily briefing."
    );
  }

  const outputText = extractResponseText(data);

  if (!outputText) {
    throw new Error(
      "The daily briefing response was empty."
    );
  }

  return JSON.parse(outputText);
}

async function saveBriefing({
  userId,
  briefingDate,
  briefing,
  activityFingerprint,
  latestActivityId
}) {
  const rows = await supabaseRequest(
    [
      "daily_coach_briefings",
      "?on_conflict=user_id,briefing_date"
    ].join(""),
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },

      body: {
        user_id: userId,
        briefing_date: briefingDate,

        headline: briefing.headline,

        training_summary:
          briefing.training_summary,

        coach_observation:
          briefing.coach_observation,

        recommendation:
          briefing.recommendation,

        reasoning:
          briefing.reasoning,

        data_limitations:
          briefing.data_limitations,

        latest_activity_id:
          latestActivityId
            ? String(latestActivityId)
            : null,

        activity_fingerprint:
          activityFingerprint,

        generated_at:
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

export default async function handler(req, res) {
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
    const accessToken = getBearerToken(req);

    if (!accessToken) {
      return sendJson(res, 401, {
        error: "Authentication required"
      });
    }

    const user =
      await getAuthenticatedUser(accessToken);

    if (!user?.id) {
      return sendJson(res, 401, {
        error:
          "The authenticated user could not be verified."
      });
    }

    const [
      profile,
      memories,
      activities,
      executionRecords
    ] = await Promise.all([
      loadProfile(user.id),
      loadMemories(user.id),
      loadActivities(user.id),
      loadRecentExecution(user.id)
    ]);

    if (!profile) {
      return sendJson(res, 404, {
        error:
          "No athlete profile was found."
      });
    }

    const feedbackContext =
      buildFeedbackContext(executionRecords);

    const briefingDate = getDateKey();

    // Fold a light feedback signature into the fingerprint so newly
    // recorded feedback regenerates today's brief.
    const feedbackFingerprint = executionRecords
      .map(
        record =>
          `${record.training_session_id || ""}:` +
          `${record.status || ""}:${record.updated_at || ""}`
      )
      .join("|");

    const activityFingerprint =
      createActivityFingerprint(activities) +
      "##" +
      feedbackFingerprint;

    const cachedBriefing =
      await loadCachedBriefing(
        user.id,
        briefingDate
      );

    const forceRegenerate =
      req.body?.force === true;

    if (
      !forceRegenerate &&
      cachedBriefing &&
      cachedBriefing.activity_fingerprint ===
        activityFingerprint
    ) {
      return sendJson(res, 200, {
        briefing: cachedBriefing,
        cached: true
      });
    }

    const activityContext =
      calculateActivityContext(activities);

    const briefing =
      await generateBriefing({
        profile,
        memories,
        activityContext,
        feedbackContext,
        briefingDate
      });

    const savedBriefing =
      await saveBriefing({
        userId: user.id,
        briefingDate,
        briefing,
        activityFingerprint,

        latestActivityId:
          activityContext.latestActivity?.id ||
          null
      });

    return sendJson(res, 200, {
      briefing:
        savedBriefing || {
          ...briefing,
          briefing_date: briefingDate
        },

      cached: false
    });
  } catch (error) {
    console.error(
      "Daily briefing API error:",
      error
    );

    return sendJson(res, 500, {
      error:
        error.message ||
        "Could not create the daily briefing."
    });
  }
}
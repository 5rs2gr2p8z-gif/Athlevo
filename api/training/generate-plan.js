import {
  addDays,
  calculateWeeksUntilRace,
  formatDateKey,
  getPlanningWeekStart,
  parseDateValue
} from "./lib/dateUtils.js";

import { buildAthlevoMethodPrompt } from "../athlevoMethod.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function sendJson(response, statusCode, payload) {
  return response.status(statusCode).json(payload);
}

function getBearerToken(request) {
  const authorization =
    request.headers.authorization ||
    request.headers.Authorization ||
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
      `Supabase request failed: ${response.status} ${errorText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();

  return responseText
    ? JSON.parse(responseText)
    : null;
}

async function loadAthleteProfile(userId) {
  const rows = await supabaseRequest(
    [
      "profiles",
      `?id=eq.${encodeURIComponent(userId)}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function loadAthleteMemories(userId) {
  const rows = await supabaseRequest(
    [
      "athlete_memory",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&is_active=eq.true",
      "&select=category,memory_key,content,importance,updated_at",
      "&order=importance.desc,updated_at.desc",
      "&limit=40"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadRecentActivities(userId) {
  const rows = await supabaseRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=id,external_activity_id,name,sport_type,activity_type,distance_meters,moving_time_seconds,elevation_gain_meters,average_heartrate,max_heartrate,average_cadence,start_date,trainer",
      "&order=start_date.desc",
      "&limit=200"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

function getTargetRaceDate(profile) {
  return (
    profile?.race_date ||
    profile?.target_race_date ||
    null
  );
}

function getTargetRaceName(profile) {
  const value =
    profile?.target_race ||
    profile?.race_type ||
    null;

  if (
    !value ||
    String(value).trim().toLowerCase() ===
      "none"
  ) {
    return null;
  }

  return String(value).trim();
}

function getActivityDate(activity) {
  if (!activity?.start_date) {
    return null;
  }

  const date = new Date(
    activity.start_date
  );

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function summarizeActivities(
  activities,
  weekStart
) {
  const sixWeeksAgo = addDays(
    weekStart,
    -42
  );

  const sevenDaysAgo = addDays(
    weekStart,
    -7
  );

  const validActivities = activities
    .map(activity => ({
      ...activity,
      parsedDate:
        getActivityDate(activity)
    }))
    .filter(activity => activity.parsedDate);

  const lastSixWeeks =
    validActivities.filter(
      activity =>
        activity.parsedDate >=
          sixWeeksAgo &&
        activity.parsedDate <
          addDays(weekStart, 7)
    );

  const previousSevenDays =
    validActivities.filter(
      activity =>
        activity.parsedDate >=
          sevenDaysAgo &&
        activity.parsedDate <
          weekStart
    );

  const summarizeList = list => {
    const distanceMeters =
      list.reduce(
        (total, activity) =>
          total +
          (Number(
            activity.distance_meters
          ) || 0),
        0
      );

    const movingSeconds =
      list.reduce(
        (total, activity) =>
          total +
          (Number(
            activity.moving_time_seconds
          ) || 0),
        0
      );

    return {
      activityCount: list.length,

      distanceKilometers:
        Number(
          (
            distanceMeters / 1000
          ).toFixed(1)
        ),

      trainingHours:
        Number(
          (
            movingSeconds / 3600
          ).toFixed(1)
        )
    };
  };

  const weeklyHistory = [];

  for (
    let weekIndex = 5;
    weekIndex >= 0;
    weekIndex -= 1
  ) {
    const start = addDays(
      weekStart,
      -weekIndex * 7
    );

    const end = addDays(start, 7);

    const weekActivities =
      validActivities.filter(
        activity =>
          activity.parsedDate >= start &&
          activity.parsedDate < end
      );

    weeklyHistory.push({
      weekStart: formatDateKey(start),
      weekEnd: formatDateKey(
        addDays(end, -1)
      ),
      ...summarizeList(weekActivities)
    });
  }

  const activeWeeks =
    weeklyHistory.filter(
      week =>
        week.activityCount > 0
    );

  const consistentWeeks =
    activeWeeks.filter(
      week =>
        week.activityCount >= 3
    ).length;

  const latestActivities =
    validActivities
      .slice(0, 10)
      .map(activity => ({
        name:
          activity.name ||
          activity.sport_type ||
          activity.activity_type ||
          "Activity",

        sport:
          activity.sport_type ||
          activity.activity_type ||
          "Unknown",

        date:
          activity.start_date,

        distanceKilometers:
          Number(
            (
              (Number(
                activity.distance_meters
              ) || 0) / 1000
            ).toFixed(2)
          ),

        durationMinutes:
          Math.round(
            (Number(
              activity.moving_time_seconds
            ) || 0) / 60
          ),

        averageHeartRate:
          Number(
            activity.average_heartrate
          ) > 0
            ? Math.round(
                Number(
                  activity.average_heartrate
                )
              )
            : null,

        elevationGainMeters:
          Number(
            activity.elevation_gain_meters
          ) > 0
            ? Math.round(
                Number(
                  activity.elevation_gain_meters
                )
              )
            : null
      }));

  return {
    previousSevenDays:
      summarizeList(
        previousSevenDays
      ),

    sixWeekTotals:
      summarizeList(lastSixWeeks),

    weeklyHistory,

    activeWeeks:
      activeWeeks.length,

    consistentWeeks,

    latestActivities
  };
}

function determinePeriodization({
  weeksUntilRace,
  activitySummary,
  profile
}) {
  const availableDays = Number(
    profile?.available_days ??
    profile?.training_days ??
    0
  );

  const hasStableRecentBase =
    activitySummary.consistentWeeks >= 3 &&
    activitySummary.activeWeeks >= 4;

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 0
  ) {
    return {
      phase: "recovery",
      phaseWeek: 1,
      phaseLengthWeeks: 2,
      label: "Post-race recovery",
      compressed: false
    };
  }

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 3
  ) {
    return {
      phase: "taper",
      phaseWeek:
        Math.max(
          1,
          4 - weeksUntilRace
        ),
      phaseLengthWeeks: 3,
      label: "Taper",
      compressed:
        !hasStableRecentBase
    };
  }

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 8
  ) {
    return {
      phase: "race_preparation",
      phaseWeek:
        Math.max(
          1,
          9 - weeksUntilRace
        ),
      phaseLengthWeeks: 5,
      label: "Race preparation",
      compressed:
        !hasStableRecentBase
    };
  }

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 14
  ) {
    return {
      phase: "development",
      phaseWeek:
        Math.max(
          1,
          15 - weeksUntilRace
        ),
      phaseLengthWeeks: 6,
      label: "Development",
      compressed:
        !hasStableRecentBase
    };
  }

  if (weeksUntilRace !== null) {
    return {
      phase: "foundation",
      phaseWeek: 1,
      phaseLengthWeeks: 6,
      label: "Foundation",
      compressed: false
    };
  }

  if (
    hasStableRecentBase &&
    availableDays >= 3
  ) {
    return {
      phase: "maintenance",
      phaseWeek: 1,
      phaseLengthWeeks: 4,
      label: "Maintenance and development",
      compressed: false
    };
  }

  return {
    phase: "foundation",
    phaseWeek: 1,
    phaseLengthWeeks: 6,
    label: "Foundation",
    compressed: false
  };
}

function getPhaseGuidance(
  periodization
) {
  const guidance = {
    foundation: {
      intent:
        "Build aerobic durability, tissue tolerance, heat adaptation, and reliable training frequency.",

      distribution: {
        ground: 75,
        control: 17,
        threshold: 3,
        edge: 5
      }
    },

    development: {
      intent:
        "Develop fatigue resistance and controlled Threshold tolerance while maintaining aerobic durability.",

      distribution: {
        ground: 68,
        control: 18,
        threshold: 10,
        edge: 4
      }
    },

    race_preparation: {
      intent:
        "Integrate race-specific work while protecting the lower-tier adaptations that support it.",

      distribution: {
        ground: 65,
        control: 18,
        threshold: 12,
        edge: 5
      }
    },

    taper: {
      intent:
        "Reduce accumulated fatigue while maintaining frequency, race-specific rhythm, and neuromuscular sharpness.",

      distribution: {
        ground: 70,
        control: 15,
        threshold: 10,
        edge: 5
      }
    },

    recovery: {
      intent:
        "Resolve race and block fatigue before beginning another structured progression.",

      distribution: {
        ground: 95,
        control: 0,
        threshold: 0,
        edge: 5
      }
    },

    maintenance: {
      intent:
        "Maintain aerobic durability, fatigue resistance, and speed economy without a fixed race deadline.",

      distribution: {
        ground: 72,
        control: 18,
        threshold: 6,
        edge: 4
      }
    }
  };

  return guidance[
    periodization.phase
  ];
}

function extractResponseText(data) {
  if (
    typeof data.output_text ===
      "string" &&
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
        part.type ===
          "output_text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
    }
  }

  return null;
}

async function generateWeeklyPlan({
  profile,
  memories,
  activitySummary,
  targetRace,
  raceDate,
  weeksUntilRace,
  weekStart,
  weekEnd,
  periodization,
  phaseGuidance
}) {
  const athlevoMethodPrompt =
    buildAthlevoMethodPrompt();

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
          effort: "medium"
        },

        input: [
          {
            role: "developer",

            content: `
${athlevoMethodPrompt}

WEEKLY TRAINING PLAN GENERATION

Create exactly seven entries, one for each date from Monday through Sunday.

The periodization phase has already been determined by the application. Do not change it.

CURRENT PHASE
${periodization.phase}

PHASE LABEL
${periodization.label}

PHASE INTENT
${phaseGuidance.intent}

WEEK START
${formatDateKey(weekStart)}

WEEK END
${formatDateKey(weekEnd)}

TARGET RACE
${targetRace || "No confirmed target race"}

RACE DATE
${raceDate ? formatDateKey(raceDate) : "No confirmed race date"}

WEEKS UNTIL RACE
${weeksUntilRace === null ? "Not applicable" : weeksUntilRace}

COMPRESSED PREPARATION
${periodization.compressed ? "Yes" : "No"}

Rules:

1. Return one session for every day, including rest days.
2. Respect the athlete's realistic available training days.
3. Do not schedule Threshold on consecutive days.
4. Normally schedule no more than one or two Threshold sessions per week.
5. Never make up missed intensity.
6. Ground must remain the majority of weekly training.
7. Edge volume must remain low.
8. Use the Athlevo workout names where appropriate:
   Foundation Run
   Foundation Long
   Stability Cruise
   Stability Blocks
   Pressure Waves
   Pressure Ladder
   Pressure Cruise
   Surge Strides
   Surge Hills
   Conversion Run
9. Do not invent exact pace or heart-rate targets when the athlete's thresholds or HRmax are unknown.
10. When pace data is uncertain, prescribe using effort, breathing, mechanics, and Athlevo zones.
11. Account for injury memories, work schedule, sleep patterns, preferred training time, diet, and other durable athlete constraints.
12. Do not claim access to sleep, HRV, readiness, weather, soreness, or recovery information unless it appears in the supplied data.
13. If preparation is compressed, state that clearly and prioritize safe completion and durability over aggressive race-specific loading.
14. Each session must explain why it exists in the current phase.
15. Rest days should use session_type "rest", sport "rest", duration_minutes null, and intensity "Rest".
16. Use ISO dates in YYYY-MM-DD format.
17. Keep instructions clear and executable.
18. Return valid structured data only.
            `.trim()
          },

          {
            role: "user",

            content: JSON.stringify(
              {
                athleteProfile:
                  profile,

                athleteMemories:
                  memories,

                recentTraining:
                  activitySummary,

                requiredPeriodization: {
                  targetRace,
                  raceDate:
                    raceDate
                      ? formatDateKey(
                          raceDate
                        )
                      : null,

                  weeksUntilRace,
                  phase:
                    periodization.phase,

                  phaseLabel:
                    periodization.label,

                  phaseWeek:
                    periodization.phaseWeek,

                  phaseLengthWeeks:
                    periodization.phaseLengthWeeks,

                  compressed:
                    periodization.compressed,

                  intendedZoneDistribution:
                    phaseGuidance.distribution
                }
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
              "athlevo_weekly_training_plan",
            strict: true,

            schema: {
              type: "object",
              additionalProperties: false,

              properties: {
                week_focus: {
                  type: "string"
                },

                weekly_intent: {
                  type: "string"
                },

                coach_summary: {
                  type: "string"
                },

                progression_reasoning: {
                  type: "string"
                },

                planned_distance_km: {
                  type: [
                    "number",
                    "null"
                  ]
                },

                planned_hours: {
                  type: [
                    "number",
                    "null"
                  ]
                },

                sessions: {
                  type: "array",
                  minItems: 7,
                  maxItems: 7,

                  items: {
                    type: "object",
                    additionalProperties:
                      false,

                    properties: {
                      session_date: {
                        type: "string",
                        pattern:
                          "^\\d{4}-\\d{2}-\\d{2}$"
                      },

                      title: {
                        type: "string"
                      },

                      sport: {
                        type: "string"
                      },

                      session_type: {
                        type: "string"
                      },

                      duration_minutes: {
                        type: [
                          "integer",
                          "null"
                        ]
                      },

                      distance_km: {
                        type: [
                          "number",
                          "null"
                        ]
                      },

                      intensity: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      purpose: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      instructions: {
                        type: "array",
                        items: {
                          type: "string"
                        },
                        maxItems: 10
                      },

                      warmup: {
                        type: [
                          "object",
                          "null"
                        ],
                        additionalProperties:
                          false,

                        properties: {
                          duration_minutes: {
                            type: [
                              "integer",
                              "null"
                            ]
                          },

                          instructions: {
                            type: "array",
                            items: {
                              type: "string"
                            }
                          }
                        },

                        required: [
                          "duration_minutes",
                          "instructions"
                        ]
                      },

                      main_set: {
                        type: [
                          "object",
                          "null"
                        ],
                        additionalProperties:
                          false,

                        properties: {
                          description: {
                            type: [
                              "string",
                              "null"
                            ]
                          },

                          repetitions: {
                            type: [
                              "integer",
                              "null"
                            ]
                          },

                          work_duration_minutes: {
                            type: [
                              "number",
                              "null"
                            ]
                          },

                          recovery_duration_minutes: {
                            type: [
                              "number",
                              "null"
                            ]
                          },

                          instructions: {
                            type: "array",
                            items: {
                              type: "string"
                            }
                          }
                        },

                        required: [
                          "description",
                          "repetitions",
                          "work_duration_minutes",
                          "recovery_duration_minutes",
                          "instructions"
                        ]
                      },

                      cooldown: {
                        type: [
                          "object",
                          "null"
                        ],
                        additionalProperties:
                          false,

                        properties: {
                          duration_minutes: {
                            type: [
                              "integer",
                              "null"
                            ]
                          },

                          instructions: {
                            type: "array",
                            items: {
                              type: "string"
                            }
                          }
                        },

                        required: [
                          "duration_minutes",
                          "instructions"
                        ]
                      },

                      pace_guidance: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      heart_rate_guidance: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      fueling_guidance: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      adjustment_rules: {
                        type: "array",
                        items: {
                          type: "string"
                        },
                        maxItems: 8
                      },

                      coach_reasoning: {
                        type: [
                          "string",
                          "null"
                        ]
                      }
                    },

                    required: [
                      "session_date",
                      "title",
                      "sport",
                      "session_type",
                      "duration_minutes",
                      "distance_km",
                      "intensity",
                      "purpose",
                      "instructions",
                      "warmup",
                      "main_set",
                      "cooldown",
                      "pace_guidance",
                      "heart_rate_guidance",
                      "fueling_guidance",
                      "adjustment_rules",
                      "coach_reasoning"
                    ]
                  }
                }
              },

              required: [
                "week_focus",
                "weekly_intent",
                "coach_summary",
                "progression_reasoning",
                "planned_distance_km",
                "planned_hours",
                "sessions"
              ]
            }
          }
        }
      })
    }
  );

  const responseData =
    await response.json();

  if (!response.ok) {
    console.error(
      "Training plan OpenAI error:",
      responseData
    );

    throw new Error(
      responseData?.error?.message ||
      "Could not generate the weekly training plan."
    );
  }

  const outputText =
    extractResponseText(
      responseData
    );

  if (!outputText) {
    throw new Error(
      "The generated training plan was empty."
    );
  }

  return JSON.parse(outputText);
}

function validateSessionDates(
  sessions,
  weekStart
) {
  const expectedDates =
    Array.from(
      { length: 7 },
      (_, index) =>
        formatDateKey(
          addDays(
            weekStart,
            index
          )
        )
    );

  const receivedDates =
    sessions.map(
      session =>
        session.session_date
    );

  const datesAreCorrect =
    expectedDates.every(
      expectedDate =>
        receivedDates.includes(
          expectedDate
        )
    );

  if (!datesAreCorrect) {
    throw new Error(
      "The generated plan did not contain the correct seven dates."
    );
  }
}

async function saveTrainingPlan({
  userId,
  plan,
  weekStart,
  weekEnd,
  targetRace,
  raceDate,
  weeksUntilRace,
  periodization,
  phaseGuidance
}) {
  const rows = await supabaseRequest(
    [
      "training_plans",
      "?on_conflict=user_id,week_start"
    ].join(""),
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },

      body: {
        user_id: userId,

        week_start:
          formatDateKey(weekStart),

        week_end:
          formatDateKey(weekEnd),

        target_race:
          targetRace,

        race_date:
          raceDate
            ? formatDateKey(
                raceDate
              )
            : null,

        weeks_until_race:
          weeksUntilRace,

        phase:
          periodization.phase,

        phase_week:
          periodization.phaseWeek,

        phase_length_weeks:
          periodization.phaseLengthWeeks,

        week_focus:
          plan.week_focus,

        weekly_intent:
          plan.weekly_intent,

        planned_distance_km:
          plan.planned_distance_km,

        planned_hours:
          plan.planned_hours,

        ground_percentage:
          phaseGuidance
            .distribution.ground,

        control_percentage:
          phaseGuidance
            .distribution.control,

        threshold_percentage:
          phaseGuidance
            .distribution.threshold,

        edge_percentage:
          phaseGuidance
            .distribution.edge,

        coach_summary:
          plan.coach_summary,

        progression_reasoning:
          periodization.compressed
            ? `Compressed preparation: ${plan.progression_reasoning}`
            : plan.progression_reasoning,

        status: "active",

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

async function saveTrainingSessions({
  userId,
  trainingPlanId,
  sessions,
  periodization,
  weekFocus,
  weekStart
}) {
  const rowsToSave =
    sessions.map(session => ({
      user_id: userId,

      training_plan_id:
        trainingPlanId,

      session_date:
        session.session_date,

      title:
        session.title,

      sport:
        session.sport ||
        "run",

      session_type:
        session.session_type,

      duration_minutes:
        session.duration_minutes,

      distance_km:
        session.distance_km,

      intensity:
        session.intensity,

      purpose:
        session.purpose,

      instructions:
        session.instructions || [],

      warmup:
        session.warmup,

      main_set:
        session.main_set,

      cooldown:
        session.cooldown,

      pace_guidance:
        session.pace_guidance,

      heart_rate_guidance:
        session.heart_rate_guidance,

      fueling_guidance:
        session.fueling_guidance,

      adjustment_rules:
        session.adjustment_rules ||
        [],

      coach_reasoning:
        session.coach_reasoning,

      status: "planned",
      source: "ai_generated",

      plan_week_start:
        formatDateKey(weekStart),

      phase:
        periodization.phase,

      weeks_until_race:
        periodization.weeksUntilRace ??
        null,

      week_focus:
        weekFocus,

      updated_at:
        new Date().toISOString()
    }));

  return supabaseRequest(
    [
      "training_sessions",
      "?on_conflict=user_id,session_date"
    ].join(""),
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },

      body: rowsToSave
    }
  );
}

export default async function handler(
  request,
  response
) {
  if (request.method !== "POST") {
    return sendJson(
      response,
      405,
      {
        error:
          "Method not allowed."
      }
    );
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return sendJson(
      response,
      500,
      {
        error:
          "Supabase server configuration is missing."
      }
    );
  }

  if (!OPENAI_API_KEY) {
    return sendJson(
      response,
      500,
      {
        error:
          "OPENAI_API_KEY is not configured."
      }
    );
  }

  try {
    const accessToken =
      getBearerToken(request);

    if (!accessToken) {
      return sendJson(
        response,
        401,
        {
          error:
            "Authentication required."
        }
      );
    }

    const user =
      await getAuthenticatedUser(
        accessToken
      );

    if (!user?.id) {
      return sendJson(
        response,
        401,
        {
          error:
            "The authenticated athlete could not be verified."
        }
      );
    }

    const [
      profile,
      memories,
      activities
    ] = await Promise.all([
      loadAthleteProfile(user.id),
      loadAthleteMemories(user.id),
      loadRecentActivities(user.id)
    ]);

    if (!profile) {
      return sendJson(
        response,
        404,
        {
          error:
            "No athlete profile was found."
        }
      );
    }

    const today = new Date();

const currentWeekMonday =
    getMondayOfCurrentWeek();

const weekStart =
  getPlanningWeekStart();

const weekEnd =
  addDays(weekStart, 6);

    const targetRace =
      getTargetRaceName(profile);

    const raceDate =
      parseDateValue(
        getTargetRaceDate(profile)
      );

    const weeksUntilRace =
      calculateWeeksUntilRace(
        raceDate,
        weekStart
      );

    const activitySummary =
      summarizeActivities(
        activities,
        weekStart
      );

    const periodization =
      determinePeriodization({
        weeksUntilRace,
        activitySummary,
        profile
      });

    periodization.weeksUntilRace =
      weeksUntilRace;

    const phaseGuidance =
      getPhaseGuidance(
        periodization
      );

    const generatedPlan =
      await generateWeeklyPlan({
        profile,
        memories,
        activitySummary,
        targetRace,
        raceDate,
        weeksUntilRace,
        weekStart,
        weekEnd,
        periodization,
        phaseGuidance
      });

    validateSessionDates(
      generatedPlan.sessions,
      weekStart
    );

    const savedPlan =
      await saveTrainingPlan({
        userId: user.id,
        plan: generatedPlan,
        weekStart,
        weekEnd,
        targetRace,
        raceDate,
        weeksUntilRace,
        periodization,
        phaseGuidance
      });

    if (!savedPlan?.id) {
      throw new Error(
        "The weekly plan could not be saved."
      );
    }

    const savedSessions =
      await saveTrainingSessions({
        userId: user.id,
        trainingPlanId:
          savedPlan.id,

        sessions:
          generatedPlan.sessions,

        periodization,

        weekFocus:
          generatedPlan.week_focus,

        weekStart
      });

    return sendJson(
      response,
      200,
      {
        success: true,

        plan: savedPlan,

        sessions:
          Array.isArray(savedSessions)
            ? savedSessions
            : [],

        periodization: {
          targetRace,
          raceDate:
            raceDate
              ? formatDateKey(
                  raceDate
                )
              : null,

          weeksUntilRace,
          phase:
            periodization.phase,

          phaseLabel:
            periodization.label,

          phaseWeek:
            periodization.phaseWeek,

          phaseLengthWeeks:
            periodization.phaseLengthWeeks,

          compressedPreparation:
            periodization.compressed
        }
      }
    );
  } catch (error) {
    console.error(
      "Training plan generation failed:",
      error
    );

    return sendJson(
      response,
      500,
      {
        error:
          error?.message ||
          "Could not generate the training plan."
      }
    );
  }
}
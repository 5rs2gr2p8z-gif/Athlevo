import {
  buildExecutionRow,
  indexRecordsBySession,
  matchActivitiesToSessions
} from "../../lib/server/executionRecords.js";

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  { method = "GET", body, headers = {} } = {}
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
    : [];
}

// Execution records may be queried before the migration has run. Never
// let a missing table break the Train tab.
async function optionalRequest(path, options) {
  try {
    return await supabaseRequest(path, options);
  } catch (error) {
    console.error(
      "Optional execution data unavailable:",
      error?.message
    );
    return null;
  }
}

function getManilaDate() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

  const values = {};

  parts.forEach(part => {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  });

  return new Date(
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day)
    )
  );
}

function getMonday(date) {
  const result = new Date(date);

  const weekday = result.getUTCDay();

  const daysSinceMonday =
    weekday === 0
      ? 6
      : weekday - 1;

  result.setUTCDate(
    result.getUTCDate() -
      daysSinceMonday
  );

  return result;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function loadCurrentPlan(
  userId,
  weekStart
) {
  const rows = await supabaseRequest(
    [
      "training_plans",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&week_start=eq.${weekStart}`,
      "&status=eq.active",
      "&select=*",
      "&order=updated_at.desc",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function loadPlanSessions(
  userId,
  trainingPlanId
) {
  const rows = await supabaseRequest(
    [
      "training_sessions",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&training_plan_id=eq.${encodeURIComponent(trainingPlanId)}`,
      "&select=*",
      "&order=session_date.asc"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadExecutionRecords(userId, sessionIds) {
  if (!sessionIds.length) {
    return [];
  }

  const idList = sessionIds
    .map(id => encodeURIComponent(id))
    .join(",");

  const rows = await optionalRequest(
    [
      "workout_execution_records",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&training_session_id=in.(${idList})`,
      "&select=*"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

async function loadWeekActivities(
  userId,
  weekStartKey,
  weekEndKey
) {
  const rows = await optionalRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=id,name,sport_type,activity_type,",
      "distance_meters,moving_time_seconds,average_heartrate,start_date",
      `&start_date=gte.${weekStartKey}T00:00:00`,
      `&start_date=lte.${weekEndKey}T23:59:59`,
      "&order=start_date.desc&limit=100"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

async function loadSessionForUser(userId, sessionId) {
  const rows = await supabaseRequest(
    [
      "training_sessions",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&id=eq.${encodeURIComponent(sessionId)}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

/*
 * Merges the athlete's execution feedback and any same-day Strava match
 * onto each session so the Train tab can render status without a second
 * round trip. The original session shape is preserved; only new keys
 * (execution, matched_activity) are added.
 */
function enrichSessions(sessions, records, activities) {
  const recordMap = indexRecordsBySession(records);
  const matches = matchActivitiesToSessions(sessions, activities);

  return sessions.map(session => {
    const record = session?.id
      ? recordMap.get(String(session.id)) || null
      : null;

    return {
      ...session,
      execution: record,
      matched_activity: session?.id
        ? matches[session.id] || null
        : null
    };
  });
}

async function handleGet(request, response, user) {
  const currentDate = getManilaDate();
  const weekStart = getMonday(currentDate);
  const weekStartKey = toDateKey(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekEndKey = toDateKey(weekEnd);

  const plan = await loadCurrentPlan(user.id, weekStartKey);

  if (!plan) {
    return sendJson(response, 200, {
      hasPlan: false,
      weekStart: weekStartKey,
      plan: null,
      sessions: [],
      executionRecords: []
    });
  }

  const sessions = await loadPlanSessions(user.id, plan.id);

  const sessionIds = sessions
    .map(session => session?.id)
    .filter(Boolean);

  const [records, activities] = await Promise.all([
    loadExecutionRecords(user.id, sessionIds),
    loadWeekActivities(user.id, weekStartKey, weekEndKey)
  ]);

  const enriched = enrichSessions(sessions, records, activities);

  return sendJson(response, 200, {
    hasPlan: true,
    weekStart: weekStartKey,
    plan,
    sessions: enriched,
    executionRecords: records
  });
}

async function handlePost(request, response, user) {
  const body =
    request.body && typeof request.body === "object"
      ? request.body
      : typeof request.body === "string" && request.body
      ? JSON.parse(request.body)
      : {};

  const sessionId =
    typeof body.training_session_id === "string"
      ? body.training_session_id.trim()
      : "";

  if (!sessionId) {
    return sendJson(response, 400, {
      error: "A training_session_id is required."
    });
  }

  // Confirms ownership and gives us the prescription to snapshot.
  const session = await loadSessionForUser(user.id, sessionId);

  if (!session) {
    return sendJson(response, 404, {
      error: "That training session could not be found."
    });
  }

  const { row, error } = buildExecutionRow({
    body,
    userId: user.id,
    session
  });

  if (error) {
    return sendJson(response, 400, { error });
  }

  const saved = await supabaseRequest(
    "workout_execution_records" +
      "?on_conflict=user_id,training_session_id",
    {
      method: "POST",
      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },
      body: row
    }
  );

  return sendJson(response, 200, {
    success: true,
    record: Array.isArray(saved) ? saved[0] || null : saved
  });
}

export default async function handler(
  request,
  response
) {
  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    response.setHeader("Allow", "GET, POST");

    return sendJson(
      response,
      405,
      {
        error: "Method not allowed."
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

  try {
    const accessToken =
      getBearerToken(request);

    if (!accessToken) {
      return sendJson(
        response,
        401,
        {
          error:
            "Authentication is required."
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

    if (request.method === "POST") {
      return await handlePost(request, response, user);
    }

    return await handleGet(request, response, user);
  } catch (error) {
    console.error(
      "Could not load or update the weekly plan:",
      error
    );

    return sendJson(
      response,
      500,
      {
        error:
          error?.message ||
          "Could not load the weekly training plan."
      }
    );
  }
}

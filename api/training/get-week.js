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

async function supabaseRequest(path) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "GET",

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type": "application/json"
      }
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

  const text = await response.text();

  return text
    ? JSON.parse(text)
    : [];
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

export default async function handler(
  request,
  response
) {
  if (request.method !== "GET") {
    response.setHeader(
      "Allow",
      "GET"
    );

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

    const currentDate =
      getManilaDate();

    const weekStart =
      toDateKey(
        getMonday(currentDate)
      );

    const plan =
      await loadCurrentPlan(
        user.id,
        weekStart
      );

    if (!plan) {
      return sendJson(
        response,
        200,
        {
          hasPlan: false,
          weekStart,
          plan: null,
          sessions: []
        }
      );
    }

    const sessions =
      await loadPlanSessions(
        user.id,
        plan.id
      );

    return sendJson(
      response,
      200,
      {
        hasPlan: true,
        weekStart,
        plan,
        sessions
      }
    );
  } catch (error) {
    console.error(
      "Could not load weekly plan:",
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
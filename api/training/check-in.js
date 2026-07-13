import {
  addDays,
  createDateFromParts,
  formatDateKey,
  getManilaDateParts,
  getMondayOfCurrentWeek
} from "./lib/dateUtils.js";

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
  { method = "GET", body, headers = {} } = {}
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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

  const text = await response.text();

  return text ? JSON.parse(text) : null;
}

function clampScale(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanFreeText(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed
    ? trimmed.slice(0, maxLength)
    : null;
}

function getRequestBody(request) {
  if (
    request.body &&
    typeof request.body === "object"
  ) {
    return request.body;
  }

  if (typeof request.body === "string" && request.body) {
    try {
      return JSON.parse(request.body);
    } catch (error) {
      return {};
    }
  }

  return {};
}

function isWeekNearlyComplete() {
  const today = createDateFromParts(
    getManilaDateParts()
  );

  const weekday = today.getUTCDay();

  // Saturday or Sunday in Asia/Manila
  return weekday === 6 || weekday === 0;
}

async function loadCheckIn(userId, weekStartKey) {
  const rows = await supabaseRequest(
    [
      "weekly_check_ins",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&week_start=eq.${weekStartKey}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function hasNextWeekPlan(userId, weekStart) {
  const nextWeekKey = formatDateKey(addDays(weekStart, 7));

  const rows = await supabaseRequest(
    [
      "training_plans",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&week_start=eq.${nextWeekKey}`,
      "&select=id",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(request, response) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(response, 500, {
      error: "Supabase server configuration is missing."
    });
  }

  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return sendJson(response, 401, {
      error: "Authentication is required."
    });
  }

  const user = await getAuthenticatedUser(accessToken);

  if (!user?.id) {
    return sendJson(response, 401, {
      error:
        "The authenticated athlete could not be verified."
    });
  }

  const weekStart = getMondayOfCurrentWeek();
  const weekStartKey = formatDateKey(weekStart);

  try {
    if (request.method === "GET") {
      const [existing, nextPlanned] = await Promise.all([
        loadCheckIn(user.id, weekStartKey),
        hasNextWeekPlan(user.id, weekStart)
      ]);

      const nearlyComplete = isWeekNearlyComplete();

      // The client sends context=pregeneration right before a new
      // weekly plan is generated.
      const preGeneration =
        request.query?.context === "pregeneration";

      // Ask only near the end of the week, or when the next week is
      // about to be planned without a check-in on file. Never ask
      // again after submission.
      const needed =
        !existing &&
        (nearlyComplete ||
          (preGeneration && !nextPlanned));

      return sendJson(response, 200, {
        weekStart: weekStartKey,
        nearlyComplete,
        needed,
        checkIn: existing
      });
    }

    if (request.method === "POST") {
      const body = getRequestBody(request);

      const row = {
        user_id: user.id,
        week_start: weekStartKey,

        overall_fatigue: clampScale(body.overall_fatigue, 1, 5),
        sleep_quality: clampScale(body.sleep_quality, 1, 5),
        muscle_soreness: clampScale(body.muscle_soreness, 1, 5),
        motivation: clampScale(body.motivation, 1, 5),
        stress_level: clampScale(body.stress_level, 1, 5),
        perceived_training_load: clampScale(
          body.perceived_training_load,
          1,
          10
        ),
        pain_or_injury: body.pain_or_injury === true,
        pain_details: cleanFreeText(body.pain_details, 500),
        sessions_felt: cleanFreeText(body.sessions_felt, 60),
        confidence_for_next_week: clampScale(
          body.confidence_for_next_week,
          1,
          5
        ),
        athlete_notes: cleanFreeText(body.athlete_notes, 1000),
        submitted_at: new Date().toISOString()
      };

      const saved = await supabaseRequest(
        "weekly_check_ins?on_conflict=user_id,week_start",
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
        checkIn: Array.isArray(saved) ? saved[0] || null : saved
      });
    }

    response.setHeader("Allow", "GET, POST");

    return sendJson(response, 405, {
      error: "Method not allowed."
    });
  } catch (error) {
    console.error("Weekly check-in failed:", error);

    return sendJson(response, 500, {
      error:
        error?.message ||
        "The weekly check-in could not be processed."
    });
  }
}

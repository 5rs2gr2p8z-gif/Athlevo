import { mapStrava, toActivityRow } from "../../lib/server/wearable/normalizer.js";

async function getAuthenticatedUser(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: serviceRoleKey
    }
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function readStravaAccount(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/strava_accounts?user_id=eq.${encodeURIComponent(
      userId
    )}&select=*`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Could not read Strava account:", data);
    throw new Error("Could not load the connected Strava account.");
  }

  return data[0] || null;
}

async function refreshStravaToken(account) {
  const currentUnixTime = Math.floor(Date.now() / 1000);

  // Keep using the existing token when it still has at least five minutes left.
  if (Number(account.expires_at) > currentUnixTime + 300) {
    return account;
  }

  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: account.refresh_token
    })
  });

  const tokenData = await response.json();

  if (!response.ok) {
    console.error("Strava token refresh failed:", tokenData);
    throw new Error("The Strava session could not be refreshed.");
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const saveResponse = await fetch(
    `${supabaseUrl}/rest/v1/strava_accounts?user_id=eq.${encodeURIComponent(
      account.user_id
    )}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!saveResponse.ok) {
    const errorText = await saveResponse.text();
    console.error("Could not save refreshed Strava token:", errorText);
    throw new Error("Could not save the refreshed Strava session.");
  }

  return {
    ...account,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_at
  };
}

// Fetch the LAP structure for one activity. Laps are what let Athlevo see the
// work/recovery structure inside a run (e.g. 3 × 8 min threshold) — the summary
// activity list never contains them. Any failure returns null so it can never
// break the sync.
async function fetchActivityLaps(activityId, accessToken) {
  try {
    const res = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/laps`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const laps = await res.json();
    return Array.isArray(laps) ? laps : null;
  } catch (error) {
    return null;
  }
}

// Attach laps to recent RUN activities so the workout-recognition engine can
// classify structure. Bounded (rate-limit friendly) and throttled; each fetch
// is best-effort. Repeated syncs backfill more of the history over time.
async function attachActivityLaps(activities, accessToken, cap) {
  const limit = Number.isFinite(cap) ? cap : 20;
  let budget = limit;
  for (const a of activities) {
    if (budget <= 0) break;
    const isRun = /run/i.test(a.type || a.sport_type || "");
    if (!isRun) continue;
    if (a.laps) continue;
    // Very short runs are unlikely to be structured quality work.
    if (Number(a.moving_time || 0) < 15 * 60) continue;
    const laps = await fetchActivityLaps(a.id, accessToken);
    if (laps && laps.length > 1) a.laps = laps;
    budget -= 1;
    await new Promise(r => setTimeout(r, 120)); // gentle spacing
  }
  return activities;
}

async function fetchStravaActivities(accessToken) {
  const activities = [];
  const pageSize = 100;

  // Initial MVP import: up to the latest 200 activities.
  for (let page = 1; page <= 2; page += 1) {
    const url = new URL(
      "https://www.strava.com/api/v3/athlete/activities"
    );

    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(pageSize));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const pageData = await response.json();

    if (!response.ok) {
      console.error("Strava activity request failed:", pageData);
      throw new Error("Could not download activities from Strava.");
    }

    activities.push(...pageData);

    if (pageData.length < pageSize) {
      break;
    }
  }

  return activities;
}

// Strava now flows through the SHARED wearable normalization layer, exactly
// like Terra and any future provider — one internal workout format. The
// activity_type/sport_type and Strava-only columns are preserved so this is
// fully backward compatible with the existing `activities` rows.
function mapStravaActivity(userId, activity) {
  const row = toActivityRow(userId, mapStrava(activity), activity);
  // Preserve Strava-specific columns previously written (coaching doesn't
  // read them, but we keep column parity).
  row.activity_type = activity.type || row.activity_type;
  row.sport_type = activity.sport_type || row.sport_type;
  row.max_speed_mps = activity.max_speed ?? null;
  row.commute = Boolean(activity.commute);
  row.private = Boolean(activity.private);
  // Store lap structure (when fetched) so the workout-recognition engine can
  // detect intervals/threshold blocks. Kept in the existing raw_data jsonb —
  // no schema change.
  if (Array.isArray(activity.laps) && activity.laps.length > 1) {
    row.raw_data = row.raw_data || {};
    row.raw_data.laps = activity.laps.map(l => ({
      distance: l.distance,
      moving_time: l.moving_time,
      elapsed_time: l.elapsed_time,
      average_speed: l.average_speed,
      average_heartrate: l.average_heartrate,
      lap_index: l.lap_index
    }));
  }
  return row;
}

async function saveActivities(activities) {
  if (!activities.length) {
    return [];
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/activities?on_conflict=source,external_activity_id`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(activities)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Could not save Strava activities:", data);
    throw new Error("Could not save imported Strava activities.");
  }

  return data;
}

async function writeSyncLog(userId, status, imported, errorMessage = null) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  await fetch(`${supabaseUrl}/rest/v1/activity_sync_logs`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      user_id: userId,
      source: "strava",
      status,
      activities_imported: imported,
      error_message: errorMessage,
      completed_at: new Date().toISOString()
    })
  });
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");

    return response.status(405).json({
      error: "Method not allowed."
    });
  }

  let authenticatedUser = null;

  try {
    const authorizationHeader = request.headers.authorization || "";

    if (!authorizationHeader.startsWith("Bearer ")) {
      return response.status(401).json({
        error: "Authentication is required."
      });
    }

    const supabaseAccessToken = authorizationHeader
      .slice("Bearer ".length)
      .trim();

    authenticatedUser = await getAuthenticatedUser(
      supabaseAccessToken
    );

    if (!authenticatedUser?.id) {
      return response.status(401).json({
        error: "Your Athlevo session is invalid or expired."
      });
    }

    const storedAccount = await readStravaAccount(
      authenticatedUser.id
    );

    if (!storedAccount) {
      return response.status(404).json({
        error: "No Strava account is connected."
      });
    }

    const activeAccount = await refreshStravaToken(storedAccount);

    const stravaActivities = await fetchStravaActivities(
      activeAccount.access_token
    );

    // Best-effort: enrich recent runs with lap structure for workout
    // recognition. Never fatal — a lap-fetch failure must not fail the sync.
    try {
      await attachActivityLaps(stravaActivities, activeAccount.access_token, 20);
    } catch (lapError) {
      console.warn("Lap enrichment skipped:", lapError && lapError.message);
    }

    const mappedActivities = stravaActivities.map(activity =>
      mapStravaActivity(authenticatedUser.id, activity)
    );

    const savedActivities = await saveActivities(mappedActivities);

    await writeSyncLog(
      authenticatedUser.id,
      "success",
      savedActivities.length
    );

    return response.status(200).json({
      success: true,
      activitiesDownloaded: stravaActivities.length,
      activitiesSaved: savedActivities.length
    });
  } catch (error) {
    console.error("Strava synchronization failed:", error);

    if (authenticatedUser?.id) {
      await writeSyncLog(
        authenticatedUser.id,
        "failed",
        0,
        error.message
      );
    }

    return response.status(500).json({
      error: error.message || "Could not synchronize Strava."
    });
  }
}
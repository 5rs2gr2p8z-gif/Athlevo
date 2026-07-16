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
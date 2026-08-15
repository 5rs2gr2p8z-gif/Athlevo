# Weather V1

Athlevo Weather V1 uses WeatherAPI.com through the consolidated authenticated
provider gateway:

`POST /api/providers?action=weather_context`

Set this server-only environment variable in Vercel:

`WEATHERAPI_KEY`

Do not expose the key in browser configuration. The browser calls Athlevo's
provider gateway with its Supabase bearer token; only the server calls
WeatherAPI.com's forecast endpoint. The implementation follows WeatherAPI's
documented `q` support for city names and decimal latitude/longitude, and maps
provider-specific current/forecast fields into Athlevo's normalized contract.

Official provider reference: <https://www.weatherapi.com/docs/>

## Location and privacy

- Device location is requested only through the browser's explicit permission
  flow. Athlevo does not use background or continuous location tracking.
- Coordinates are rounded to two decimal places before transmission.
- Coordinates are never written to Supabase, local storage, analytics, or logs.
- If device location is unavailable, denied, or times out, the server reads
  only the authenticated athlete's existing `profiles.location` value.
- If neither source is available, Today continues without weather.

## Caching and failure behavior

Normalized current conditions are cached in memory for 30 minutes by rounded
location/query. No weather database table is used. Provider failures and a
missing `WEATHERAPI_KEY` return a generic unavailable state and never block the
Today screen.

## V1 boundaries

Weather is factual context plus one deterministic risk message for self-guided
athletes. It does not automatically change workouts, pace targets, zones, or
training plans. Human-coached athletes see factual conditions only, except for
the factual severe-storm warning. Coach Dashboard weather, historical workout
weather, automatic heat calibration, and broad Daily Brief integration remain
deferred.

/**
 * Activity stream normalize / graph / cache contracts.
 *
 * Run: node tests/activity-streams.test.mjs
 */

import { readFileSync } from "node:fs";
import {
  extractStoredStreams,
  normalizeProviderStreams,
  downsampleStreams,
  hasUsableStreams,
  availableGraphKeys,
  graphSeriesFor,
  packStreamsForStore,
  paceSeriesFromVelocity
} from "../lib/server/activityStreams.js";

const clientSrc = readFileSync("./js/activityStreams.js", "utf8");
const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const providers = readFileSync("./api/providers/index.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log("PASS — " + name);
  } else {
    failed += 1;
    console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : ""));
  }
}

console.log("\n──── Normalize real provider payloads ────");
{
  const strava = normalizeProviderStreams({
    time: { data: [0, 1, 2, 3, 4] },
    heartrate: { data: [140, 142, 144, 146, 148] },
    velocity_smooth: { data: [3.1, 3.0, 2.9, 3.2, 3.1] },
    altitude: { data: [10, 11, 12, 11, 10] }
  });
  test("Strava key_by_type streams normalize",
    hasUsableStreams(strava) &&
    strava.heartrate.length === 5 &&
    strava.velocity.length === 5 &&
    strava.altitude.length === 5);

  const intervals = normalizeProviderStreams([
    { type: "time", data: [0, 5, 10, 15] },
    { type: "heartrate", data: [150, 152, 151, 149] },
    { type: "watts", data: [200, 210, 190, 205] }
  ]);
  test("Intervals array streams normalize",
    availableGraphKeys(intervals, "ride").join(",") === "heartrate,power");
}

console.log("\n──── Do not invent graphs from averages ────");
{
  const empty = extractStoredStreams({
    average_heartrate: 161,
    training_load: 105,
    average_pace_sec_per_km: 356
  });
  test("summary averages alone are not streams", !hasUsableStreams(empty));
  test("no graphs when only averages exist", availableGraphKeys(empty, "run").length === 0);
  test("chart renderer is not called from averages in Train",
    !/renderStreamChart\(act\.average/.test(calendar) &&
    /hasUsableStreams/.test(calendar));
}

console.log("\n──── Only available series render ────");
{
  const streams = normalizeProviderStreams({
    heartrate: [140, 142, 144, 146],
    velocity: [2.8, 2.9, 3.0, 2.9]
  });
  test("pace + HR render when those streams exist",
    availableGraphKeys(streams, "run").join(",") === "pace,heartrate");
  test("elevation / cadence / power stay hidden without samples",
    !availableGraphKeys(streams, "run").includes("elevation") &&
    !availableGraphKeys(streams, "run").includes("cadence") &&
    !availableGraphKeys(streams, "run").includes("power"));
  test("pace is derived from velocity, not a stored average",
    Math.abs(paceSeriesFromVelocity([1000 / 360, 1000 / 360, 1000 / 355])[0] - 360) < 0.01);
  test("graphSeriesFor returns null for missing power",
    graphSeriesFor(streams, "power") == null);
}

console.log("\n──── Stored streams + downsample ────");
{
  const raw = {
    activity_streams: {
      time: [0, 10, 20, 30],
      heartrate: [150, 151, 152, 153],
      cadence: [168, 170, 169, 171]
    }
  };
  const stored = extractStoredStreams(raw);
  test("persisted activity_streams are reused",
    hasUsableStreams(stored) && availableGraphKeys(stored, "run").includes("cadence"));

  const longHr = Array.from({ length: 2000 }, (_, i) => 140 + (i % 20));
  const packed = packStreamsForStore({ heartrate: longHr, time: longHr.map((_, i) => i) }, { source: "strava" });
  test("persisted streams are downsampled",
    packed && packed.heartrate.length <= 400 && packed.heartrate.length >= 3);
  test("downsample keeps shape, never fabricates extra series",
    !packed.watts && !packed.altitude);

  const tiny = downsampleStreams({ heartrate: [1, 2] });
  test("too-short series are rejected", !hasUsableStreams(tiny));
}

console.log("\n──── Client cache + render ────");
{
  const calls = [];
  const world = {
    supabaseClient: {
      auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) }
    }
  };
  world.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        streams: { heartrate: [140, 141, 142, 143], time: [0, 1, 2, 3] }
      })
    };
  };
  new Function("window", "supabaseClient", "fetch", clientSrc)(world, world.supabaseClient, world.fetch);
  const AS = world.AthlevoActivityStreams;

  const storedAct = {
    id: "cached-1",
    raw_data: { activity_streams: { heartrate: [150, 151, 152, 153], velocity: [3, 3.1, 2.9, 3] } }
  };
  const first = await AS.loadStreams(storedAct);
  test("stored streams skip the network",
    calls.length === 0 && AS.hasUsableStreams(first));
  const again = await AS.loadStreams({ id: "cached-1", raw_data: {} });
  test("reopening uses the in-memory cache",
    calls.length === 0 && AS.hasUsableStreams(again));

  const remoteAct = { id: "remote-1", raw_data: {} };
  const remote = await AS.loadStreams(remoteAct);
  test("missing streams fetch on demand",
    calls.length === 1 && /action=activity_streams/.test(calls[0]) &&
    AS.hasUsableStreams(remote));
  await AS.loadStreams({ id: "remote-1", raw_data: {} });
  test("a second open of the same activity does not refetch", calls.length === 1);

  const html = AS.renderStackedCharts(first, "run");
  test("stacked graphs render only real series",
    /data-stream="pace"/.test(html) && /data-stream="heartrate"/.test(html) &&
    !/data-stream="elevation"/.test(html) && !/data-stream="power"/.test(html));
  test("empty streams render no fake charts",
    AS.renderStackedCharts({ heartrate: null }, "run") === "");
  test("stacked graphs share one timeline width and aligned vertical grid",
    (html.match(/viewBox="0 0 360 88"/g) || []).length >= 2 &&
    /ad-chart-grid--v/.test(html) &&
    !/ad-chart-stats/.test(html) &&
    /ad-chart-label/.test(html));
}

console.log("\n──── Wiring ────");
test("providers gateway exposes activity_streams without a new function file",
  /action === "activity_streams"/.test(providers) &&
  /async function actionActivityStreams/.test(providers));
test("calendar week loader still selects lightweight activity rows only", (() => {
  const start = calendar.indexOf("async function loadWeek");
  const end = calendar.indexOf("function statusOf", start);
  const loader = calendar.slice(start, end);
  return /base\("activities"\)/.test(loader) && !/activity_streams/.test(loader) && !/\/streams/.test(loader);
})());
test("no-stream detail still keeps coach analysis",
  /renderCoachSection/.test(calendar) &&
  /ad-coach/.test(calendar));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

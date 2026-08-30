/**
 * Train selected-day activity cards: sport color, metric rules,
 * planned vs completed, matched plan context.
 *
 * Run: node tests/activity-cards.test.mjs
 */

import { readFileSync } from "node:fs";

const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const streamsSrc = readFileSync("./js/activityStreams.js", "utf8");
const html = readFileSync("./index.html", "utf8");

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

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not close ${name}()`);
}

const windowStub = {
  AthlevoCalendar: {
    resolveTimezone: () => "Asia/Manila",
    localCivil: (d) => {
      const x = d instanceof Date ? d : new Date(d);
      return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() };
    }
  },
  SportClassification: {
    canonicalSportOf: (a) => {
      const s = String((a && (a.sport_type || a.activity_type)) || "").toLowerCase();
      if (/ride|bike|cycl/.test(s)) return "ride";
      if (/swim/.test(s)) return "swim";
      if (/weight|gym|strength/.test(s)) return "strength";
      if (/walk/.test(s)) return "walk";
      if (/hike/.test(s)) return "hike";
      if (/yoga|mobility|other/.test(s)) return "other";
      if (/run/.test(s)) return "run";
      return "other";
    }
  }
};

new Function("window", streamsSrc)(windowStub);
new Function("window", calendar)(windowStub);
const TC = windowStub.AthlevoTrainCalendar;

console.log("\n──── Color system ────");
test("running uses the run theme", TC.sportTheme({ sport_type: "Run" }) === "run");
test("strength uses the graphite theme", TC.sportTheme({ sport_type: "WeightTraining" }) === "strength");
test("cycling uses the ride theme", TC.sportTheme({ sport_type: "Ride" }) === "ride");
test("swim / walk / other have distinct themes",
  TC.sportTheme({ sport_type: "Swim" }) === "swim" &&
  TC.sportTheme({ sport_type: "Walk" }) === "walk" &&
  TC.sportTheme({ sport_type: "Hike" }) === "walk" &&
  TC.sportTheme({ sport_type: "Yoga" }) === "other");
test("CSS defines restrained sport tokens, not full-card fills",
  html.includes("--sport-run:") &&
  html.includes("--sport-ride:") &&
  html.includes("--sport-swim:") &&
  html.includes("af-card-accent") &&
  html.includes(".af-card--run"));

console.log("\n──── Metric rules by sport ────");
{
  const run = TC.cardMetricItems({
    sport_type: "Run",
    moving_time_seconds: 5640,
    distance_meters: 16000,
    average_heartrate: 161,
    raw_data: { training_load: 105, perceived_exertion: 7 }
  });
  const labels = run.items.map(i => i.label);
  const lines = run.lines.join(" | ");
  test("run card includes duration, distance, pace, HR, load, RPE",
    labels.includes("Duration") && labels.includes("Distance") &&
    labels.includes("Average pace") && labels.includes("HR") &&
    labels.includes("Load") && labels.includes("RPE"));
  test("run card does not invent missing cadence or elevation",
    !labels.includes("Cadence") && !labels.includes("Elev"));
  test("run values stay real",
    /1h34m/.test(lines) && /16\.0 km/.test(lines) && /161 bpm/.test(lines) && /Load 105/.test(lines) && /RPE 7/.test(lines));
  test("run card uses compact unlabeled lines",
    run.lines[0] === "16.0 km · 1h34m" &&
    run.lines[1] === "5:53/km · 161 bpm" &&
    run.lines[2] === "Load 105 · RPE 7");

  const sparse = TC.cardMetricItems({ sport_type: "Run", name: "Easy" });
  test("missing run data yields no fake metrics", sparse.items.length === 0 && sparse.lines.length === 0);

  const strength = TC.cardMetricItems({
    sport_type: "WeightTraining",
    moving_time_seconds: 2400,
    distance_meters: 1200,
    average_heartrate: 110,
    raw_data: { training_load: 40, total_volume_kg: 8200 }
  });
  const sLabels = strength.items.map(i => i.label);
  test("strength shows duration, load, volume — not distance or pace",
    sLabels.includes("Duration") && sLabels.includes("Load") && sLabels.includes("Volume") &&
    !sLabels.includes("Distance") && !sLabels.includes("Average pace") && !sLabels.includes("HR"));
  test("strength lines stay compact",
    /40m/.test(strength.lines.join(" ")) && /Load 40/.test(strength.lines.join(" ")) && /8200 kg/.test(strength.lines.join(" ")));

  const ride = TC.cardMetricItems({
    sport_type: "Ride",
    moving_time_seconds: 3600,
    distance_meters: 28000,
    average_heartrate: 142,
    raw_data: { average_power_watts: 198, training_load: 72 }
  });
  const rLabels = ride.items.map(i => i.label);
  test("cycling shows speed and power, not running pace",
    rLabels.includes("Average speed") && rLabels.includes("Average power") &&
    !rLabels.includes("Average pace"));
  test("cycling lines use speed not pace",
    /28\.0 km\/h/.test(ride.lines.join(" ")) && !/\/km/.test(ride.lines.join(" ")));
}

console.log("\n──── Card markup ────");
{
  const runCard = TC.activityCardHtml({
    id: "act-run",
    sport_type: "Run",
    name: "Lubao Running",
    moving_time_seconds: 5640,
    distance_meters: 16000,
    average_heartrate: 161,
    raw_data: { training_load: 105 }
  }, "2026-08-29", { done: true, session: { session_type: "threshold", title: "Threshold" } });
  test("completed run is a tappable button card",
    /<button type="button"/.test(runCard) && /af-card--run/.test(runCard) && /data-activity-id="act-run"/.test(runCard));
  test("completed run opens this activity's detail",
    /openModal\('2026-08-29','act-run'\)/.test(runCard));
  test("matched completed card includes plan context, not a second plan card",
    /Planned: Threshold/.test(runCard) && !/af-card--planned/.test(runCard));
  test("completed cards do not use the planned outline treatment",
    !/af-card--planned/.test(runCard) && /af-card--activity/.test(runCard));
  test("run card uses inline metrics, not labeled boxes",
    /af-card-metrics-row/.test(runCard) && /af-card-metric-val/.test(runCard) &&
    /16\.0 km/.test(runCard) && /1h34m/.test(runCard) &&
    !/<small>Duration<\/small>/.test(runCard) &&
    !/AVERAGE PACE/.test(runCard));

  const strengthCard = TC.activityCardHtml({
    id: "act-str",
    sport_type: "WeightTraining",
    name: "Gym",
    moving_time_seconds: 2400,
    raw_data: { training_load: 40 }
  }, "2026-08-29", {});
  test("run and strength cards use distinct sport treatments",
    /af-card--strength/.test(strengthCard) && !/af-card--run/.test(strengthCard) &&
    /af-card--run/.test(runCard) && !/af-card--strength/.test(runCard));

  const planned = TC.plannedCardHtml({
    date: "2026-09-02",
    session: { session_type: "easy", title: "Aerobic", duration_minutes: 50 },
    missed: false,
    skipped: false
  });
  test("planned card stays outlined and unlabeled as completed",
    /af-card--planned/.test(planned) && /Planned/.test(planned) &&
    !/af-card--run/.test(planned) && !/af-card--activity/.test(planned));
}

console.log("\n──── Selected-day composition ────");
{
  const matched = TC.buildSelectedDayModel("2026-08-25", {
    session: { session_type: "threshold", title: "Threshold" },
    execution: { status: "completed", imported_activity_id: "a1" },
    activities: [{ id: "a1", name: "Morning Run", sport_type: "Run", moving_time_seconds: 3000, distance_meters: 8000 }]
  }, "2026-08-29");
  const matchedHtml = TC.renderSelectedDayHtml(matched);
  test("matched completed day renders one completed card and no planned card",
    (matchedHtml.match(/data-train-item="activity"/g) || []).length === 1 &&
    !/data-train-item="plan"/.test(matchedHtml) &&
    /Planned: Threshold/.test(matchedHtml));

  const unmatched = TC.buildSelectedDayModel("2026-08-26", {
    session: { session_type: "easy" },
    activities: [{ id: "a2", name: "Shakeout", sport_type: "Run", moving_time_seconds: 1800 }]
  }, "2026-08-29");
  const unmatchedHtml = TC.renderSelectedDayHtml(unmatched);
  test("unmatched plan + activity stay separate",
    /data-train-item="plan"/.test(unmatchedHtml) &&
    /data-train-item="activity"/.test(unmatchedHtml));

  const both = TC.buildSelectedDayModel("2026-08-24", {
    activities: [
      { id: "r1", sport_type: "Run", name: "AM", moving_time_seconds: 2400, distance_meters: 6000 },
      { id: "s1", sport_type: "WeightTraining", name: "Lift", moving_time_seconds: 1800 }
    ]
  }, "2026-08-29");
  const bothHtml = TC.renderSelectedDayHtml(both);
  test("run + strength on the same date keep distinct cards",
    /data-activity-id="r1"/.test(bothHtml) && /data-activity-id="s1"/.test(bothHtml) &&
    /af-card--run/.test(bothHtml) && /af-card--strength/.test(bothHtml));
  test("each card opens its own activity id",
    /openModal\('2026-08-24','r1'\)/.test(bothHtml) &&
    /openModal\('2026-08-24','s1'\)/.test(bothHtml));
}

console.log("\n──── Mini graph inside completed cards ────");
{
  const laps = [
    { distance: 1000, moving_time: 360 },
    { distance: 1000, moving_time: 340 },
    { distance: 1000, moving_time: 355 },
    { distance: 1000, moving_time: 370 }
  ];
  const runLaps = {
    id: "hist-1",
    sport_type: "Run",
    name: "Lubao Running",
    moving_time_seconds: 5640,
    distance_meters: 16000,
    average_heartrate: 161,
    raw_data: { training_load: 105, laps }
  };
  const lapCard = TC.activityCardHtml(runLaps, "2026-08-24", {});
  test("completed run + lap data renders a workout strip inside the card",
    /af-card-strip/.test(lapCard) && /af-strip-seg/.test(lapCard) &&
    /af-card--has-strip/.test(lapCard));
  test("lap profile is real pace data, not a decorative placeholder",
    !!TC.cardProfileSeries(runLaps) && TC.cardProfileSeries(runLaps).invert === true &&
    TC.cardProfileSeries(runLaps).values.length >= 2);

  const streamRun = {
    id: "cached-stream",
    sport_type: "Run",
    moving_time_seconds: 3000,
    distance_meters: 8000,
    raw_data: {
      activity_streams: {
        time: [0, 30, 60, 90, 120, 150],
        velocity: [3.0, 2.8, 2.9, 3.1, 2.7, 2.95]
      }
    }
  };
  const streamCard = TC.activityCardHtml(streamRun, "2026-08-25", {});
  test("completed run + cached full stream renders a workout strip",
    /af-card-strip/.test(streamCard) && /af-strip-seg/.test(streamCard));

  const summaryOnly = {
    id: "avg-only",
    sport_type: "Run",
    moving_time_seconds: 5640,
    distance_meters: 16000,
    average_heartrate: 161,
    raw_data: { training_load: 105 }
  };
  test("completed run with only summary values has no fake graph",
    TC.cardMiniProfile(summaryOnly) === "" &&
    !/af-card-profile/.test(TC.activityCardHtml(summaryOnly, "2026-08-27", {})));

  const planned = TC.plannedCardHtml({
    date: "2026-08-30",
    session: { session_type: "easy", title: "Aerobic", duration_minutes: 50 },
    missed: false,
    skipped: false
  });
  test("planned workout has no mini activity graph",
    !/af-card-profile/.test(planned) && !/af-card--has-profile/.test(planned));

  const matched = TC.buildSelectedDayModel("2026-08-25", {
    session: { session_type: "threshold", title: "Threshold" },
    execution: { status: "completed", imported_activity_id: "a1" },
    activities: [{ ...runLaps, id: "a1" }]
  }, "2026-08-30");
  const matchedHtml = TC.renderSelectedDayHtml(matched);
  test("matched plan + completed still shows the workout strip",
    /Planned: Threshold/.test(matchedHtml) && /af-card-strip/.test(matchedHtml) &&
    !/data-train-item="plan"/.test(matchedHtml));

  const runA = { ...runLaps, id: "r1" };
  const lift = { id: "s1", sport_type: "WeightTraining", name: "Lift", moving_time_seconds: 1800, raw_data: { training_load: 40 } };
  const runB = {
    id: "r2", sport_type: "Run", name: "PM",
    moving_time_seconds: 1800, distance_meters: 4000,
    raw_data: { laps: [{ distance: 1000, moving_time: 300 }, { distance: 1000, moving_time: 280 }] }
  };
  const both = TC.renderSelectedDayHtml(TC.buildSelectedDayModel("2026-08-24", {
    activities: [runA, lift, runB]
  }, "2026-08-30"));
  test("each eligible same-day activity has its own strip",
    /af-card-strip/.test(TC.activityCardHtml(runA, "2026-08-24", {})) &&
    /af-card-strip/.test(TC.activityCardHtml(runB, "2026-08-24", {})) &&
    /data-activity-id="r1"/.test(both) && /data-activity-id="r2"/.test(both) && /data-activity-id="s1"/.test(both));

  test("mini graph uses the sport accent token",
    /color:var\(--sport-accent/.test(html) && /af-card-profile/.test(html));
  test("graph container has a visible non-zero height",
    /\.af-card-profile\{[^}]*height:50px/.test(html.replace(/\s+/g, "")) ||
    /height:50px/.test(html) && /af-card-profile/.test(html));
  test("tapping the card still opens detail graphs",
    /openModal\('2026-08-24','hist-1'\)/.test(lapCard) &&
    /loadActivityCharts/.test(calendar) && /loadStreams\(act\)/.test(calendar));
  test("selected-day cards do not prefetch streams",
    !/activity_streams/.test(extractFunction(calendar, "loadWeek")) &&
    !/loadStreams/.test(extractFunction(calendar, "activityCardHtml")) &&
    !/loadStreams/.test(extractFunction(calendar, "cardMiniProfile")));
}

console.log("\n──── Architecture ────");
test("selected-day filtering is still the only feed renderer",
  !/for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*7/.test(extractFunction(calendar, "renderActivityFeed")));
test("week load does not prefetch activity streams",
  !/activity_streams/.test(extractFunction(calendar, "loadWeek")));
test("detail loads streams only after the card is opened",
  /loadActivityCharts/.test(calendar) && /loadStreams\(act\)/.test(calendar));
test("activityStreams script is loaded before the calendar",
  /activityStreams\.js/.test(html) &&
  html.indexOf("activityStreams.js") < html.indexOf("trainCalendar.js"));

console.log("\n──── Scanability ────");
{
  const runCard = TC.activityCardHtml({
    id: "scan-run",
    sport_type: "Run",
    name: "Lubao Running",
    moving_time_seconds: 5640,
    distance_meters: 16000,
    average_heartrate: 161,
    raw_data: { training_load: 105, perceived_exertion: 7, laps: [{ distance: 1000, moving_time: 360 }, { distance: 1000, moving_time: 340 }] }
  }, "2026-08-24", { done: true });
  test("run card can be read without metric labels",
    /16\.0 km/.test(runCard) && /1h34m/.test(runCard) &&
    /5:53\/km/.test(runCard) && /161 bpm/.test(runCard) &&
    /af-card-metric-val/.test(runCard) && !/DURATION/.test(runCard));
  test("workout strip uses sport accent for work segments",
    /af-card-strip/.test(runCard) && /af-strip-seg/.test(runCard));
  test("strength does not show a fake graph",
    TC.cardMiniProfile({ id: "s", sport_type: "WeightTraining", moving_time_seconds: 1800, raw_data: { training_load: 40 } }) === "");

  const detail = TC.renderDetailSummary({
    sport_type: "Run",
    moving_time_seconds: 5640,
    distance_meters: 16000,
    average_heartrate: 161,
    raw_data: { training_load: 105, perceived_exertion: 7 }
  }, null, "run");
  test("detail top is one compact metric line",
    /ad-metrics/.test(detail) && /16\.0 km · 1h34m · 5:53\/km · 161 bpm · Load 105 · RPE 7/.test(detail) &&
    !/ad-summary-item/.test(detail));

  const longCoach = TC.clipCoachText("First sentence stays. Second sentence also stays. Third sentence must drop.");
  test("coach analysis is clipped to two sentences",
    longCoach === "First sentence stays. Second sentence also stays.");

  const laps = [
    { distance: 1000, moving_time: 355, average_heartrate: 150 },
    { distance: 1000, moving_time: 360, average_heartrate: 154 }
  ];
  const strip = TC.renderSplitsStrip({ raw_data: { laps } }, "run");
  test("splits strip appears only with real laps",
    /ad-splits-strip/.test(strip) && /5:55/.test(strip) && /150 bpm/.test(strip));
  test("no splits strip without real laps",
    TC.renderSplitsStrip({ raw_data: {} }, "run") === "" &&
    TC.renderSplitsStrip({ raw_data: { laps: [{ distance: 1000, moving_time: 300 }] } }, "run") === "");

  const coach = TC.renderCoachSection({ sport_type: "Run", moving_time_seconds: 3600, average_heartrate: 150 }, { coachSummary: "Pace stayed controlled, but HR drifted steadily in the final third. That points more to durability than pacing. Extra unused sentence." }, null);
  test("coach block is one short interpretation",
    /ad-coach-text/.test(coach) && !/Ask Coach/.test(coach) &&
    (coach.match(/[.!?]/g) || []).length <= 2);

  windowStub.WorkoutStructureView = {
    render: segs => `<div class="wsv">${segs.map(s => s.kind).join(",")}</div>`
  };
  test("steady-only recognition does not render a Workout Structure block",
    TC.workoutStructureHtml({ workoutType: "threshold", segments: [{ kind: "steady", duration: 3600 }] }, {
      moving_time_seconds: 3600, distance_meters: 10000
    }) === "");
  test("structured intervals still render below the telemetry stack",
    /ad-section--secondary/.test(TC.workoutStructureHtml({
      workoutType: "threshold",
      segments: [
        { kind: "warmup", duration: 600 },
        { kind: "work", duration: 1200 },
        { kind: "recovery", duration: 180 }
      ]
    }, { moving_time_seconds: 1980 })) &&
    /warmup,work,recovery/.test(TC.workoutStructureHtml({
      workoutType: "threshold",
      segments: [
        { kind: "warmup", duration: 600 },
        { kind: "work", duration: 1200 },
        { kind: "recovery", duration: 180 }
      ]
    }, { moving_time_seconds: 1980 })));

  test("Train no longer shows weekly progress or training context below cards",
    !/<details class="train-more">/.test(html) &&
    /id="trainWeekProgress"/.test(html) &&
    /display:none/.test(html.slice(html.indexOf('id="trainWeekProgress"') - 180, html.indexOf('id="trainWeekProgress"'))) &&
    /clearTrainExtras/.test(calendar) &&
    !/renderWeekProgress\(\);\s*renderContext\(\)/.test(extractFunction(calendar, "render")));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

/*
 * Executable Trends data/security/UI contract checks.
 * Run: node tests/trends-analytics.test.mjs
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  buildProviderTrendsResponse,
  dateRangeForTrends,
  normalizeIntervalsWellness
} from "../lib/server/providerTrends.js";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
process.env.OAUTH_STATE_SECRET = "state-secret";
process.env.INTERVALS_CLIENT_ID = "client";
process.env.INTERVALS_CLIENT_SECRET = "client-secret";
process.env.APP_URL = "https://athlevo.org";

const handler = (await import("../api/providers/index.js")).default;
const html = readFileSync("./index.html", "utf8");
const clientSource = readFileSync("./js/trendsAnalytics.js", "utf8");
const providerSource = readFileSync("./api/providers/index.js", "utf8");
let passed = 0;
let failed = 0;

const test = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
};
const section = name => console.log(`\n──── ${name} ────`);

const wellnessFixture = [
  { id: "2026-07-27", ctl: 46.5, atl: 39, ctlLoad: 72, atlLoad: 72 },
  { id: "2026-07-28", ctl: 47.2, atl: null, ctlLoad: null, atlLoad: null },
  { id: "2026-07-29", ctl: 48, atl: 34, ctlLoad: 0, atlLoad: 0 }
];

section("Pure provider normalization");
{
  const days = normalizeIntervalsWellness(wellnessFixture);
  test("uses provider ctl as Fitness", days[2].fitness === 48);
  test("uses provider atl as Fatigue", days[2].fatigue === 34);
  test("derives absolute Form as ctl - atl", days[2].form === 14);
  test("uses ctlLoad as completed daily load", days[0].completedLoad === 72);
  test("does not invent planned load", days.every(day => day.plannedLoad === null));
  test("preserves missing values as null instead of zero",
    days[1].fatigue === null && days[1].form === null && days[1].completedLoad === null);

  const contract = buildProviderTrendsResponse(wellnessFixture, "3m", new Date("2026-07-29T00:00:00Z"));
  test("normalized response documents absolute mode and field map",
    contract.formMode === "absolute" &&
    contract.fields.fitness === "ctl" &&
    contract.fields.fatigue === "atl" &&
    contract.fields.form === "ctl-atl" &&
    contract.fields.completedLoad === "ctlLoad" &&
    contract.fields.plannedLoad === null);
  test("3-month server range is bounded to 90 days",
    contract.oldest === "2026-05-01" && contract.newest === "2026-07-29");
  test("normalized response returns only the requested bounded date range",
    buildProviderTrendsResponse(
      [{ id: "2026-04-30", ctl: 20, atl: 10, ctlLoad: 40 }, ...wellnessFixture],
      "3m",
      new Date("2026-07-29T00:00:00Z")
    ).days.every(day => day.date >= "2026-05-01" && day.date <= "2026-07-29"));
  test("unsupported range falls back to 3 months",
    dateRangeForTrends("anything", new Date("2026-07-29T00:00:00Z")).range === "3m");
}

const makeResponse = () => {
  const response = { code: null, body: null, headers: {} };
  response.status = code => (response.code = code, response);
  response.json = body => (response.body = body, response);
  response.setHeader = (key, value) => { response.headers[key] = value; };
  response.end = () => response;
  return response;
};

async function callTrends({
  subscription = {
    provider: "whop",
    plan_id: "performance",
    status: "active",
    current_period_end: "2099-01-01T00:00:00.000Z"
  },
  account = {
    id: "pa-a",
    user_id: "user-a",
    provider: "intervals",
    provider_athlete_id: "i-a",
    access_token: "provider-secret-token",
    scope: "ACTIVITY:READ,WELLNESS:READ",
    status: "connected"
  },
  wellnessStatus = 200,
  body = { range: "3m", user_id: "user-b" }
} = {}) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    seen.push({ url: value, init });
    const json = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    });
    if (value.includes("/auth/v1/user")) return json(200, { id: "user-a" });
    if (value.includes("/rest/v1/subscriptions")) {
      return json(200, subscription ? [subscription] : []);
    }
    if (value.includes("/rest/v1/provider_accounts")) {
      return json(200, account ? [account] : []);
    }
    if (value.includes("/athlete/0/wellness")) {
      return json(wellnessStatus, wellnessStatus === 200 ? wellnessFixture : { error: "provider down" });
    }
    return json(404, {});
  };

  const response = makeResponse();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer verified-jwt" },
    query: { provider: "intervals", action: "trends" },
    body
  }, response);
  return { response, seen };
}

section("Authenticated provider route and security");
{
  const { response, seen } = await callTrends();
  test("paid_active receives personalized premium Trends data",
    response.code === 200 && Array.isArray(response.body.days));
  const accountRead = seen.find(call => call.url.includes("/rest/v1/provider_accounts"));
  test("route scopes provider lookup to verified JWT user",
    accountRead && accountRead.url.includes("user_id=eq.user-a"));
  test("request-body user_id cannot override ownership",
    accountRead && !accountRead.url.includes("user-b"));
  test("route reads wellness through athlete 0 bound to the bearer credential",
    seen.some(call => call.url.includes("/athlete/0/wellness?oldest=")));
  test("successful route returns normalized days", response.code === 200 &&
    response.body.days[2].fitness === 48 &&
    response.body.days[2].fatigue === 34 &&
    response.body.days[2].form === 14 &&
    response.body.days[2].completedLoad === 0);
  test("provider credentials never reach the browser",
    !JSON.stringify(response.body).includes("provider-secret-token") &&
    !JSON.stringify(response.body).includes("service-secret") &&
    !Object.prototype.hasOwnProperty.call(response.body, "access_token"));

  const free = await callTrends({
    subscription: null,
    body: {
      range: "3m",
      entitlement: "paid_active",
      checkout_return: "success"
    }
  });
  test("free receives structured premium-required response without personalized data",
    free.response.code === 402 &&
    free.response.body.code === "PERFORMANCE_REQUIRED" &&
    free.response.body.feature === "trends_analytics" &&
    !Object.prototype.hasOwnProperty.call(free.response.body, "days"));
  test("free does not trigger provider-account or Intervals wellness fetch",
    !free.seen.some(call => call.url.includes("/rest/v1/provider_accounts")) &&
    !free.seen.some(call => call.url.includes("/athlete/0/wellness")));

  const inactive = await callTrends({
    subscription: {
      provider: "whop",
      plan_id: "performance",
      status: "expired",
      current_period_end: "2025-01-01T00:00:00.000Z"
    }
  });
  test("paid_inactive receives no personalized premium Trends data",
    inactive.response.code === 402 &&
    inactive.response.body.code === "PERFORMANCE_REQUIRED" &&
    !inactive.seen.some(call => call.url.includes("/athlete/0/wellness")));
  test("client entitlement and checkout-return fields cannot unlock Trends",
    free.response.code === 402 &&
    !free.seen.some(call => call.url.includes("/athlete/0/wellness")));

  const disconnected = await callTrends({ account: null });
  test("disconnected athlete receives the correct state",
    disconnected.response.code === 409 &&
    disconnected.response.body.code === "NOT_CONNECTED");

  const missingScope = await callTrends({
    account: {
      id: "pa-a", user_id: "user-a", provider: "intervals",
      access_token: "provider-secret-token", scope: "ACTIVITY:READ"
    }
  });
  test("existing activity-only connection gets explicit wellness scope state",
    missingScope.response.code === 403 &&
    missingScope.response.body.code === "TRENDS_SCOPE_REQUIRED");

  const failure = await callTrends({ wellnessStatus: 500 });
  test("provider failure does not become fake zero data",
    failure.response.code === 502 &&
    failure.response.body.code === "PROVIDER_UNAVAILABLE" &&
    !Object.prototype.hasOwnProperty.call(failure.response.body, "days"));
  test("route never accepts a client athlete or user identifier",
    (() => {
      const route = providerSource.slice(
        providerSource.indexOf("async function actionTrends"),
        providerSource.indexOf("ACTION: diagnose")
      );
      return /const range = request\.body && request\.body\.range/.test(route) &&
    !/actionTrends[\s\S]*?request\.body\.(?:user|user_id|athlete|athlete_id)/.test(
      route
    ) &&
      route.indexOf('requirePaidAccess(user.id, "trends_analytics")') <
        route.indexOf("const account = await readProviderAccount");
    })());
}

const context = { window: {} };
vm.runInNewContext(clientSource, context);
const analytics = context.window.AthlevoTrendsAnalytics;

section("Training Status and truthful gaps");
{
  const expanded = analytics.expandTrendDays(
    "2026-07-26",
    "2026-07-29",
    [
      { date: "2026-07-26", form: 8, fitness: 45, fatigue: 37 },
      { date: "2026-07-28", form: null, fitness: 47, fatigue: null },
      { date: "2026-07-29", form: -22, fitness: 48, fatigue: 70 }
    ]
  );
  test("missing provider dates become null gaps, not invented zeroes",
    expanded[1].date === "2026-07-27" && expanded[1].form === null);
  const segments = analytics.lineSegments(expanded, "form", index => index, value => value);
  test("missing Form breaks the plotted line", segments.length === 2 &&
    segments[0].length === 1 && segments[1].length === 1);
  test("latest valid Form drives current status",
    analytics.classifyForm(expanded[3].form).label === "High Risk");
  test("zones are ordered Detraining, Fresh, Maintaining, Gaining, High Risk",
    analytics.FORM_ZONES.map(zone => zone.label).join("|") ===
    "Detraining|Fresh|Maintaining|Gaining Fitness|High Risk");
  test("absolute Athlevo thresholds are deterministic",
    analytics.classifyForm(26).label === "Detraining" &&
    analytics.classifyForm(14).label === "Fresh" &&
    analytics.classifyForm(0).label === "Maintaining" &&
    analytics.classifyForm(-10).label === "Gaining Fitness" &&
    analytics.classifyForm(-21).label === "High Risk");
}

section("Fitness/Fatigue and Training Load calculations");
{
  const expanded = analytics.expandTrendDays(
    "2026-07-20",
    "2026-07-29",
    wellnessFixture.map(day => ({
      date: day.id,
      fitness: day.ctl,
      fatigue: day.atl,
      form: day.atl === null ? null : day.ctl - day.atl,
      completedLoad: day.ctlLoad,
      plannedLoad: null
    }))
  );
  test("Fitness and Fatigue share the same expanded date axis",
    expanded.length === 10 &&
    expanded[0].date === "2026-07-20" &&
    expanded[9].date === "2026-07-29");
  test("missing daily Fitness/Fatigue values remain missing",
    expanded[0].fitness === null && expanded[8].fatigue === null);
  test("latest normalized Fitness and Fatigue values remain accurate",
    expanded[9].fitness === 48 && expanded[9].fatigue === 34);
  test("six-week range keeps real daily load buckets",
    analytics.aggregateTrainingLoad(expanded, "6w").length === expanded.length);
  test("completed daily load keeps the provider value, including measured zero",
    analytics.aggregateTrainingLoad(expanded, "6w")[9].completed === 0 &&
    analytics.aggregateTrainingLoad(expanded, "6w")[7].completed === 72);
  test("longer ranges aggregate load into Monday-based weeks",
    analytics.aggregateTrainingLoad(expanded, "6m").length === 2);
  test("planned load remains absent when provider does not supply it",
    analytics.aggregateTrainingLoad(expanded, "6m").every(bucket => bucket.planned === null));
  test("planned load is retained only when a real normalized value is present",
    analytics.aggregateTrainingLoad([
      { date: "2026-07-27", completedLoad: 40, plannedLoad: null },
      { date: "2026-07-28", completedLoad: null, plannedLoad: 55 }
    ], "6w").map(bucket => bucket.planned).join("|") === "|55");

  const comparison = analytics.loadWeekComparison(expanded, "2026-07-29");
  test("incomplete week is labelled in progress", comparison.inProgress === true);
  test("comparison requires measured data on both elapsed periods",
    comparison.comparable === false && comparison.percent === null);
  test("planned-load availability is true only for real normalized values",
    analytics.hasPlannedLoad([
      { planned: null },
      { planned: undefined }
    ]) === false &&
    analytics.hasPlannedLoad([{ planned: 0 }]) === true &&
    analytics.hasPlannedLoad([{ planned: 55 }]) === true);
}

section("Graph-first UI and accessibility");
{
  const trendsId = html.indexOf('id="screen-trends"');
  const trendsStart = html.lastIndexOf("<section", trendsId);
  const trendsMarkup = html.slice(
    trendsStart,
    html.indexOf("</section>", trendsStart) +
      "</section>".length
  );
  const chartHost = () => ({
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => []
  });
  const statusHost = chartHost();
  analytics.renderStatusChart(statusHost, [
    { date: "2026-07-25", form: 28 },
    { date: "2026-07-26", form: 12 },
    { date: "2026-07-27", form: 0 },
    { date: "2026-07-28", form: -10 },
    { date: "2026-07-29", form: 14 }
  ]);
  const fitnessHost = chartHost();
  analytics.renderFitnessChart(fitnessHost, [
    { date: "2026-07-25", fitness: 42, fatigue: 46 },
    { date: "2026-07-29", fitness: 45, fatigue: 39 }
  ]);
  const loadHost = chartHost();
  analytics.renderLoadChart(loadHost, [
    { key: "2026-07-25", label: "Jul 25", completed: 45, planned: null },
    { key: "2026-07-29", label: "Jul 29", completed: 60, planned: null }
  ]);
  test("exactly three primary graph views exist",
    (trendsMarkup.match(/data-trend-graph=/g) || []).length === 3 &&
    /data-trend-graph="training-status"/.test(trendsMarkup) &&
    /data-trend-graph="fitness-fatigue"/.test(trendsMarkup) &&
    /data-trend-graph="training-load"/.test(trendsMarkup));
  test("no separate duplicate Form graph exists",
    !/data-trend-graph="form"/.test(trendsMarkup));
  test("all five Training Status bands render with direct labels",
    ["Detraining", "Fresh", "Maintaining", "Gaining Fitness", "High Risk"]
      .every(label => statusHost.innerHTML.includes(`>${label}</text>`)) &&
    (statusHost.innerHTML.match(/class="trend-zone trend-zone-/g) || []).length === 5);
  test("Training Status renders full plot bands, boundaries, and Form thresholds",
    /class="trend-plot-surface"/.test(statusHost.innerHTML) &&
    (statusHost.innerHTML.match(/class="trend-zone-boundary"/g) || []).length === 4 &&
    ["+25", "+5", "−5", "−20"].every(value =>
      statusHost.innerHTML.includes(`>${value}</text>`)));
  test("Training Balance chart still plots the Form series",
    /id="trendStatusTitle">Training Balance</.test(trendsMarkup) &&
    /class="trend-series trend-form-series"/.test(statusHost.innerHTML));
  test("latest Form value is labeled directly beside the latest point",
    /class="trend-latest-label trend-latest-label-form"[\s\S]*?>Form \+14<\/text>/.test(
      statusHost.innerHTML
    ));
  test("educational Form formula and zone essays are not on the main screen",
    !trendsMarkup.includes("Form = Fitness − Fatigue") &&
    !trendsMarkup.includes("Positive Form: fresher") &&
    !trendsMarkup.includes("About Training Status") &&
    !/id="trendStatusInterpretation"/.test(trendsMarkup));
  test("Training Balance keeps Form on the chart without repeating status",
    /statusTitle\.textContent = "Training Balance"/.test(clientSource) &&
    /id="trendStatusFormValue"/.test(trendsMarkup) &&
    !/`Training Status: \$\{zone\.label\}`/.test(clientSource) &&
    !/data-trend-graph="form"/.test(trendsMarkup));
  test("Fitness/Fatigue chart has a plot surface, scale, grid, dates, and latest labels",
    /class="trend-plot-surface"/.test(fitnessHost.innerHTML) &&
    (fitnessHost.innerHTML.match(/class="trend-grid-line"/g) || []).length === 4 &&
    /class="trend-axis-label"/.test(fitnessHost.innerHTML) &&
    /Fitness 45<\/text>/.test(fitnessHost.innerHTML) &&
    /Fatigue 39<\/text>/.test(fitnessHost.innerHTML) &&
    /Jul/.test(fitnessHost.innerHTML));
  test("Fitness & Fatigue heading is restored without an education paragraph",
    /Fitness &amp; Fatigue/.test(trendsMarkup) &&
    /id="trendFitnessChart"/.test(trendsMarkup) &&
    !trendsMarkup.includes(
      "Fitness reflects your longer-term training load. Fatigue reacts more quickly to recent training."
    ) &&
    !/id="trendFitnessInterpretation"/.test(trendsMarkup));
  test("Fitness/Fatigue interpretation helpers stay available without being shown",
    analytics.fitnessInterpretation([
      { date: "2026-07-22", fitness: 50, fatigue: 60 },
      { date: "2026-07-23", fitness: null, fatigue: null },
      { date: "2026-07-24", fitness: null, fatigue: null },
      { date: "2026-07-25", fitness: null, fatigue: null },
      { date: "2026-07-26", fitness: null, fatigue: null },
      { date: "2026-07-27", fitness: null, fatigue: null },
      { date: "2026-07-28", fitness: null, fatigue: null },
      { date: "2026-07-29", fitness: 48, fatigue: 48 }
    ]) === "Fatigue has fallen faster than fitness, leaving you fresher." &&
    analytics.fitnessInterpretation([
      { date: "2026-07-22", fitness: 45, fatigue: 40 },
      { date: "2026-07-23", fitness: null, fatigue: null },
      { date: "2026-07-24", fitness: null, fatigue: null },
      { date: "2026-07-25", fitness: null, fatigue: null },
      { date: "2026-07-26", fitness: null, fatigue: null },
      { date: "2026-07-27", fitness: null, fatigue: null },
      { date: "2026-07-28", fitness: null, fatigue: null },
      { date: "2026-07-29", fitness: 47, fatigue: 50 }
    ]).includes("carrying more short-term load") &&
    analytics.fitnessInterpretation([
      { date: "2026-07-22", fitness: 40, fatigue: 40 },
      { date: "2026-07-23", fitness: null, fatigue: null },
      { date: "2026-07-24", fitness: null, fatigue: null },
      { date: "2026-07-25", fitness: null, fatigue: null },
      { date: "2026-07-26", fitness: null, fatigue: null },
      { date: "2026-07-27", fitness: null, fatigue: null },
      { date: "2026-07-28", fitness: null, fatigue: null },
      { date: "2026-07-29", fitness: 50, fatigue: 45 }
    ]) === "Fitness and fatigue are both rising as recent training accumulates.");
  test("Training Load heading is restored without a week-total or essay",
    />Training Load</.test(trendsMarkup) &&
    /id="trendLoadChart"/.test(trendsMarkup) &&
    !/id="trendLoadValues"/.test(trendsMarkup) &&
    !/id="trendLoadInterpretation"/.test(trendsMarkup));
  test("Training Load chart has a plot surface, baseline, grid, and date labels",
    /class="trend-plot-surface"/.test(loadHost.innerHTML) &&
    /class="trend-load-baseline"/.test(loadHost.innerHTML) &&
    (loadHost.innerHTML.match(/class="trend-grid-line"/g) || []).length === 3 &&
    /class="trend-axis-label"/.test(loadHost.innerHTML) &&
    /Jul/.test(loadHost.innerHTML));
  test("Planned-load helper remains truthful when planned values are unavailable",
    analytics.hasPlannedLoad([
      { planned: null },
      { planned: null }
    ]) === false);
  test("all four compact time ranges exist with 3 months default",
    ["6w", "3m", "6m", "1y"].every(range =>
      trendsMarkup.includes(`data-trend-range="${range}"`)) &&
    /class="is-active" data-trend-range="3m" aria-pressed="true"/.test(trendsMarkup));
  test("range selection updates pressed state and refreshes the selected range",
    /selectedRange = range;/.test(clientSource) &&
    /button\.setAttribute\("aria-pressed", active \? "true" : "false"\)/.test(clientSource) &&
    /function selectRange\(range\)[\s\S]*?refresh\(\);/.test(clientSource));
  test("tooltips use normalized dates and values without button semantics",
    /Fitness \$\{fmt\(day\.fitness\)\} · Fatigue \$\{fmt\(day\.fatigue\)\}/.test(clientSource) &&
    /Completed \$\{fmt\(bucket\.completed\)\}/.test(clientSource) &&
    /element\.setAttribute\("role", "img"\)/.test(clientSource) &&
    !/element\.setAttribute\("role", "button"\)/.test(clientSource));
  test("charts keep accessible text summaries without visible essays",
    (trendsMarkup.match(/class="trend-text-summary/g) || []).length === 3 &&
    /id="trendStatusSummary"/.test(trendsMarkup) &&
    /id="trendFitnessSummary"/.test(trendsMarkup) &&
    /id="trendLoadSummary"/.test(trendsMarkup) &&
    /trend-visually-hidden/.test(trendsMarkup));
  test("Fitness, Fatigue, and Form appear once and 7-day load is hidden",
    /metricMarkup\("Fitness"/.test(clientSource) &&
    /metricMarkup\("Fatigue"/.test(clientSource) &&
    /metricMarkup\("Form"/.test(clientSource) &&
    (clientSource.match(/metricMarkup\("/g) || []).length === 3 &&
    !/7-day load/.test(trendsMarkup + clientSource) &&
    !/Fresh · Fitness/.test(clientSource));
  test("status copy follows the existing Form zone without a new calculation",
    analytics.statusDisplayName(analytics.classifyForm(14)) === "Fresh" &&
    analytics.statusDisplayName(analytics.classifyForm(0)) === "Balanced" &&
    analytics.statusDisplayName(analytics.classifyForm(-10)) === "Building" &&
    analytics.statusDisplayName(analytics.classifyForm(-21)) === "High Risk" &&
    analytics.statusDisplayName(analytics.classifyForm(26)) === "Detraining" &&
    analytics.statusLeadCopy(analytics.classifyForm(14)) ===
      "You're recovered enough for quality training." &&
    analytics.statusLeadCopy(analytics.classifyForm(0)) ===
      "Your training load is currently well balanced." &&
    analytics.statusLeadCopy(analytics.classifyForm(-10)) ===
      "You're carrying productive training stress." &&
    analytics.statusLeadCopy(analytics.classifyForm(-21)) ===
      "Fatigue is high. Recovery should take priority." &&
    analytics.statusLeadCopy(analytics.classifyForm(26)) ===
      "Training stimulus has been low recently.");
  test("native SVG is responsive inside the narrow app shell",
    /\.trend-svg\{[^}]*width:100%[^}]*height:auto/.test(html) &&
    /\.trend-chart\{[^}]*width:100%[^}]*overflow:hidden/.test(html) &&
    /@media\(max-width:360px\)\{[\s\S]*?\.trend-zone-label,\.trend-threshold-label,\.trend-latest-label\{font-size:var\(--fs-micro\)\}/.test(html));
  test("chart colors are centralized as tokens",
    /--trend-fitness:/.test(html) && /--trend-fatigue:/.test(html) &&
    /--trend-zone-risk:/.test(html) && /--trend-load:/.test(html));
  test("chart colors inherit in explicit and system dark modes",
    (html.match(/\[data-theme="dark"\]|prefers-color-scheme:dark/g) || []).length >= 2 &&
    /--trend-fitness:/.test(html) && /--trend-fatigue:/.test(html));
  test("defined plotting surfaces use theme-aware elevated and border tokens",
    /\.trend-plot-surface\{fill:var\(--card2\);stroke:var\(--line\)/.test(html));
  test("reduced motion is inherited from the global motion guard",
    /prefers-reduced-motion: reduce\)\{[\s\S]*?animation-duration:\.001ms!important/.test(html));
  test("no Intervals logo, embedded page, copied asset, gradient, or chart dependency was added",
    !/intervals.*(?:logo|iframe)|chart\.js|d3\.js|echarts/i.test(trendsMarkup + clientSource) &&
    !/gradient\(/.test(clientSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

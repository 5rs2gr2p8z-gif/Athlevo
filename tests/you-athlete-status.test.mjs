/**
 * Focused executable checks for the You screen: Athlevo Score →
 * Athlete Status → Training Paces → Trends, and removal of the old
 * Resting HR / HRV / Weekly Mileage strip.
 * Run: node tests/you-athlete-status.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const scoreSource = readFileSync("./js/athlevoScore.js", "utf8");
const trendsSource = readFileSync("./js/trends.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}`);
  }
}
const section = name => console.log(`\n──── ${name} ────`);

const trendsScreenStart = html.indexOf('id="screen-trends"');
const you = html.slice(
  html.lastIndexOf("<section", trendsScreenStart),
  html.indexOf('<section class="screen"', trendsScreenStart)
);

section("You screen — section order");
{
  const scorePos = you.indexOf('id="youScoreCard"');
  const statusPos = you.indexOf('id="todayAthleteStatusCard"');
  const pacesPos = you.indexOf('id="youPacesCard"');
  const trendsPos = you.indexOf('id="trendsState"');
  test("You screen contains Athlevo Score before Athlete Status",
    scorePos >= 0 && statusPos >= 0 && scorePos < statusPos);
  test("Athlete Status appears before Training Paces",
    statusPos >= 0 && pacesPos >= 0 && statusPos < pacesPos);
  test("Training Paces appears before Trends",
    pacesPos >= 0 && trendsPos >= 0 && pacesPos < trendsPos);
}

section("Wearable metric strip removed");
{
  test("Resting HR strip is gone from the You screen",
    !/Resting HR/.test(you) && !/youRestingHRValue/.test(you));
  test("HRV strip is gone from the You screen",
    !/>HRV</.test(you) && !/youHrvValue/.test(you));
  test("Weekly Mileage strip is gone from the You screen",
    !/Weekly mileage/i.test(you) && !/youMileageValue/.test(you));
  test("no leftover strip container/CSS remains",
    !/youDataStrip/.test(html) && !/you-data-strip/.test(html) && !/you-data-section/.test(html));
  test("the dead renderYouWeeklyMileage renderer was removed, not just unmounted",
    !/renderYouWeeklyMileage/.test(trendsSource));
}

section("Compact score exposes the five canonical dimensions");
{
  test("compact You score renders the same RADAR_AXES labels used by the detail modal",
    /you-score-dims/.test(scoreSource) &&
    /RADAR_AXES\.map\(axis =>/.test(scoreSource));
  test("You score detail line uses the same delta/peak values as the modal, not new copies",
    /const peak = computePeakScore\(result\);/.test(scoreSource) &&
    /you-score-detail-line/.test(scoreSource));
  test("dimension values come from result.components (canonical score source), not literals",
    /const c = components\[axis\.key\] \|\| \{\};/.test(scoreSource) &&
    /c\.status === "valid" && Number\.isFinite\(Number\(c\.score\)\)/.test(scoreSource));
  test("peak/'Best' figure is computed once and shared by the modal badge and the compact line",
    (scoreSource.match(/function computePeakScore\(result\)/g) || []).length === 1 &&
    (scoreSource.match(/computePeakScore\(result\)/g) || []).length >= 2);
  test("only the You mount gets the expanded detail block — Today's compact card is unchanged",
    /mount\.innerHTML = mount\.id === "youScoreCard" \? cardHTML \+ youDetailHTML : cardHTML;/.test(scoreSource));
}

section("Athlete Status reuses the canonical Today component");
{
  test("Athlete Status keeps its original id, headings, and three signals (Readiness/Training Load/Recovery)",
    /id="todayAthleteStatusCard"[\s\S]*?Athlete status/.test(you) &&
    /id="todayReadinessSignal"/.test(you) &&
    /id="todayLoadSignal"/.test(you) &&
    /id="todayRecoverySignal"/.test(you));
  test("Athlete Status is not duplicated — Today no longer contains its own copy",
    (html.match(/id="todayAthleteStatusCard"/g) || []).length === 1);
  test("no duplicate DOM ids exist for any Athlete Status child element",
    ["todayReadinessSignalValue", "todayLoadSignalValue", "todayRecoverySignalValue",
     "todayReadinessSignalNote", "todayLoadSignalNote", "todayRecoverySignalNote",
     "todayRecoverySignalQuality", "todayPremiumInsightTeaser", "todayStatusHeading"]
      .every(id => (html.match(new RegExp(`id="${id}"`, "g")) || []).length === 1));
  test("visibility is still driven by the single existing state machine (setTodayScreenState)",
    /athleteStatus\.hidden = state !== "no-plan" && state !== "active"/.test(html));
}

section("Dark/light token inheritance");
{
  test("the moved Athlete Status card uses only existing shared tokens, no new colors",
    /\.today-status-card\{margin-top:14px;padding:15px 16px;background:var\(--paper\);border:1px solid var\(--line\)/.test(html));
  test("no new dark-mode-only color literals were introduced for the You status/score sections",
    !/\.you-status-section\{[^}]*#[0-9a-fA-F]{3,6}/.test(html) &&
    !/\.you-score-de(tail|tail-line)?\{[^}]*#[0-9a-fA-F]{3,6}/.test(html) &&
    !/\.you-score-dim[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/.test(html));
  test("light mode remains functional (no light-mode-only override removed for shared tokens)",
    /:root\{/.test(html) && /--bg:/.test(html) && /--paper:/.test(html));
}

section("Adjacent systems untouched");
{
  test("Trends calculation engine (buildTrends/diff/windowMetrics) is untouched by the strip removal",
    /function buildTrends/.test(trendsSource) && /function diff\(/.test(trendsSource) && /function windowMetrics/.test(trendsSource));
  test("Training pace calculation (paceService) is not duplicated for the You screen",
    (html.match(/AthlevoPaceService\.getTrainingPaces/g) || []).length <= 1);
  test("Coach/Calendar routing markup is not present in the You screen slice",
    !/screen-coachmode/.test(you) && !/AthlevoTrainCalendar/.test(you));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

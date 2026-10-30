/**
 * Focused executable checks for the You screen: Athlevo Score →
 * Training Paces → Trends (Athlete Status moved to Home), and removal of the
 * old Resting HR / HRV / Weekly Mileage strip.
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
const todayStart = html.indexOf('id="screen-today"');
const home = html.slice(
  html.lastIndexOf("<section", todayStart),
  html.indexOf('<section class="screen', todayStart + 20)
);

section("You screen — section order");
{
  const scorePos = you.indexOf('id="youScoreCard"');
  const pacesPos = you.indexOf('id="youPacesCard"');
  const trendsPos = you.indexOf('id="trendsState"');
  test("You screen contains Athlevo Score before Training Paces",
    scorePos >= 0 && pacesPos >= 0 && scorePos < pacesPos);
  test("Athlete Status is no longer on the You screen", !/todayAthleteStatusCard/.test(you) && !/home-status-section|you-status-section/.test(you));
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

section("Athlete Status lives on Home (same component, single mount)");
{
  test("Home holds Athlete Status with its original id, heading, and three signals (Readiness/Training Load/Recovery)",
    /id="todayAthleteStatusCard"[\s\S]*?Athlete status/.test(home) &&
    /id="todayReadinessSignal"/.test(home) &&
    /id="todayLoadSignal"/.test(home) &&
    /id="todayRecoverySignal"/.test(home));
  test("it sits after Today's training and before Next/Coach on Home",
    home.indexOf("todayActivePlanState") < home.indexOf('class="home-status-section"') &&
    home.indexOf('class="home-status-section"') < home.indexOf('id="homeNextCard"'));
  test("Athlete Status is not duplicated — exactly one mount in the whole app",
    (html.match(/id="todayAthleteStatusCard"/g) || []).length === 1);
  test("Home no longer renders the Training Paces card (it stays on You)",
    !/id="trainingPacesCard"/.test(home) && /id="youPacesCard"/.test(you));
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
  test("no new dark-mode-only color literals were introduced for the Home status / You score sections",
    !/\.home-status-section\{[^}]*#[0-9a-fA-F]{3,6}/.test(html) &&
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

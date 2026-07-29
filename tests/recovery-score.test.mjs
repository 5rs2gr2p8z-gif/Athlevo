/**
 * Executable Athlevo Recovery formula and data-availability checks.
 * Run: node tests/recovery-score.test.mjs
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("./js/recoveryScore.js", "utf8");
const context = { window: {} };
vm.runInNewContext(source, context);
const recovery = context.window.AthlevoRecovery;

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

console.log("\n──── Formula and full-data behavior ────");
test("documented nominal weights total 100%",
  recovery.WEIGHTS.readiness === 0.30 &&
  recovery.WEIGHTS.hrv === 0.25 &&
  recovery.WEIGHTS.restingHeartRate === 0.15 &&
  recovery.WEIGHTS.sleep === 0.20 &&
  recovery.WEIGHTS.body === 0.10);

const full = recovery.calculateRecovery({
  readinessScore: 80,
  hrv: 50,
  hrvBaseline: 50,
  restingHeartRate: 60,
  restingHeartRateBaseline: 60,
  sleepQuality: 4,
  soreness: 2,
  painPresent: false,
  acwr: 1
});
test("full-data Recovery uses the documented weighted formula",
  full.available === true &&
  full.score === 79 &&
  full.quality === "Full data" &&
  full.componentCount === 5);
test("HRV and resting-HR baseline transforms are deterministic",
  Math.round(recovery.hrvScore(50, 50)) === 80 &&
  Math.round(recovery.restingHeartRateScore(60, 60)) === 75);

console.log("\n──── Missing-data reweighting and minimum ────");
const reweighted = recovery.calculateRecovery({
  readinessScore: 80,
  sleepQuality: 5
});
test("missing inputs are omitted and available weights are normalized",
  reweighted.available === true &&
  reweighted.score === 88 &&
  reweighted.quality === "Limited data" &&
  reweighted.componentCount === 2);
test("reweighting does not treat three missing components as zero",
  reweighted.score > 80);
const insufficient = recovery.calculateRecovery({ readinessScore: 80 });
test("fewer than two valid inputs returns unavailable",
  recovery.MINIMUM_COMPONENTS === 2 &&
  insufficient.available === false &&
  insufficient.score === null &&
  insufficient.quality === "Limited data");

console.log("\n──── Conservative pain and load modifiers ────");
const pain = recovery.calculateRecovery({
  readinessScore: 95,
  sleepQuality: 5,
  soreness: 1,
  painPresent: true
});
test("reported pain caps an otherwise high Recovery at 39",
  pain.available === true &&
  pain.score === 39 &&
  pain.painCapped === true);
const highLoad = recovery.calculateRecovery({
  readinessScore: 80,
  hrv: 50,
  hrvBaseline: 50,
  restingHeartRate: 60,
  restingHeartRateBaseline: 60,
  sleepQuality: 4,
  soreness: 2,
  painPresent: false,
  acwr: 1.5
});
const elevatedLoad = recovery.calculateRecovery({
  readinessScore: 80,
  hrv: 50,
  hrvBaseline: 50,
  restingHeartRate: 60,
  restingHeartRateBaseline: 60,
  sleepQuality: 4,
  soreness: 2,
  painPresent: false,
  acwr: 1.3
});
test("high load is only the documented post-weight modifier",
  full.score === 79 &&
  elevatedLoad.score === 74 &&
  elevatedLoad.loadModifier === -5 &&
  highLoad.score === 69 &&
  highLoad.loadModifier === -10);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

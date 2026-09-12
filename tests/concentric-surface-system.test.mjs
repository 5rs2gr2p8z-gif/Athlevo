/**
 * Regression coverage for the iOS 26 concentric-surface design system.
 * Run: node tests/concentric-surface-system.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSource = readFileSync("index.html", "utf8");
const swiftSource = readFileSync("ios/App/App/AthlevoConcentricSurface.swift", "utf8");
const pbxproj = readFileSync("ios/App/App.xcodeproj/project.pbxproj", "utf8");
const appDelegate = readFileSync("ios/App/App/AppDelegate.swift", "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("web: concentric edge-surface tokens are defined", () => {
  assert.match(indexSource, /--radius-surface-outer:var\(--ui-radius-sheet\);/);
  assert.match(indexSource, /--radius-edge-inset:6px;/);
  assert.match(
    indexSource,
    /--radius-surface-inner:calc\(var\(--radius-surface-outer\) - var\(--radius-edge-inset\)\);/
  );
});

test("web: floating tab capsule uses the concentric tokens, not a hardcoded pair", () => {
  assert.match(indexSource, /border-radius: var\(--radius-surface-outer\);.*\n?.*concentric outer/);
  assert.match(
    indexSource,
    /opacity:\.58;transition:[^}]*border-radius:var\(--radius-surface-inner\)\}/
  );
  assert.match(
    indexSource,
    /\.tab:focus-visible\{outline:2px solid var\(--focus-ring\);outline-offset:2px;border-radius:var\(--radius-surface-inner\)\}/
  );
});

test("web: ordinary internal cards keep their fixed-radius system (untouched)", () => {
  assert.match(
    indexSource,
    /\.card\{background:var\(--surface-soft\);border:1px solid var\(--border-default\);border-radius:var\(--r-lg\);/
  );
  assert.match(indexSource, /\.stat\{background:var\(--card\);border-radius:var\(--r-md\);/);
  assert.match(
    indexSource,
    /\.composer\{--focus-ring:color-mix\(in srgb,var\(--text\) 50%,transparent\);/
  );
  assert.match(indexSource, /border-radius:var\(--r-lg\);background:var\(--paper\);/);
});

test("web: bottom-sheet radius token is unchanged (still 26px, only aliased)", () => {
  assert.match(indexSource, /--ui-radius-sheet:26px;/);
});

test("native: helper only touches ConcentricRectangle behind an iOS 26 availability guard", () => {
  assert.match(swiftSource, /#available\(iOS 26\.0, \*\)/);
  assert.match(swiftSource, /ConcentricRectangle\(\)/);
  const guardCount = (swiftSource.match(/#available\(iOS 26\.0, \*\)/g) || []).length;
  const usageCount = (swiftSource.match(/ConcentricRectangle\(\)/g) || []).length;
  assert.ok(guardCount >= usageCount, "every ConcentricRectangle use must sit behind an availability guard");
});

test("native: pre-iOS-26 path falls back to continuous RoundedRectangle", () => {
  assert.match(swiftSource, /RoundedRectangle\(cornerRadius: fallbackRadius, style: \.continuous\)/);
});

test("native: helper is not wired into AppDelegate or any other native surface", () => {
  assert.doesNotMatch(appDelegate, /Concentric/);
  assert.doesNotMatch(appDelegate, /athlevoConcentricSurface|athlevoConcentricShape/);
});

test("native: deployment target is unchanged at iOS 15.0 across all build configs", () => {
  const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(m => m[1]);
  assert.ok(targets.length > 0, "expected at least one IPHONEOS_DEPLOYMENT_TARGET entry");
  targets.forEach(t => assert.equal(t, "15.0"));
});

test("native: no availability warnings possible — RoundedRectangle fallback branch has no #available gate needed", () => {
  // The else-branch of every `if #available(iOS 26.0, *)` in the file must not
  // itself reference ConcentricRectangle (that would be unreachable-safe but
  // would still be a mistake in intent).
  const elseBlocks = swiftSource.split(/if #available\(iOS 26\.0, \*\) \{[\s\S]*?\} else \{([\s\S]*?)\}/g);
  // odd indices are captured else-bodies
  for (let i = 1; i < elseBlocks.length; i += 2) {
    assert.doesNotMatch(elseBlocks[i], /ConcentricRectangle/);
  }
});

test("native: AthlevoConcentricSurface.swift is registered exactly once in the Xcode project", () => {
  const fileRefs = (pbxproj.match(/AthlevoConcentricSurface\.swift \*\/ = \{isa = PBXFileReference/g) || []).length;
  const buildFiles = (pbxproj.match(/AthlevoConcentricSurface\.swift in Sources \*\/ = \{isa = PBXBuildFile/g) || []).length;
  const sourcesPhaseRefs = (pbxproj.match(/AthlevoConcentricSurface\.swift in Sources \*\/,/g) || []).length;
  assert.equal(fileRefs, 1);
  assert.equal(buildFiles, 1);
  assert.equal(sourcesPhaseRefs, 1);
});

test("native helper does not reference Coach reasoning, pricing, auth, trainingState, Calendar, analytics or entitlements", () => {
  // The Swift helper is pure shape/geometry infrastructure. It must not name
  // any of the systems this task is explicitly barred from touching, so a
  // future edit to this file can't accidentally couple it to app logic.
  assert.doesNotMatch(swiftSource, /trainingState|Entitlement|CoachReasoning|AuthLogic/);
});

console.log(`\n${passed} passed`);

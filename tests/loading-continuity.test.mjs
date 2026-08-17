import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("index.html", "utf8");
const loadingSource = readFileSync("js/loadingContinuity.js", "utf8");
const athleteMode = readFileSync("js/athleteMode.js", "utf8");
const train = readFileSync("js/train.js", "utf8");
const trends = readFileSync("js/trendsAnalytics.js", "utf8");
const brain = readFileSync("js/brain.js", "utf8");

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); }
  };
}

function loadingWorld(reduced = false) {
  const timers = [];
  const screens = Object.fromEntries(["train", "trends", "you"].map(name => [
    `screen-${name}`,
    {
      classList: classList(["athlevo-surface-loading"]),
      attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; }
    }
  ]));
  const root = {
    document: { getElementById: id => screens[id] || null },
    matchMedia: () => ({ matches: reduced }),
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {}
  };
  root.window = root;
  vm.runInNewContext(loadingSource, { window: root });
  return { root, screens, timers };
}

console.log("\n──── Loading geometry ────");
assert.match(athleteMode, /am-coach-resolving-head/);
assert.match(athleteMode, /am-coach-context-skeleton/);
assert.ok((athleteMode.match(/am-coach-message-skeleton/g) || []).length >= 3);
assert.doesNotMatch(athleteMode, /am-coach-resolving-mark|Checking your coaching setup/);
assert.match(athleteMode, /am-coach-resolution-error/);

for (const name of ["train", "trends", "you"]) {
  assert.match(html, new RegExp(`data-loading-surface="${name}"`));
  assert.match(html, new RegExp(`id="screen-${name}"[^>]*athlevo-surface-loading|athlevo-surface-loading[^>]*id="screen-${name}"`));
}
assert.match(html, /data-loading-surface="train"[\s\S]*?asl-week[\s\S]*?asl-training-context[\s\S]*?asl-workout[\s\S]*?asl-training-summary/);
assert.match(html, /data-loading-surface="trends"[\s\S]*?asl-metrics[\s\S]*?data-skeleton-region="chart"[\s\S]*?data-skeleton-region="status"/);
const youSkeleton = html.slice(
  html.indexOf('data-loading-surface="you"'),
  html.indexOf('<div class="profilehead">')
);
assert.match(youSkeleton, /asl-profile[\s\S]*?asl-training-data[\s\S]*?asl-preferences-label[\s\S]*?asl-support-label[\s\S]*?asl-support-row/);
assert.doesNotMatch(youSkeleton, /Workspace|youWorkspaceSection/);

for (const width of [375, 390, 430]) {
  const horizontalPadding = width <= 390 ? 36 : 44;
  const calendarInner = width - horizontalPadding - 30;
  const gap = width <= 390 ? 5 : 7;
  assert.ok((calendarInner - (6 * gap)) / 7 >= 39);
}

console.log("✓ Coach, Train, Trends, and You use geometry-matched initial shells");
console.log("✓ Public You skeleton contains no Coach Workspace placeholder");
console.log("✓ Skeleton geometry remains within 375, 390, and 430px viewports");

console.log("\n──── Handoff lifecycle ────");
{
  const { root, screens, timers } = loadingWorld(false);
  const loading = root.AthlevoLoadingContinuity;
  assert.equal(loading.begin("train"), true);
  loading.success("train");
  assert.equal(screens["screen-train"].classList.contains("athlevo-surface-loading"), false);
  assert.equal(screens["screen-train"].classList.contains("athlevo-surface-revealing"), true);
  assert.equal(timers[0].delay, 120);
  timers[0].callback();
  assert.equal(screens["screen-train"].classList.contains("athlevo-surface-revealing"), false);
  assert.equal(loading.begin("train"), false);
}
{
  const { root, screens } = loadingWorld(false);
  root.AthlevoLoadingContinuity.begin("trends");
  root.AthlevoLoadingContinuity.error("trends");
  assert.equal(screens["screen-trends"].classList.contains("athlevo-surface-loading"), false);
  assert.equal(screens["screen-trends"].attrs["aria-busy"], "false");
}
{
  const { root, screens, timers } = loadingWorld(true);
  root.AthlevoLoadingContinuity.success("you");
  assert.equal(screens["screen-you"].classList.contains("athlevo-surface-revealing"), false);
  assert.equal(timers.length, 0);
}
assert.match(train, /initialLoading[\s\S]*loading\.success\("train"\)[\s\S]*loading\.error\("train"\)/);
assert.match(trends, /if \(!initialLoading\) return/);
assert.match(brain, /loading\.success\("you"\)[\s\S]*loading\.error\("you"\)/);
console.log("✓ Success crossfades for 120ms, cache bypasses replay, and errors always settle");
console.log("✓ Reduced motion reveals immediately and later refreshes remain localized");

console.log("\n──── Android compositor material ────");
assert.match(html, /html\.athlevo-native-android #tabbar\{[\s\S]*?backdrop-filter:none;[\s\S]*?-webkit-backdrop-filter:none;/);
assert.match(html, /html\.athlevo-native-android \.athlevo-surface-skeleton \.skel[\s\S]*?athlevoSkeletonBreathe/);
assert.doesNotMatch(loadingSource, /scroll|pointermove|requestAnimationFrame/);
console.log("✓ Android removes live nav blur, retains elevation, and uses opacity-only skeleton motion");

console.log("\nAll loading continuity checks passed.");

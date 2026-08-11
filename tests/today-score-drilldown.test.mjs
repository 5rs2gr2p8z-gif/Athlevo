/**
 * Executable UI contract for the compact Today Athlevo Score drill-down.
 * Run: node tests/today-score-drilldown.test.mjs
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const source = readFileSync("./js/athlevoScore.js", "utf8");

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

function makeClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); }
  };
}

const mount = {
  innerHTML: "",
  querySelector() { return null; }
};
let sheetFocused = 0;
let triggerFocused = 0;
const attributes = new Map();
const modal = {
  innerHTML: "",
  classList: makeClassList(),
  setAttribute(name, value) { attributes.set(name, value); },
  querySelector(selector) {
    if (selector !== ".scd") return null;
    return { focus() { sheetFocused += 1; } };
  }
};
const body = { classList: makeClassList() };
let keydownHandler = null;
const document = {
  body,
  activeElement: { focus() { triggerFocused += 1; } },
  getElementById(id) {
    if (id === "athlevoScoreCard") return mount;
    if (id === "scoreDetailModal") return modal;
    return null;
  },
  addEventListener(type, handler) {
    if (type === "keydown") keydownHandler = handler;
  }
};
const root = {
  localStorage: {
    getItem() { return null; },
    setItem() {}
  },
  matchMedia() { return { matches: false }; }
};
root.window = root;
vm.runInNewContext(source, {
  window: root,
  document,
  console,
  performance: { now: () => 0 },
  requestAnimationFrame() {}
});

const component = (key, label, score) => ({
  key,
  label,
  score,
  status: "valid",
  coverage: "Strong data",
  explanation: `${label} explanation`
});
const result = {
  overall: {
    status: "valid",
    score: 64,
    dataQuality: "Strong data",
    explanation: "Your long-term development is stable.",
    change: 0,
    changeReasons: []
  },
  components: {
    aerobic: component("aerobic", "Aerobic", 68),
    threshold: component("threshold", "Threshold", 61),
    speed: component("speed", "Speed / Top-End", 58),
    durability: component("durability", "Durability", 66),
    consistency: component("consistency", "Consistency", 70),
    level: component("level", "Current Running Level", 63)
  },
  strengths: ["Consistency"],
  limiter: "Speed / Top-End",
  dataNeeded: []
};

console.log("\n──── Compact Today placement ────");
const todayStart = html.indexOf('<section class="screen" id="screen-today">');
const todayEnd = html.indexOf('<section class="screen"', todayStart + 1);
const today = html.slice(todayStart, todayEnd);
test("score mount is in the Today header, before primary training state",
  /<header class="today-header">[\s\S]*?id="athlevoScoreCard"[\s\S]*?id="todayPlanLoadingState"/.test(today));
test("Today contains only one score mount", (today.match(/id="athlevoScoreCard"/g) || []).length === 1);
test("tile is 104 by 84px and narrows safely on the smallest phones",
  /\.today-score-mount\{width:104px;height:84px/.test(html) &&
  /\.asc-compact\{[\s\S]*?width:104px;height:84px/.test(html) &&
  /@media \(max-width:380px\)[\s\S]*?\.today-score-mount,\.asc-compact\{width:96px\}/.test(html));
test("header grid and long-name copy cannot cause horizontal overflow",
  /\.today-header\{[^}]*grid-template-columns:minmax\(0,1fr\) 104px[^}]*min-width:0/.test(html) &&
  /\.today-header-copy\{min-width:0\}/.test(html) &&
  /\.today-header \.greet h1\{overflow-wrap:anywhere\}/.test(html) &&
  [375, 390, 430].every(width => {
    const compact = width <= 380;
    return width - 44 - (compact ? 96 : 104) - (compact ? 10 : 14) > 0;
  }));

console.log("\n──── Paid summary and full drill-down ────");
root.AthlevoScore.renderScoreCard(result);
test("compact tile shows label, current score, trend and a five-point preview",
  /Athlevo Score/.test(mount.innerHTML) &&
  /asc-compact-score[^>]*>64</.test(mount.innerHTML) &&
  /Building baseline/.test(mount.innerHTML) &&
  /asc-mini-area/.test(mount.innerHTML));
test("compact tile omits the full dimension list and explanation",
  !/asc-crow|Aerobic|Threshold|Your long-term development/.test(mount.innerHTML));
test("tile is an accessible dialog affordance",
  /type="button"/.test(mount.innerHTML) &&
  /aria-haspopup="dialog"/.test(mount.innerHTML) &&
  /aria-controls="scoreDetailModal"/.test(mount.innerHTML));

root.AthlevoScore.openDetails();
test("open renders the full score, trend, radar and every existing dimension",
  modal.classList.contains("show") &&
  /role="dialog"/.test(modal.innerHTML) &&
  /Long-term development/.test(modal.innerHTML) &&
  /Building baseline/.test(modal.innerHTML) &&
  /asc-radar/.test(modal.innerHTML) &&
  ["Aerobic", "Threshold", "Speed / Top-End", "Durability", "Consistency", "Current Running Level"]
    .every(label => modal.innerHTML.includes(label)));
test("sheet has a drag handle, close control and truthful explanation",
  /scd-handle/.test(modal.innerHTML) &&
  /aria-label="Close"/.test(modal.innerHTML) &&
  /Your long-term development is stable\./.test(modal.innerHTML));
test("opening exposes the dialog, focuses it and locks body scroll",
  attributes.get("aria-hidden") === "false" && sheetFocused === 1 &&
  body.classList.contains("score-detail-open") &&
  /body\.score-detail-open \.screen\.active\{overflow:hidden\}/.test(html));

keydownHandler({ key: "Escape" });
test("Escape closes, restores trigger focus and unlocks body scroll",
  !modal.classList.contains("show") && attributes.get("aria-hidden") === "true" &&
  !body.classList.contains("score-detail-open") && triggerFocused === 1);
test("backdrop is wired to close only from the backdrop itself",
  /id="scoreDetailModal"[\s\S]*?onclick="if\(event\.target===this\)AthlevoScore\.closeDetails\(\)"/.test(html));

console.log("\n──── Missing data and responsive motion ────");
const missing = {
  ...result,
  overall: { ...result.overall, status: "building", score: null, dataQuality: "Limited data" },
  components: Object.fromEntries(Object.entries(result.components).map(([key, value]) => [
    key,
    { ...value, status: "building", score: null, coverage: "Limited data" }
  ]))
};
root.AthlevoScore.renderScoreCard(missing);
test("missing score is represented honestly without a fabricated number",
  /asc-compact-score[^>]*>—</.test(mount.innerHTML) && /Building baseline/.test(mount.innerHTML));
test("mobile sheet and centered desktop modal share the existing overlay",
  /\.scd\{[^}]*max-height:88vh/.test(html) &&
  /@media \(min-width:700px\)[\s\S]*?#scoreDetailModal\{align-items:center;justify-content:center/.test(html));
test("entrance stays within 220–300ms and reduced motion removes it",
  /animation:scoreSheetIn 260ms/.test(html) &&
  /@media \(prefers-reduced-motion:reduce\)[\s\S]*?\.scd\{animation:none\}/.test(html));
test("keyboard handling includes Escape and an in-dialog focus loop",
  /event\.key === "Escape"/.test(source) &&
  /event\.key !== "Tab"/.test(source) &&
  /button:not\(\[disabled\]\),a\[href\],summary/.test(source));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

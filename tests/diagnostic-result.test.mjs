/*
 * Compact diagnostic result card + grounded limiter/feasibility copy.
 * Run: node tests/diagnostic-result.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const engineSrc = readFileSync("./js/diagnostic.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");
const chatSrc = readFileSync("./lib/server/diagnosticChatEndpoint.js", "utf8");

function loadEngine() {
  const values = new Map();
  const context = {
    console: { log() {}, warn() {} }, Date, Math, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSrc, context);
  return context.AthlevoDiagnostic;
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function completeWith(answers) {
  const Engine = loadEngine();
  const engine = Engine.create();
  engine.begin();
  for (const [key, value] of Object.entries(answers)) {
    engine.recordAnswer(key, value);
  }
  return engine.complete();
}

function diagnosisText(result) {
  return [
    result.primaryLimiter && result.primaryLimiter.label,
    result.primaryLimiter && result.primaryLimiter.explanation,
    result.holdingBack,
    (result.whatWedChange || []).join(" "),
    result.feasibility && result.feasibility.label,
    result.feasibility && result.feasibility.explanation
  ].filter(Boolean).join(" ");
}

const LONG_RUN_TOO_SHORT = /long runs aren't long enough|aren't long enough|inadequate long-run|mileage is too low|volume is still light|long runs that aren't/i;

{
  assert.doesNotMatch(uiSrc, /Analysing your running profile/);
  assert.doesNotMatch(uiSrc, /Identifying your primary limiter/);
  assert.doesNotMatch(uiSrc, /Assessing goal feasibility/);
  assert.doesNotMatch(uiSrc, /Building your coaching strategy/);
  assert.doesNotMatch(uiSrc, /Here’s what I’m seeing/);
  assert.doesNotMatch(uiSrc, /Okay — I have enough to work with/);
  assert.doesNotMatch(uiSrc, /Okay — I see the main issue/);
  assert.doesNotMatch(uiSrc, /I analyzed your profile/);
  assert.doesNotMatch(uiSrc, /Based on my analysis/);
  assert.doesNotMatch(uiSrc, /ensureVerdictMessage/);
  assert.doesNotMatch(uiSrc, /chat-msg-verdict/);
}

{
  const build = uiSrc.slice(
    uiSrc.indexOf("async function showBuildAnimation"),
    uiSrc.indexOf("function renderResult")
  );
  assert.match(build, /appendTypingIndicator/);
  assert.match(build, /RESULT_THINK_DELAY/);
  assert.match(uiSrc, /chat-typing-dots/);
  assert.doesNotMatch(build, /appendAthlevoMsg\(thread, lines/);
  assert.match(build, /removeTypingIndicator\(\);\s*renderResult\(\)/);
}

{
  const render = uiSrc.slice(
    uiSrc.indexOf("function renderResult"),
    uiSrc.indexOf("function updateProgress")
  );
  assert.match(render, /chat-result-card/);
  assert.equal((render.match(/chat-result-card/g) || []).length, 1);
  assert.match(render, /if \(thread\.querySelector\("\.chat-msg-result"\)\) return;/);
  assert.doesNotMatch(render, /Your running profile/);
  assert.doesNotMatch(render, /What’s holding you back/);
  assert.doesNotMatch(render, /How Athlevo would coach you/);
  assert.doesNotMatch(render, /Goal feasibility/);
  assert.doesNotMatch(render, /What we’d change/);
  assert.doesNotMatch(render, /chat-result-cap/);
  assert.doesNotMatch(render, /chat-result-caps/);
  assert.doesNotMatch(render, /chat-msg-cta/);
  assert.match(render, /What I’d change/);
  assert.match(render, /Your diagnosis/i);
  assert.match(render, /Train with Athlevo AI/);
  assert.match(render, /id="diagCTA"/);
  assert.match(render, /Start my training — ₱597\/month/);
  assert.match(render, /openAiSignup\(\)/);
  assert.doesNotMatch(render, /\.checkout\(/);
  assert.match(render, /chat-cta-annual/);
  assert.doesNotMatch(render, /<a[^>]*chat-cta-annual/);
  assert.doesNotMatch(render, /<button[^>]*chat-cta-annual/);
  assert.doesNotMatch(render, /Your diagnostic is saved/);
  assert.doesNotMatch(render, /modelReasoning/);
}

{
  assert.doesNotMatch(indexSrc, /chat-result-cap/);
  assert.doesNotMatch(indexSrc, /chat-result-section/);
  assert.match(indexSrc, /content:"→"/);
  assert.match(chatSrc, /Volume ≠ specificity/);
  assert.match(engineSrc, /longRunIsAdequateForGoal/);
  assert.match(engineSrc, /function classifyDiagnosis/);
  assert.match(engineSrc, /Not enough data yet/);
  assert.doesNotMatch(engineSrc, /Requires reassessment/);
}

const SPECIFIC_KEYS = new Set([
  "race_specific_endurance", "pacing_durability", "specificity_gap",
  "intensity_distribution", "recovery_fatigue", "aerobic_base",
  "volume_progression", "consistency", "timeline_mismatch",
  "race_execution", "threshold_development", "injury_management",
  "running_durability"
]);

{
  const result = completeWith({
    goal: { goal_distance: "Marathon" },
    race_details: {
      goal_race: "Pampanga Marathon",
      goal_race_date: isoDaysFromNow(15),
      goal_time: "Sub-4"
    },
    experience: { experience: "3_5_years" },
    training_status: { training_status: "training_block" },
    weekly_volume: { weekly_mileage: "90", weekly_hours: "8" },
    current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "26" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 5 },
    training_structure: { training_structure: "easy_long" },
    perceived_limiter: { perceived_limiter: "endurance" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  const text = diagnosisText(result);
  const key = result.primaryLimiter && result.primaryLimiter.key;
  assert.ok(["race_specific_endurance", "pacing_durability", "specificity_gap"].includes(key), "high-volume fade should be specificity/pacing, got " + key);
  assert.notEqual(key, "training_structure");
  assert.doesNotMatch(text, LONG_RUN_TOO_SHORT);
  assert.doesNotMatch(text, /too low|isn't yet developed enough|need more consistent easy work|grow the long run/i);
  assert.match(result.primaryLimiter.explanation, /race-specific|pacing|specificity/i);
  assert.match(result.whatWedChange.join(" "), /pace|pacing|fueling|threshold|long run/i);
  assert.doesNotMatch(result.whatWedChange.join(" "), /Give each week a simple hard\/easy rhythm/);
  assert.equal(result.whatWedChange.length, 3);
  assert.ok(
    result.feasibility.rating === "insufficient_data" || result.feasibility.rating === "reassess",
    "missing race marker should not pretend certainty, got " + result.feasibility.rating
  );
}

{
  const result = completeWith({
    goal: { goal_distance: "Marathon" },
    race_details: {
      goal_race: "Pampanga Marathon",
      goal_race_date: isoDaysFromNow(15),
      goal_time: "Sub-4"
    },
    experience: { experience: "3_5_years" },
    training_status: { training_status: "training_block" },
    weekly_volume: { weekly_mileage: "90", weekly_hours: "8" },
    current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "26" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 5 },
    training_structure: { training_structure: "easy_long" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  const key = result.primaryLimiter && result.primaryLimiter.key;
  assert.notEqual(key, "training_structure", "skipped fade question must not collapse to training structure");
  assert.ok(SPECIFIC_KEYS.has(key), "got " + key);
}

{
  const result = completeWith({
    goal: { goal_distance: "Marathon" },
    race_details: {
      goal_race: "City Marathon",
      goal_race_date: isoDaysFromNow(28),
      goal_time: "4:30"
    },
    experience: { experience: "1_2_years" },
    training_status: { training_status: "building_base" },
    weekly_volume: { weekly_mileage: "20", weekly_hours: "3" },
    current_capacity: { recent_consistency: "occasional", recent_longest_run_km: "8" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 3 },
    training_structure: { training_structure: "easy_long" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  const text = diagnosisText(result);
  const key = result.primaryLimiter && result.primaryLimiter.key;
  assert.ok(["timeline_mismatch", "aerobic_base", "volume_progression"].includes(key), "low-volume marathon soon, got " + key);
  assert.match(text, /volume|endurance|long run|timeline|durability/i);
  assert.equal(result.whatWedChange.length, 3);
  assert.doesNotMatch(result.whatWedChange.join(" "), /marathon-pace segments late/);
}

{
  const result = completeWith({
    goal: { goal_distance: "Marathon" },
    race_details: {
      goal_race: "City Marathon",
      goal_race_date: "2027-04-01",
      goal_time: "Sub-4"
    },
    experience: { experience: "3_5_years" },
    training_status: { training_status: "training_block" },
    weekly_volume: { weekly_mileage: "90", weekly_hours: "8" },
    current_capacity: { recent_consistency: "consistent", recent_longest_run_km: "26" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 5 },
    training_structure: { training_structure: "balanced_quality" },
    perceived_limiter: { perceived_limiter: "endurance" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  assert.equal(result.feasibility.rating, "insufficient_data");
  assert.equal(result.feasibility.label, "Not enough data yet");
  assert.match(result.feasibility.explanation, /wouldn't lock|wouldn’t lock|recent race/i);
  assert.doesNotMatch(diagnosisText(result), LONG_RUN_TOO_SHORT);
}

{
  const result = completeWith({
    goal: { goal_distance: "Half marathon" },
    race_details: { goal_race: "City Half", goal_race_date: "2027-03-01", goal_time: "1:40" },
    experience: { experience: "3_5_years" },
    training_status: { training_status: "training_block" },
    weekly_volume: { weekly_mileage: "75", weekly_hours: "8" },
    current_capacity: { recent_consistency: "consistent", recent_longest_run_km: "20" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 6 },
    training_structure: { training_structure: "balanced_quality" },
    perceived_limiter: { perceived_limiter: "muscular" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  const key = result.primaryLimiter && result.primaryLimiter.key;
  assert.ok(["intensity_distribution", "recovery_fatigue"].includes(key), "dense quality should be intensity/recovery, got " + key);
  assert.match(result.whatWedChange.join(" "), /hard|easy|quality|fatigue/i);
  assert.notEqual(key, "training_structure");
}

{
  const result = completeWith({
    goal: { goal_distance: "10K" },
    race_details: { goal_race: "First 10K", goal_race_date: "2027-04-01", goal_time: "" },
    experience: { experience: "new" },
    training_status: { training_status: "starting" },
    weekly_volume: { weekly_mileage: "18", weekly_hours: "3" },
    current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "6" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 3 },
    training_structure: { training_structure: "mostly_easy" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  const key = result.primaryLimiter && result.primaryLimiter.key;
  assert.ok(["aerobic_base", "consistency"].includes(key), "beginner 10K should be base/consistency, got " + key);
  assert.doesNotMatch(result.whatWedChange.join(" "), /marathon-pace|threshold work controlled rather than stacking/);
  assert.match(result.whatWedChange.join(" "), /frequency|easy|repeat/i);
}

{
  const result = completeWith({
    goal: { goal_distance: "10K" },
    race_details: {
      goal_race: "City 10K",
      goal_race_date: "2027-06-01",
      goal_time: "42:00"
    },
    experience: { experience: "5_plus" },
    training_status: { training_status: "training_block" },
    weekly_volume: { weekly_mileage: "55", weekly_hours: "6" },
    current_capacity: { recent_consistency: "consistent", recent_longest_run_km: "16" },
    recent_performance: { recent_race_dist: "10K", recent_race_time: "44:00" },
    training_days: { training_days: 5 },
    training_structure: { training_structure: "balanced_quality" },
    injury_status: { injury_has: "none", injury_area: "" }
  });
  assert.ok(
    result.feasibility.rating === "realistic" || result.feasibility.rating === "realistic_structured",
    "strong baseline should look realistic, got " + result.feasibility.rating
  );
  assert.equal(result.feasibility.label, "Looks realistic");
  const key = result.primaryLimiter && result.primaryLimiter.key;
  assert.ok(["race_execution", "threshold_development", "specificity_gap"].includes(key), "got " + key);
  assert.match(result.whatWedChange.join(" "), /pace|execution|easy|threshold|specific/i);
  assert.doesNotMatch(result.whatWedChange.join(" "), /Give each week a simple hard\/easy rhythm/);
}

{
  const result = completeWith({
    goal: { goal_distance: "Marathon" },
    race_details: { goal_race: "Race", goal_race_date: "2027-04-01", goal_time: "4:00" },
    experience: { experience: "3_5_years" },
    training_status: { training_status: "training_block" },
    weekly_volume: { weekly_mileage: "70", weekly_hours: "7" },
    current_capacity: { recent_consistency: "consistent", recent_longest_run_km: "24" },
    recent_performance: { recent_race_dist: "none" },
    training_days: { training_days: 5 },
    training_structure: { training_structure: "easy_long" },
    injury_status: { injury_has: "significant", injury_area: "Achilles" }
  });
  assert.equal(result.primaryLimiter && result.primaryLimiter.key, "injury_management");
  assert.equal(result.feasibility.rating, "not_advisable");
  assert.equal(result.athlevoRecommendation.safetyOverride, true);
}

function makeNode(tag, registry) {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    style: {},
    children: [],
    attributes: {},
    disabled: false,
    value: "",
    innerHTML: "",
    textContent: "",
    parentNode: null,
    content: { firstElementChild: null },
    classList: {
      add(name) {
        const parts = node.className.split(/\s+/).filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        node.className = parts.join(" ");
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter(c => c && c !== name).join(" ");
      },
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      }
    },
    setAttribute(k, v) {
      node.attributes[k] = String(v);
      if (k === "id") {
        node.id = String(v);
        registry.set(node.id, node);
      }
    },
    getAttribute(k) { return node.attributes[k]; },
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
      if (child.id) registry.set(child.id, child);
      return child;
    },
    querySelector(sel) {
      if (sel === ".chat-thread") return registry.get("chatThread") || null;
      if (sel && sel.startsWith("#")) return registry.get(sel.slice(1)) || null;
      if (sel && sel.startsWith(".")) {
        const cls = sel.slice(1).split(/[.\s]/)[0];
        const stack = [...(node.children || [])];
        if (node.className.split(/\s+/).includes(cls)) return node;
        while (stack.length) {
          const cur = stack.pop();
          if (cur.className && cur.className.split(/\s+/).includes(cls)) return cur;
          (cur.children || []).forEach(c => stack.push(c));
        }
      }
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    scrollTo() {},
    remove() {
      if (node.id) registry.delete(node.id);
      if (node.parentNode) {
        node.parentNode.children = node.parentNode.children.filter(c => c !== node);
      }
    },
    animate() {}
  };
  Object.defineProperty(node, "firstElementChild", {
    get() { return node.children[0] || node.content.firstElementChild || null; }
  });
  return node;
}

function parseHtml(html, registry) {
  const node = makeNode("div", registry);
  const id = (html.match(/\sid="([^"]+)"/) || [])[1];
  const cls = (html.match(/\sclass="([^"]+)"/) || [])[1];
  if (id) {
    node.id = id;
    registry.set(id, node);
  }
  if (cls) node.className = cls;
  node.innerHTML = html;
  node.textContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return node;
}

{
  const registry = new Map();
  const storage = new Map();
  const document = {
    readyState: "complete",
    getElementById: id => registry.get(id) || null,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) {
      const el = makeNode(tag, registry);
      if (String(tag).toLowerCase() === "template") {
        Object.defineProperty(el, "innerHTML", {
          set(html) {
            el._html = html;
            el.content = { firstElementChild: parseHtml(html, registry) };
          },
          get() { return el._html; }
        });
      } else {
        Object.defineProperty(el, "textContent", {
          set(v) {
            el._text = String(v);
            el.innerHTML = String(v);
          },
          get() { return el._text || ""; }
        });
      }
      return el;
    }
  };
  const body = makeNode("div", registry);
  body.id = "diagBody";
  registry.set("diagBody", body);
  const thread = makeNode("div", registry);
  thread.id = "chatThread";
  thread.className = "chat-thread";
  registry.set("chatThread", thread);
  body.appendChild(thread);
  ["chatQuickReplies", "chatComposer", "chatInput", "chatSend", "diagBack", "diagProgress"].forEach(id => {
    const el = makeNode(id === "chatInput" ? "input" : "div", registry);
    el.id = id;
    registry.set(id, el);
  });

  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Uint8Array, Promise,
    crypto: globalThis.crypto,
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document,
    location: { pathname: "/ai" }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSrc, context, { filename: "diagnostic.js" });
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context, { filename: "diagnosticSalesEngine.js" });
  vm.runInContext(uiSrc, context, { filename: "diagnosticUI.js" });

  const Engine = context.AthlevoDiagnostic;
  const UI = context.AthlevoDiagnosticUI;
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  engine.recordAnswer("injury_status", { injury_has: "none", injury_area: "" });
  engine.complete();
  UI._internal.bindEngine(engine);
  UI._internal.renderResult();
  UI._internal.renderResult({ restored: true });
  const cards = thread.children.filter(child =>
    (child.className || "").split(/\s+/).includes("chat-msg-result")
  );
  const verdicts = thread.children.filter(child =>
    (child.className || "").split(/\s+/).includes("chat-msg-verdict") ||
    /Okay — I see the main issue/.test(child.textContent || "")
  );
  assert.equal(cards.length, 1, "restore/refresh must not duplicate the result card");
  assert.equal(verdicts.length, 0, "result must not include a transition bubble");
  assert.match(cards[0].textContent, /Train with Athlevo AI/);
  assert.match(cards[0].textContent, /₱5,498\/year/);
  assert.doesNotMatch(cards[0].textContent, /Your running profile|Primary limiter|How Athlevo would coach you/);
}

console.log("diagnostic-result.test.mjs ok");

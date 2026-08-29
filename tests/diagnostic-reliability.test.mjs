/*
 * Production-hardening regressions for the /ai diagnostic:
 * dead-state recovery, composer busy/timeout, and asset version sync.
 * Run: node tests/diagnostic-reliability.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const engineSrc = readFileSync("./js/diagnostic.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");
const metaSrc = readFileSync("./js/metaPixel.js", "utf8");
const registrySrc = readFileSync("./js/analyticsRegistry.js", "utf8");

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

function load() {
  const registry = new Map();
  const storage = new Map();
  const events = [];
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
  ["chatQuickReplies", "chatComposer", "chatInput", "chatSend"].forEach(id => {
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
  context.AthlevoProductAnalytics = {
    trackAthlevoEvent(name) { events.push(name); },
    attributionProps() { return {}; },
    landingProps() { return {}; }
  };
  context.AthlevoAnalytics = {
    track(name) { events.push(name); }
  };
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context, { filename: "diagnostic.js" });
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context, { filename: "diagnosticSalesEngine.js" });
  vm.runInContext(readFileSync("./js/diagnosticUI.js", "utf8"), context, { filename: "diagnosticUI.js" });
  return { ctx: context, UI: context.AthlevoDiagnosticUI, Engine: context.AthlevoDiagnostic, events, registry };
}

function threadText(registry) {
  const thread = registry.get("chatThread");
  return (thread.children || []).map(child => child.textContent || "").join(" | ");
}

{
  const advance = uiSrc.slice(
    uiSrc.indexOf("async function advanceFlow"),
    uiSrc.indexOf("function recoverContinuationQuestion")
  );
  assert.match(advance, /failOpenDeadDiagnostic/);
  assert.match(advance, /recoveredKeys/);
  assert.doesNotMatch(advance, /if \(!next\) return;/);
  assert.match(uiSrc, /DEAD_STATE_MESSAGE/);
  assert.match(uiSrc, /I still need a bit more to continue/);
}

{
  assert.match(uiSrc, /function setDiagnosticBusy/);
  assert.match(uiSrc, /send\.disabled = busy/);
  assert.match(uiSrc, /aria-busy/);
  assert.match(uiSrc, /Athlevo is responding/);
  assert.doesNotMatch(uiSrc, /chat-typing-label/);
  assert.match(uiSrc, /aria-label="Athlevo is responding"/);
  assert.match(uiSrc, /if \(e\.key === "Enter" && !e\.shiftKey\) \{[\s\S]*?if \(busy\) return;[\s\S]*?handleComposerSend\(\);/);
  assert.match(uiSrc, /send\.addEventListener\("click", function \(\) \{\s*if \(busy\) return;\s*handleComposerSend\(\);/);
  assert.match(uiSrc, /if \(thread\) appendUserMsg\(thread, val\);/);
}

{
  const files = [
    "js/diagnostic.js",
    "js/diagnosticSalesEngine.js",
    "js/diagnosticUI.js",
    "js/diagnosticHandoff.js",
    "js/diagnosticAcquisition.js"
  ];
  const versions = files.map(file => {
    const match = indexSrc.match(new RegExp(`${file.replace(/\./g, "\\.")}\\?v=(\\d+)`));
    assert.ok(match, `${file} must be cache-busted in index.html`);
    return match[1];
  });
  assert.equal(new Set(versions).size, 1, "tightly coupled diagnostic assets must share one version");
  assert.notEqual(versions[0], "1", "diagnostic modules must not remain on the stale v=1 cache key");
}

{
  assert.match(registrySrc, /ai_landing_viewed:/);
  assert.match(registrySrc, /diagnostic_started:/);
  assert.match(registrySrc, /diagnostic_completed:/);
  assert.match(uiSrc, /trackEvent\("diagnostic_completed"/);
  assert.match(metaSrc, /ai_landing_viewed:\s*\{\s*event:\s*"ViewContent"/);
  assert.match(metaSrc, /diagnostic_completed:\s*\{\s*event:\s*"Lead"/);
  assert.doesNotMatch(uiSrc, /failOpenDeadDiagnostic[\s\S]{0,400}diagnostic_completed/);
  assert.doesNotMatch(engineSrc, /recoverContinuationQuestion[\s\S]{0,200}this\.complete\(/);
}

{
  const { ctx, UI, Engine, events, registry } = load();
  const questions = Engine.getQuestions();
  const engine = new Engine();
  engine.begin();
  engine.history = questions.map(q => q.key);
  assert.equal(engine.nextQuestion(), null);
  assert.equal(engine.canComplete(), false);
  const recovered = engine.recoverContinuationQuestion();
  assert.equal(recovered && recovered.key, "injury_status");

  UI._internal.bindEngine(engine);
  engine.nextQuestion = () => null;
  engine.canComplete = () => false;
  engine.recoverContinuationQuestion = () => Engine.getQuestion("injury_status");
  let completed = false;
  engine.complete = () => {
    completed = true;
    return { profile: {}, version: 1 };
  };
  await UI._internal.advanceFlow();
  assert.equal(completed, false, "injury recovery must not complete the diagnostic");
  assert.equal(events.includes("diagnostic_completed"), false);
  assert.match(threadText(registry), /Any current pain, injuries, or recurring niggles/);
}

{
  const { UI, events } = load();
  let completed = false;
  const stub = {
    begun: true,
    completed: false,
    history: ["goal"],
    known: {},
    canComplete: () => false,
    nextQuestion: () => null,
    recoverContinuationQuestion: () => null,
    complete() {
      completed = true;
      return { profile: {}, version: 1 };
    }
  };
  UI._internal.bindEngine(stub);
  await UI._internal.advanceFlow();
  assert.equal(completed, false);
  assert.equal(events.includes("diagnostic_completed"), false);
  const message = UI._internal.failOpenDeadDiagnostic;
  assert.equal(typeof message, "function");
}

{
  const { ctx, UI, Engine, events, registry } = load();
  const stub = {
    begun: true,
    completed: false,
    history: ["goal"],
    known: {},
    canComplete: () => false,
    nextQuestion: () => null,
    recoverContinuationQuestion: () => null,
    complete() {
      throw new Error("completeDiagnostic must not run from dead-state recovery");
    }
  };
  UI._internal.bindEngine(stub);
  await UI._internal.advanceFlow();
  assert.match(threadText(registry), /I still need a bit more to continue/);
  assert.equal(registry.get("chatComposer").style.display !== "none", true);
  assert.equal(UI._internal.isBusy(), false);
  assert.equal(events.includes("diagnostic_completed"), false);
  assert.equal(Engine.getQuestion("goal").key, "goal");
}

{
  const { ctx, UI, Engine, registry } = load();
  const Sales = ctx.AthlevoDiagnosticSales;
  const goal = Engine.getQuestion("goal");
  const engine = new Engine();
  engine.begin();
  UI._internal.bindEngine(engine);
  UI._internal.prepareQuestion(goal);

  Sales.classify = () => null;
  Sales.detectPainPoints = () => [];
  Sales.looksLikeAQuestion = () => true;
  Sales.shouldUseAiAcknowledgement = () => false;
  Sales.shouldUseAiFallback = () => true;

  let routerCalls = 0;
  let rejectRouter;
  Sales.callRouter = () => {
    routerCalls += 1;
    return new Promise((_, reject) => { rejectRouter = reject; });
  };

  const input = registry.get("chatInput");
  const send = registry.get("chatSend");
  input.value = "what does this question mean?";
  UI._internal.handleComposerSend();
  assert.equal(routerCalls, 1);
  assert.equal(UI._internal.isBusy(), true);
  assert.equal(send.disabled, true);
  assert.equal(send.attributes["aria-busy"], "true");
  assert.match(threadText(registry), /what does this question mean/);

  input.value = "second submit should be ignored";
  UI._internal.handleComposerSend();
  UI._internal.handleComposerSend();
  assert.equal(routerCalls, 1, "busy composer must ignore duplicate click/Enter submits");
  assert.doesNotMatch(threadText(registry), /second submit should be ignored/);

  rejectRouter(new Error("timeout"));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(UI._internal.isBusy(), false, "composer must recover after AI failure/timeout");
  assert.equal(send.disabled, false);
  assert.equal(send.attributes["aria-busy"], "false");
}

{
  const { ctx, UI, Engine, registry } = load();
  const Sales = ctx.AthlevoDiagnosticSales;
  const goal = Engine.getQuestion("goal");
  const engine = new Engine();
  engine.begin();
  UI._internal.bindEngine(engine);
  UI._internal.prepareQuestion(goal);
  Sales.classify = () => null;
  Sales.detectPainPoints = () => [];
  Sales.looksLikeAQuestion = () => true;
  Sales.shouldUseAiAcknowledgement = () => false;
  Sales.callRouter = () => Promise.resolve(Sales.FALLBACK_RESPONSE);
  registry.get("chatInput").value = "could you repeat that?";
  UI._internal.handleComposerSend();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(UI._internal.isBusy(), false, "composer must recover after AI fallback");
  assert.equal(registry.get("chatSend").disabled, false);
}

console.log("PASS — diagnostic reliability (dead-state, busy composer, asset versions)");

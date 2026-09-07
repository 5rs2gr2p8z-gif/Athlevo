/*
 * Anonymous Coach response — visual hierarchy regression suite.
 *
 * The anonymous discovery-stage reply must render as a restrained,
 * conversational block (short insight optionally bold, plain-body
 * explanation, visually separated question) — never the authenticated
 * Coach's oversized/bold "coach-response-lead" treatment. Once the
 * existing diagnostic engine reports sufficient context, the anonymous
 * flow may fall back to the shared, UNMODIFIED authenticated renderer.
 *
 * Run: node tests/anonymous-coach-response-hierarchy.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const rendererSrc = readFileSync("./js/renderCoachResponse.js", "utf8");
const anonSrc = readFileSync("./js/anonymousCoach.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");

/* ---------- minimal DOM stub (no jsdom in this repo) ---------- */
function makeNode(tag) {
  return {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }
    },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text || ""; },
    set innerHTML(v) { if (v === "") { this.children = []; } },
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return null; }
  };
}

function runRenderer() {
  const sandbox = {
    console,
    document: {
      createElement: (tag) => makeNode(tag),
      createTextNode: (text) => ({ textContent: text }),
      querySelector: () => null
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(rendererSrc, sandbox, { filename: "renderCoachResponse.js" });
  return sandbox;
}

function allText(node) {
  // Flattened textContent of every descendant paragraph/strong, in order.
  const out = [];
  (function walk(n) {
    if (n.textContent) out.push(n.textContent);
    (n.children || []).forEach(walk);
  })(node);
  return out.join(" ");
}

function classesOf(node) {
  const out = [];
  (function walk(n) {
    if (n.className) out.push(n.className);
    (n.children || []).forEach(walk);
  })(node);
  return out;
}

const sandbox = runRenderer();

section("A — discovery-stage anonymous reply is NOT one large/bold block");
{
  const container = makeNode("div");
  const reply =
    "For now I'd keep today simple. Until I know what you're training toward, " +
    "an easy run or easy aerobic cross-training is usually the safest direction. " +
    "What are you aiming for right now — 5K, 10K, half marathon, marathon, ultra, or general fitness?";

  sandbox.renderAnonymousCoachResponse(container, reply);
  const classes = classesOf(container);

  t("discovery renderer never applies coach-response-lead (the oversized/bold class)",
    !classes.some(c => c.includes("coach-response-lead")));
  t("discovery renderer produces more than one visual block (not a single wall of text)",
    container.children.length > 1);
  t("discovery renderer marks the container with the restrained coach-anon-response class",
    container.classList._set.has("coach-anon-response"));
  t("full reply text is preserved somewhere in the rendered output",
    allText(container).includes("What are you aiming for right now"));
}

section("B — a short insight sentence can be emphasized");
{
  const container = makeNode("div");
  sandbox.renderAnonymousCoachResponse(
    container,
    "Easy days build the base. That's why keeping today conversational-pace matters more than mileage. " +
    "How many days a week are you currently running?"
  );
  const classes = classesOf(container);
  t("an insight block using the restrained (non-oversized) coach-anon-insight class exists",
    classes.includes("coach-anon-insight"));
}

section("C — explanation uses normal Coach body typography, not the insight class");
{
  const container = makeNode("div");
  sandbox.renderAnonymousCoachResponse(
    container,
    "Easy days build the base. That's why keeping today conversational-pace matters more than mileage. " +
    "How many days a week are you currently running?"
  );
  const classes = classesOf(container);
  t("a normal-body block using coach-anon-body exists alongside the insight",
    classes.includes("coach-anon-body"));
  t("the explanation block is a distinct class from the insight block (not both bold)",
    classes.includes("coach-anon-body") && classes.includes("coach-anon-insight"));
}

section("D — the follow-up question is visually separated");
{
  const container = makeNode("div");
  sandbox.renderAnonymousCoachResponse(
    container,
    "For now I'd keep today simple. Until I know what you're training toward, an easy run is usually safest. " +
    "What are you training for right now?"
  );
  const classes = classesOf(container);
  t("a dedicated coach-anon-question block renders for a trailing question",
    classes.includes("coach-anon-question"));
  t("coach-anon-question gets its own margin-top spacing rule in CSS (separated, not run-on)",
    /\.coach-anon-question\s*\{[^}]*margin-top:\s*6px/.test(indexSrc));
  t("the question is NOT rendered in the oversized coach-response-lead class",
    !classes.includes("coach-response-lead"));
}

section("E — authenticated Coach rendering (renderCoachResponse) is unchanged");
{
  t("renderCoachResponse() body is untouched — still applies coach-response-lead to the lead paragraph",
    /appendCoachProse\(\s*container,\s*response\.direct_answer,\s*"coach-response-lead"\s*\)/.test(rendererSrc));
  t("headline/mission/sections/actions rendering in renderCoachResponse() is untouched",
    /"h3",\s*"coach-response-headline"/.test(rendererSrc) &&
    /"Your next move"/.test(rendererSrc) &&
    /renderCoachActions\(container, response\.actions\)/.test(rendererSrc));
  t("the new anonymous renderer is an ADDITION, not a rewrite of renderCoachResponse",
    typeof sandbox.renderCoachResponse === "function" &&
    typeof sandbox.renderAnonymousCoachResponse === "function");

  // Behavioral check: feeding the authenticated renderer the same text
  // still produces the oversized/bold lead treatment (that path is
  // intentionally unchanged — only anonymousCoach.js's calling convention
  // changed which renderer it invokes).
  const container = makeNode("div");
  sandbox.renderCoachResponse(container, { direct_answer: "This entire sentence should read as the lead." });
  t("renderCoachResponse still applies coach-response-lead to a single-paragraph direct_answer",
    classesOf(container).includes("coach-response-lead"));
}

section("F — sufficient-context anonymous state still uses the stronger hierarchy");
{
  t("anonymousCoach.js computes sufficientContext from the existing diagnostic engine's canComplete(), not turn count alone",
    /var sufficientContext = !!\(\s*engine &&\s*typeof engine\.canComplete === "function" &&\s*engine\.canComplete\(\)\s*\);/.test(anonSrc));
  t("when context is sufficient, anonymousCoach.js calls the shared renderCoachResponse (stronger hierarchy)",
    /if \(changeEl && sufficientContext && typeof root\.renderCoachResponse === "function"\) \{/.test(anonSrc));
  t("when context is NOT sufficient, anonymousCoach.js calls the restrained renderAnonymousCoachResponse",
    /root\.renderAnonymousCoachResponse\(changeEl, reply\)/.test(anonSrc));
  t("no second/new sufficiency system was invented — canComplete() is the existing diagnostic engine API",
    /engine\.canComplete\(\)/.test(anonSrc) && (anonSrc.match(/canComplete/g) || []).length >= 2);
}

section("G — existing anonymous signup CTA behavior is intact");
{
  t("CTA still gated on MIN_TURNS_BEFORE_CTA or engine.completed, unchanged by the rendering switch",
    /var shouldOfferSignup = _turnCount >= MIN_TURNS_BEFORE_CTA \|\|\s*\(engine && engine\.completed\);/.test(anonSrc));
  t("CTA still appended as its own trailing block (appendSignupCta), not folded into either renderer",
    /if \(shouldOfferSignup && changeEl\) appendSignupCta\(changeEl\);/.test(anonSrc));
  t("appendSignupCta remains visually separate (own wrapper div, own class) from the conversational response",
    /wrap\.className = "coach-anonymous-cta"/.test(anonSrc));
}

section("H — no quota/auth/thread regressions from this rendering change");
{
  t("anonymous module still never calls /api/coach (the authenticated + quota-metered endpoint)",
    !/fetch\("\/api\/coach"[,)]/.test(anonSrc) && /fetch\("\/api\/coach-anonymous"/.test(anonSrc));
  t("anonymous module still has no coach_threads / coach_conversations WRITE calls",
    !/(insert|update|upsert)\([\s\S]{0,40}coach_(threads|conversations)/.test(anonSrc));
  t("anonymous module still keeps history in sessionStorage only",
    /sessionStorage\.setItem/.test(anonSrc) && !/localStorage\.setItem/.test(anonSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/**
 * Focused Coach workspace UI checks.
 * Run: node tests/coach-ui.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const coach = readFileSync("./js/coach.js", "utf8");
const renderer = readFileSync("./js/renderCoachResponse.js", "utf8");
const coachApi = readFileSync("./api/coach.js", "utf8");
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

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not close ${name}()`);
}

const coachScreen = html.slice(
  html.indexOf('<section class="screen coach-is-empty" id="screen-coachai">'),
  html.indexOf("</section>", html.indexOf('<section class="screen coach-is-empty" id="screen-coachai">')) +
    "</section>".length
);
const coachCss = html.slice(
  html.indexOf("/* ---------- chat ---------- */"),
  html.indexOf("/* ---------- train ---------- */")
);

console.log("\n──── Empty workspace ────");
test("empty state uses the exact centered workspace prompt",
  /id="coachEmptyGreeting">What should we work on\?<\/h2>/.test(coachScreen) &&
  /Ask about today’s training, recovery, pacing, or your plan\./.test(coachScreen));
test("the focal composer follows the prompt and starters follow the composer",
  coachScreen.indexOf("coachEmptyGreeting") < coachScreen.indexOf('class="coach-composer"') &&
  coachScreen.indexOf('class="composer"') < coachScreen.indexOf('id="coachStarters"'));
test("empty suggestions are compact and limited to three or four",
  (coachScreen.match(/class="coach-starter"/g) || []).length >= 3 &&
  (coachScreen.match(/class="coach-starter"/g) || []).length <= 4 &&
  /\.coach-starters\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(coachCss));

const starterFactory = new Function(
  "document",
  `${extractFunction(coach, "buildCoachStarterPrompts")}
   return buildCoachStarterPrompts;`
);
const starterPrompts = planState => starterFactory({
  getElementById: id => id === "dailyBriefCard" ? { dataset: { planState } } : null
})();
test("saved workout context produces relevant session prompts",
  starterPrompts("workout").length === 4 &&
  starterPrompts("workout")[0] === "Should I complete today’s workout?" &&
  starterPrompts("workout")[1] === "How should I pace this session?");
test("no-plan context does not suggest completing a nonexistent workout",
  starterPrompts("no-plan").length === 3 &&
  !starterPrompts("no-plan").some(prompt => /today’s workout|pace this session/i.test(prompt)));

console.log("\n──── Active conversation ────");
test("assistant responses render as open page content, not bubbles",
  /\.msg\.ai\{[^}]*align-self:stretch[^}]*background:transparent[^}]*border-radius:0/.test(coachCss) &&
  !/\.msg\.ai\{[^}]*background:var\(--card\)/.test(coachCss));
test("user messages remain a compact visually secondary chip",
  /\.msg\.user\{[^}]*width:auto[^}]*max-width:78%[^}]*background:var\(--card2\)[^}]*border:1px solid var\(--line\)/.test(coachCss));
test("structured response typography keeps conclusion-first hierarchy",
  /coach-response-headline/.test(renderer) &&
  /appendCoachProse\([\s\S]*?"coach-response-lead"/.test(renderer) &&
  /coach-response-section/.test(renderer) &&
  /\.coach-rich-response\s*\{[^}]*gap:\s*var\(--s-3\)[^}]*max-width:\s*640px/.test(html) &&
  /\.coach-response-lead\s*\{[^}]*font-size:\s*var\(--fs-h3\)[^}]*font-weight:\s*650[^}]*line-height:\s*var\(--lh-caption\)/.test(html) &&
  /\.coach-response-direct\s*\{[^}]*font-size:\s*calc\(var\(--fs-body\) \+ 1px\)[^}]*line-height:\s*calc\(var\(--lh-body\) \+ \.1\)/.test(html) &&
  /\.coach-response-headline\s*\{[^}]*font-family:\s*var\(--sans\)[^}]*font-size:\s*var\(--fs-body\)/.test(html) &&
  !/\.coach-response-(?:headline|lead)\s*\{[^}]*font-size:\s*var\(--fs-(?:display|h1|h2)\)/.test(html));
test("safe Coach output rendering remains DOM-based",
  /element\.textContent = cleanCoachText\(text\)/.test(renderer) &&
  /document\.createTextNode\(part\)/.test(renderer));

const followUpFactory = new Function(
  `${extractFunction(coach, "buildFollowUpActions")}
   return buildFollowUpActions;`
)();
test("active conversations expose no more than two follow-ups",
  followUpFactory({ response_type: "plan_change", actions: [{}] }).length === 2 &&
  /replies\.slice\(0, 2\)/.test(renderer));
test("large starter suggestions disappear after conversation starts",
  /coach-is-active \.coach-starters\s*\{display:none\}/.test(html) &&
  /hideCoachEmptyState\(\)/.test(extractFunction(coach, "addChatMessage")));
test("follow-up suggestions are mounted above the composer input",
  coachScreen.indexOf('id="chips"') < coachScreen.indexOf('<div class="composer">') &&
  /coach-composer \.chips\{[^}]*flex-wrap:wrap[^}]*margin:0 0 var\(--s-2\)/.test(html));

console.log("\n──── Latest-message controls ────");
test("old text pill is replaced by a labelled circular arrow",
  !/textContent\s*=\s*["']Jump to latest["']|>Jump to latest</.test(coach + coachScreen) &&
  /id="coachJumpLatest"[\s\S]*?aria-label="Jump to latest message"[\s\S]*?<svg/.test(coachScreen) &&
  /\.coach-jump-latest\{[^}]*width:38px;height:38px[^}]*border-radius:50%/.test(coachCss) &&
  /\.coach-jump-latest\[hidden\]\{display:none\}/.test(coachCss));

const chatlog = {
  scrollHeight: 1000,
  scrollTop: 600,
  clientHeight: 400,
  listeners: {},
  addEventListener(name, fn) { this.listeners[name] = fn; },
  removeEventListener() {},
  scrollTo({ top }) { this.scrollTop = top; }
};
const chips = {
  dataset: { hasSuggestions: "true" },
  children: [{}],
  style: {}
};
const jumpButton = {
  hidden: true,
  dataset: {},
  listeners: {},
  addEventListener(name, fn) { this.listeners[name] = fn; }
};
const coachActiveScreen = {
  classList: { contains: name => name === "coach-is-empty" ? false : false }
};
const scrollDocument = {
  getElementById(id) {
    return {
      chatlog,
      chips,
      coachJumpLatest: jumpButton,
      "screen-coachai": coachActiveScreen
    }[id] || null;
  }
};
const scrollControlsFactory = new Function(
  "document",
  "window",
  "requestAnimationFrame",
  `var coachRequestInFlight = false;
   var _coachScrollListener = null;
   var _coachJumpingToLatest = false;
   ${extractFunction(coach, "coachIsNearBottom")}
   ${extractFunction(coach, "coachScrollBehavior")}
   ${extractFunction(coach, "setCoachFollowUpsVisible")}
   ${extractFunction(coach, "showJumpToLatest")}
   ${extractFunction(coach, "hideJumpToLatest")}
   ${extractFunction(coach, "syncCoachScrollUi")}
   ${extractFunction(coach, "jumpToLatestCoachMessage")}
   ${extractFunction(coach, "bindCoachScrollWatcher")}
   bindCoachScrollWatcher();
   return { syncCoachScrollUi, jumpToLatestCoachMessage };`
)(
  scrollDocument,
  { matchMedia: () => ({ matches: false }) },
  callback => callback()
);

test("at latest, suggestions show and the arrow is hidden",
  chips.style.display === "flex" && jumpButton.hidden === true);
chatlog.scrollTop = 100;
chatlog.listeners.scroll();
test("away from latest, only the circular arrow shows",
  chips.style.display === "none" && jumpButton.hidden === false);
jumpButton.listeners.click();
test("clicking the arrow reaches latest and restores suggestions",
  chatlog.scrollTop === chatlog.scrollHeight &&
  chips.style.display === "flex" &&
  jumpButton.hidden === true);
test("arrow and suggestions can never be visible together",
  /if \(coachIsNearBottom\(\)\)[\s\S]*?hideJumpToLatest\(\);[\s\S]*?setCoachFollowUpsVisible\(!coachRequestInFlight\)/.test(
    extractFunction(coach, "syncCoachScrollUi")
  ) &&
  /setCoachFollowUpsVisible\(false\);[\s\S]*?showJumpToLatest\(\)/.test(
    extractFunction(coach, "syncCoachScrollUi")
  ));
test("loading clears stale follow-up suggestions",
  /if \(isSending[\s\S]*?chips\.innerHTML = ""[\s\S]*?hasSuggestions = "false"/.test(
    extractFunction(coach, "setCoachSendingState")
  ));

console.log("\n──── Composer and state feedback ────");
test("composer is multiline, labelled, and uses the required placeholder",
  /<textarea[\s\S]*?rows="1"[\s\S]*?placeholder="Ask your coach anything…"[\s\S]*?aria-label="Message your coach"/.test(coachScreen) &&
  /id="coachSendBtn"[\s\S]*?aria-label="Send message"/.test(coachScreen));
test("composer stays keyboard- and safe-area-aware above navigation",
  /inset:0 0 calc\(var\(--athlevo-tabbar-height\) \+ env\(safe-area-inset-bottom\)\)/.test(html) &&
  /padding:var\(--s-2\) 22px var\(--s-3\)/.test(html) &&
  /max-height:120px/.test(coachCss) &&
  /scroll-padding-bottom:var\(--s-6\)/.test(html));
test("send treatment is integrated and no longer a giant red circle",
  /\.send\{[^}]*width:36px;height:36px[^}]*border-radius:var\(--r-md\)[^}]*background:var\(--ink\)/.test(coachCss) &&
  !/\.send\{[^}]*background:var\(--red\)/.test(coachCss));

const sendButton = {
  disabled: false,
  attrs: {},
  classList: { toggle(name, on) { this[name] = on; } },
  setAttribute(name, value) { this.attrs[name] = value; }
};
const sendingFactory = new Function(
  "document",
  `${extractFunction(coach, "setCoachSendingState")}
   return setCoachSendingState;`
)({ querySelector: () => sendButton });
sendingFactory(true);
test("loading state disables the real send button and exposes aria-busy",
  sendButton.disabled === true &&
  sendButton.attrs["aria-busy"] === "true" &&
  sendButton.classList["is-sending"] === true);
test("inline errors remain accessible and retryable",
  /wrap\.setAttribute\("role", "alert"\)/.test(coach) &&
  /retryBtn\.textContent = "Try again"/.test(coach) &&
  /askCoach\(question\)/.test(extractFunction(coach, "renderCoachError")));

console.log("\n──── Preserved behavior and visual constraints ────");
test("plan action Apply and Cancel handlers remain wired",
  /window\.applyCoachAction\(action\.id, card\)/.test(renderer) &&
  /window\.cancelCoachAction\(action\.id, card\)/.test(renderer) &&
  /intent:\s*"apply_coach_action"/.test(coach));
test("conversation persistence remains user-scoped and unchanged",
  /\.from\("coach_conversations"\)[\s\S]*?\.insert/.test(coach) &&
  /\.from\("coach_conversations"\)[\s\S]*?\.select\("role, message, created_at"\)[\s\S]*?\.eq\("user_id", user\.id\)/.test(coach));
test("server-enforced free Coach limits remain before AI",
  /consumeFreeUsage\(\s*authenticatedUser\.id,\s*"coach_message"\s*\)/.test(coachApi) &&
  coachApi.search(/consumeFreeUsage\(\s*authenticatedUser\.id,\s*"coach_message"\s*\)/) <
    coachApi.indexOf('"https://api.openai.com/v1/responses"') &&
  /COACH_WEEKLY_LIMIT_REACHED/.test(coach) &&
  /showCoachLimitUpgrade\(coachAccessTier\)/.test(coach));
test("dark mode remains token-driven and Coach contains no glass surface",
  /background:var\(--paper\)/.test(html) &&
  /color:var\(--text\)/.test(coachCss) &&
  !/#screen-coachai[^{]*\{[^}]*(?:nav-glass|backdrop-filter)/.test(html) &&
  !/#screen-coachai \.coach-(?:head|composer)[^{]*\{[^}]*(?:nav-glass|backdrop-filter)/.test(html));
test("reduced-motion coverage remains for Coach transitions",
  /prefers-reduced-motion:reduce[\s\S]*?coach-thinking-mark\{animation:none/.test(coachCss) &&
  /prefers-reduced-motion: reduce[\s\S]*?\.msg\{animation:none\}/.test(html) &&
  extractFunction(coach, "coachScrollBehavior")
    .includes('matchMedia("(prefers-reduced-motion: reduce)")'));
test("no Gemini branding, copied assets, gradients, or sparkle decoration exist",
  !/gemini|sparkle/i.test(coachScreen + coach + renderer + coachCss) &&
  !/gradient\(/.test(coachCss));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

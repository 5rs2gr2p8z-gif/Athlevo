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
const coachHeader = html.slice(
  html.indexOf('<header class="chat-head coach-head"'),
  html.indexOf("</header>", html.indexOf('<header class="chat-head coach-head"')) +
    "</header>".length
);
const coachMenu = html.slice(
  html.indexOf('<div class="coach-side-panel-overlay" id="coachSidePanelOverlay"'),
  html.indexOf("<!-- Coach history reflects", html.indexOf('id="coachSidePanelOverlay"'))
);
const coachHistory = html.slice(
  html.indexOf('coach-side-panel-chats'),
  html.indexOf("</div>", html.indexOf('id="coachSidePanelChatList"'))
);

console.log("\n──── Athlete Coach header ────");
test("old athlete Coach title is removed from the header",
  coachHeader.length > 0 && !/>\s*Athlevo Coach\s*</.test(coachHeader));
test("header has a labelled menu button with exactly two horizontal lines",
  /id="coachMenuButton"[\s\S]*?aria-label="Open Coach menu"/.test(coachHeader) &&
  (coachHeader.match(/<i><\/i>/g) || []).length === 2);
test("the centered identity uses the existing transparent Athlevo AI icon",
  /class="coach-logo-bubble"[\s\S]*?<img[^>]+athlevo-icon-transparent\.png[^>]+alt="Athlevo AI"/.test(coachHeader) &&
  /\.coach-logo-bubble\{[^}]*width:42px;height:42px;border-radius:50%/.test(html));
test("header uses a true centered three-column grid",
  /#screen-coachai \.coach-head\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/.test(html) &&
  /#screen-coachai \.coach-head\{[^}]*min-height:64px[^}]*box-sizing:border-box/.test(html) &&
  /\.coach-head-side--start\{justify-self:start/.test(html) &&
  /\.coach-head-side--end\{justify-self:end/.test(html));
test("right header actions start hidden while canonical auth resolves",
  /id="coachHeaderAuthAction"[^>]*data-auth-state="pending"/.test(coachHeader) &&
  /id="coachHeaderSignIn"[^>]*hidden/.test(coachHeader) &&
  /id="coachHeaderSignedIn"[^>]*hidden/.test(coachHeader) &&
  /\.coach-header-control\[hidden\],\.coach-header-authenticated\[hidden\],\.coach-menu-pending\[hidden\],\.coach-menu-action\[hidden\]\{display:none\}/.test(html));
test("athlete Coach header has no opaque full-width bar or divider",
  /#screen-coachai \.coach-head\{[^}]*background:transparent;border:0;box-shadow:none[^}]*backdrop-filter:none/.test(html));
test("left menu floats independently and the center logo has no disk",
  /\.coach-header-control\{[^}]*min-width:44px;min-height:44px[^}]*color-mix\(in srgb,var\(--paper\) 66%,transparent\)/.test(html) &&
  /\.coach-logo-bubble\{[^}]*background:transparent;border:0;box-shadow:none/.test(html));
test("signed-in right bubble contains labelled Settings and New Chat icons only",
  /id="coachHeaderSignedIn"[\s\S]*?id="coachHeaderSettings"[\s\S]*?aria-label="Open Settings"/.test(coachHeader) &&
  /id="coachHeaderSignedIn"[\s\S]*?id="coachHeaderNewChat"[\s\S]*?aria-label="Start a new Coach chat"/.test(coachHeader) &&
  !/id="coachHeaderChats"|notification/i.test(coachHeader));

const headerAuthElements = {
  coachHeaderAuthAction: { dataset: {} },
  coachHeaderSignIn: { hidden: true },
  coachHeaderSignedIn: { hidden: true },
  coachMenuPending: { hidden: false }
};
const headerMenuItems = ["signed-in", "signed-in", "signed-out", "signed-in"].map(auth => ({
  hidden: true,
  getAttribute(name) { return name === "data-coach-auth" ? auth : null; }
}));
const headerAuthFactory = new Function(
  "document",
  `var coachHeaderAuthState = "pending";
   ${extractFunction(html, "renderCoachHeaderAuthState")}
   return renderCoachHeaderAuthState;`
)({
  getElementById(id) { return headerAuthElements[id] || null; },
  querySelectorAll(selector) { return selector === "[data-coach-auth]" ? headerMenuItems : []; }
});
headerAuthFactory(null, false);
test("unresolved Supabase state keeps both right-side actions neutral",
  headerAuthElements.coachHeaderSignIn.hidden === true &&
  headerAuthElements.coachHeaderSignedIn.hidden === true &&
  headerAuthElements.coachMenuPending.hidden === false &&
  headerMenuItems.every(item => item.hidden));
headerAuthFactory(null);
test("signed-out state renders Sign in without Chats, New Chat, settings, or notifications",
  headerAuthElements.coachHeaderSignIn.hidden === false &&
  headerAuthElements.coachHeaderSignedIn.hidden === true &&
  headerMenuItems.filter(item => item.getAttribute("data-coach-auth") === "signed-out").every(item => item.hidden === false) &&
  headerMenuItems.filter(item => item.getAttribute("data-coach-auth") === "signed-in").every(item => item.hidden));
headerAuthFactory({ user: { id: "athlete-1" } });
test("signed-in state never renders Sign in and reveals Chats plus New Chat",
  headerAuthElements.coachHeaderSignIn.hidden === true &&
  headerAuthElements.coachHeaderSignedIn.hidden === false &&
  headerMenuItems.filter(item => item.getAttribute("data-coach-auth") === "signed-in").every(item => item.hidden === false) &&
  headerMenuItems.filter(item => item.getAttribute("data-coach-auth") === "signed-out").every(item => item.hidden));
test("auth state comes from restoreSession and the canonical Supabase listener",
  /athlevoSessionUserId = session \? session\.user\.id : null;[\s\S]{0,260}renderCoachHeaderAuthState\(session, !sessionRestoreTimedOut\)/.test(html) &&
  /onAuthStateChange\(function \(event, session\) \{[\s\S]{0,160}syncCoachHeaderFromAuthEvent\(event, session\)/.test(html));
test("auth events keep initial null state pending and update signed-in/out explicitly",
  /event === "SIGNED_OUT"[\s\S]*?renderCoachHeaderAuthState\(null\)/.test(extractFunction(html, "syncCoachHeaderFromAuthEvent")) &&
  /session && session\.user[\s\S]*?renderCoachHeaderAuthState\(session\)/.test(extractFunction(html, "syncCoachHeaderFromAuthEvent")) &&
  /event === "INITIAL_SESSION" && !window\.__athlevoSessionRestoreSettled[\s\S]*?renderCoachHeaderAuthState\(null, false\)/.test(
    extractFunction(html, "syncCoachHeaderFromAuthEvent")
  ));
const authEventWindow = { __athlevoSessionRestoreSettled: false };
const authEventFactory = new Function(
  "document",
  "window",
  `var coachHeaderAuthState = "pending";
   var athlevoSessionUserId = null;
   ${extractFunction(html, "renderCoachHeaderAuthState")}
   ${extractFunction(html, "syncCoachHeaderFromAuthEvent")}
   return {
     sync: syncCoachHeaderFromAuthEvent,
     state: function () { return coachHeaderAuthState; },
     setUserId: function (id) { athlevoSessionUserId = id; }
   };`
)({
  getElementById(id) { return headerAuthElements[id] || null; },
  querySelectorAll(selector) { return selector === "[data-coach-auth]" ? headerMenuItems : []; }
}, authEventWindow);
authEventFactory.sync("INITIAL_SESSION", null);
test("a null INITIAL_SESSION cannot flash Sign in while restore is pending",
  authEventFactory.state() === "pending" && headerAuthElements.coachHeaderSignIn.hidden === true);
authEventFactory.setUserId("athlete-1");
authEventWindow.__athlevoSessionRestoreSettled = true;
authEventFactory.sync("SIGNED_IN", { user: { id: "athlete-1" } });
authEventFactory.sync("INITIAL_SESSION", null);
test("a late null INITIAL_SESSION cannot downgrade a resolved signed-in header",
  authEventFactory.state() === "signed-in" && headerAuthElements.coachHeaderSignIn.hidden === true);
authEventFactory.sync("SIGNED_OUT", null);
test("an explicit SIGNED_OUT event resolves the header to Sign in",
  authEventFactory.state() === "signed-out" && headerAuthElements.coachHeaderSignIn.hidden === false);
test("Coach menu is a left side panel rather than an AthlevoSheet bottom sheet",
  /id="coachSidePanelOverlay"[^>]*aria-hidden="true"/.test(coachMenu) &&
  /id="coachSidePanel"[^>]*role="dialog"[^>]*aria-modal="true"/.test(coachMenu) &&
  /\.coach-side-panel\{[^}]*inset:0 auto 0 0[^}]*width:min\(82%,340px\)[^}]*transform:translate3d\(-100%,0,0\)/.test(html) &&
  /\.coach-side-panel-overlay\.is-open \.coach-side-panel\{transform:translate3d\(0,0,0\)/.test(html) &&
  !/coach-menu-sheet|AthlevoSheet/.test(coachMenu + extractFunction(html, "openCoachMenu")));
test("side panel has backdrop, X, Escape, focus containment, and focus restoration",
  /onclick="handleCoachMenuBackdrop\(event\)"/.test(coachMenu) &&
  /class="coach-side-panel-close"[^>]*onclick="closeCoachMenu\(\)"/.test(coachMenu) &&
  /event\.key === "Escape"[\s\S]*?closeCoachMenu\(\)/.test(extractFunction(html, "handleCoachMenuKeydown")) &&
  /event\.key !== "Tab"/.test(extractFunction(html, "handleCoachMenuKeydown")) &&
  /coachMenuInertTargets[\s\S]*?item\.inert = true/.test(extractFunction(html, "openCoachMenu")) &&
  /coachMenuReturnFocus\.focus\(\)/.test(extractFunction(html, "closeCoachMenu")));
test("signed-in and signed-out menu rows are separated by canonical auth state",
  /data-coach-auth="signed-in"[\s\S]*?>New chat</.test(coachMenu) &&
  /data-coach-auth="signed-in"[\s\S]*?>Chats</.test(coachMenu) &&
  /data-coach-auth="signed-in"[\s\S]*?>Settings</.test(coachMenu) &&
  /data-coach-auth="signed-out"[\s\S]*?>Sign in</.test(coachMenu) &&
  /data-coach-auth="signed-in"[\s\S]*?>Sign out</.test(coachMenu));
test("Profile row removed from Coach side panel (account config lives in Settings; athlete identity lives in You)",
  !/>Profile</.test(coachMenu));
test("menu actions reuse the same canonical chat and account flows as the header controls",
  /action === "new-chat"[\s\S]*?startNewCoachConversation\(\)/.test(extractFunction(html, "runCoachMenuAction")) &&
  /action === "profile"[\s\S]*?openProfileScreen\(\)/.test(extractFunction(html, "runCoachMenuAction")) &&
  /action === "settings"[\s\S]*?openSettings\(\)/.test(extractFunction(html, "runCoachMenuAction")) &&
  /action === "sign-in"[\s\S]*?openLogin\(true, "coach_header"\)/.test(extractFunction(html, "runCoachMenuAction")) &&
  /action === "sign-out"[\s\S]*?doLogout\(\)/.test(extractFunction(html, "runCoachMenuAction")) &&
  !/action === "chats"/.test(extractFunction(html, "runCoachMenuAction")));
test("top-right Settings icon calls canonical openSettings; hamburger menu still opens the side panel",
  /id="coachHeaderSettings"[^>]*onclick="openSettings\(\)"/.test(html) &&
  /id="coachMenuButton"[^>]*onclick="openCoachMenu\(\)"/.test(html) &&
  !/id="coachHeaderChats"/.test(html));
test("the side panel renders the canonical thread list inline (one row per conversation), not a separate sheet",
  /coach-side-panel-label">Chats</.test(coachMenu) &&
  /id="coachSidePanelChatList"/.test(coachMenu) &&
  !/id="coachHistorySheet"|openCoachHistory\(\)/.test(html) &&
  /const threads = await loadThreadList\(\)/.test(extractFunction(coach, "renderCoachHistoryList")) &&
  /\.from\("coach_threads"\)/.test(extractFunction(coach, "loadThreadList")) &&
  /\.eq\("user_id", user\.id\)/.test(extractFunction(coach, "loadThreadList")));
test("no flat-message history UI remains on the active Chats path",
  !/coachHistoryPreviewText/.test(coach) &&
  !extractFunction(coach, "renderCoachHistoryList").includes("loadConversationHistory") &&
  /formatThreadDate/.test(extractFunction(coach, "renderCoachHistoryList")));
test("thread rows render as text and selecting one never deletes messages",
  /label\.textContent = thread\.title \|\| "Untitled conversation"/.test(extractFunction(coach, "renderCoachHistoryList")) &&
  /renderConversationHistory\(\)/.test(extractFunction(coach, "selectThread")) &&
  !/\.delete\(/.test(extractFunction(coach, "selectThread")));
test("New Chat starts a fresh thread directly, with no destructive confirmation dialog",
  !/Starting over clears your current Coach conversation\. This cannot be undone\./.test(html) &&
  /openCoachNewChatPrompt/.test(coachHeader) &&
  /startNewCoachConversation\(\)/.test(extractFunction(html, "openCoachNewChatPrompt")));
test("New chat preserves history — it clears the active thread pointer, not coach_conversations rows",
  /function startNewCoachConversation/.test(coach) &&
  !/\.from\("coach_conversations"\)[\s\S]*?\.delete\(/.test(extractFunction(coach, "startNewCoachConversation")) &&
  /_activeThreadId = null/.test(extractFunction(coach, "startNewCoachConversation")) &&
  /querySelectorAll\("\.msg, \.coach-error"\)/.test(extractFunction(coach, "startNewCoachConversation")));
test("global profile avatar is hidden only for active athlete Coach",
  /body:not\(\.coach-workspace-active\) #screen-coachai\.active ~ #profileAvatarBtn\{display:none!important\}/.test(html));

console.log("\n──── Empty workspace ────");
test("empty state uses the exact centered workspace prompt",
  /id="coachEmptyGreeting">What should we work on\?<\/h2>/.test(coachScreen) &&
  /Ask about today’s training, recovery, pacing, or your plan\./.test(coachScreen));
test("the focal composer follows the prompt, and starter suggestions sit directly above the composer",
  coachScreen.indexOf("coachEmptyGreeting") < coachScreen.indexOf('class="coach-composer"') &&
  coachScreen.indexOf('id="coachStarters"') < coachScreen.indexOf('class="composer"'));
test("empty suggestions are exactly three, one vertical column",
  (coachScreen.match(/class="coach-suggestion( coach-suggestion--recommended)?"/g) || []).length === 3 &&
  /\.coach-starters,\.coach-followups\{[^}]*grid-template-columns:1fr/.test(coachCss));
test("top suggestion carries a reduced-motion-safe recommended accent, with no gradient/glow decoration",
  /class="coach-suggestion coach-suggestion--recommended"/.test(coachScreen) &&
  /\.coach-suggestion--recommended/.test(coachCss) &&
  /prefers-reduced-motion:reduce\)\{\.coach-suggestion--recommended::after\{animation:none/.test(html) &&
  !/\.coach-suggestion--recommended[\s\S]*?gradient\(/.test(coachCss));
test("starter and follow-up suggestions share one canonical renderer/class system (no parallel chip CSS)",
  !/class="chip"/.test(html) && !html.includes('class="chips"') &&
  /renderCoachStarterPrompts/.test(coach) && /renderFollowUpActions/.test(coach));

const starterFactory = new Function(
  "document",
  `${extractFunction(coach, "buildCoachStarterPrompts")}
   return buildCoachStarterPrompts;`
);
const starterPrompts = planState => starterFactory({
  getElementById: id => id === "dailyBriefCard" ? { dataset: { planState } } : null
})();
test("saved workout context produces relevant session prompts",
  starterPrompts("workout").length === 3 &&
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
  /\.coach-rich-response\s*\{[^}]*gap:\s*16px[^}]*max-width:\s*640px/.test(html) &&
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
test("active conversations expose exactly two suggested-reply follow-ups, never more",
  followUpFactory({ response_type: "plan_change", actions: [{}] }).length === 2 &&
  /replies\.slice\(0, 2\)/.test(renderer));
test("large starter suggestions disappear after conversation starts",
  /coach-is-active \.coach-starters\s*\{display:none\}/.test(html) &&
  /hideCoachEmptyState\(\)/.test(extractFunction(coach, "addChatMessage")));
test("follow-up suggestions are mounted above the composer input, in the same vertical component as starters",
  coachScreen.indexOf('id="chips"') < coachScreen.indexOf('<div class="composer">') &&
  /coach-composer \.coach-followups\{margin:0 0 var\(--s-2\)/.test(html));

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
  /inset:0 0 calc\(var\(--athlevo-tabbar-height\) \+ var\(--athlevo-safe-bottom\)\)/.test(html) &&
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
test("dark mode remains token-driven and the full-width Coach header stays clear",
  /background:var\(--paper\)/.test(html) &&
  /color:var\(--text\)/.test(coachCss) &&
  /\.coach-side-panel\{[^}]*background:var\(--paper\);color:var\(--text\)/.test(html) &&
  /#screen-coachai \.coach-head\{[^}]*background:transparent[^}]*backdrop-filter:none/.test(html));
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

/**
 * Coach-led app: no paywall, no upgrade surfaces, no AI Coach chat, and the
 * Programs offer rebuilt in-app and shown once after sign-up.
 * Run: node tests/coach-led-app.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

let passed = 0, failed = 0;
const test = (name, condition, detail = "") => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name + (detail ? `  [${detail}]` : "")); }
};
const section = name => console.log(`\n──── ${name} ────`);
const read = f => readFileSync(f, "utf8");
const html = read("./index.html");

section("Flag");
const appMode = read("./js/appMode.js");
test("js/appMode.js turns the mode on and marks <html>", /ATHLEVO_COACH_LED = true/.test(appMode) && /classList\.add\("coach-led"\)/.test(appMode));
const firstScript = html.search(/<script src="js\/runtimeEnvironment\.js/);
test("appMode.js loads right after runtimeEnvironment.js and before every other app script",
  html.indexOf('<script src="js/appMode.js') > firstScript &&
  html.indexOf('<script src="js/appMode.js') < html.indexOf('<script src="js/landingContent.js'));
const srv = await import("../lib/server/appMode.js");
test("server mirror: on in Vercel, off locally, overridable",
  srv.coachLed({ VERCEL: "1" }) === true && srv.coachLed({}) === false &&
  srv.coachLed({ VERCEL: "1", ATHLEVO_COACH_LED: "0" }) === false && srv.coachLed({ ATHLEVO_COACH_LED: "1" }) === true);

section("Client entitlement (js/features.js)");
function loadPlan(flag, subscription) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    supabaseClient: {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: subscription, error: null }) }) }) })
    }
  };
  sandbox.window = sandbox;
  if (flag) sandbox.ATHLEVO_COACH_LED = true;
  new Function(...Object.keys(sandbox), read("./js/features.js"))(...Object.values(sandbox));
  return sandbox.AthlevoPlan;
}
const freeOn = loadPlan(true, null);
const freeOff = loadPlan(false, null);
test("coach-led: a free athlete resolves to paid_active Pro", freeOn.entitlement().accessState === "paid_active" && freeOn.entitlement().planId === "performance");
test("coach-led: every registered feature is usable", freeOn.canUse("daily_brief") && freeOn.canUse("weekly_analysis") && freeOn.canUse("adaptive_ai"));
test("flag off: the old free tier is unchanged", freeOff.entitlement().accessState === "free" && freeOff.canUse("daily_brief") === false);
test("the raw resolver stays untouched (server parity)", freeOn._resolveEntitlement(null).accessState === "free");
const elite = loadPlan(true, { plan_id: "elite", provider: "paymongo", status: "active" });
await elite.load();
test("coach-led never downgrades a paid Pro+ athlete", elite.entitlement().planId === "elite");

section("Acquisition gates (js/diagnosticAcquisition.js)");
const acq = read("./js/diagnosticAcquisition.js");
test("gateUnpaidAthlete lets everyone in under the flag", /gateUnpaidAthlete[\s\S]{0,600}ATHLEVO_COACH_LED === true[\s\S]{0,200}allowed: true/.test(acq));
test("resolveAfterAuth skips the payment-first funnel under the flag", /resolveAfterAuth[\s\S]{0,400}ATHLEVO_COACH_LED === true[\s\S]{0,200}handled: false/.test(acq));
test("showPaywall (as exported) does nothing under the flag", /function showPaywallUnlessCoachLed[\s\S]{0,120}ATHLEVO_COACH_LED === true\) return;/.test(acq) && !/showPaywall: showPaywall[,\s]/.test(acq));
test("a stored 'exited the paywall' marker is ignored", /function hasPaywallExit[\s\S]{0,160}ATHLEVO_COACH_LED === true\) return false/.test(acq));
const guard = read("./js/accessGuard.js");
test("openPaywall and the upgrade sheet are no-ops", /function openPaywall[\s\S]{0,200}if \(coachLed\(\)\) return/.test(guard) && /function showUpgradeSheet[\s\S]{0,80}if \(coachLed\(\)\) return/.test(guard));
test("the trial countdown is removed", /renderTrialIndicator[\s\S]{0,400}if \(coachLed\(\)\) \{ if \(existing\) existing\.remove\(\); return; \}/.test(guard));

section("Server access (lib/server/freemium.js)");
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
const realFetch = globalThis.fetch;
globalThis.fetch = async url => ({ ok: !String(url).includes("rpc"), json: async () => [] });
const { checkAccess } = await import("../lib/server/freemium.js");
process.env.ATHLEVO_COACH_LED = "1";
const on = await checkAccess("user-1");
process.env.ATHLEVO_COACH_LED = "0";
const off = await checkAccess("user-1");
globalThis.fetch = realFetch;
test("coach-led: a user with no subscription row gets paid Pro access", on.ok && on.paid === true && on.entitlement.planId === "performance" && !on.isPerformanceTrial);
test("flag off: the same user is free", off.ok && off.paid === false);

section("AI Coach chat is retired");
for (const f of ["api/coach.js", "lib/server/coachAnonymousEndpoint.js", "lib/server/diagnosticChatEndpoint.js"]) {
  test(`${f} answers 410 under the flag`, /coachLed\(\)[\s\S]{0,120}410/.test(read(f)));
}
const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
process.env.ATHLEVO_COACH_LED = "1";
const anon = (await import("../lib/server/coachAnonymousEndpoint.js")).default;
const out = res();
await anon({ method: "POST", body: { message: "hello" }, headers: {} }, out);
test("the anonymous coach endpoint really returns 410 AI_COACH_RETIRED", out.code === 410 && out.body.code === "AI_COACH_RETIRED");
process.env.ATHLEVO_COACH_LED = "0";
test("askCoach() does nothing under the flag", /async function askCoach\(question\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(window\.ATHLEVO_COACH_LED === true\) return;/.test(read("./js/coach.js")));
const am = read("./js/athleteMode.js");
test("Coach tab with no coach shows 'Your coach' + See programs, not the AI chat",
  /function restoreSelfGuidedCoachTab\(\) \{\s*if \(coachLedApp\(\)\) \{ renderNoCoachTab\(\); return; \}/.test(am) && /data-am-see-programs/.test(am) && /AthlevoPrograms\.open\("screen-coachai"\)/.test(am));
test("logged-out /ai and root land on the welcome screen, not an AI preview",
  /function showAnonymousCoachPreview\(\) \{[\s\S]{0,400}ATHLEVO_COACH_LED === true\) \{\s*showScreen\('screen-welcome'\);/.test(html));
test("AI chat history and 'New chat' are hidden from the side panel", /html\.coach-led \.coach-side-panel-chats,\s*html\.coach-led \.coach-side-panel-section:has\(\[onclick\*="new-chat"\]\)/.test(html));
test("the pre-signup diagnostic does not start under the flag", /ATHLEVO_COACH_LED !== true &&\s*window\.AthlevoDiagnostic && window\.AthlevoDiagnostic\.hasPending/.test(html));
test("the /pricing page is not shown under the flag", (html.match(/ATHLEVO_COACH_LED !== true\) \{/g) || []).length >= 1 && /path === "\/pricing" && window\.ATHLEVO_COACH_LED !== true/.test(html) && /pricingPath && window\.ATHLEVO_COACH_LED !== true/.test(html));

section("Welcome / sign-up screen");
test("/signup shows the same welcome screen: tagline visible, AI sign-up headline and value lines hidden",
  /html\.coach-led #screen-welcome\.is-ai-signup \.w-tag\{display:block\}/.test(html) &&
  /html\.coach-led #wAiSignupTitle,html\.coach-led #wAiSignupSub,html\.coach-led #wAiSignupTrust\{display:none!important\}/.test(html) &&
  /id="wAiSignupLegal"/.test(html));
test("the rail toggle is hidden below tablet width (it showed as a grey strip on phones)",
  /\.coach-rail-toggle\{display:none\}\n@media\(min-width:768px\)\{\s*:root\{--athlevo-rail-w:248px\}/.test(html));

section("Upgrade and plan UI");
test("the Home Pro card, trial indicator and Analyze-with-Coach buttons are hidden",
  /html\.coach-led \.af-card-analyze,\s*html\.coach-led #todayProUpgradeCard,\s*html\.coach-led #athlevoTrialIndicator\{display:none!important\}/.test(html));
test("Settings Plan card offers 'Upgrade to coaching', which opens programs.athlevo.org (not a Pro paywall)",
  /id="settingsPlanUpgradeCta"[\s\S]{0,80}onclick="openProgramsSite\('settings-upgrade'\)">Upgrade to coaching</.test(html) &&
  /cta\.textContent = 'Upgrade to coaching'/.test(html) && /ATHLEVO_PROGRAMS_URL = "https:\/\/programs\.athlevo\.org"/.test(appMode) &&
  /function openProgramsSite\(source\)[\s\S]{0,500}AthlevoRuntime\.openExternal\(url\)/.test(html));
test("an athlete who already has a coach sees who coaches them and no upgrade button",
  /nameEl\.textContent = 'Athlevo Coaching'/.test(html) && /You are coached by ' \+ coachName/.test(html) && /if \(cta\) cta\.hidden = true/.test(html));
test("the plan card's hidden attribute really hides it (the class used to override it)", /\.settings-plan-card\[hidden\]\{display:none\}/.test(html));
test("Home has no separate Coach row; Fuel is marked Beta and You has no Fuel card",
  !/id="homeCoachCard"/.test(html) && /<b>Fuel <span class="beta-tag">Beta<\/span><\/b>/.test(html) && !/id="youFuelEntry"/.test(html));
test("Coach tab names the coach with a photo: Coach Dean until real coach profiles exist",
  /function coachIdentity\(\)/.test(am) && /\/\^your\\s\+coach\$\/i\.test\(raw\)\) raw = "Dean"/.test(am) &&
  /dean: "assets\/store\/founder-640\.webp"/.test(am) && /coachAvatarHtml\(who, "am-human-coach-avatar"\)/.test(am));
test("Coach tab is a chat: name and photo header, boxed bubbles for both sides with times inside, day pills, pill composer with arrow send",
  /\.am-human-coach-head\{[^}]*grid-template-columns:40px minmax\(0,1fr\) 40px/.test(html) &&
  /\.am-human-message \.am-bubble\{/.test(html) && /\.am-human-message\.is-athlete \.am-bubble\{/.test(html) &&
  /\.am-bubble time\{float:right/.test(html) && /\.am-human-day\{align-self:center/.test(html) &&
  /class="am-human-day" role="separator"/.test(am) && /humanDayLabel\(message\.created_at\)/.test(am) &&
  /class="composer am-human-compose-box"/.test(am) && /type="submit" class="send" id="amHumanCoachSend"/.test(am));
test("screen, root and both controls exist", ["screen-programs", "programsRoot", "programsBack", "programsSkip"].every(id => html.includes(`id="${id}"`)));
test("the screen script is loaded; the store catalog is lazy-loaded on first open (the app shell never ships the storefront)",
  html.includes('<script src="js/programsScreen.js') && !html.includes("storeCatalog") && /tag\.src = "js\/storeCatalog\.js/.test(read("./js/programsScreen.js")));
test("routeAfterAuth shows Programs once, before onboarding",
  /coachLedApp && window\.AthlevoPrograms &&\s*window\.AthlevoPrograms\.shouldShowAfterSignup\(userId, profile\)[\s\S]{0,300}openWelcome[\s\S]{0,200}routeAfterAuth\(userId\)/.test(html) &&
  html.indexOf("shouldShowAfterSignup(userId, profile)") < html.indexOf("const completed =\n    profile &&"));

// Run the real module against the real catalog in a tiny DOM.
function fakeDom() {
  const byId = {};
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attrs = {}; this.listeners = {}; this._text = ""; this.className = ""; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set textContent(v) { this._text = String(v); if (v === "") this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    focus() {}
    querySelectorAll() { return []; }
    all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.all(pred, out)); return out; }
  }
  const doc = {
    createElement: t => new El(t),
    getElementById: id => byId[id] || (byId[id] = new El("div")),
    querySelector: () => null
  };
  return { doc, byId, El };
}
function loadPrograms(userStore = {}, offer = true) {
  const { doc, byId } = fakeDom();
  const shown = [];
  const posts = [];
  const opened = [];
  const sandbox = {
    document: doc, console, URL, Promise, setTimeout, JSON,
    localStorage: { getItem: k => userStore[k] ?? null, setItem: (k, v) => { userStore[k] = v; } },
    showScreen: id => shown.push(id),
    scrollTo() {},
    AthlevoRuntime: { openExternal: async url => { opened.push(url); return { ok: true }; } },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ checkout_url: "https://checkout.paymongo.com/abc" }) };
    }
  };
  sandbox.window = sandbox;
  if (offer) sandbox.ATHLEVO_PROGRAMS_OFFER = true;
  vm.runInNewContext(read("./js/storeCatalog.js"), sandbox);
  vm.runInNewContext(read("./js/programsScreen.js"), sandbox);
  return { P: sandbox.AthlevoPrograms, byId, shown, posts, opened, store: userStore, El: fakeDom().El };
}
const t = loadPrograms();
t.P.openWelcome("u1", () => {});
const root = t.byId.programsRoot;
const allText = root.textContent;
test("welcome mode shows the screen and the post-signup heading", t.shown.includes("screen-programs") && /Pick how you want to train/.test(allText));
test("all three priced programs render with their prices", ["Athlevo Plan", "Athlevo Coaching", "Elite Coaching", "₱1,998", "₱4,998", "₱7,998"].every(x => allText.includes(x)));
test("Hybrid Programming is listed as not available, not sellable", /Hybrid Programming/.test(allText) && /Not available yet/.test(allText));
test("athlete feedback, the three coaches and the FAQs are on the screen",
  /From Athlevo athletes/.test(allText) && ["Dean Vincent Castro", "Christian Francia", "Louie Agawa"].every(x => allText.includes(x)) && /Can I buy a program today\?/.test(allText) && /Do you coach runners outside Pampanga\?/.test(allText));
test("payment, renewal and non-refundable terms are shown with each Sign Up", (allText.match(/non-refundable/g) || []).length === 3);
test("no internal coach-support terms leak onto the screen", !/Support terms for this offer are not decided/.test(allText));
const buttons = root.all(n => n.tag === "button" && n.textContent === "Sign Up");
test("three Sign Up buttons, and Elite has no discount-code box", buttons.length === 3 && root.all(n => n.className === "prg-code").length === 2);
await buttons[0].listeners.click[0]();
await new Promise(r => setTimeout(r, 10));
test("Sign Up posts to the same checkout endpoint as the website and opens the hosted checkout externally",
  t.posts[0] && t.posts[0].url === "/api/plan-signup/checkout" && t.opened[0] === "https://checkout.paymongo.com/abc");
const cont = root.all(n => n.attrs && "data-programs-continue" in n.attrs)[0];
test("Continue is offered in welcome mode", !!cont);
let routed = 0;
const t2 = loadPrograms();
t2.P.openWelcome("u2", () => { routed += 1; });
t2.byId.programsRoot.all(n => n.attrs && "data-programs-continue" in n.attrs)[0].listeners.click[0]();
test("Continue records 'seen' for that user and re-runs routing", routed === 1 && t2.P.hasSeen("u2") && t2.store["athlevo_programs_seen:u2"] === "1");
test("it is offered once: not again after being seen, not to coaches, not after onboarding",
  t2.P.shouldShowAfterSignup("u2", { onboarding_complete: false }) === false &&
  t.P.shouldShowAfterSignup("u3", { onboarding_complete: false }) === true &&
  t.P.shouldShowAfterSignup("u3", { role: "coach" }) === false &&
  t.P.shouldShowAfterSignup("u3", { onboarding_complete: true }) === false);
const browse = loadPrograms();
browse.P.open("screen-coachai");
test("browse mode (from the Coach tab or Settings) has no Continue button and Back returns to the caller",
  browse.byId.programsRoot.all(n => n.attrs && "data-programs-continue" in n.attrs).length === 0 &&
  (browse.P.close(), browse.shown.at(-1) === "screen-coachai"));
test("the screen uses textContent only (no innerHTML) for catalog data", !/innerHTML/.test(read("./js/programsScreen.js").replace(/\/\*[\s\S]*?\*\//g, "")));

section("The app is free: Programs offer is off");
test("appMode.js turns the offer off", /ATHLEVO_PROGRAMS_OFFER = false/.test(appMode));
const freeApp = loadPrograms({}, false);
let ranOnDone = 0;
freeApp.P.openWelcome("u9", () => { ranOnDone += 1; });
test("with the offer off, nothing is shown after sign-up: routing just continues", ranOnDone === 1 && !freeApp.shown.includes("screen-programs"));
freeApp.P.open("screen-coachai");
test("with the offer off, Programs cannot be opened from anywhere", !freeApp.shown.includes("screen-programs") && freeApp.P.shouldShowAfterSignup("u9", { onboarding_complete: false }) === false && freeApp.P.isOn() === false);
test("no-coach Coach tab offers no purchase: it points to the coach's invite link",
  /You are not connected to a coach yet\. Ask your coach for their Athlevo invite link/.test(am) && /var offer = !!\(window\.AthlevoPrograms/.test(am));
test("the legacy freemium Settings upsell still exists behind the flag", /Legacy freemium app \(ATHLEVO_COACH_LED off\)/.test(html) && /proCta\.textContent = 'Upgrade to Pro'/.test(html));

section("No daily check-in pop-up");
test("appMode.js turns the morning prompt off", /ATHLEVO_MORNING_PROMPT = false/.test(appMode));
{
  const sb = { document: { addEventListener() {} }, console, setTimeout, Promise, Set, Date, localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, ATHLEVO_MORNING_PROMPT: false, openReadinessCheck: () => { sb.opened = true; } };
  sb.window = sb;
  vm.runInNewContext(read("./js/morningCheckIn.js").replace(/\}\)\(window\);\s*$/, "})(window);"), sb);
  const out = await sb.AthlevoMorningCheckIn.evaluate({ reason: "today-open" });
  test("with the prompt off, evaluate() never opens the readiness form", out.shown === false && out.reason === "disabled" && !sb.opened);
}
test("Home's status card leads with Training status (from Intervals.icu), not the daily readiness check-in", /id="todayTrainingStatusSignal"/.test(html) && /<span class="direction-signal-name">Training status<\/span>/.test(html) && existsSync("./js/trainingStatus.js"));

section("Home and favicon");
test("the brand mark on Home is sized for the wide AE logo, not clipped, and hidden where the rail shows it",
  /\.today-brand-mark\{display:flex;align-items:center;justify-content:center;\s*padding:14px 22px 8px\}/.test(html) && /\.today-brand-mark img\{display:block;width:auto;height:22px/.test(html) && /body\.layout-tablet \.today-brand-mark,body\.layout-desktop \.today-brand-mark\{display:none\}/.test(html));
test("a real favicon.ico (AE mark) ships at the site root and is linked first", existsSync("./favicon.ico") && read("./index.html").indexOf('href="/favicon.ico?v=ae1"') > 0 && read("./index.html").indexOf('href="/favicon.ico?v=ae1"') < read("./index.html").indexOf('favicon-32.png'));

section("Coached athlete's Home");
test("Home's first card: with no workouts it says so and its button goes to the coach (not the AI plan builder)",
  /noPlanTitle\.textContent = "No workouts yet\."/.test(html) && /noPlanAction\.textContent = "Message coach"/.test(html) &&
  /setAttribute\("onclick", "openCoachFromHome\(\)"\)/.test(html));
test("an athlete with no coach sees 'Connect with your coach' instead; everyone else 'Message coach'",
  /action\.textContent = notConnected \? "Connect with your coach" : "Message coach"/.test(am) && /Connect with your coach and their workouts will show up here/.test(html) && /Your coach adds your workouts here/.test(html));
test("the AI plan-builder note is hidden on Home; Calendar's builder button is hidden for coached athletes",
  /html\.coach-led #todayNoPlanState \.today-state-note,\s*body\.athlete-coached \.train-empty \.primary-btn\{display:none!important\}/.test(html));
test("the desktop Home greeting clears the rail toggle", /body\.layout-desktop #screen-today \.today-header\{margin-top:72px\}/.test(html));

section("Sending a message to the coach");
{
  const { validateCoachMessage } = await import("../lib/server/coachMessaging.js");
  const gateway = read("./api/providers/index.js");
  test("the server reads {message:{body}}; a bare string is not a message", validateCoachMessage({ body: "hi" }).ok !== false && validateCoachMessage("hi").ok === false);
  test("the client sends the shape the server validates ({ message: { body } })", /JSON\.stringify\(\{ message: \{ body: message \} \}\)/.test(am));
  test("the athlete POST accepts either the object or a bare string", /typeof incoming === "string" \? \{ body: incoming \} : incoming/.test(gateway));
}
test("sending is optimistic: the bubble appears at once as pending, and is removed with the text restored if the send fails",
  /var pendingId = "pending-" \+ Date\.now\(\)/.test(am) && /pending: true/.test(am) && /is-pending/.test(am) && /Sending…/.test(am) &&
  /filter\(function \(item\) \{ return item\.id !== pendingId; \}\)/.test(am) && /amHumanCoachInput/.test(am));
test("only newly arrived bubbles animate (seen-id tracking), so re-renders and polling never replay the animation",
  /_seenMessageIds/.test(am) && /markMessagesSeen/.test(am) && /is-new/.test(am));
test("the send animation: sender bubble springs in, coach bubble fades in, send button pops, all off under reduced motion",
  /@keyframes amBubbleSend/.test(html) && /@keyframes amBubbleArrive/.test(html) && /@keyframes amSendPop/.test(html) &&
  /\.am-human-message\.is-athlete\.is-new\{[^}]*amBubbleSend/.test(html) && /\.send\.is-popped\{[^}]*amSendPop/.test(html) &&
  /prefers-reduced-motion[\s\S]{0,400}\.am-human-message\.is-new/.test(html));
test("incoming coach replies appear without reopening the tab (quiet polling, only while the Coach tab is open)",
  /ensureMessagePolling/.test(am) && /setInterval\(/.test(am));

section("Scripts are cache-busted");
test("service-worker cache and script versions were raised together (stale JS can no longer pair with new HTML)",
  /athlevo-shell-v97/.test(read("./service-worker.js")) && existsSync("./tests/js-version-lock.test.mjs") && existsSync("./scripts/js-version-lock.json"));

section("Coach Home and navigation");
{
  const cm = read("./js/coachMode.js");
  const tabs = cm.slice(cm.indexOf("var COACH_TABS = ["), cm.indexOf("];", cm.indexOf("var COACH_TABS = [")));
  test("a coach's tabs are Home, Messages, Analytics, You; no Calendar or Train", (tabs.match(/screen:/g) || []).length === 4 && /label: "Home"/.test(tabs) && !/Calendar|Train/.test(tabs));
  test("the desktop sidebar is rewritten for coaches (same four, plus Settings) and restored for athletes",
    /function rewriteRail\(\)/.test(cm) && /AthlevoCoachMode\.go\(this\)/.test(cm) && /openSettings\(\)/.test(cm) &&
    /rewriteRail\(\);\s*\/\/ Hide athlete profile avatar/.test(cm) && /restoreAthleteRail\(\);\s*\/\/ Re-show profile avatar/.test(cm));
  test("coach Home is the My Athletes table; a row opens that athlete's training calendar",
    /<h1>My Athletes<\/h1>/.test(cm) && /openCoachAthletePage\(row\.getAttribute\("data-open-athlete"\), "training"\)/.test(cm));
}

section("Fuel is locked for now");
{
  const fuel = read("./js/fuel.js");
  test("a single switch in appMode.js locks Fuel (set it to false to open Fuel again)", /root\.ATHLEVO_FUEL_LOCKED = true/.test(appMode));
  test("with the lock on, opening Fuel shows the notice and never opens the screen",
    /function open\(source\) \{\s*if \(isLocked\(\)\) \{ showLockedNotice\(\); return false; \}/.test(fuel) &&
    /Fuel is locked/.test(fuel) && /Fuel will only be available for coaching clients\./.test(fuel));
  test("the Home entry stays visible and shows a lock instead of the arrow",
    /entry\.classList\.toggle\("is-locked", isLocked\(\)\)/.test(fuel) && /\.home-fuel\.is-locked \.arr\{display:none\}/.test(html) && /class="fuel-lock-glyph"/.test(html));
  test("the notice sheet sits above the tab bar", /\.fuel-lock-overlay\{[^}]*z-index:1200/.test(html));
}

section("Packaged for Android");
const markers = read("./scripts/check-native-assets.mjs");
test("native asset check pins the Programs screen and the coach-led flag",
  markers.includes('id="screen-programs"') && markers.includes("ATHLEVO_COACH_LED = true"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

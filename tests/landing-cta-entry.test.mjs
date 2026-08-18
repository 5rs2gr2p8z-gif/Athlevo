/* Focused regression coverage for public landing CTAs entering the app flow. */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const content = readFileSync("./js/landingContent.js", "utf8");
const landing = html.slice(
  html.indexOf('<section class="screen lp" id="screen-landing">'),
  html.indexOf('<section class="screen" id="screen-welcome">')
);

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}`);
  const end = nextName ? html.indexOf(`function ${nextName}`, start + 1) : -1;
  return html.slice(start, end > start ? end : undefined);
}

const landingStart = functionSource("landingStartFree", "landingStartBeta");
const landingOpen = functionSource("landingOpenApp", "landingStartFree");
const restore = functionSource("restoreSession", "endBootGate");
const logout = functionSource("doLogout", "openDeleteAccount");

function createHandlers(sessionUserId) {
  const calls = [];
  const factory = new Function(
    "initialSessionUserId",
    "openAthlevoApp",
    "rememberAppEntryIntent",
    "rememberLandingAuthEntry",
    "trackAuthChoice",
    "interceptInAppAuthHandoff",
    "openAppEntry",
    `let athlevoSessionUserId = initialSessionUserId;
     ${landingOpen}
     ${landingStart}
     return { landingOpenApp, landingStartFree };`
  );
  const handlers = factory(
    sessionUserId,
    () => calls.push("app"),
    () => calls.push("intent"),
    source => calls.push(`entry:${source}`),
    (event, properties) => calls.push(`analytics:${event}:${properties.cta_location}`),
    () => false,
    () => calls.push("welcome")
  );
  return { handlers, calls };
}

console.log("\n──── CTA markup and native interaction ────");
const trainLinks = [...landing.matchAll(
  /<a class="lp-btn(?: sm| light)" href="#train-with-athlevo">Train With Athlevo<\/a>/g
)];
test("the remaining Train With Athlevo CTA is an in-page anchor to the offers section", trainLinks.length === 1);
test("Train With Athlevo navigates to Ways to Train, not app entry", trainLinks.every(match => match[0].includes('href="#train-with-athlevo"') && !match[0].includes("landingOpenApp")));
test("Start Training remains approved offer copy and signup location", /cta: "Start Training"[\s\S]*?appEntry: true,[\s\S]*?ctaLocation: "ai_product"/.test(content));
test("Start Training renders as a native button", /node\(offer\.appEntry \? "button" : "a", "lp-btn lp-offer-cta", offer\.cta\)/.test(content) && /cta\.type = "button"/.test(content));
test("Start Training invokes the same authoritative handler", /cta\.addEventListener\("click", \(\) => global\.landingStartFree\(cta\)\)/.test(content));
test("native buttons provide Enter and Space activation without custom key handlers", !/keydown|keyup|keypress/.test(content.slice(content.indexOf("function renderTrainingOffers"), content.indexOf("function renderStories"))));
test("landing buttons retain visible keyboard focus", /button:focus-visible/.test(html) && /outline:2px solid var\(--focus-ring\)/.test(html));
test("normal landing CTAs are not pointer-blocked", !/\.lp-btn(?:\[[^\]]+\]|\.[\w-]+)?\{[^}]*pointer-events:none/.test(html));
test("landing skeleton stops intercepting after reveal", /\.lp-section-revealed \.lp-skel\{display:none\}/.test(html));

console.log("\n──── Shared app-entry routing ────");
test("Start Training records tab-scoped app intent and opens app entry",
  /rememberAppEntryIntent\(\)/.test(landingStart) && /openAppEntry\(\)/.test(landingStart));
test("authenticated Start Training delegates to role-aware app routing",
  /if \(athlevoSessionUserId\) \{ openAthlevoApp\(\); return; \}/.test(landingStart) &&
  /async function openAthlevoApp\(\)[\s\S]*?routeAfterAuth\(athlevoSessionUserId\)/.test(html));
test("public signed-out browser still resolves to landing",
  /else \{\s*showScreen\("screen-landing"\)/.test(restore));
test("logout still records app-entry intent and opens welcome",
  /rememberAppEntryIntent\('logout'\)/.test(logout) && /showScreen\('screen-welcome'\)/.test(logout));
test("CTA analytics remain attached to the shared entry handler",
  /trackAuthChoice\("signup_cta_clicked"/.test(landingStart) && /cta_location: locationName/.test(landingStart));
test("cache-busted landing script prevents the stale fragment-link renderer from surviving deployment",
  /<script src="js\/landingContent\.js\?v=78"><\/script>/.test(html));

console.log("\n──── Executable CTA routing ────");
test("Train With Athlevo CTAs use in-page anchors, not JS handlers",
  !/<(?:button|a)[^>]*onclick="landingOpenApp\(\)"[^>]*>Train With Athlevo/.test(landing));
{
  const { handlers, calls } = createHandlers(null);
  handlers.landingStartFree({ dataset: { ctaLocation: "ai_product" }, textContent: "Start Training" });
  test("anonymous Start Training records signup intent then opens app entry",
    calls.join("|") === "entry:ai_product|analytics:signup_cta_clicked:ai_product|intent|welcome");
}
{
  const { handlers, calls } = createHandlers("athlete-or-coach-user");
  handlers.landingStartFree({ dataset: { ctaLocation: "ai_product" }, textContent: "Start Training" });
  test("authenticated Start Training delegates directly to role-aware app routing",
    calls.join("|") === "app");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

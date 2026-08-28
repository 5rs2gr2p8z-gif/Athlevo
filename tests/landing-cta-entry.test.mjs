/* Focused regression coverage for public landing CTAs entering the app flow. */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const content = readFileSync("./js/landingContent.js", "utf8");
const analytics = readFileSync("./js/analytics.js", "utf8");
const registry = readFileSync("./js/analyticsRegistry.js", "utf8");
const landing = html.slice(
  html.indexOf('<section class="screen lp" id="screen-landing">'),
  html.indexOf('<section class="screen" id="screen-welcome">')
);

const FACEBOOK_COACHING =
  "https://www.facebook.com/profile.php?id=61574957235305";

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
const restore = functionSource("restoreSession", "endBootGate");
const logout = functionSource("doLogout", "openDeleteAccount");

function aiTrigger(overrides = {}) {
  return {
    dataset: { ctaLocation: "ai_product" },
    textContent: "Start Training",
    getAttribute(name) { return name === "href" ? "/ai" : null; },
    ...overrides
  };
}

function createHandlers(sessionUserId, { intercept = false } = {}) {
  const calls = [];
  const factory = new Function(
    "initialSessionUserId",
    "rememberLandingAuthEntry",
    "trackAuthChoice",
    "interceptInAppAuthHandoff",
    "locationAssign",
    `let athlevoSessionUserId = initialSessionUserId;
     const window = { location: { assign: locationAssign } };
     ${landingStart}
     return { landingStartFree };`
  );
  const handlers = factory(
    sessionUserId,
    source => calls.push(`entry:${source}`),
    (event, properties) => calls.push(
      `analytics:${event}:${properties.cta_location}:${properties.destination}:${properties.cta_text}`
    ),
    () => {
      calls.push("intercept");
      return intercept;
    },
    url => calls.push(`nav:${url}`)
  );
  return { handlers, calls };
}

console.log("\n──── CTA markup and native interaction ────");
test("no public landing CTA still says Install Athlevo — Free",
  !/Install Athlevo — Free/.test(landing));
test("hero Start Training is a same-tab /ai link",
  /<a class="lp-btn" href="\/ai" data-cta-location="hero_ai" onclick="return landingStartFree\(this\)">Start Training<\/a>/.test(landing));
test("showcase Start Training is a same-tab /ai link",
  /<a class="lp-btn" href="\/ai" data-cta-location="showcase_ai" onclick="return landingStartFree\(this\)">Start Training<\/a>/.test(landing));
test("Train With Athlevo is the primary self-serve /ai CTA",
  /<a class="lp-btn sm" href="\/ai">Train With Athlevo<\/a>/.test(landing) &&
  !/href="#train-with-athlevo">Train With Athlevo/.test(landing));
test("Train With Athlevo does not use a JS popup or Open App handler",
  !/<(?:button|a)[^>]*onclick="landingOpenApp\(\)"[^>]*>Train With Athlevo/.test(landing) &&
  !/window\.open\(/.test(landingStart));
test("Start Training remains approved offer copy and signup location",
  /cta: "Start Training"[\s\S]*?href: "\/ai"[\s\S]*?appEntry: true,[\s\S]*?ctaLocation: "ai_product"/.test(content));
test("Athlevo AI Start Training renders as a same-tab /ai anchor",
  /node\("a", "lp-btn lp-offer-cta", offer\.cta\)/.test(content) &&
  /cta\.href = offer\.href/.test(content) &&
  !/cta\.type = "button"/.test(content));
test("Athlevo AI Start Training still uses the shared analytics handler",
  /global\.landingStartFree\(cta\) === false/.test(content));
test("human coaching offer CTAs open Facebook in a new tab",
  /cta: "Get My Plan",\s*href: "https:\/\/www\.facebook\.com\/profile\.php\?id=61574957235305"/.test(content) &&
  /cta: "Start Coaching",\s*href: "https:\/\/www\.facebook\.com\/profile\.php\?id=61574957235305"/.test(content) &&
  /cta: "Apply for Elite",\s*href: "https:\/\/www\.facebook\.com\/profile\.php\?id=61574957235305"/.test(content) &&
  /cta\.target = "_blank"/.test(content) &&
  /cta\.rel = "noopener noreferrer"/.test(content));
test("Explore Coaching is a human-coaching Facebook CTA",
  landing.includes(`href="${FACEBOOK_COACHING}" target="_blank" rel="noopener noreferrer">Explore Coaching</a>`));
test("Talk to a Coach is a human-coaching Facebook CTA",
  landing.includes(`href="${FACEBOOK_COACHING}" target="_blank" rel="noopener noreferrer">Talk to a Coach</a>`));
test("AI CTAs do not go directly to checkout or signup",
  !/href="\/ai-signup"/.test(landing) &&
  !/href="[^"]*checkout/.test(landing) &&
  !/openAppEntry\(\)/.test(landingStart) &&
  !/openAthlevoApp\(\)/.test(landingStart) &&
  /destination: "\/ai"/.test(landingStart));
test("native links provide Enter and Space activation without custom key handlers",
  !/keydown|keyup|keypress/.test(content.slice(content.indexOf("function renderTrainingOffers"), content.indexOf("function renderStories"))));
test("landing buttons retain visible keyboard focus",
  /button:focus-visible/.test(html) && /outline:2px solid var\(--focus-ring\)/.test(html));
test("normal landing CTAs are not pointer-blocked",
  !/\.lp-btn(?:\[[^\]]+\]|\.[\w-]+)?\{[^}]*pointer-events:none/.test(html));
test("landing skeleton stops intercepting after reveal",
  /\.lp-section-revealed \.lp-skel\{display:none\}/.test(html));

console.log("\n──── Shared /ai routing ────");
test("Start Training navigates to /ai instead of starting diagnostic in place",
  /window\.location\.assign\("\/ai"\)/.test(landingStart) &&
  !/AthlevoDiagnosticUI/.test(landingStart) &&
  !/rememberAppEntryIntent\(\)/.test(landingStart));
test("public signed-out browser still resolves to landing",
  /else \{\s*showScreen\("screen-landing"\)/.test(restore));
test("logout still records app-entry intent and opens welcome",
  /rememberAppEntryIntent\('logout'\)/.test(logout) && /showScreen\('screen-welcome'\)/.test(logout));
test("CTA analytics remain attached to the shared entry handler",
  /trackAuthChoice\("signup_cta_clicked"/.test(landingStart) &&
  /cta_location: locationName/.test(landingStart) &&
  /destination: "\/ai"/.test(landingStart));
test("Start Training is an approved analytics cta_text",
  /APPROVED_CTA_TEXT = \{ "Build My Training Plan": true, "Start Training": true \}/.test(analytics) &&
  /APPROVED_CTA_TEXT = \{ "Build My Training Plan": true, "Start Training": true \}/.test(registry));
test("cache-busted landing script prevents the stale fragment-link renderer from surviving deployment",
  /<script src="js\/landingContent\.js\?v=79"><\/script>/.test(html));

console.log("\n──── Executable CTA routing ────");
{
  const { handlers, calls } = createHandlers(null);
  const proceeded = handlers.landingStartFree(aiTrigger());
  test("anonymous Start Training fires signup_cta_clicked once with destination /ai",
    proceeded === true &&
    calls.join("|") === "entry:ai_product|analytics:signup_cta_clicked:ai_product:/ai:Start Training|intercept");
}
{
  const { handlers, calls } = createHandlers(null);
  handlers.landingStartFree({
    dataset: { ctaLocation: "hero_ai" },
    textContent: "Start Training"
  });
  test("href-less Start Training falls back to same-tab /ai navigation",
    calls.includes("nav:/ai") &&
    calls.filter(call => call.startsWith("analytics:")).length === 1 &&
    !calls.some(call => call === "nav:/ai-signup" || call.startsWith("nav:") && call !== "nav:/ai"));
}
{
  const { handlers, calls } = createHandlers("athlete-or-coach-user");
  const proceeded = handlers.landingStartFree(aiTrigger());
  test("authenticated Start Training skips signup analytics and still enters through /ai",
    proceeded === true && calls.join("|") === "");
}
{
  const { handlers, calls } = createHandlers(null, { intercept: true });
  const proceeded = handlers.landingStartFree(aiTrigger());
  test("in-app browser intercept still cancels native /ai navigation once",
    proceeded === false &&
    calls.filter(call => call.startsWith("analytics:")).length === 1 &&
    !calls.includes("nav:/ai"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

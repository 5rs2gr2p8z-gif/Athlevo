/*
 * /webinar and /webinar/thank-you: the pages, their wording, head tags, form markup, styling rules
 * and routing. Run: node tests/webinar-pages.test.mjs
 *
 * Wording is checked two ways: every string in content/webinar.mjs must be on the built page
 * (so a hand edit to the HTML is caught), and the lines marked CONTRACT below are the copy as
 * supplied, repeated here on purpose. If you change that wording deliberately, change it in
 * content/webinar.mjs, rebuild, and update the matching CONTRACT line.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { buildWebinarPages, staleWebinarFiles } from "../scripts/build-webinar-pages.mjs";
import { DISTANCES, LANDING, SESSION, SITE, THANKS, TRAINING, sessionDetails } from "../content/webinar.mjs";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : "")); }
};
const section = (s) => console.log("\n──── " + s + " ────");

const landing = readFileSync("webinar.html", "utf8");
const thanks = readFileSync("webinar-thank-you.html", "utf8");
const css = readFileSync("webinar.css", "utf8");
const storeCss = readFileSync("store.css", "utf8");
const script = readFileSync("js/webinar.js", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));

const head = (html) => (html.match(/<head>([\s\S]*?)<\/head>/) || [, ""])[1];
const body = (html) => (html.match(/<body[\s\S]*<\/body>/) || [""])[0];
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The visible text of a page: tags removed, entities decoded, scripts and comments dropped. */
const visible = (html) => decode(body(html).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, ""));
const strip = (s) => String(s).replace(/\*/g, "");
const metaContent = (html, key, attr = "name") =>
  decode((html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`)) || [, null])[1] || "");
const has = (html, s) => html.includes(s);

// ---- 1. Built from the content file ----------------------------------------------------------
section("1. Pages are built from content/webinar.mjs");
{
  t("both generated pages are up to date (run: node scripts/build-webinar-pages.mjs)", staleWebinarFiles().length === 0, staleWebinarFiles().join());
  {
    // A Pixel pasted into the marked spot of either page survives a rebuild, in place and unchanged.
    const snippet = "<script>!function(f,b,e,v,n,t,s){}(window,document,'script');fbq('init','123');fbq('track','PageView');</script>\n  <noscript><img height=\"1\" width=\"1\" alt=\"\" src=\"https://www.facebook.com/tr?id=123&ev=PageView&noscript=1\"></noscript>\n";
    const clean = buildWebinarPages();
    const withPixel = clean.map(f => ({ ...f, content: f.content.replace("  <!-- /META PIXEL -->", "  " + snippet + "  <!-- /META PIXEL -->") }));
    const existing = Object.fromEntries(withPixel.map(f => [f.path, f.content]));
    const rebuilt = buildWebinarPages(SESSION, existing);
    t("a Meta Pixel pasted into the marked spot is kept when the pages are rebuilt", rebuilt.every((f, i) => f.content === withPixel[i].content && f.content.includes("fbq('init','123')")));
    const dated = buildWebinarPages({ date: "Nov 22", time: "6 PM" }, existing);
    t("and it is kept when the date and time change", dated.every(f => f.content.includes("fbq('init','123')")) && dated.every(f => f.content.indexOf("fbq('init','123')") < f.content.indexOf('rel="stylesheet"')));
    t("an empty spot stays empty on rebuild", buildWebinarPages(SESSION, Object.fromEntries(clean.map(f => [f.path, f.content]))).every((f, i) => f.content === clean[i].content));
  }
  const built = buildWebinarPages();
  t("the build produces exactly webinar.html and webinar-thank-you.html", built.map(f => f.path).join() === "webinar.html,webinar-thank-you.html");

  const edited = buildWebinarPages({ date: "Sunday, November 15, 2026", time: "7:00 PM Manila" });
  const L = edited[0].content, T = edited[1].content;
  t("the date and time are set in one place and appear on both pages",
    /<dt>Date<\/dt><dd>Sunday, November 15, 2026<\/dd>/.test(L) && /<dt>Time<\/dt><dd>7:00 PM Manila<\/dd>/.test(L) &&
    /<dt>Date<\/dt><dd>Sunday, November 15, 2026<\/dd>/.test(T) && /<dt>Time<\/dt><dd>7:00 PM Manila<\/dd>/.test(T));
  const normal = (html) => html.replace(/Sunday, November 15, 2026|7:00 PM Manila/g, SESSION.date);
  t("changing the date and time changes nothing else on either page",
    normal(L) === buildWebinarPages()[0].content.replace(/To be announced/g, SESSION.date) && normal(T) === buildWebinarPages()[1].content.replace(/To be announced/g, SESSION.date));
  const tricky = buildWebinarPages({ date: "<b>Nov</b> & 22", time: "6 \"PM\"" })[0].content;
  t("a date or time with symbols is escaped, never injected as markup", !tricky.includes("<b>Nov</b>") && tricky.includes("&lt;b&gt;Nov&lt;/b&gt; &amp; 22"));
  t("until you set them the date and time read 'To be announced'", SESSION.date === "To be announced" && SESSION.time === "To be announced" &&
    sessionDetails().slice(0, 2).every(([, v]) => v === "To be announced"));
}

// ---- 2. Wording -------------------------------------------------------------------------------
section("2. Wording");
{
  const text = visible(landing);
  const everyString = [];
  const collect = (value) => {
    if (typeof value === "string") everyString.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  const SKIP = new Set([LANDING.title, LANDING.description, LANDING.ogTitle, LANDING.ogDescription, LANDING.form.errors.submit]);
  collect(LANDING);
  const missing = everyString.filter(s => !SKIP.has(s) && !s.includes("*") && !text.includes(s) && !text.replace(/\s+/g, " ").includes(s));
  const emphasised = everyString.filter(s => s.includes("*")).filter(s => !text.includes(strip(s)));
  t("every line in the content file is on the landing page", missing.length === 0, missing[0]);
  t("every emphasised heading is on the page with its word wrapped in <em>",
    emphasised.length === 0 && [...landing.matchAll(/<em>([^<]+)<\/em>/g)].map(m => m[1]).join("|") === ["guessing", "you", "Castro", "Ignite", "register", "Athlevo"].join("|"));
  t("the submit failure message is on the page for the script to show", has(landing, `data-message="${LANDING.form.errors.submit}"`));

  const thanksText = visible(thanks);
  const thanksStrings = [];
  const gather = (value) => {
    if (typeof value === "string") thanksStrings.push(value);
    else if (Array.isArray(value)) value.forEach(gather);
    else if (value && typeof value === "object") Object.values(value).forEach(gather);
  };
  gather(THANKS);
  const thanksMissing = thanksStrings.filter(s => s !== THANKS.title && !s.includes("*") && !thanksText.includes(s));
  t("every line in the thank-you content is on the thank-you page", thanksMissing.length === 0, thanksMissing[0]);

  // CONTRACT: the supplied copy, word for word.
  const contract = [
    "Stop guessing your training.",
    "Online endurance coaching for Filipino runners who are committed to the personal pursuit of excellence.",
    "Join the free session",
    "Free online session for runners at Ignite the Grit Run, in partnership with JCIR Events Management.",
    "Coaching built around you.",
    "Training built around your fitness, your schedule and your race goal.",
    "Running coaches and a strength and conditioning coach, working on one team.",
    "Coach support with regular reviews, assessments and adjustments as you train.",
    "Plans start at ₱1,998/month.",
    "Dean Castro",
    "Dean is a competitive runner and the founder of Athlevo Coaching. He has coached more than 300 runners online, with training built around each runner's fitness, schedule and race goal.",
    "USATF Level 1 coach", "STRYD Certified Running Coach",
    "A free session for Ignite the Grit Run runners.",
    "We are teaching a live online session with Q&A for runners at Ignite the Grit Run on November 22, 2026, in partnership with JCIR Events Management. Everyone is welcome.",
    "Live online, with Q&A",
    "Made for runners who train without a structured plan. If you already follow a periodized plan, this one may be too basic, but you are welcome to join the Q&A.",
    "Save your seat",
    "Free. We will send the link and reminders by message.",
    "Full name", "Mobile number (for the link and reminders)", "Email (optional)", "Your race distance", "How do you train right now?", "A question for the session (optional)",
    "Choose one", "Not registered yet", "No set plan. I run when I can", "A loose weekly routine", "I follow a structured plan",
    "Register free",
    "We use your details to send the session link and reminders, and to follow up about Athlevo Coaching. Reply STOP to any message to opt out.",
    "Enter your full name.", "Enter a mobile number we can message.", "Enter a valid email address.", "Choose your race distance.", "Choose how you train right now.",
    "Before you register.",
    "Is it really free?",
    "Yes. There is nothing to buy. At the end we will explain how Athlevo Coaching works, and runners registered for JCIR races get 10% off if they want to continue. There is no pressure.",
    "Do I need to be registered for Ignite the Grit Run?",
    "The session is made for runners at this race, but you can register either way. Choose \"Not registered yet\" for your distance.",
    "Who is the session for?",
    "Will there be a replay?", "Yes. We record the session and send the replay to everyone who registers.",
    "What if I have pain or an injury?",
    "See a doctor or physiotherapist. We share general guidance for healthy runners and cannot diagnose anything.",
    "Join the free session with Athlevo.",
    "Athlevo Coaching · athlevo.org · In partnership with JCIR Events Management.",
    "General guidance for healthy runners. If something hurts or feels wrong, stop and see a doctor. We do not promise finish times or placings."
  ];
  const off = contract.filter(s => !text.includes(s));
  t("the supplied landing-page copy is on the page word for word", off.length === 0, off[0]);
  t("the form failure message is word for word",
    has(landing, 'data-message="Something went wrong. Please try again, or message Athlevo Coaching on Instagram or Facebook."'));
  t("the plain line under the cards is the only price on the page", (text.match(/₱/g) || []).length === 1);

  const contractThanks = [
    "Registration received", "You're in.", "Thank you. Here is what happens next.",
    "Watch your messages", "We will send the session link and reminders to the mobile number you gave.",
    "Send us your questions", "Reply to any message with what you want covered. We will answer as many as we can live.",
    "Live online, with Q&A",
    "Ignite the Grit Run · November 22, 2026 · In partnership with JCIR Events Management.",
    "Athlevo Coaching · athlevo.org",
    "General guidance for healthy runners. If something hurts or feels wrong, stop and see a doctor."
  ];
  const offThanks = contractThanks.filter(s => !thanksText.includes(s));
  t("the supplied thank-you copy is on the page word for word", offThanks.length === 0, offThanks[0]);
  t("the thank-you footer is the shorter one (no finish-time line)", !thanksText.includes("We do not promise finish times"));

  // Nothing the brief ruled out.
  const everything = (text + " " + thanksText).toLowerCase();
  for (const word of ["testimonial", "agenda", "topic", "template", "download", "countdown", "spots left", "limited seats", "before and after", "personal best", "pr of"]) {
    t(`the pages do not mention "${word}"`, !everything.includes(word));
  }
  t("no results, stats or percentages beyond the one in the FAQ", (text.match(/\d+\s?%/g) || []).join() === "10%" && !/\b(finishers?|athletes? coached|years)\b/i.test(text));
  t("no emoji on either page or in the form script", !/\p{Extended_Pictographic}/u.test(landing + thanks + script));
  t("no popups, dialogs or sticky bars in the markup or the styles",
    !/<dialog|role="dialog"|aria-modal|position:\s*(sticky|fixed)|setInterval|countdown/i.test(landing + thanks + css + script));
}

// ---- 3. Structure and the one conversion ---------------------------------------------------------
section("3. Structure");
{
  const order = [...landing.matchAll(/<(?:section|header|footer)[^>]*?(?:id="([^"]+)"|class="([^"]+)")/g)].map(m => m[1] || m[2]);
  const sectionOrder = ["hero-heading", "how", "coach", "session", "faq", "closing", "site-footer"];
  const positions = ["aria-labelledby=\"hero-heading\"", 'id="how"', 'id="coach"', 'id="session"', 'id="faq"', 'class="section closing"', 'class="site-footer"'].map(s => landing.indexOf(s));
  t("sections appear in the order: hero, how it works, coach, session, FAQ, closing, footer",
    positions.every((p, i) => p > -1 && (i === 0 || p > positions[i - 1])), positions.join());
  t("the header is the wordmark only, and the logo is small (no image)", /<header class="site-header">\s*<div class="nav"><span class="wordmark">Athlevo<i aria-hidden="true">\.<\/i><\/span><\/div>\s*<\/header>/.test(landing));
  t("exactly one h1 on each page", (landing.match(/<h1[ >]/g) || []).length === 1 && (thanks.match(/<h1[ >]/g) || []).length === 1);
  t("headings never skip a level (h1, h2, h3 only, h3 only inside a section with an h2)",
    !/<h[4-6]/.test(landing) && landing.indexOf("<h2") > landing.indexOf("<h1"));
  t("semantic landmarks: header, main, footer on both pages",
    [landing, thanks].every(h => /<header[ >]/.test(h) && /<main[ >]/.test(h) && /<footer[ >]/.test(h) && /<html lang="en">/.test(h)));
  t("a skip link points at the main content", [landing, thanks].every(h => has(h, '<a class="skip" href="#main">') && has(h, '<main id="main"')));

  const links = [...landing.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(m => m[1]);
  t("the only links in the page are the skip link and buttons that scroll to the form", links.every(h => h === "#main" || h === "#register") && links.filter(h => h === "#register").length === 2, links.join());
  t("the form exists once, with the id the buttons point at", (landing.match(/<form[ >]/g) || []).length === 1 && has(landing, '<form class="webinar-form" id="register"'));
  const primary = [...landing.matchAll(/<a class="btn btn-red btn-lg" href="#register">([^<]+)<\/a>/g)].map(m => m[1]);
  t("both primary buttons scroll to the form, with the supplied labels", primary.join("|") === "Join the free session|Register free", primary.join("|"));
  t("the hero button comes before the form and the closing button after it",
    landing.indexOf(">Join the free session<") < landing.indexOf('id="register"') && landing.indexOf(">Register free</a>") > landing.indexOf('id="register"'));
  t("the thank-you page has no form and no links out", !/<form|<a\s[^>]*href="(?!#main)/.test(body(thanks)));
  t("the details block comes before the form (the form follows the details on a phone)",
    landing.indexOf('<dl class="pdp-facts">') > -1 && landing.indexOf('<dl class="pdp-facts">') < landing.indexOf('<form class="webinar-form"'));
  t("the details block lists date, time, format, cost in that order",
    [...landing.matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]).join() === "Date,Time,Format,Cost" &&
    [...thanks.matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]).join() === "Date,Time,Format,Cost");
  t("the FAQ is a list of details/summary with five questions and the first one open",
    (landing.match(/<details/g) || []).length === 5 && (landing.match(/<details open>/g) || []).length === 1 && landing.indexOf("<details open>") < landing.indexOf("<summary>Do I need"));
}

// ---- 4. The form ----------------------------------------------------------------------------------
section("4. Form");
{
  const form = (landing.match(/<form[\s\S]*?<\/form>/) || [""])[0];
  t("posts to the registration endpoint", has(form, 'method="post"') && has(form, `action="${SITE.registerApi}"`) && has(form, "novalidate"));
  const field = (name) => (form.match(new RegExp(`<(?:input|select|textarea)[^>]*name="${name}"[^>]*>`)) || [""])[0];
  const names = [...form.matchAll(/<(?:input|select|textarea)[^>]*name="([^"]+)"/g)].map(m => m[1]);
  t("the fields are name, mobile, email, distance, training, question (plus the trap)", names.join() === "name,mobile,email,distance,training,question,contact_website", names.join());
  t("name is required text", /type="text"/.test(field("name")) && /\brequired\b/.test(field("name")));
  t("mobile is required and type tel", /type="tel"/.test(field("mobile")) && /\brequired\b/.test(field("mobile")));
  t("email is optional and type email", /type="email"/.test(field("email")) && !/\brequired\b/.test(field("email")));
  t("distance is a required select", /<select[^>]*name="distance"[^>]*required/.test(form));
  t("training is a required select", /<select[^>]*name="training"[^>]*required/.test(form));
  t("question is an optional textarea", /<textarea[^>]*name="question"/.test(form) && !/<textarea[^>]*required/.test(form));
  for (const control of ["name", "mobile", "email", "distance", "training", "question"]) {
    t(`"${control}" has a visible <label for>`, new RegExp(`<label for="webinar-${control}">[^<]+</label>`).test(form) && has(form, `id="webinar-${control}"`));
  }
  for (const control of ["name", "mobile", "distance", "training"]) {
    t(`"${control}" has an error message the script can show`, new RegExp(`<p class="field-error" id="webinar-${control}-error" hidden>[^<]+</p>`).test(form));
  }
  t("email has its error message too", /id="webinar-email-error" hidden>Enter a valid email address\.</.test(form));
  t("the first option of each select is 'Choose one' with an empty value", (form.match(/<option value="">Choose one<\/option>/g) || []).length === 2);
  t("the select options are the ones in the content file",
    DISTANCES.every(o => has(form, `<option value="${o.value}">${o.label}</option>`)) && TRAINING.every(o => has(form, `<option value="${o.value}">${o.label}</option>`)));
  t("the spam trap is hidden from people and assistive tech, skipped by the keyboard, and not auto-filled",
    /<div class="hp" aria-hidden="true"><label for="webinar-website">[^<]+<\/label><input id="webinar-website" name="contact_website" type="text" tabindex="-1" autocomplete="off"><\/div>/.test(form));
  t("the trap is not hidden with display:none (bots skip those)", !/\.hp\s*\{[^}]*display:\s*none/.test(css) && /\.hp\s*\{[^}]*position:\s*absolute/.test(css));
  t("the failure message area is a live alert", /<p class="form-error" id="webinar-form-error" role="alert"/.test(form));
  t("the submit button is the site's red large button and says 'Register free'", /<button class="btn btn-red btn-lg" type="submit">Register free<\/button>/.test(form));
  t("fields use 16px text so phones do not zoom the page", /font:\s*400 16px/.test(css));
  t("the script only ever sends the visitor to the thank-you page", script.includes(`"${SITE.thankYouPath}"`) && !/location\.(assign|replace|href)\s*=?\s*\(?\s*["'](?!\/webinar\/thank-you)/.test(script));
  t("the form script holds no wording of its own (messages come from the HTML)", ![
    "Enter your full name", "Enter a mobile number", "Enter a valid email", "Something went wrong", "Choose your race distance"
  ].some(s => script.includes(s)));
  t("the form script is loaded once, deferred, from the site", (landing.match(/<script[^>]*src=/g) || []).length === 1 && has(landing, '<script src="/js/webinar.js" defer></script>'));
  t("the script's option lists equal the content file's",
    JSON.stringify([...script.matchAll(/var DISTANCES = \[([^\]]*)\]/g)][0][1].replace(/"/g, "").split(",").map(s => s.trim())) === JSON.stringify(DISTANCES.map(o => o.value)) &&
    JSON.stringify([...script.matchAll(/var TRAINING = \[([^\]]*)\]/g)][0][1].replace(/"/g, "").split(",").map(s => s.trim())) === JSON.stringify(TRAINING.map(o => o.value)));
}

// ---- 5. Head: SEO, noindex, Pixel ------------------------------------------------------------------
section("5. Head");
{
  const H = head(landing), TH = head(thanks);
  t("title, description and Open Graph tags are the supplied ones",
    has(H, `<title>${LANDING.title}</title>`) &&
    metaContent(landing, "description") === "Athlevo Coaching is online endurance coaching for Filipino runners. Join our free online session with Q&A for runners at Ignite the Grit Run on November 22, 2026." &&
    metaContent(landing, "og:title", "property") === "Athlevo Coaching: free online session for Ignite the Grit Run runners" &&
    metaContent(landing, "og:description", "property") === "Online endurance coaching for Filipino runners. Join our free live session with Q&A, in partnership with JCIR Events Management." &&
    LANDING.title === "Free Online Session for Ignite the Grit Run Runners | Athlevo Coaching");
  t("canonical is https://programs.athlevo.org/webinar/", has(H, '<link rel="canonical" href="https://programs.athlevo.org/webinar/">') && SITE.canonical === "https://programs.athlevo.org/webinar/");
  t("og:url matches the canonical and og:type is website", has(H, '<meta property="og:url" content="https://programs.athlevo.org/webinar/">') && has(H, '<meta property="og:type" content="website">'));
  t("the landing page is indexable (no robots meta)", !/name="robots"/.test(H));
  t("viewport is set for phones", has(H, '<meta name="viewport" content="width=device-width, initial-scale=1">'));
  t("the thank-you page is noindex, nofollow", has(TH, '<meta name="robots" content="noindex, nofollow">'));
  t("the thank-you page has the supplied title and no canonical or social tags", has(TH, "<title>You're registered | Athlevo Coaching</title>") && !/canonical|og:/.test(TH));
  t("neither page is blocked in robots.txt (a blocked page cannot be read as noindex)", !/webinar/i.test(readFileSync("robots.txt", "utf8")));
  t("the thank-you page is not in the sitemaps", !/webinar/.test(readFileSync("sitemap.xml", "utf8") + readFileSync("sitemap-programs.xml", "utf8")));
  for (const [label, html] of [["landing page", landing], ["thank-you page", thanks]]) {
    const h = head(html);
    const open = h.indexOf("<!-- ======================= META PIXEL");
    const close = h.indexOf("<!-- /META PIXEL -->");
    t(`${label}: a marked Meta Pixel spot sits in the <head>`, open > -1 && close > open && /Paste your Meta Pixel base code here/.test(h.slice(open, close)));
    t(`${label}: the Pixel spot is before the stylesheets, so it loads early`, close < h.indexOf('rel="stylesheet"'));
    t(`${label}: the spot is empty (nothing pasted in yet)`, !/fbq|facebook\.net/.test(h));
  }
  const noComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
  t("the Lead event fires on the thank-you page only", /window\.fbq\("track", "Lead"\)/.test(thanks) && !/Lead/.test(noComments(landing)) && !/Lead/.test(script));
  t("the Lead event does nothing until the Pixel is installed", /typeof window\.fbq !== "function"\) return/.test(thanks));
  t("the Lead event is counted once per browser session, so a refresh does not repeat it", /sessionStorage\.getItem\("athlevoWebinarLead"\)/.test(thanks) && /sessionStorage\.setItem\("athlevoWebinarLead"/.test(thanks));
  t("the Lead script is inline, so nothing extra loads", (noComments(thanks).match(/<script/g) || []).length === 1 && !/<script[^>]*src/.test(noComments(thanks)));
}

// ---- 6. Styling: only what the site already has -----------------------------------------------------
section("6. Styling");
{
  const tokens = new Map([...storeCss.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const used = [...css.matchAll(/var\(--([a-z-]+)\)/g)].map(m => m[1]);
  t("every colour, font and size variable the new CSS uses is defined in store.css", used.every(n => tokens.has(n)), used.filter(n => !tokens.has(n)).join());
  t("the new CSS adds no colours of its own (no hex or named colours; only the shadow already used by cards)", !/#[0-9a-fA-F]{3,8}\b/.test(css) && (css.match(/rgba?\(/g) || []).length === 1 && /rgba\(16, 17, 20, 0\.08\)/.test(css));
  t("the new CSS adds no fonts (no @font-face, @import or literal font families)", !/@font-face|@import/.test(css) && !/font-family:(?!\s*var\()/.test(css));
  t("both pages load the site's own stylesheet first, then the small webinar one",
    [landing, thanks].every(h => h.indexOf('href="/store.css"') > -1 && h.indexOf('href="/webinar.css"') > h.indexOf('href="/store.css"')));
  t("the page loads the same Fraunces font link as the storefront", has(landing, "family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600") && has(readFileSync("store.html", "utf8"), "family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600"));
  t("it reuses the storefront's own components", ["pdp-hero--offer", "offer-description", "pdp-facts", "faq", "offer-coach-row", "coach-card-creds", "site-footer", "signup-confirm", "offer-steps", "btn btn-red btn-lg"].every(c => has(landing + thanks, c) && storeCss.includes("." + c.split(" ")[0])));
  t("visible focus on every field, summary and the skip link", /\.field input:focus-visible[\s\S]*?\.faq summary:focus-visible[\s\S]*?\.skip:focus-visible[\s\S]*?outline:\s*2px solid var\(--red\)/.test(css));
  t("no rule removes focus outlines except on the programmatic scroll targets", [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)].every(m => /#main:focus|\.webinar-form:focus/.test(m[1])));
  t("the page offsets the jump to the form below the header", /#register\s*\{[^}]*scroll-margin-top/.test(css));
  t("layouts are mobile-first: single column by default, wider layouts only inside min-width queries",
    /\.how-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css) && /@media \(min-width: 981px\)[\s\S]*repeat\(3/.test(css));

  // WCAG AA contrast on the colour pairs the pages use (normal text needs 4.5:1).
  const hex = (name) => (tokens.get(name) || "").replace("#", "");
  const lum = (h) => {
    const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [fg, bg, where] of [
    ["ink", "white", "body text on cards and the form"], ["ink", "paper", "body text on the page"],
    ["muted", "white", "help text on cards"], ["muted", "paper", "eyebrows and small text"],
    ["red", "white", "emphasised words and error text on cards"], ["red", "paper", "emphasised words on the page"],
    ["white", "red", "button label"]
  ]) {
    const r = ratio(fg, bg);
    t(`contrast ${fg} on ${bg} (${where}) is at least 4.5:1`, r >= 4.5, r.toFixed(2));
  }
}

// ---- 7. Speed ----------------------------------------------------------------------------------------
section("7. Speed");
{
  t("each page is small", Buffer.byteLength(landing) < 20000 && Buffer.byteLength(thanks) < 6000, Buffer.byteLength(landing) + "/" + Buffer.byteLength(thanks));
  const external = [...(landing + thanks).matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => new URL(m[1]).host).filter(h => h !== "programs.athlevo.org");
  t("the only outside hosts are Google Fonts, the same ones the storefront uses", [...new Set(external)].every(h => h === "fonts.googleapis.com" || h === "fonts.gstatic.com"), [...new Set(external)].join());
  t("no third-party scripts", !/<script[^>]*src="https?:/.test(landing + thanks));
  const imgs = [...landing.matchAll(/<img [^>]*>/g)].map(m => m[0]);
  t("every image has alt text, width and height (no layout shift)", imgs.length === 2 && imgs.every(i => /alt="[^"]+"/.test(i) && /width="\d+"/.test(i) && /height="\d+"/.test(i)));
  t("the hero image loads first and the coach photo waits", /loading="eager" fetchpriority="high"/.test(imgs[0]) && /loading="lazy"/.test(imgs[1]));
  const assets = [...new Set([...landing.matchAll(/\/assets\/store\/[a-z0-9-]+\.(?:avif|webp)/g)].map(m => m[0].slice(1)))];
  const absent = assets.filter(p => !existsSync(p));
  t("every picture file the page points at exists in the repository", assets.length === 8 && absent.length === 0, absent.join());
  const icons = [...(landing + thanks).matchAll(/<link rel="icon"[^>]*href="(\/[^"?]+)/g)].map(m => m[1].slice(1));
  t("the tab icon on both pages points at a file that exists (the site renamed it once already)", icons.length === 2 && icons.every(p => existsSync(p)), icons.join());
  t("the stylesheets exist and are small", existsSync("webinar.css") && statSync("webinar.css").size < 8000 && statSync("js/webinar.js").size < 8000);
}

// ---- 8. Routing ----------------------------------------------------------------------------------------
section("8. Routing");
{
  const rewrite = (source) => vercel.rewrites.find(r => r.source === source && !r.has);
  t("/webinar serves the landing page, with and without a trailing slash",
    rewrite("/webinar")?.destination === "/webinar.html" && rewrite("/webinar/")?.destination === "/webinar.html");
  t("/webinar/thank-you serves the thank-you page, with and without a trailing slash",
    rewrite("/webinar/thank-you")?.destination === "/webinar-thank-you.html" && rewrite("/webinar/thank-you/")?.destination === "/webinar-thank-you.html");
  t("the registration endpoint is routed through the existing gateway", rewrite("/api/webinar/register")?.destination === "/api/providers?action=webinar_register");
  const catchAll = vercel.redirects.find(r => r.has?.some(h => h.type === "host" && h.value === "programs.athlevo.org") && /^\/:path\(\(\?!/.test(r.source));
  const keep = new RegExp("^" + (catchAll?.source.match(/\/:path\((.*)\)$/)?.[1] || "(?!)") + "$");
  const throughPaths = ["webinar", "webinar/", "webinar/thank-you", "webinar/thank-you/", "webinar.css", "js/webinar.js", "assets/store/stretch-640.avif", "api/webinar/register"];
  const sentAway = throughPaths.filter(p => keep.test(p));
  t("the programs-site catch-all (which sends strangers to athlevo.org) lets the webinar paths through", Boolean(catchAll) && sentAway.length === 0, sentAway.join());
  t("the catch-all still sends unknown paths away", keep.test("pricing") && keep.test("webinars") && keep.test("webinar.html"));
  const apex = vercel.redirects.filter(r => r.has?.some(h => h.type === "host" && h.value === "athlevo.org") && r.missing?.some(h => h.value === "programs.athlevo.org") && /^\/webinar/.test(r.source));
  t("on athlevo.org, /webinar and everything under it moves to programs.athlevo.org, temporarily and keeping the query",
    apex.length === 4 && apex.every(r => r.permanent === false && r.destination === "https://programs.athlevo.org" + r.source) &&
    ["/webinar", "/webinar/", "/webinar/thank-you", "/webinar/thank-you/"].every(p => apex.some(r => r.source === p)));
  t("no webinar rewrite is limited to one host, so previews and the programs site both work", [...vercel.rewrites].filter(r => /webinar/.test(r.source)).every(r => !r.has));
  const serve = readFileSync("scripts/serve-web.mjs", "utf8");
  t("the local preview server serves the same webinar routes", /webinar/.test(serve) && /webinar-thank-you\.html/.test(serve));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

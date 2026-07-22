/*
 * Athlevo — WorkoutStructureView (wsv-v3).
 *
 * Loads the REAL client module the way the page does, exercises its pure
 * model + a simulated DOM selection, AND cross-checks the rendered BEM class
 * names against the actual CSS selectors in index.html — the exact class of
 * bug (stale/mismatched markup vs CSS) that broke production.
 *
 * Run: node tests/workout-structure.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const CSS = readFileSync("./index.html", "utf8");

// Load the REAL module exactly as index.html would (window global).
const src = readFileSync("./js/workoutStructure.js", "utf8");
const cm = { exports: {} };
new Function("module", "window", src + "\nmodule.exports = (typeof window!=='undefined'&&window.WorkoutStructureView)||module.exports;")(cm, {});
const WSV = cm.exports;

const warm = { kind: "warmup", label: "Warm-up", duration: 1202, tone: "warm", pace: "6:05/km" };
const work = (n, d = 360) => ({ kind: "work", label: "Threshold", duration: d, tone: "red", pace: "4:38/km", distanceKm: 1.44 });
const rec = { kind: "recovery", label: "Recovery", duration: 118, tone: "blue", pace: "8:22/km" };
const cool = { kind: "cooldown", label: "Cooldown", duration: 900, tone: "gray" };
const threshold = [warm, work(1), rec, work(2), rec, work(3), rec, work(4), cool];

/* ══════ single easy run ═══════════════════════════════════════════════ */

section("A single easy run renders one green block, not an empty state");
{
  const segs = [{ kind: "steady", label: "Easy Run", duration: 1800, tone: "green", pace: "5:20/km" }];
  const m = WSV.model(segs);
  t("one block", m.blocks.length === 1, String(m.blocks.length));
  t("it is green", m.blocks[0].tone === "green");
  t("not the empty state", m.empty === false);
  const html = WSV.render(segs);
  t("renders a segment, not 'No workout structure'", /wsv__segment/.test(html) && !/No workout structure/.test(html));
}

/* ══════ long run ══════════════════════════════════════════════════════ */

section("A long run renders one proportional green block");
{
  const segs = [{ kind: "steady", label: "Long Run", duration: 7800, tone: "green" }];
  const m = WSV.model(segs);
  t("one block", m.blocks.length === 1);
  t("duration text is mm:ss", m.blocks[0].durationText === "130:00", m.blocks[0].durationText);
  t("grow is proportional to duration", m.blocks[0].grow === 7800);
}

/* ══════ threshold — proportional widths + SHORT labels ════════════════ */

section("A threshold session becomes proportional blocks with short labels");
{
  const m = WSV.model(threshold);
  t("nine blocks", m.blocks.length === 9, String(m.blocks.length));
  const works = m.blocks.filter(b => b.kind === "work");
  t("four work blocks", works.length === 4);
  t("work blocks are red", works.every(b => b.tone === "red"));
  t("warm-up is 'warm' toned", m.blocks[0].tone === "warm");
  t("recoveries are blue", m.blocks.filter(b => b.kind === "recovery").every(b => b.tone === "blue"));
  t("cooldown is gray", m.blocks[m.blocks.length - 1].tone === "gray");
  t("warm-up grows far more than a recovery", m.blocks[0].grow > m.blocks[2].grow * 5);
  t("work reps are numbered (detail title)", works[1].repLabel === "Threshold Rep 2", works[1].repLabel);
  t("warm-up short label", m.blocks[0].short === "Warm", m.blocks[0].short);
  t("work short labels are T1..Tn", works.map(b => b.short).join(",") === "T1,T2,T3,T4", works.map(b => b.short).join(","));
  t("recovery short label is 'Rec'", m.blocks[2].short === "Rec", m.blocks[2].short);
  t("cooldown short label is 'Cool'", m.blocks[m.blocks.length - 1].short === "Cool");
  const html = WSV.render(threshold);
  t("short labels appear in the graph", /Warm/.test(html) && /T1/.test(html) && /Rec/.test(html) && /Cool/.test(html));
  t("pace is NOT drawn on the graph at all", !/\/km/.test(html));
}

/* ══════ VO2 ═══════════════════════════════════════════════════════════ */

section("A VO2 session keeps work blocks red");
{
  const segs = [warm, { kind: "work", label: "VO2", duration: 180, tone: "red" },
    rec, { kind: "work", label: "VO2", duration: 180, tone: "red" }, cool];
  const m = WSV.model(segs);
  t("work blocks red", m.blocks.filter(b => b.kind === "work").every(b => b.tone === "red"));
  t("VO2 reps numbered (detail title)", m.blocks.filter(b => b.kind === "work")[0].repLabel === "VO2 Rep 1");
  t("VO2 short label is V1", m.blocks.filter(b => b.kind === "work")[0].short === "V1");
}

/* ══════ many repetitions — horizontal scroll, no compression ══════════ */

section("Many repetitions scroll horizontally and stay readable");
{
  const many = [warm];
  for (let i = 0; i < 14; i++) { many.push(work(i, 120)); many.push(rec); }
  many.push(cool);
  const m = WSV.model(many);
  t("14 work reps kept as distinct blocks", m.blocks.filter(b => b.kind === "work").length === 14);
  const html = WSV.render(many);
  t("track lives in a horizontal scroller", /wsv__scroller/.test(html) && /wsv__track/.test(html));
  const minW = (CSS.match(/\.wsv__segment\{[^}]*min-width:(\d+)px/) || [])[1];
  t("CSS enforces a 40–44px minimum interactive width", Number(minW) >= 40 && Number(minW) <= 44, minW);
  t("CSS makes the scroller scroll horizontally", /\.wsv__scroller\{[^}]*overflow-x:auto/.test(CSS));
}

/* ══════ one continuous track — not a row of cards ═════════════════════ */

section("Segments form ONE connected track, not floating cards");
{
  const trackCss = (CSS.match(/\.wsv__track\{[^}]*\}/) || [""])[0];
  const segCss = (CSS.match(/\.wsv__segment\{[^}]*\}/) || [""])[0];
  t("the track has one shared background", /background:/.test(trackCss));
  t("the track is rounded and clips its children", /border-radius:/.test(trackCss) && /overflow:hidden/.test(trackCss));
  t("only a very small divider between segments (gap<=2px)", /gap:[12]px/.test(trackCss));
  t("internal segments have NO rounded corners of their own", /border-radius:0/.test(segCss));
  t("internal segments have NO individual border", /border:0/.test(segCss));
  const segRest = segCss.replace(/transition:[^;}]*/g, "");
  t("internal segments cast NO individual shadow at rest", !/box-shadow/.test(segRest));
}

/* ══════ unknown / no structure → empty state ══════════════════════════ */

section("No structure shows the empty message, not a placeholder");
{
  t("empty array → empty state", WSV.model([]).empty === true);
  t("segments with no duration → empty state", WSV.model([{ kind: "steady", label: "?" }]).empty === true);
  const html = WSV.render([]);
  t("renders the exact copy", /No workout structure available\./.test(html));
  t("draws no segments", !/wsv__segment/.test(html));
}

/* ══════ responsive layout ═════════════════════════════════════════════ */

section("Responsive by construction (flex + scroll, no page overflow)");
{
  t("segments flex to fill available width on desktop", /\.wsv__segment\{[^}]*flex:1 1 0/.test(CSS));
  t("track is a flex row", /\.wsv__track\{[^}]*display:flex/.test(CSS));
  t("scroller is capped to its box (no horizontal page overflow)", /\.wsv__scroller\{[^}]*max-width:100%/.test(CSS));
  t("reduced-motion users get no animation", /prefers-reduced-motion:reduce/.test(CSS) && /animation:none/.test(CSS));
}

/* ══════ selection — one open card at a time ═══════════════════════════ */

section("Tapping a segment expands one detail card at a time");
{
  t("clicking an idle block opens it", WSV.toggleState(null, 2) === 2);
  t("clicking the open block closes it", WSV.toggleState(2, 2) === null);
  t("clicking a different block moves selection", WSV.toggleState(2, 5) === 5);

  const dom = makeDom(WSV.render(threshold), threshold);
  const blocks = dom.root.querySelectorAll(".wsv__segment");
  WSV.select(blocks[1]);
  t("first tap opens exactly one card", dom.detail().includes("Threshold Rep 1"));
  t("exactly one block is active", countActive(dom.root) === 1, String(countActive(dom.root)));
  WSV.select(blocks[3]);
  t("second tap replaces — still exactly one card", countActive(dom.root) === 1 &&
    dom.detail().includes("Threshold Rep 2") && !dom.detail().includes("Rep 1"));
  WSV.select(blocks[3]);
  t("tapping the open block closes it (zero active)", countActive(dom.root) === 0 && dom.detail().trim() === "");
}

/* ══════ detail panel — duration/pace/HR first, rest behind Show more ═══ */

section("Selected detail shows duration, pace, HR first; secondary hidden");
{
  const withHr = [{ kind: "work", label: "Threshold", duration: 361, tone: "red",
    pace: "4:39/km", hr: "171", distanceKm: 1.55, cadence: "181", elevation: "+3 m", power: "290" }];
  const d = WSV.detailModel(withHr, 0);
  t("primary is exactly duration, pace, HR — in order",
    d.primary.map(r => r[0]).join("|") === "Duration|Average pace|Average HR", d.primary.map(r => r[0]).join("|"));
  t("HR is formatted with bpm", d.primary.find(r => r[0] === "Average HR")[1] === "171 bpm");
  t("secondary holds distance/cadence/elevation/power",
    d.secondary.map(r => r[0]).join("|") === "Distance|Cadence|Elevation|Power");

  const html = WSV.render(withHr, { selected: 0 });
  t("primary rows render up top", /Average pace/.test(html) && /Average HR/.test(html));
  t("a 'Show more' control is offered", /wsv__more[^>]*>Show more</.test(html));
  t("secondary metrics start hidden", /class="wsv__detail-more" hidden/.test(html));
  t("secondary metrics are inside the hidden block", html.indexOf("Distance") > html.indexOf("Show more"));

  const bare = WSV.detailModel([{ kind: "work", label: "Threshold", duration: 360, tone: "red", pace: "4:10/km" }], 0);
  t("bare segment: primary is just Duration + pace", bare.primary.map(r => r[0]).join("|") === "Duration|Average pace");
  t("bare segment: no HR row invented", !bare.primary.some(r => r[0] === "Average HR"));
  t("bare segment: no secondary metrics", bare.secondary.length === 0);
  const bareHtml = WSV.render([{ kind: "work", label: "Threshold", duration: 360, tone: "red", pace: "4:10/km" }], { selected: 0 });
  t("bare segment: no 'Show more' when nothing to reveal", !/Show more/.test(bareHtml));
  t("bare segment: no empty rows rendered", !/<b><\/b>/.test(bareHtml));

  const dm = makeToggleDom();
  WSV.toggleMore(dm.btn);
  t("Show more reveals the secondary block", !dm.more.hasAttribute("hidden"));
  t("aria-expanded flips to true", dm.btn.getAttribute("aria-expanded") === "true");
  t("button text becomes 'Show less'", dm.btn.textContent === "Show less");
  WSV.toggleMore(dm.btn);
  t("toggling again re-hides", dm.more.hasAttribute("hidden") && dm.btn.getAttribute("aria-expanded") === "false");
}

/* ══════ accessibility ═════════════════════════════════════════════════ */

section("Each segment is an accessible, keyboard-operable button");
{
  const html = WSV.render(threshold, { selected: 1 });
  t("each block is a real <button>", /<button type="button" class="wsv__segment/.test(html));
  t("blocks carry a spoken aria-label", /aria-label="Threshold Rep 2, 6 minutes"/.test(html) ||
    /aria-label="Threshold Rep 1, 6 minutes/.test(html));
  t("aria-label spells warm-up duration in words", /aria-label="Warm-up, 20 minutes 2 seconds"/.test(html));
  t("selected sets aria-pressed=true and others false",
    /aria-pressed="true"/.test(html) && /aria-pressed="false"/.test(html));
  t("blocks have a visible focus state", /\.wsv__segment:focus-visible\{[^}]*outline/.test(CSS));
  t("focus outline sits inside the clipped track (offset negative)", /\.wsv__segment:focus-visible\{[^}]*outline-offset:-2px/.test(CSS));
  t("active state uses no transform (no layout shift)", !/\.wsv__segment\.is-active\{[^}]*transform/.test(CSS));
  t("active transition uses the base motion token (≈200ms)", /\.wsv__segment\{[^}]*transition:[^}]*var\(--dur-base\)/.test(CSS));

  const dom = makeDom(html, threshold);
  const blocks = dom.root.querySelectorAll(".wsv__segment");
  WSV.select(blocks[2]);
  t("selecting sets aria-pressed=true on exactly one block",
    blocks.filter(b => b.getAttribute("aria-pressed") === "true").length === 1);
  t("...and it is the tapped block", blocks[2].getAttribute("aria-pressed") === "true");
}

/* ══════ PRODUCTION-STYLE — real markup vs real CSS, no vertical text ═══ */

section("Production render: a real horizontal graph, not concatenated text");
{
  const html = WSV.render(threshold, { selected: 0 });

  // 1. Every wsv__ class the component emits MUST have a matching CSS rule in
  //    index.html. This is the exact check that would have caught the prod bug.
  const emitted = [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap(m => m[1].split(/\s+/)).filter(c => c.startsWith("wsv"));
  const uniq = [...new Set(emitted)];
  const missing = uniq.filter(c => !new RegExp("\\." + c.replace(/([-_])/g, "\\$1") + "[\\s{:.,]").test(CSS));
  t("every emitted wsv class is defined in the CSS", missing.length === 0, "missing: " + missing.join(", "));

  // 2. The track is display:flex (row) — segments sit horizontally.
  t("the track is display:flex in CSS", /\.wsv__track\{[^}]*display:flex/.test(CSS));
  t("the track is explicitly flex-direction:row (Safari)", /\.wsv__track\{[^}]*flex-direction:row/.test(CSS));

  // 3. Segments are siblings inside the track — no vertical stacking wrapper.
  const trackStart = html.indexOf('<div class="wsv__track');
  const track = html.slice(html.indexOf(">", trackStart) + 1, html.indexOf('<div class="wsv__detail'));
  const segCount = (track.match(/<button[^>]*class="wsv__segment/g) || []).length;
  t("all nine segments are direct children of ONE track", segCount === 9, String(segCount));
  t("no nested block wrappers stacking segments vertically", !/<div/.test(track));

  // 4. Label and duration are SEPARATE elements, never concatenated text.
  t("label and duration are separate spans",
    /<span class="wsv__label">Warm<\/span><span class="wsv__dur">20:02<\/span>/.test(html));
  t("no jammed 'label+duration' text node", !/>Warm20:02</.test(html));

  // 5. NO pace text anywhere inside the track.
  t("the track contains no pace text", !/\/km/.test(track));

  // 6. Colour classes are present and obvious (not text-only/transparent).
  t("segments carry colour modifier classes", /wsv__segment--warm/.test(html) &&
    /wsv__segment--red/.test(html) && /wsv__segment--blue/.test(html) && /wsv__segment--gray/.test(html));
  ["warm", "blue", "red", "orange", "green", "gray"].forEach(tone =>
    t(`colour ${tone} sets a solid background`, new RegExp("\\.wsv__segment--" + tone + "\\{[^}]*background:").test(CSS)));

  // 7. Selected detail appears BELOW the track in DOM order.
  t("detail panel comes after the scroller", html.indexOf("wsv__detail") > html.indexOf("wsv__scroller"));

  // 8. Debug build marker + version tag are present (temporary, wsv-v3).
  t("root carries data-wsv-version=3", /data-wsv-version="3"/.test(html));
  t("visible build marker says wsv-v3", /Workout graph build: wsv-v3/.test(html));
}

/* ══════ Safari — explicit, non-fragile CSS assumptions ════════════════ */

section("Safari-safe CSS resets are explicit");
{
  const segCss = (CSS.match(/\.wsv__segment\{[^}]*\}/) || [""])[0];
  t("appearance reset (webkit + std)", /-webkit-appearance:none/.test(segCss) && /appearance:none/.test(segCss));
  t("box-sizing:border-box on segments", /box-sizing:border-box/.test(segCss));
  t("segment font inherits", /font-family:inherit/.test(segCss));
  t("white-space:nowrap on segment", /white-space:nowrap/.test(segCss));
  t("min-width on segment buttons", /min-width:42px/.test(segCss));
  t("track sets flex-direction:row + nowrap", /\.wsv__track\{[^}]*flex-direction:row/.test(CSS) && /\.wsv__track\{[^}]*flex-wrap:nowrap/.test(CSS));
  t("scroller sets overflow-x:auto", /\.wsv__scroller\{[^}]*overflow-x:auto/.test(CSS));
  t("-webkit-overflow-scrolling for momentum", /-webkit-overflow-scrolling:touch/.test(CSS));
  t("box-sizing applied to all wsv children", /\.wsv \*\{box-sizing:border-box\}/.test(CSS));
}

/* ══════ fallback — never dump raw text ════════════════════════════════ */

section("The modal shows a clean fallback, never an unstyled text dump");
{
  const cal = readFileSync("./js/trainCalendar.js", "utf8");
  t("mounts via the component when present", /WorkoutStructureView\.render/.test(cal));
  t("guarded by a try/catch", /try \{[\s\S]*WorkoutStructureView\.render[\s\S]*catch/.test(cal));
  t("clean fallback copy on failure", /Workout structure unavailable\./.test(cal));
  t("the old twm-seg text list is gone", !/twm-seg/.test(cal));
}

/* ══════ update path — versioned assets defeat stale-while-revalidate ═══ */

section("Deploys can't serve stale JS against fresh CSS");
{
  const sw = readFileSync("./service-worker.js", "utf8");
  const ver = (sw.match(/CACHE_VERSION = "athlevo-shell-v(\d+)"/) || [])[1];
  t("service worker cache version is v54+", Number(ver) >= 54, ver);
  t("the component script is version-busted", /workoutStructure\.js\?v=\d+/.test(CSS));
  t("the train modal script is version-busted", /trainCalendar\.js\?v=\d+/.test(CSS));
  t("all js includes are versioned (none bare)", !/src="js\/[^"?]+\.js"/.test(CSS));
}

/* ══════ isolation — component is source-agnostic ══════════════════════ */

section("The component knows nothing about Intervals/Strava/Supabase/recognition");
{
  const s = src.replace(/\/\*[\s\S]*?\*\//, "");
  t("no network calls (fetch)", !/\bfetch\s*\(/.test(s));
  t("no Supabase/Intervals/Strava API usage", !/supabase|intervals|strava/i.test(s));
  t("no recognition-engine coupling (raw_data / .recognition)", !/raw_data|\.recognition\b/.test(s));
  t("no coupling to AthlevoCoach or recognition globals", !/AthlevoCoach|getStoredRecognition/.test(s));
  t("input is only normalized segments (documented)", /normalized segment/i.test(src));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

/* ── a tiny DOM good enough for select()'s classList/querySelector needs ─── */
function makeDom(html, segments) {
  const idxs = [...html.matchAll(/data-idx="(\d+)"/g)].map(m => Number(m[1]));
  const root = elem("div");
  root.matches = sel => sel === "[data-wsv]";
  const detailEl = elem("div"); detailEl._attr["data-wsv-detail"] = "1";
  const blockEls = idxs.map(i => { const b = elem("button"); b._attr["data-idx"] = String(i);
    b.classList._set.add("wsv__segment"); b.closest = sel => sel === "[data-wsv]" ? root : null; return b; });
  root._children = blockEls.concat([detailEl]);
  root.querySelectorAll = sel => sel === ".wsv__segment" ? blockEls
    : root._children.filter(c => c.classList._set.has(sel.replace(".", "")));
  root.querySelector = sel => sel === "[data-wsv-detail]" ? detailEl
    : (root.querySelectorAll(sel)[0] || null);
  WSV.mount(root, segments);
  return { root, detail: () => detailEl.innerHTML };
}
function elem(tag) {
  const set = new Set();
  return { tag, nodeType: 1, _attr: {}, _children: [], innerHTML: "", textContent: "", nextSibling: null,
    classList: { _set: set, add: c => set.add(c), remove: c => set.delete(c),
      contains: c => set.has(c), toggle: (c, on) => { on ? set.add(c) : set.delete(c); } },
    getAttribute(k) { return this._attr[k] != null ? this._attr[k] : null; },
    setAttribute(k, v) { this._attr[k] = String(v); },
    hasAttribute(k) { return this._attr[k] != null; },
    removeAttribute(k) { delete this._attr[k]; } };
}
function countActive(root) {
  return root.querySelectorAll(".wsv__segment").filter(b => b.classList._set.has("is-active")).length;
}
function makeToggleDom() {
  const btn = elem("button"); btn._attr["aria-expanded"] = "false"; btn.textContent = "Show more";
  const more = elem("div"); more._attr["hidden"] = "";
  btn.nextSibling = more;
  return { btn, more };
}

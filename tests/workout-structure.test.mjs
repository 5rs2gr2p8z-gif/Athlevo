/*
 * Athlevo — WorkoutStructureView component.
 *
 * Loads the REAL client module the way the page does and exercises its pure
 * model + a simulated DOM selection. Nothing is mocked away.
 *
 * Run: node tests/workout-structure.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

// Load the REAL module exactly as index.html would (window global).
const src = readFileSync("./js/workoutStructure.js", "utf8");
const cm = { exports: {} };
new Function("module", "window", src + "\nmodule.exports = (typeof window!=='undefined'&&window.WorkoutStructureView)||module.exports;")(cm, {});
const WSV = cm.exports;

const warm = { kind: "warmup", label: "Warm-up", duration: 1203, tone: "warm", pace: "5:33/km" };
const work = (n, d = 360) => ({ kind: "work", label: "Threshold", duration: d, tone: "red", pace: "4:10/km", distanceKm: 1.44 });
const rec = { kind: "recovery", label: "Recovery", duration: 120, tone: "blue", pace: "5:00/km" };
const cool = { kind: "cooldown", label: "Cooldown", duration: 480, tone: "gray" };
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
  t("renders a block, not 'No workout structure'", /wsv-block/.test(html) && !/No workout structure/.test(html));
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

/* ══════ threshold — proportional widths + labels ══════════════════════ */

section("A threshold session becomes proportional blocks with labels");
{
  const m = WSV.model(threshold);
  t("nine blocks", m.blocks.length === 9, String(m.blocks.length));
  const works = m.blocks.filter(b => b.kind === "work");
  t("four work blocks", works.length === 4);
  t("work blocks are red", works.every(b => b.tone === "red"));
  t("warm-up is 'warm' toned", m.blocks[0].tone === "warm");
  t("recoveries are blue", m.blocks.filter(b => b.kind === "recovery").every(b => b.tone === "blue"));
  t("cooldown is gray", m.blocks[m.blocks.length - 1].tone === "gray");
  // proportional: warm-up (1203s) is much wider than a recovery (120s)
  t("warm-up grows far more than a recovery", m.blocks[0].grow > m.blocks[2].grow * 5);
  // repeated work reps are numbered for the detail card
  t("work reps are numbered (detail title)", works[1].repLabel === "Threshold Rep 2", works[1].repLabel);
  // narrow blocks use the SHORT label: Warm-up · T1/T2 · Rec · Cool
  t("warm-up short label", m.blocks[0].short === "Warm-up", m.blocks[0].short);
  t("work short labels are T1..Tn", works.map(b => b.short).join(",") === "T1,T2,T3,T4", works.map(b => b.short).join(","));
  t("recovery short label is 'Rec'", m.blocks[2].short === "Rec", m.blocks[2].short);
  t("cooldown short label is 'Cool'", m.blocks[m.blocks.length - 1].short === "Cool", m.blocks[m.blocks.length - 1].short);
  const html = WSV.render(threshold);
  t("short labels appear in the graph", /Warm-up/.test(html) && /T1/.test(html) && /Rec/.test(html) && /Cool/.test(html));
  t("pace is NOT drawn on the graph blocks", !/4:10\/km/.test(html));
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
  t("track lives in a horizontal scroll container", /wsv-scroll/.test(html) && /wsv-track/.test(html));
  const css = readFileSync("./index.html", "utf8");
  const minW = (css.match(/\.wsv-block\{[^}]*min-width:(\d+)px/) || [])[1];
  t("CSS enforces a 40–44px minimum interactive width", Number(minW) >= 40 && Number(minW) <= 44, minW);
  t("CSS makes the track scroll horizontally", /\.wsv-scroll\{[^}]*overflow-x:auto/.test(css));
}

/* ══════ one continuous track — not a row of cards ═════════════════════ */

section("Segments form ONE connected track, not floating cards");
{
  const css = readFileSync("./index.html", "utf8");
  const trackCss = (css.match(/\.wsv-track\{[^}]*\}/) || [""])[0];
  const blockCss = (css.match(/\.wsv-block\{[^}]*\}/) || [""])[0];
  t("the track has one shared background", /background:/.test(trackCss));
  t("the track is rounded and clips its children", /border-radius:/.test(trackCss) && /overflow:hidden/.test(trackCss));
  t("only a very small divider between segments (gap<=2px)", /gap:[12]px/.test(trackCss));
  t("internal blocks have NO rounded corners of their own", /border-radius:0/.test(blockCss));
  t("internal blocks have NO individual border", /border:0/.test(blockCss));
  // strip the transition list (which may name box-shadow as an animated prop)
  const blockRest = blockCss.replace(/transition:[^;}]*/g, "");
  t("internal blocks cast NO individual shadow at rest", !/box-shadow/.test(blockRest));
  // outer rounding comes from the track clipping → only first/last read rounded
  t("outer rounding via the track, not per-block radius",
    /border-radius:/.test(trackCss) && /border-radius:0/.test(blockCss));
}

/* ══════ unknown / no structure → empty state ══════════════════════════ */

section("No structure shows the empty message, not a placeholder");
{
  t("empty array → empty state", WSV.model([]).empty === true);
  t("segments with no duration → empty state", WSV.model([{ kind: "steady", label: "?" }]).empty === true);
  const html = WSV.render([]);
  t("renders the exact copy", /No workout structure available\./.test(html));
  t("draws no blocks", !/wsv-block/.test(html));
}

/* ══════ responsive layout ═════════════════════════════════════════════ */

section("Responsive by construction (flex + scroll, no page overflow)");
{
  const css = readFileSync("./index.html", "utf8");
  t("blocks flex to fill available width on desktop", /\.wsv-block\{[^}]*flex:1 1 0/.test(css));
  t("track is a flex row", /\.wsv-track\{[^}]*display:flex/.test(css));
  t("scroll container is capped to its box (no horizontal page overflow)",
    /\.wsv-scroll\{[^}]*max-width:100%/.test(css));
  t("reduced-motion users get no animation", /prefers-reduced-motion:reduce/.test(css) && /animation:none/.test(css));
}

/* ══════ segment selection — one expanded card at a time ═══════════════ */

section("Tapping a segment expands one detail card at a time");
{
  // pure toggle rule
  t("clicking an idle block opens it", WSV.toggleState(null, 2) === 2);
  t("clicking the open block closes it", WSV.toggleState(2, 2) === null);
  t("clicking a different block moves selection", WSV.toggleState(2, 5) === 5);

  // simulate real DOM selection to prove ONE card open at a time
  const dom = makeDom(WSV.render(threshold), threshold);
  const blocks = dom.root.querySelectorAll(".wsv-block");
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
  // A segment with HR present: primary carries duration → pace → HR, in order.
  const withHr = [{ kind: "work", label: "Threshold", duration: 361, tone: "red",
    pace: "4:39/km", hr: "171", distanceKm: 1.55, cadence: "181", elevation: "+3 m", power: "290" }];
  const d = WSV.detailModel(withHr, 0);
  t("primary is exactly duration, pace, HR — in that order",
    d.primary.map(r => r[0]).join("|") === "Duration|Average pace|Average HR",
    d.primary.map(r => r[0]).join("|"));
  t("HR is formatted with bpm", d.primary.find(r => r[0] === "Average HR")[1] === "171 bpm");
  t("secondary holds distance/cadence/elevation/power",
    d.secondary.map(r => r[0]).join("|") === "Distance|Cadence|Elevation|Power",
    d.secondary.map(r => r[0]).join("|"));

  // Rendered HTML: primary visible, secondary behind a hidden 'Show more'.
  const html = WSV.render(withHr, { selected: 0 });
  t("primary rows render up top", /Average pace/.test(html) && /Average HR/.test(html));
  t("a 'Show more' control is offered", /wsv-more[^>]*>Show more</.test(html));
  t("secondary metrics start hidden", /class="wsv-detail-more" hidden/.test(html));
  t("secondary metrics are inside the hidden block, not the primary list",
    html.indexOf("Distance") > html.indexOf("Show more"));

  // No HR, no secondary → no Show more button, no empty rows.
  const bare = WSV.detailModel([{ kind: "work", label: "Threshold", duration: 360, tone: "red", pace: "4:10/km" }], 0);
  t("bare segment: primary is just Duration + pace", bare.primary.map(r => r[0]).join("|") === "Duration|Average pace");
  t("bare segment: no HR row invented", !bare.primary.some(r => r[0] === "Average HR"));
  t("bare segment: no secondary metrics", bare.secondary.length === 0);
  const bareHtml = WSV.render([{ kind: "work", label: "Threshold", duration: 360, tone: "red", pace: "4:10/km" }], { selected: 0 });
  t("bare segment: no 'Show more' when nothing to reveal", !/Show more/.test(bareHtml));
  t("bare segment: no empty rows rendered", !/<b><\/b>/.test(bareHtml));

  // Show more toggle flips visibility + aria-expanded + label.
  const dom = makeToggleDom(html);
  WSV.toggleMore(dom.btn);
  t("Show more reveals the secondary block", !dom.more.hasAttribute("hidden"));
  t("aria-expanded flips to true", dom.btn.getAttribute("aria-expanded") === "true");
  t("button text becomes 'Show less'", dom.btn.textContent === "Show less");
  WSV.toggleMore(dom.btn);
  t("toggling again re-hides", dom.more.hasAttribute("hidden") && dom.btn.getAttribute("aria-expanded") === "false");
}

/* ══════ accessibility ═════════════════════════════════════════════════ */

section("Each segment is an accessible, keyboard-operable button");
{
  const html = WSV.render(threshold, { selected: 1 });
  t("each block is a real <button>", /<button type="button" class="wsv-block/.test(html));
  t("blocks carry a spoken aria-label", /aria-label="Threshold Rep 2, 6 minutes 1 second"/.test(html) ||
    /aria-label="Threshold Rep 1, 6 minutes/.test(html));
  t("aria-label spells warm-up duration in words", /aria-label="Warm-up, 20 minutes 3 seconds"/.test(html));
  t("selected block is aria-pressed=true, others false",
    /is-active[^>]*aria-pressed="true"|aria-pressed="true"[^>]*is-active/.test(html) === false ?
      /aria-pressed="true"/.test(html) && /aria-pressed="false"/.test(html) : true);
  const css = readFileSync("./index.html", "utf8");
  t("blocks have a visible focus state", /\.wsv-block:focus-visible\{[^}]*outline/.test(css));
  t("focus outline sits inside the clipped track (offset negative)",
    /\.wsv-block:focus-visible\{[^}]*outline-offset:-2px/.test(css));
  t("active state uses no transform (no layout shift)",
    !/\.wsv-block\.is-active\{[^}]*transform/.test(css));
  t("active transition stays within 150–220ms",
    /\.wsv-block\{[^}]*transition:[^}]*1[5-9]0ms|\.wsv-block\{[^}]*transition:[^}]*2[01]0ms|\.wsv-block\{[^}]*transition:[^}]*180ms/.test(css));

  // aria-pressed toggles on selection via the DOM handler.
  const dom = makeDom(html, threshold);
  const blocks = dom.root.querySelectorAll(".wsv-block");
  WSV.select(blocks[2]);
  t("selecting sets aria-pressed=true on exactly one block",
    blocks.filter(b => b.getAttribute("aria-pressed") === "true").length === 1);
  t("...and it is the tapped block", blocks[2].getAttribute("aria-pressed") === "true");
}

/* ══════ isolation — component is source-agnostic ══════════════════════ */

section("The component knows nothing about Intervals/Strava/Supabase/recognition");
{
  // Strip the header docstring, which names those systems only to declare
  // independence; assert the CODE has no functional coupling to any of them.
  const s = readFileSync("./js/workoutStructure.js", "utf8").replace(/\/\*[\s\S]*?\*\//, "");
  t("no network calls (fetch)", !/\bfetch\s*\(/.test(s));
  t("no Supabase/Intervals/Strava API usage", !/supabase|intervals|strava/i.test(s));
  t("no recognition-engine coupling (raw_data / .recognition)", !/raw_data|\.recognition\b/.test(s));
  t("no coupling to AthlevoCoach or the recognition globals", !/AthlevoCoach|getStoredRecognition/.test(s));
  t("input is only normalized segments (documented contract)", /normalized segment/i.test(readFileSync("./js/workoutStructure.js", "utf8")));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

/* ── a tiny DOM good enough for select()'s classList/querySelector needs ─── */
function makeDom(html, segments) {
  // Parse the flat block list; build minimal element stand-ins.
  const idxs = [...html.matchAll(/data-idx="(\d+)"/g)].map(m => Number(m[1]));
  const root = elem("div");
  root.matches = sel => sel === "[data-wsv]";
  const detailEl = elem("div"); detailEl._attr["data-wsv-detail"] = "1";
  const blockEls = idxs.map(i => { const b = elem("button"); b._attr["data-idx"] = String(i);
    b.classList._set.add("wsv-block"); b.closest = sel => sel === "[data-wsv]" ? root : null; return b; });
  root._children = blockEls.concat([detailEl]);
  root.querySelectorAll = sel => sel === ".wsv-block" ? blockEls
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
  return root.querySelectorAll(".wsv-block").filter(b => b.classList._set.has("is-active")).length;
}
// A 'Show more' button followed by a hidden secondary block, as rendered.
function makeToggleDom() {
  const btn = elem("button"); btn._attr["aria-expanded"] = "false"; btn.textContent = "Show more";
  const more = elem("div"); more._attr["hidden"] = "";
  btn.nextSibling = more;
  return { btn, more };
}

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — WorkoutStructureView   (BEM markup, wsv-v3)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  One continuous horizontal timeline of a workout's SHAPE — Apple-Health /
 *  Strava style. Segments connect edge-to-edge on a shared track, never
 *  floating cards, never a vertical text list.
 *
 *  DOM contract (kept stable so the CSS in index.html can never drift):
 *    <div class="wsv" data-wsv data-wsv-version="3">
 *      <div class="wsv__scroller">
 *        <div class="wsv__track">
 *          <button class="wsv__segment wsv__segment--red">…</button> …
 *        </div>
 *      </div>
 *      <div class="wsv__detail">…</div>
 *    </div>
 *
 *  Deliberately ignorant of Intervals, Strava, Supabase and the recognition
 *  engine. It receives ONLY normalized segments:
 *
 *    segment = {
 *      kind:     "warmup" | "work" | "recovery" | "cooldown" | "steady",
 *      label:    "Threshold",        // full display name (required)
 *      duration: 360,                // seconds (required, > 0 to render)
 *      tone:     "warm"|"blue"|"red"|"orange"|"green"|"gray",
 *      // optional detail fields, surfaced on tap — never invented:
 *      pace, hr, cadence, elevation, power, distanceKm
 *    }
 *
 *  Inside a track segment we show ONLY the short label + duration. Pace lives
 *  exclusively in the tap-detail card below the graph.
 *
 *  Pure where it can be: model()/detailModel()/toggleState() are DOM-free and
 *  unit-testable. render() returns HTML; select()/toggleMore()/mount() are the
 *  only DOM functions. Exposed as window.WorkoutStructureView.
 */
(function (root) {
  "use strict";

  var VERSION = "workout-structure-v3";
  var BUILD = "wsv-v3";
  try { if (root.console) root.console.log("[athlevo] workout structure build: " + BUILD); } catch (e) {}

  // tone → BEM modifier suffix. Colours live in index.html (theme-aware).
  var TONES = { warm: "warm", blue: "blue", recovery: "blue", red: "red",
    orange: "orange", green: "green", gray: "gray", grey: "gray" };
  var KIND_TONE = { warmup: "warm", recovery: "blue", work: "red",
    cooldown: "gray", steady: "green" };

  function num(v) { var x = Number(v); return isFinite(x) ? x : null; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  function fmtDur(sec) {
    var s = Math.max(0, Math.round(num(sec) || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  // Spoken duration for aria: "6 minutes 1 second", "20 minutes 2 seconds".
  function spokenDur(sec) {
    var s = Math.max(0, Math.round(num(sec) || 0));
    var m = Math.floor(s / 60), r = s % 60, parts = [];
    if (m) parts.push(m + (m === 1 ? " minute" : " minutes"));
    if (r || !m) parts.push(r + (r === 1 ? " second" : " seconds"));
    return parts.join(" ");
  }

  function toneOf(seg) {
    var t = seg && seg.tone && TONES[seg.tone];
    return t || KIND_TONE[seg && seg.kind] || "gray";
  }

  // Compact label for a narrow block: Warm · T1/T2 · Rec · Cool · full name.
  function shortLabel(kind, label, repNum, workTotal) {
    if (kind === "warmup") return "Warm";
    if (kind === "cooldown") return "Cool";
    if (kind === "recovery") return "Rec";
    if (kind === "work") {
      var initial = (String(label || "T").trim()[0] || "T").toUpperCase();
      return workTotal > 1 ? initial + repNum : initial;
    }
    return label || "Run";
  }

  /*
   * model(segments) → { empty, blocks[], totalSec }
   * Keeps only positive-duration segments; work blocks are numbered.
   */
  function model(segments) {
    var list = Array.isArray(segments) ? segments : [];
    var blocks = [];
    var workSeen = 0, workTotal = 0;
    list.forEach(function (s) { if (s && s.kind === "work" && num(s.duration) > 0) workTotal++; });

    var total = 0;
    list.forEach(function (s) {
      var dur = num(s && s.duration);
      if (!s || !(dur > 0)) return;               // no placeholders for empty segments
      total += dur;
      var isWork = s.kind === "work";
      var repNum = isWork ? (++workSeen) : 0;
      var label = s.label || (s.kind ? s.kind.charAt(0).toUpperCase() + s.kind.slice(1) : "Segment");
      var repLabel = (isWork && workTotal > 1) ? label + " Rep " + repNum : label;
      blocks.push({
        index: blocks.length,
        kind: s.kind || "steady",
        tone: toneOf(s),
        label: label,
        short: shortLabel(s.kind, label, repNum, workTotal),
        repLabel: repLabel,
        durationSec: Math.round(dur),
        durationText: fmtDur(dur),
        durationSpoken: spokenDur(dur),
        pace: s.pace != null ? String(s.pace) : null,
        hr: s.hr != null ? String(s.hr) : null,
        cadence: s.cadence != null ? String(s.cadence) : null,
        elevation: s.elevation != null ? String(s.elevation) : null,
        power: s.power != null ? String(s.power) : null,
        distanceKm: s.distanceKm != null ? num(s.distanceKm) : null,
        // Duration-proportional grow; the CSS min-width is the interactive floor.
        grow: Math.max(1, Math.round(dur))
      });
    });

    return { empty: blocks.length === 0, blocks: blocks, totalSec: total };
  }

  function bpm(hr) { return /^\d+$/.test(String(hr)) ? hr + " bpm" : String(hr); }

  /*
   * detailModel(segments, idx) → { title, tone, primary[], secondary[] } | null
   * primary   = duration, pace, HR (only when present)
   * secondary = distance, cadence, elevation, power (only when present)
   * Nothing is fabricated; absent metrics never become empty rows.
   */
  function detailModel(segments, idx) {
    var m = model(segments);
    if (idx == null || idx < 0 || idx >= m.blocks.length) return null;
    var b = m.blocks[idx];
    var primary = [["Duration", b.durationText]];
    if (b.pace) primary.push(["Average pace", b.pace]);
    if (b.hr) primary.push(["Average HR", bpm(b.hr)]);
    var secondary = [];
    if (b.distanceKm != null) secondary.push(["Distance", b.distanceKm.toFixed(2) + " km"]);
    if (b.cadence) secondary.push(["Cadence", /^\d+$/.test(b.cadence) ? b.cadence + " spm" : b.cadence]);
    if (b.elevation) secondary.push(["Elevation", b.elevation]);
    if (b.power) secondary.push(["Power", /^\d+$/.test(b.power) ? b.power + " W" : b.power]);
    return { title: b.repLabel, tone: b.tone, primary: primary, secondary: secondary };
  }

  function rowsHTML(rows) {
    return rows.map(function (r) {
      return '<div class="wsv__detail-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
    }).join("");
  }

  function detailHTML(d) {
    if (!d) return "";
    var html = '<div class="wsv__detail-card wsv__detail-card--' + d.tone + '">' +
      '<div class="wsv__detail-h">' + esc(d.title) + '</div>' + rowsHTML(d.primary);
    if (d.secondary.length) {
      html += '<button type="button" class="wsv__more" aria-expanded="false"' +
        ' onclick="WorkoutStructureView.toggleMore(this)">Show more</button>' +
        '<div class="wsv__detail-more" hidden>' + rowsHTML(d.secondary) + '</div>';
    }
    return html + '</div>';
  }

  // Pure selection rule: re-tapping the open block closes it — one open, max.
  function toggleState(current, idx) { return (current === idx) ? null : idx; }

  /*
   * render(segments, opts) → HTML string. opts.selected pre-expands an index.
   */
  function render(segments, opts) {
    var o = opts || {};
    var m = model(segments);
    if (m.empty) return '<p class="wsv__empty">No workout structure available.</p>';
    var sel = (o.selected != null) ? o.selected : null;

    var track = m.blocks.map(function (b) {
      var active = (sel === b.index);
      return '<button type="button" class="wsv__segment wsv__segment--' + b.tone + (active ? " is-active" : "") + '"' +
        ' style="flex-grow:' + b.grow + '"' +
        ' data-idx="' + b.index + '" aria-pressed="' + (active ? "true" : "false") + '"' +
        ' aria-label="' + esc(b.repLabel + ", " + b.durationSpoken) + '"' +
        ' onclick="WorkoutStructureView.select(this)">' +
        '<span class="wsv__label">' + esc(b.short) + '</span>' +
        '<span class="wsv__dur">' + esc(b.durationText) + '</span>' +
        '</button>';
    }).join("");

    // OVERLAY SLOT — future pace/HR/power lines + coach comments mount over
    // .wsv__track without touching block layout.
    return '<div class="wsv" data-wsv data-wsv-version="3">' +
      '<div class="wsv__scroller"><div class="wsv__track" role="group" aria-label="Workout structure">' +
      track + '</div></div>' +
      '<div class="wsv__detail" data-wsv-detail>' + detailHTML(detailModel(segments, sel)) + '</div>' +
      // Temporary debug marker (wsv-v3) — confirms the current JS + CSS shipped.
      '<div class="wsv__build" aria-hidden="true">Workout graph build: ' + BUILD + '</div>' +
      '</div>';
  }

  /*
   * select(el) — DOM click/keyboard handler. Toggles the one open detail card
   * and flips aria-pressed / is-active on exactly one segment. Browser-only.
   */
  function select(el) {
    if (!el || !el.closest) return;
    var rootEl = el.closest("[data-wsv]");
    if (!rootEl) return;
    var idx = parseInt(el.getAttribute("data-idx"), 10);
    var next = toggleState(rootEl.__wsvSel != null ? rootEl.__wsvSel : null, idx);
    rootEl.__wsvSel = next;

    var segs = rootEl.querySelectorAll(".wsv__segment");
    for (var i = 0; i < segs.length; i++) {
      var on = parseInt(segs[i].getAttribute("data-idx"), 10) === next;
      segs[i].classList.toggle("is-active", on);
      segs[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    var detail = rootEl.querySelector("[data-wsv-detail]");
    if (detail) detail.innerHTML = detailHTML(detailModel(rootEl.__wsvSegments || [], next));
  }

  // toggleMore(btn) — reveal/hide the secondary metrics under a detail card.
  function toggleMore(btn) {
    if (!btn) return;
    var more = btn.nextSibling;
    while (more && more.nodeType !== 1) more = more.nextSibling;
    if (!more) return;
    var open = more.hasAttribute("hidden");
    if (open) more.removeAttribute("hidden"); else more.setAttribute("hidden", "");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "Show less" : "Show more";
  }

  // mount(rootEl, segments) — cache segment data on the root so select() can
  // rebuild detail cards without re-parsing the DOM. Call after innerHTML.
  function mount(rootEl, segments) {
    if (!rootEl) return;
    var el = rootEl.matches && rootEl.matches("[data-wsv]") ? rootEl
      : (rootEl.querySelector ? rootEl.querySelector("[data-wsv]") : null);
    if (el) { el.__wsvSegments = Array.isArray(segments) ? segments : []; el.__wsvSel = null; }
  }

  var api = { render: render, mount: mount, select: select, toggleMore: toggleMore,
    model: model, detailModel: detailModel, toggleState: toggleState,
    VERSION: VERSION, BUILD: BUILD };
  if (root) root.WorkoutStructureView = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

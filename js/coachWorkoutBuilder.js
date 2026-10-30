/*
 * ═════════════════════════════════════════════════
 *  Athlevo — Coach Workout Builder (UI)
 * ═════════════════════════════════════════════════
 *
 *  Mounts a structured-workout editor inside any container. All validation,
 *  maths and text output come from js/structuredWorkout.js; this file is only
 *  the editor. It never talks to the network: the host (js/coachMode.js)
 *  passes library callbacks in.
 *
 *    var b = AthlevoCoachWorkoutBuilder.mount(el, {
 *      structure,            // existing structure or null
 *      paces,                // athlete.training_paces ({ zones, vdot, source }) or null
 *      athleteName,          // for the summary hint
 *      readOnly,             // render without editing
 *      library: { list(), save(item), remove(id) },   // optional
 *      onChange(state),      // { hasSteps, summary }
 *      onLoadLibraryItem(item)  // e.g. prefill the title
 *    });
 *    b.getStructure()   → structure object (unvalidated copy)
 *    b.validate()       → { ok, value | error }
 *    b.hasSteps()       → boolean
 */
(function (root) {
  "use strict";

  var SW = root.AthlevoStructuredWorkout;

  var TEMPLATES = [
    { id: "easy", label: "Easy run", build: function () { return { steps: [step("steady", "min", 45, zone("easy"))] }; } },
    { id: "tempo", label: "Tempo run", build: function () { return { steps: [step("warmup", "min", 15, zone("easy")), step("work", "min", 20, zone("tempo")), step("cooldown", "min", 10, zone("easy"))] }; } },
    { id: "threshold", label: "Threshold intervals", build: function () { return { steps: [step("warmup", "min", 15, zone("easy")), rep(4, [step("work", "min", 8, zone("threshold")), step("recovery", "min", 2, zone("recovery"))]), step("cooldown", "min", 10, zone("easy"))] }; } },
    { id: "vo2", label: "VO2 intervals", build: function () { return { steps: [step("warmup", "min", 15, zone("easy")), rep(5, [step("work", "min", 3, zone("vo2")), step("recovery", "min", 2, zone("recovery"))]), step("cooldown", "min", 10, zone("easy"))] }; } },
    { id: "reps", label: "Repetitions (track)", build: function () { return { steps: [step("warmup", "min", 15, zone("easy")), rep(8, [step("work", "m", 400, zone("repetition")), step("recovery", "m", 200, zone("recovery"))]), step("cooldown", "min", 10, zone("easy"))] }; } },
    { id: "long", label: "Long run", build: function () { return { steps: [step("steady", "min", 90, zone("easy"))] }; } }
  ];

  function zone(z) { return { kind: "zone", zone: z }; }
  function step(type, unit, value, target) { return { type: type, duration: { unit: unit, value: value }, target: target }; }
  function rep(reps, steps) { return { type: "repeat", reps: reps, steps: steps }; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function paceToText(sec) { return sec ? SW.fmtPace(sec) : ""; }
  function parsePace(text) { var m = /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(String(text || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

  var STYLE_ID = "coachWorkoutBuilderStyles";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      ".wb{display:grid;gap:12px;padding:14px;border:1px solid var(--line,#dcdcd8);border-radius:var(--r-lg,14px);background:var(--paper,#fff)}",
      ".wb-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px}",
      ".wb-head b{font-size:var(--fs-body,15px);color:var(--text,#141416)}",
      ".wb-paces{font-size:var(--fs-caption,12px);color:var(--ink3,#6b6b70)}",
      ".wb-tools{display:flex;flex-wrap:wrap;gap:8px}",
      ".wb select,.wb input{font:inherit;font-size:var(--fs-body-sm,14px);min-height:40px;box-sizing:border-box;padding:6px 8px;border:1px solid var(--line,#dcdcd8);border-radius:10px;background:var(--paper,#fff);color:var(--text,#141416);max-width:100%}",
      ".wb input[type=number]{width:78px}.wb input.wb-pace{width:68px}.wb input.wb-name{flex:1 1 160px}",
      ".wb button{font:inherit;font-size:var(--fs-body-sm,14px);min-height:40px;padding:6px 12px;border:1px solid var(--line,#dcdcd8);border-radius:var(--r-pill,999px);background:var(--paper,#fff);color:var(--text,#141416);cursor:pointer}",
      ".wb button.wb-primary{background:var(--text,#141416);color:#fff;border-color:var(--text,#141416)}",
      ".wb button:disabled,.wb select:disabled,.wb input:disabled{opacity:.55;cursor:default}",
      ".wb-steps{list-style:none;margin:0;padding:0;display:grid;gap:8px}",
      ".wb-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;border:1px solid var(--line,#dcdcd8);border-radius:12px}",
      ".wb-row[data-type=work]{border-left:4px solid var(--red,#c0272d)}",
      ".wb-row[data-type=recovery]{border-left:4px solid var(--ink3,#9a9aa0)}",
      ".wb-repeat{padding:10px;border:1px dashed var(--ink3,#9a9aa0);border-radius:14px;display:grid;gap:8px}",
      ".wb-repeat-head{display:flex;align-items:center;gap:8px;font-size:var(--fs-body-sm,14px);font-weight:700}",
      ".wb-inner{list-style:none;margin:0;padding:0;display:grid;gap:8px}",
      ".wb-x{margin-left:auto;min-width:40px;padding:6px 10px}",
      ".wb-shape{display:flex;align-items:flex-end;gap:1px;height:56px;padding:4px 0}",
      ".wb-bar{flex:0 0 auto;min-width:2px;border-radius:3px 3px 0 0;background:var(--ink3,#9a9aa0)}",
      ".wb-bar[data-kind=work]{background:var(--red,#c0272d)}",
      ".wb-bar[data-kind=warmup],.wb-bar[data-kind=cooldown]{background:var(--ink2,#55555a);opacity:.6}",
      ".wb-bar[data-kind=recovery]{opacity:.45}",
      ".wb-summary{margin:0;font-size:var(--fs-body-sm,14px);font-weight:700;color:var(--text,#141416)}",
      ".wb-hint{margin:0;font-size:var(--fs-caption,12px);color:var(--ink3,#6b6b70)}",
      ".wb-error{margin:0;min-height:1em;font-size:var(--fs-caption,12px);color:var(--red,#c0272d)}",
      ".wb-empty{margin:0;font-size:var(--fs-body-sm,14px);color:var(--ink2,#55555a)}",
      ".wb [hidden]{display:none!important}",
      ".wb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}"
    ].join("\n");
    document.head.appendChild(s);
  }

  var TYPE_LABEL = { warmup: "Warm up", work: "Work", steady: "Steady", recovery: "Recovery", cooldown: "Cool down" };
  var UNIT_LABEL = { min: "min", km: "km", m: "m" };

  function mount(container, options) {
    options = options || {};
    if (!SW || !container) return null;
    ensureStyles();
    var readOnly = options.readOnly === true;
    var model = options.structure && Array.isArray(options.structure.steps) ? clone(options.structure) : { steps: [] };
    var zones = options.paces && options.paces.zones ? options.paces.zones : null;
    var libraryItems = [];
    var libraryNote = "";
    var saving = false;

    function zonePace(key) { return zones && zones[key] && zones[key].secPerKm ? zones[key].secPerKm : null; }

    /* ───────── rendering ───────── */
    function targetControls(path, t) {
      var kind = t && t.kind || "zone";
      var out = '<select data-f="target-kind" data-path="' + path + '" aria-label="Target type"' + (readOnly ? " disabled" : "") + '>' +
        [["zone", "Zone"], ["rpe", "RPE"], ["pace", "Pace"], ["hr", "Heart rate"], ["none", "No target"]].map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === kind ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select>";
      var dis = readOnly ? " disabled" : "";
      if (kind === "zone") {
        out += '<select data-f="target-zone" data-path="' + path + '" aria-label="Zone"' + dis + ">" + SW.ZONES.map(function (z) {
          var p = zonePace(z.key);
          return '<option value="' + z.key + '"' + (t && t.zone === z.key ? " selected" : "") + ">" + esc(z.label) + (p ? " (" + paceToText(p) + "/km)" : "") + "</option>";
        }).join("") + "</select>";
      } else if (kind === "rpe") {
        out += '<input type="number" min="1" max="10" step="0.5" data-f="rpe-min" data-path="' + path + '" value="' + esc(t.min) + '" aria-label="RPE from"' + dis + '> to ' +
          '<input type="number" min="1" max="10" step="0.5" data-f="rpe-max" data-path="' + path + '" value="' + esc(t.max) + '" aria-label="RPE to"' + dis + ">";
      } else if (kind === "pace") {
        out += '<input class="wb-pace" inputmode="numeric" placeholder="4:20" data-f="pace-min" data-path="' + path + '" value="' + esc(paceToText(t.minSec)) + '" aria-label="Fastest pace per km"' + dis + '> to ' +
          '<input class="wb-pace" inputmode="numeric" placeholder="4:35" data-f="pace-max" data-path="' + path + '" value="' + esc(paceToText(t.maxSec)) + '" aria-label="Slowest pace per km"' + dis + "> /km";
      } else if (kind === "hr") {
        out += '<input type="number" min="40" max="230" data-f="hr-min" data-path="' + path + '" value="' + esc(t.min) + '" aria-label="Heart rate from"' + dis + '> to ' +
          '<input type="number" min="40" max="230" data-f="hr-max" data-path="' + path + '" value="' + esc(t.max) + '" aria-label="Heart rate to"' + dis + "> bpm";
      }
      return out;
    }

    function stepRow(s, path) {
      var dis = readOnly ? " disabled" : "";
      return '<li class="wb-row" data-type="' + esc(s.type) + '">' +
        '<select data-f="type" data-path="' + path + '" aria-label="Step type"' + dis + ">" + SW.STEP_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (t === s.type ? " selected" : "") + ">" + TYPE_LABEL[t] + "</option>";
        }).join("") + "</select>" +
        '<input type="number" min="0" step="any" data-f="value" data-path="' + path + '" value="' + esc(s.duration.value) + '" aria-label="Length"' + dis + ">" +
        '<select data-f="unit" data-path="' + path + '" aria-label="Unit"' + dis + ">" + SW.UNITS.map(function (u) {
          return '<option value="' + u + '"' + (u === s.duration.unit ? " selected" : "") + ">" + UNIT_LABEL[u] + "</option>";
        }).join("") + "</select>" + targetControls(path, s.target) +
        (readOnly ? "" : '<button type="button" class="wb-x" data-act="remove" data-path="' + path + '" aria-label="Remove step">×</button>') + "</li>";
    }

    function render() {
      var steps = model.steps.map(function (s, i) {
        if (s.type === "repeat") {
          var dis = readOnly ? " disabled" : "";
          return '<li class="wb-repeat"><div class="wb-repeat-head"><span>Repeat</span>' +
            '<input type="number" min="2" max="30" data-f="reps" data-path="' + i + '" value="' + esc(s.reps) + '" aria-label="Repeat count"' + dis + "><span>times</span>" +
            (readOnly ? "" : '<button type="button" class="wb-x" data-act="remove" data-path="' + i + '" aria-label="Remove repeat">×</button>') + "</div>" +
            '<ol class="wb-inner">' + s.steps.map(function (inner, j) { return stepRow(inner, i + "." + j); }).join("") + "</ol>" +
            (readOnly ? "" : '<div class="wb-tools"><button type="button" data-act="add-inner" data-path="' + i + '"' + (s.steps.length >= 6 ? " disabled" : "") + ">+ Step in repeat</button></div>") + "</li>";
        }
        return stepRow(s, String(i));
      }).join("");

      var templateSelect = readOnly || model.steps.length ? "" :
        '<label class="wb-hint" for="wbTemplate">Start from a template, or add steps below</label><select id="wbTemplate" data-f="template" aria-label="Start from a template"><option value="">Choose a template…</option>' +
        TEMPLATES.map(function (t) { return '<option value="' + t.id + '">' + esc(t.label) + "</option>"; }).join("") + "</select>";

      var libraryRow = options.library && !readOnly
        ? '<div class="wb-tools" id="wbLibraryRow"><select data-f="library-pick" aria-label="Load from your library"><option value="">Load from your library…</option>' + libraryOptions() + "</select>" +
          '<button type="button" data-act="library-toggle">Save to library</button></div>' +
          '<div class="wb-tools" id="wbLibrarySave" hidden><input class="wb-name" data-f="library-name" placeholder="Workout name" aria-label="Library workout name" maxlength="120"><input data-f="library-folder" placeholder="Folder (optional)" aria-label="Library folder" maxlength="80">' +
          '<button type="button" class="wb-primary" data-act="library-save">Save</button><button type="button" data-act="library-cancel">Cancel</button></div>' +
          (libraryNote ? '<p class="wb-hint">' + esc(libraryNote) + "</p>" : "")
        : "";

      container.innerHTML = '<section class="wb" aria-label="Workout builder">' +
        '<div class="wb-head"><b>Workout structure</b><span class="wb-paces">' + pacesLine() + "</span></div>" +
        templateSelect + libraryRow +
        (model.steps.length ? '<ol class="wb-steps">' + steps + "</ol>" : '<p class="wb-empty">No steps yet. Add a step or pick a template. You can also skip this and use the simple fields.</p>') +
        (readOnly ? "" : '<div class="wb-tools"><button type="button" data-act="add-step">+ Step</button><button type="button" data-act="add-repeat">+ Repeat</button></div>') +
        '<div class="wb-shape" id="wbShape" aria-hidden="true"></div>' +
        '<p class="wb-summary" id="wbSummary" aria-live="polite"></p><p class="wb-hint" id="wbHint"></p><p class="wb-error" id="wbError" aria-live="polite"></p></section>';
      refreshPreview();
    }

    function libraryOptions() {
      var byFolder = {};
      libraryItems.forEach(function (it) { (byFolder[it.folder || ""] = byFolder[it.folder || ""] || []).push(it); });
      return Object.keys(byFolder).sort().map(function (folder) {
        var opts = byFolder[folder].map(function (it) { return '<option value="' + esc(it.id) + '">' + esc(it.name) + (it.summary && it.summary.duration_minutes ? " · " + it.summary.duration_minutes + " min" : "") + "</option>"; }).join("");
        return folder ? '<optgroup label="' + esc(folder) + '">' + opts + "</optgroup>" : opts;
      }).join("");
    }

    function pacesLine() {
      if (!zones) return "No recent race or run yet: zones show names only";
      var z = ["easy", "marathon", "threshold", "vo2"].filter(function (k) { return zonePace(k); }).map(function (k) { return SW.zoneLabel(k).split(" ")[0] + " " + paceToText(zonePace(k)); });
      return (options.athleteName ? esc(options.athleteName) + "'s paces: " : "Paces: ") + z.join(" · ") + "/km";
    }

    function refreshPreview() {
      var shape = container.querySelector("#wbShape"), summary = container.querySelector("#wbSummary"), hint = container.querySelector("#wbHint");
      if (!shape || !summary) return;
      shape.innerHTML = ""; summary.textContent = ""; if (hint) hint.textContent = "";
      var state = { hasSteps: model.steps.length > 0, summary: "" };
      if (model.steps.length) {
        var r = SW.resolve(model, zones);
        if (r.ok) {
          var total = r.totals.seconds || 1;
          var heights = { recovery: 30, easy: 45, marathon: 62, tempo: 72, threshold: 82, vo2: 94, repetition: 100 };
          shape.innerHTML = r.steps.map(function (s) {
            var h = s.target && s.target.kind === "zone" ? heights[s.target.zone] || 60 : 60;
            return '<span class="wb-bar" data-kind="' + esc(s.type) + '" style="width:' + (s.seconds / total * 100).toFixed(2) + '%;height:' + h + '%"></span>';
          }).join("");
          state.summary = SW.summaryLine(r);
          summary.textContent = state.summary;
          if (hint) hint.textContent = r.totals.distanceKm == null
            ? "Distance is shown once the athlete has a recent race or run to base paces on."
            : r.totals.hasEstimates ? "Some distance steps use a default pace for the preview only." : "Distance uses the athlete's own paces.";
        } else {
          var err = container.querySelector("#wbError");
          if (err) err.textContent = r.error;
        }
      }
      if (typeof options.onChange === "function") options.onChange(state);
    }

    /* ───────── model edits ───────── */
    function locate(path) {
      var parts = String(path).split(".").map(Number);
      return parts.length === 1 ? { list: model.steps, index: parts[0] } : { list: model.steps[parts[0]].steps, index: parts[1] };
    }
    function defaultStep(type) { return step(type || "work", "min", 10, zone(SW.DEFAULT_ZONE[type || "work"])); }

    function onInput(e) {
      var t = e.target, f = t.getAttribute && t.getAttribute("data-f");
      if (!f || f.indexOf("library") === 0 || f === "template") return;
      var path = t.getAttribute("data-path"); if (path == null) return;
      var err = container.querySelector("#wbError"); if (err) err.textContent = "";
      var loc = locate(path), s = loc.list[loc.index];
      if (f === "reps") { s.reps = Number(t.value); refreshPreview(); return; }
      if (f === "value") { s.duration.value = Number(t.value); }
      else if (f === "unit") { s.duration.unit = t.value; render(); return; }
      else if (f === "type") { s.type = t.value; if (s.target && s.target.kind === "zone") s.target = zone(SW.DEFAULT_ZONE[t.value]); render(); return; }
      else if (f === "target-kind") {
        s.target = t.value === "zone" ? zone(SW.DEFAULT_ZONE[s.type]) : t.value === "rpe" ? { kind: "rpe", min: 6, max: 7 }
          : t.value === "pace" ? { kind: "pace", minSec: 255, maxSec: 270 } : t.value === "hr" ? { kind: "hr", min: 150, max: 165 } : { kind: "none" };
        render(); return;
      }
      else if (f === "target-zone") s.target = zone(t.value);
      else if (f === "rpe-min") s.target.min = Number(t.value);
      else if (f === "rpe-max") s.target.max = Number(t.value);
      else if (f === "hr-min") s.target.min = Number(t.value);
      else if (f === "hr-max") s.target.max = Number(t.value);
      else if (f === "pace-min") { var a = parsePace(t.value); if (a) s.target.minSec = a; }
      else if (f === "pace-max") { var b = parsePace(t.value); if (b) s.target.maxSec = b; }
      refreshPreview();
    }

    async function onChange(e) {
      var t = e.target, f = t.getAttribute && t.getAttribute("data-f");
      if (f === "template" && t.value) {
        var tpl = TEMPLATES.filter(function (x) { return x.id === t.value; })[0];
        if (tpl) { model = tpl.build(); render(); }
        return;
      }
      if (f === "library-pick" && t.value) {
        var item = libraryItems.filter(function (x) { return x.id === t.value; })[0];
        if (item && item.structure) {
          model = clone(item.structure); render();
          if (typeof options.onLoadLibraryItem === "function") options.onLoadLibraryItem(item);
        }
        return;
      }
      // Every other control is handled by the "input" listener (selects fire it too).
    }

    async function onClick(e) {
      var btn = e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn || readOnly) return;
      var act = btn.getAttribute("data-act"), path = btn.getAttribute("data-path");
      if (act === "add-step") { model.steps.push(defaultStep(model.steps.length ? "work" : "steady")); render(); }
      else if (act === "add-repeat") { model.steps.push(rep(4, [defaultStep("work"), defaultStep("recovery")])); render(); }
      else if (act === "add-inner") { var r = model.steps[Number(path)]; if (r.steps.length < 6) r.steps.push(defaultStep("work")); render(); }
      else if (act === "remove") { var loc = locate(path); loc.list.splice(loc.index, 1); render(); }
      else if (act === "library-toggle") { var box = container.querySelector("#wbLibrarySave"); if (box) { box.hidden = !box.hidden; var nm = box.querySelector("[data-f=library-name]"); if (!box.hidden && nm) nm.focus(); } }
      else if (act === "library-cancel") { var b2 = container.querySelector("#wbLibrarySave"); if (b2) b2.hidden = true; }
      else if (act === "library-save") { await saveToLibrary(btn); }
    }

    async function saveToLibrary(btn) {
      if (saving || !options.library) return;
      var err = container.querySelector("#wbError");
      var v = SW.validate(model);
      if (!v.ok) { if (err) err.textContent = v.error; return; }
      var name = (container.querySelector("[data-f=library-name]") || {}).value || "";
      var folder = (container.querySelector("[data-f=library-folder]") || {}).value || "";
      if (!name.trim()) { if (err) err.textContent = "Give the library workout a name."; return; }
      saving = true; btn.disabled = true;
      var res = await options.library.save({ name: name.trim(), folder: folder.trim(), structure: v.value });
      saving = false; btn.disabled = false;
      if (!res || !res.ok) { if (err) err.textContent = (res && res.error) || "Could not save to your library."; return; }
      libraryItems = [res.item].concat(libraryItems.filter(function (x) { return x.id !== res.item.id; }));
      libraryNote = "Saved to your library.";
      var keep = model; render(); model = keep;
    }

    container.addEventListener("input", onInput);
    container.addEventListener("change", onChange);
    container.addEventListener("click", onClick);
    render();

    if (options.library && !readOnly) {
      Promise.resolve(options.library.list()).then(function (res) {
        if (!res) return;
        libraryItems = res.items || [];
        if (res.unavailable) libraryNote = res.message || "The workout library is not set up yet.";
        var keep = model; render(); model = keep;
      }).catch(function () {});
    }

    return {
      getStructure: function () { return clone(model); },
      validate: function () { return SW.validate(model); },
      hasSteps: function () { return model.steps.length > 0; }
    };
  }

  root.AthlevoCoachWorkoutBuilder = { mount: mount, TEMPLATES: TEMPLATES };
})(typeof window !== "undefined" ? window : globalThis);

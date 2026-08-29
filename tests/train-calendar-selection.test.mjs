/**
 * Train calendar day selection: clicks must change the selected date
 * and replace the selected-day panel.
 *
 * Run: node tests/train-calendar-selection.test.mjs
 */

import { readFileSync } from "node:fs";

const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const html = readFileSync("./index.html", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log("PASS — " + name);
  } else {
    failed += 1;
    console.log("FAIL — " + name + (extra ? "  [" + extra + "]" : ""));
  }
}

function el(id) {
  const node = {
    id,
    innerHTML: "",
    style: {},
    className: "",
    dataset: {},
    offsetTop: 0,
    offsetHeight: 80,
    scrollTop: 0,
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    querySelector(sel) {
      if (sel === ".tc-day.sel") {
        const m = this.innerHTML.match(/class="([^"]*\btc-day\b[^"]*\bsel\b[^"]*)"[^>]*data-date="([^"]+)"/);
        return m ? { className: m[1], getAttribute: k => (k === "data-date" ? m[2] : null), animate() {} } : null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    contains() { return true; }
  };
  return node;
}

const nodes = {
  trainCalendar: el("trainCalendar"),
  trainDayPanel: el("trainDayPanel"),
  trainWeekProgress: el("trainWeekProgress"),
  trainContext: el("trainContext"),
  "screen-train": el("screen-train")
};

const documentStub = {
  getElementById(id) { return nodes[id] || null; },
  querySelector(sel) {
    if (sel === "#trainCalendar .tc-day.sel") return nodes.trainCalendar.querySelector(".tc-day.sel");
    return null;
  }
};

const windowStub = {
  matchMedia: () => ({ matches: true }),
  PointerEvent: function PointerEvent() {},
  AthlevoCalendar: {
    resolveTimezone: () => "Asia/Manila",
    localCivil: (d) => {
      const x = d instanceof Date ? d : new Date(d);
      return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() };
    }
  },
  SportClassification: {
    canonicalSportOf: (a) => /weight|strength/i.test(String(a && a.sport_type || "")) ? "strength" : "run"
  }
};

const supabaseClient = { auth: { getUser: async () => ({ data: { user: null } }) } };
new Function("window", "document", "supabaseClient", readFileSync("./js/activityStreams.js", "utf8"))(windowStub, documentStub, supabaseClient);
new Function("window", "document", "supabaseClient", calendar)(windowStub, documentStub, supabaseClient);
const TC = windowStub.AthlevoTrainCalendar;

const monday = new Date(2026, 7, 24);
const byDate = {
  "2026-08-24": { activities: [{ id: "r24", sport_type: "Run", name: "Aug 24 run", moving_time_seconds: 3600, distance_meters: 10000, raw_data: { laps: [{ distance: 1000, moving_time: 360 }, { distance: 1000, moving_time: 340 }] } }] },
  "2026-08-25": { activities: [{ id: "r25", sport_type: "Run", name: "Aug 25 run", moving_time_seconds: 2400, distance_meters: 6000 }] },
  "2026-08-29": { session: { session_type: "easy", title: "Saturday easy", duration_minutes: 50 }, activities: [] },
  "2026-08-30": { session: { session_type: "long_run", title: "Sunday long", duration_minutes: 90 }, activities: [] }
};

function clickDay(dISO) {
  const cal = nodes.trainCalendar;
  const handlers = cal.listeners.click || [];
  handlers.forEach(fn => fn({
    target: {
      closest(sel) {
        if (sel === ".tc-nav") return null;
        if (sel === ".tc-day") return { getAttribute: k => (k === "data-date" ? dISO : null) };
        return null;
      }
    },
    preventDefault() {}
  }));
}

TC.hydrate(monday, "2026-08-30", byDate);

console.log("\n──── Click changes selected date and panel ────");
test("initial selected date is Sunday Aug 30", TC.getSelectedDate() === "2026-08-30");
test("Sunday panel is the only day rendered",
  /data-train-day="2026-08-30"/.test(nodes.trainDayPanel.innerHTML) &&
  !/data-train-day="2026-08-24"/.test(nodes.trainDayPanel.innerHTML));

clickDay("2026-08-24");
test("click Aug 24 selects Aug 24", TC.getSelectedDate() === "2026-08-24");
test("detail renders Aug 24 only",
  /data-train-day="2026-08-24"/.test(nodes.trainDayPanel.innerHTML) &&
  /data-activity-id="r24"/.test(nodes.trainDayPanel.innerHTML) &&
  !/data-train-day="2026-08-30"/.test(nodes.trainDayPanel.innerHTML) &&
  !/Sunday long/.test(nodes.trainDayPanel.innerHTML));

const after24 = nodes.trainDayPanel.innerHTML;
clickDay("2026-08-25");
test("click Aug 25 selects Aug 25", TC.getSelectedDate() === "2026-08-25");
test("Aug 24 content disappears",
  /data-train-day="2026-08-25"/.test(nodes.trainDayPanel.innerHTML) &&
  /data-activity-id="r25"/.test(nodes.trainDayPanel.innerHTML) &&
  !/data-activity-id="r24"/.test(nodes.trainDayPanel.innerHTML) &&
  !/data-train-day="2026-08-24"/.test(nodes.trainDayPanel.innerHTML));

clickDay("2026-08-29");
test("click Aug 29 updates selected styling",
  TC.getSelectedDate() === "2026-08-29" &&
  /data-date="2026-08-29"[^>]*aria-pressed="true"/.test(nodes.trainCalendar.innerHTML) &&
  (nodes.trainCalendar.innerHTML.match(/class="[^"]*\btc-day\b[^"]*\bsel\b/g) || []).length === 1 &&
  /Saturday easy/.test(nodes.trainDayPanel.innerHTML));

const beforeSame = nodes.trainDayPanel.innerHTML;
clickDay("2026-08-29");
test("click same day twice does not duplicate cards",
  TC.getSelectedDate() === "2026-08-29" &&
  (nodes.trainDayPanel.innerHTML.match(/data-train-item="plan"/g) || []).length ===
    (beforeSame.match(/data-train-item="plan"/g) || []).length &&
  (nodes.trainDayPanel.innerHTML.match(/data-train-day=/g) || []).length === 1);

console.log("\n──── Today, navigation, cards ────");
TC.goToday();
test("Today button selects today", TC.getSelectedDate() === "2026-08-30" || /^\d{4}-\d{2}-\d{2}$/.test(TC.getSelectedDate()));

TC.hydrate(monday, "2026-08-30", byDate);
const clickCount = (nodes.trainCalendar.listeners.click || []).length;
TC.hydrate(new Date(2026, 7, 31), "2026-09-02", { "2026-09-02": { session: { session_type: "tempo", title: "New week tempo" } } });
clickDay("2026-09-02");
test("after week navigation a newly rendered day is still clickable",
  TC.getSelectedDate() === "2026-09-02" &&
  /New week tempo/.test(nodes.trainDayPanel.innerHTML) &&
  (nodes.trainCalendar.listeners.click || []).length === clickCount);

test("day buttons have pointer-events enabled and a real touch target",
  /pointer-events:auto/.test(html) &&
  /min-height:52px/.test(html) &&
  /min-width:44px/.test(html));

TC.hydrate(monday, "2026-08-24", byDate);
test("selected-day activity cards still open the activity modal",
  /openModal\('2026-08-24','r24'\)/.test(nodes.trainDayPanel.innerHTML) &&
  /af-card--activity/.test(nodes.trainDayPanel.innerHTML));
test("mini graph lives on the activity card, not the date row",
  /af-card-profile/.test(nodes.trainDayPanel.innerHTML) &&
  !/af-card-profile/.test(nodes.trainCalendar.innerHTML));
test("exactly one selected date exists",
  (nodes.trainCalendar.innerHTML.match(/class="[^"]*\btc-day\b[^"]*\bsel\b/g) || []).length === 1 &&
  (nodes.trainCalendar.innerHTML.match(/aria-pressed="true"/g) || []).length === 1);

console.log("\n──── Listener strategy ────");
test("day buttons carry a data-date attribute",
  /data-date="\$\{dISO\}"/.test(calendar));
test("clicks are delegated on the stable calendar container",
  /bindCalendarInteractions/.test(calendar) &&
  /closest\("\.tc-day"\)/.test(calendar) &&
  /getAttribute\("data-date"\)/.test(calendar));
test("swipe does not capture the pointer until a horizontal drag",
  /gesture\.captured/.test(calendar) &&
  !/setPointerCapture[\s\S]{0,80}addEventListener\("pointermove"/.test(calendar) &&
  /intent !== "horizontal"[\s\S]{0,180}setPointerCapture/.test(calendar));
test("week swipe still exists and still ignores the Today/arrow nav cluster",
  /function attachSwipe/.test(calendar) &&
  /closest\("\.tc-nav"\)/.test(calendar));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

/* Focused contract for the consolidated fluid-interaction completion pass. */
import { readFileSync } from "node:fs";

const sheet = readFileSync("./js/sheet.js", "utf8");
const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const coach = readFileSync("./js/coachMode.js", "utf8");
const athlete = readFileSync("./js/athleteMode.js", "utf8");
const train = readFileSync("./js/train.js", "utf8");
const access = readFileSync("./js/accessGuard.js", "utf8");
const html = readFileSync("./index.html", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}

console.log("\n──── Sheet gesture boundary ────");
test("drag is explicit opt-in and uses a handle with Pointer Events",
  /options\.draggable !== true/.test(sheet) &&
  /athlevo-sheet-drag-handle/.test(sheet + html) &&
  /pointerdown/.test(sheet) && /setPointerCapture/.test(sheet));
test("drag tracks vertically with upward resistance and projected dismissal",
  /dy < 0 \? dy \* \.18 : dy/.test(sheet) &&
  /drag\.offset \+ drag\.velocity \* 180/.test(sheet));
test("release can spring home or continue from its current presentation",
  /function settleDrag/.test(sheet) && /function runDragClose/.test(sheet) &&
  /cubic-bezier\(\.2,\.9,\.2,1\.08\)/.test(sheet));
test("payment stays gesture-free while using the shared lifecycle",
  /sheet: "\.performance-upgrade-sheet",\s*draggable: false/.test(access));

console.log("\n──── Calendar and Athlete Detail ────");
const calendarMove = calendar.slice(calendar.indexOf("const move = event"), calendar.indexOf("const end = event"));
test("week swipe locks horizontal intent and preserves vertical scrolling",
  /touchAction = "pan-y"/.test(calendar) && /gesture\.intent = Math\.abs\(dx\)/.test(calendar));
test("week swipe is direct, edge-safe, and does not rerender on pointermove",
  /translate3d\(\$\{gesture\.dx\}px/.test(calendar) &&
  /event\.clientX < 24/.test(calendar) && !/render\(/.test(calendarMove));
test("week release combines distance and velocity while buttons remain",
  /projected = finished\.travelX \+ finished\.velocity \* 180/.test(calendar) &&
  /AthlevoTrainCalendar\.prevWeek/.test(calendar) && /AthlevoTrainCalendar\.nextWeek/.test(calendar));
test("Athlete Detail has distinct push/reverse motion and exact return state",
  /function animateAthleteDrillIn/.test(coach) && /translate3d\(24px,0,0\)/.test(coach) &&
  /finishCloseAthletePage/.test(coach) && /_coachDashboardScrollTop/.test(coach) &&
  /_athleteDetailScrollTop/.test(coach));

console.log("\n──── Human messaging and training polish ────");
test("athlete messaging follows only near bottom and exposes Jump to latest",
  /humanThreadNearBottom/.test(athlete) && /amHumanCoachLatest/.test(athlete) &&
  /wasNearBottom/.test(athlete));
test("athlete messaging keeps cached reading context and own sends finish at bottom",
  /_threadScroll = \{ top: 0, nearBottom: true \}/.test(athlete) &&
  /renderHumanThread\(\{ forceLatest: true \}\)/.test(athlete));
test("workout, feedback, check-in, and beta feedback use the shared engine",
  /sheet: "\.tw-modal-box"/.test(calendar) &&
  (train.match(/AthlevoSheet\.open/g) || []).length >= 2 &&
  /js\/feedback\.js\?v=79/.test(html));
test("current training details avoid max-height measurement animation",
  !/detail\.style\.maxHeight|detail\.scrollHeight/.test(train) &&
  /@keyframes trainDetailReveal/.test(html));
test("workout status, add, and reschedule paths acknowledge completion",
  /Workout recorded\.|Workout skipped\.|Workout updated\./.test(train) &&
  /Workout added\.|Workout rescheduled\./.test(coach));
test("transparency, contrast, and reduced-motion preferences are explicit",
  /prefers-reduced-transparency:reduce/.test(html) &&
  /prefers-contrast:more/.test(html) && /prefers-reduced-motion:reduce/.test(html + sheet) &&
  /!root\.PointerEvent \|\| reducedMotion\(\)/.test(sheet) && /if \(reduced\(\)/.test(calendar));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

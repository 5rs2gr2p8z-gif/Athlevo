/*
 * Executable first-open readiness coordinator and submission checks.
 * Run: node tests/morning-readiness.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const morningSource = readFileSync("./js/morningCheckIn.js", "utf8");
const readinessSource = readFileSync("./js/readiness.js", "utf8");
const html = readFileSync("./index.html", "utf8");
const registrySource = readFileSync("./js/analyticsRegistry.js", "utf8");
let passed = 0;
let failed = 0;

function test(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
}
const section = name => console.log(`\n──── ${name} ────`);

function memoryStorage(seed) {
  const store = seed || new Map();
  return {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    store
  };
}

function classList(active) {
  const values = new Set(active ? ["active"] : []);
  return {
    contains: value => values.has(value),
    add: value => values.add(value),
    remove: value => values.delete(value)
  };
}

function makeMorningWorld(options = {}) {
  const storage = options.storage || memoryStorage();
  const screens = {
    "screen-today": { classList: classList(options.todayActive !== false) },
    "screen-onboard": { classList: classList(options.onboarding === true) },
    "screen-connect": { classList: classList(options.connecting === true) },
    "todayAthleteName": {
      textContent: options.firstName || "Dean",
      classList: classList(false)
    },
    "readinessModal": {
      classList: classList(false),
      style: {},
      getAttribute: () => "true"
    }
  };
  const modalOpen = options.blockingModal === true
    ? [{ id: "feedbackModal" }]
    : [];
  const listeners = {};
  const captured = [];
  const opened = [];
  let verifyCalls = 0;
  let currentDay = options.day || "2026-07-29";
  let status = options.status || {
    verified: true,
    user: { id: options.userId || "user-a", user_metadata: {} },
    record: null,
    reason: "incomplete"
  };

  const document = {
    visibilityState: options.hidden ? "hidden" : "visible",
    body: { classList: classList(options.booting === true) },
    getElementById: id => screens[id] || null,
    querySelectorAll: selector =>
      selector === ".modal-back.show" ? modalOpen : [],
    querySelector: () => null,
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  const root = {
    location: { search: options.search || "" },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    AthlevoConnect: {
      isActive: () => options.guidedSetup === true
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent: (name, props) => captured.push({ name, props })
    },
    readinessTodayKey: () => currentDay,
    verifyTodayReadiness: async dayKey => {
      verifyCalls += 1;
      if (options.verify) return options.verify(dayKey);
      return status;
    },
    openReadinessCheck: openOptions => {
      opened.push(openOptions);
      return options.openResult !== false;
    }
  };
  const context = {
    window: root,
    document,
    localStorage: storage,
    URLSearchParams,
    Date,
    Set,
    Array,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.runInNewContext(morningSource, context);
  return {
    api: root.AthlevoMorningCheckIn,
    root,
    document,
    storage,
    listeners,
    captured,
    opened,
    verifyCalls: () => verifyCalls,
    setDay: value => { currentDay = value; },
    setStatus: value => { status = value; }
  };
}

section("Manila date and authoritative lookup");
{
  const root = {};
  vm.runInNewContext(readinessSource, {
    window: root,
    document: {},
    Intl,
    Date,
    console: { log() {}, warn() {}, error() {} }
  });
  test("11:50 PM Manila belongs to that local date",
    root.readinessTodayKey(new Date("2026-07-28T15:50:00Z")) === "2026-07-28");
  test("after Manila midnight the next day becomes eligible",
    root.readinessTodayKey(new Date("2026-07-28T16:01:00Z")) === "2026-07-29");
  test("verified readiness query is scoped to JWT user and Manila day",
    /getUser\(\)/.test(readinessSource) &&
    /\.eq\("user_id", user\.id\)/.test(readinessSource) &&
    /\.eq\("readiness_date", dayKey\)/.test(readinessSource));
}

section("First authenticated open and no-flash behavior");
{
  const world = makeMorningWorld();
  const result = await world.api.evaluate();
  test("incomplete today opens the prompt", result.shown === true && world.opened.length === 1);
  test("prompt opens only once in the active session",
    (await world.api.evaluate()).reason === "already_opened_this_session" &&
    world.opened.length === 1);
}
{
  const world = makeMorningWorld({
    status: {
      verified: true,
      user: { id: "user-a" },
      record: { readiness_date: "2026-07-29" },
      reason: "completed"
    }
  });
  const result = await world.api.evaluate();
  test("completed today suppresses the prompt", result.reason === "completed" && world.opened.length === 0);
}
{
  let resolveVerification;
  const pending = new Promise(resolve => { resolveVerification = resolve; });
  const world = makeMorningWorld({ verify: async () => pending });
  const evaluation = world.api.evaluate();
  test("verification loading does not flash the modal", world.opened.length === 0);
  resolveVerification({
    verified: true,
    user: { id: "user-a" },
    record: { readiness_date: "2026-07-29" }
  });
  await evaluation;
  test("completed verification remains suppressed", world.opened.length === 0);
}
{
  const world = makeMorningWorld({ day: "2026-07-29" });
  const result = await world.api.evaluate();
  test("yesterday's completion cannot suppress today's keyed lookup",
    result.shown === true && world.opened.length === 1);
}

section("Onboarding, callbacks, blocking UI, and lifecycle");
{
  const onboarding = makeMorningWorld({ onboarding: true });
  const callback = makeMorningWorld({ search: "?code=oauth-code&state=signed" });
  const blocking = makeMorningWorld({ blockingModal: true });
  test("onboarding is not interrupted",
    (await onboarding.api.evaluate()).reason === "app_not_ready" &&
    onboarding.verifyCalls() === 0);
  test("auth/OAuth callback processing is not interrupted",
    (await callback.api.evaluate()).reason === "app_not_ready" &&
    callback.verifyCalls() === 0);
  test("another blocking modal prevents the prompt",
    (await blocking.api.evaluate()).reason === "app_not_ready" &&
    blocking.verifyCalls() === 0);
}
{
  const world = makeMorningWorld({ day: "2026-07-29" });
  await world.api.evaluate();
  world.setDay("2026-07-30");
  const nextDay = await world.api.evaluate();
  test("app resume on a new Manila date evaluates again",
    nextDay.shown === true && world.opened.length === 2);
}

section("Temporary dismissal isolation and delay");
{
  const shared = memoryStorage();
  const first = makeMorningWorld({ storage: shared, userId: "user-a" });
  await first.api.evaluate();
  first.opened[0].onDismiss();
  const dismissalEntry = Array.from(shared.store.entries())
    .find(([key]) => key.includes("readiness-dismissed:user-a:2026-07-29"));
  const dismissedAt = JSON.parse(dismissalEntry[1]).dismissedAt;

  const beforeDelay = makeMorningWorld({
    storage: shared,
    userId: "user-a"
  });
  const suppressed = await beforeDelay.api.evaluate({
    nowMs: dismissedAt + first.api.DISMISS_DELAY_MS - 1
  });
  test("Not now temporarily suppresses the same user and date",
    suppressed.reason === "temporarily_dismissed" &&
    beforeDelay.opened.length === 0);

  const otherUser = makeMorningWorld({
    storage: shared,
    userId: "user-b"
  });
  test("dismissal is isolated by authenticated user",
    (await otherUser.api.evaluate()).shown === true);

  const afterDelay = makeMorningWorld({
    storage: shared,
    userId: "user-a"
  });
  test("prompt becomes eligible after the three-hour delay",
    (await afterDelay.api.evaluate({
      nowMs: dismissedAt + first.api.DISMISS_DELAY_MS + 1
    })).shown === true);

  const nextDate = makeMorningWorld({
    storage: shared,
    userId: "user-a",
    day: "2026-07-30"
  });
  test("dismissal is isolated by Manila date",
    (await nextDate.api.evaluate()).shown === true);
}

function makeSubmissionWorld({ failFirst = false } = {}) {
  let fail = failFirst;
  let savedRow = null;
  let closeCount = 0;
  let directionRefreshes = 0;
  let recommendationRefreshes = 0;
  let completedMarks = 0;
  const captured = [];
  const message = { textContent: "" };
  const submit = { disabled: false, textContent: "Save check-in" };
  const modal = {
    classList: { remove: () => { closeCount += 1; } },
    setAttribute() {},
    innerHTML: "",
    onclick: null,
    onkeydown: null
  };
  const elements = {
    rdMsg: message,
    rdSubmit: submit,
    rdPainLocation: { value: "" },
    rdNotes: { value: "Kept on failure" },
    readinessModal: modal
  };
  const document = {
    activeElement: null,
    getElementById: id => elements[id] || null,
    querySelectorAll: () => []
  };
  function dailyBuilder() {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({ data: savedRow, error: null }),
      upsert: async row => {
        if (fail) return { error: { message: "Temporary save failure" } };
        savedRow = { ...row };
        return { error: null };
      }
    };
  }
  function executionBuilder() {
    return {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit: async () => ({ data: [], error: null })
    };
  }
  const root = {
    AthlevoProductAnalytics: {
      trackAthlevoEvent: (name, props) => captured.push({ name, props })
    },
    AthlevoMorningCheckIn: {
      markCompleted: () => { completedMarks += 1; }
    },
    renderTodayPassiveStatus: async () => { directionRefreshes += 1; },
    refreshTodayAfterPlanChange: async () => { recommendationRefreshes += 1; },
    dispatchEvent() {}
  };
  const context = {
    window: root,
    document,
    supabaseClient: {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-a" } },
          error: null
        })
      },
      from: table => table === "daily_readiness"
        ? dailyBuilder()
        : executionBuilder()
    },
    CustomEvent: class {
      constructor(name, options) {
        this.type = name;
        this.detail = options.detail;
      }
    },
    Intl,
    Date,
    console: { log() {}, warn() {}, error() {} },
    toast() {}
  };
  vm.runInNewContext(
    readinessSource + `
      window.__readinessTest = {
        submit: submitReadiness,
        setDraft(value) { readinessDraft = { ...(value || {}) }; },
        getDraft() { return { ...readinessDraft }; },
        setOpenContext(value) {
          readinessOpenContext = value ? { ...value } : null;
        }
      };`,
    context
  );
  root.__readinessTest.setDraft({
    sleep_quality: 4,
    energy: 7,
    muscle_soreness: 2,
    mental_stress: 3,
    pain_present: false,
    pain_severity: null
  });
  root.__readinessTest.setOpenContext({
    automatic: true,
    source: "morning_prompt",
    dismissed: false,
    returnFocus: null
  });
  return {
    root,
    message,
    submit,
    captured,
    setFail: value => { fail = value; },
    closeCount: () => closeCount,
    directionRefreshes: () => directionRefreshes,
    recommendationRefreshes: () => recommendationRefreshes,
    completedMarks: () => completedMarks,
    savedRow: () => savedRow
  };
}

section("Submission success, failure, and focused refresh");
{
  const world = makeSubmissionWorld();
  await world.root.__readinessTest.submit();
  test("successful submission persists and closes the prompt",
    world.savedRow()?.user_id === "user-a" &&
    world.savedRow()?.readiness_date &&
    world.closeCount() === 1 &&
    world.completedMarks() === 1);
  test("successful submission refreshes Direction and recommendation without reload",
    world.directionRefreshes() === 1 &&
    world.recommendationRefreshes() === 1);
  test("completion analytics contain only safe categorical properties",
    world.captured.length === 1 &&
    world.captured[0].name === "readiness_check_completed" &&
    JSON.stringify(world.captured[0].props) ===
      JSON.stringify({
        source: "morning_prompt",
        completion_status: "completed"
      }));
}
{
  const world = makeSubmissionWorld({ failFirst: true });
  await world.root.__readinessTest.submit();
  test("failed submission keeps the prompt open and preserves answers",
    world.closeCount() === 0 &&
    world.message.textContent === "Temporary save failure" &&
    world.submit.disabled === false &&
    world.root.__readinessTest.getDraft().energy === 7);
  world.setFail(false);
  await world.root.__readinessTest.submit();
  test("failed submission permits a successful retry",
    world.closeCount() === 1 && world.savedRow()?.energy === 7);
}

section("Analytics privacy, accessibility, and no push");
{
  const world = makeMorningWorld();
  await world.api.evaluate();
  test("shown analytics are persistently keyed once per user and Manila date",
    world.captured.filter(event =>
      event.name === "readiness_prompt_shown"
    ).length === 1 &&
    Array.from(world.storage.store.keys()).some(key =>
      key.includes("readiness-prompt-shown:user-a:2026-07-29")
    ));
  world.opened[0].onDismiss();
  test("prompt analytics contain no answers or health data",
    world.captured.every(event =>
      Object.keys(event.props || {}).join("|") === "source" &&
      event.props.source === "morning_prompt"
    ));
  test("registry allowlists only categorical readiness properties",
    registrySource.includes(
      'readiness_prompt_shown:        { kind: "behavioural", props: ["source"] }'
    ) &&
    registrySource.includes(
      'readiness_prompt_dismissed:    { kind: "behavioural", props: ["source"] }'
    ) &&
    registrySource.includes(
      'readiness_check_completed:     { kind: "behavioural", props: ["source", "completion_status"] }'
    ));
  test("modal exposes dialog title, description, labels, focus trap, and inert background",
    /role="dialog" aria-modal="true" aria-labelledby="rdTitle" aria-describedby="rdDescription"/.test(readinessSource) &&
    /setReadinessBackgroundInert\(true\)/.test(readinessSource) &&
    /event\.key === "Escape"/.test(readinessSource) &&
    /event\.key !== "Tab"/.test(readinessSource) &&
    /aria-pressed=/.test(readinessSource));
  test("manual readiness entry remains available after dismissal",
    /Open today’s check-in/.test(html) &&
    /onclick="openReadinessCheck\(\)"/.test(html));
  test("reduced motion remains covered by the global guard",
    /prefers-reduced-motion: reduce\)\{[\s\S]{0,180}animation-duration:\.001ms!important/.test(html));
  test("no push notification or permission request was added",
    !/Notification\\.requestPermission|PushManager|pushManager|serviceWorker\\.push/i.test(
      morningSource + readinessSource
    ));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

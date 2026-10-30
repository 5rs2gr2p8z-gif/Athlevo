/*
 * Athlevo app mode.
 *
 * COACH-LED: the app is the coaching workspace. There is no in-app paywall,
 * upgrade sheet, trial timer or plan lock, and no AI Coach chat or AI sign-up
 * page. The offer athletes see is the Programs screen (js/programsScreen.js),
 * shown once after sign-up. Paying for a program happens at PayMongo hosted
 * checkout and is the only time the app hands off to a browser.
 *
 * Must load before every other app script. The server mirror is
 * lib/server/appMode.js (tests/app-mode.test.mjs keeps them aligned).
 * Set to false to bring the old freemium flow back; the old code is intact.
 */
(function (root) {
  "use strict";
  root.ATHLEVO_COACH_LED = true;
  // The Programs offer (js/programsScreen.js) is OFF: the app is completely free
  // for athletes and coaches. Set to true to show it once after sign-up again.
  root.ATHLEVO_PROGRAMS_OFFER = false;
  // CSS hook: html.coach-led hides AI-chat and upgrade surfaces (see index.html).
  try {
    if (root.document && root.document.documentElement) {
      root.document.documentElement.classList.add("coach-led");
    }
  } catch (e) {}
  root.AthlevoAppMode = Object.freeze({
    coachLed: function () { return root.ATHLEVO_COACH_LED === true; }
  });
})(typeof window !== "undefined" ? window : globalThis);

/*
 * Server mirror of js/appMode.js.
 *
 * Coach-led mode is ON for deployed (Vercel) runtimes and OFF everywhere else
 * (local scripts, unit tests) so legacy freemium tests keep exercising the
 * real limits. Override with ATHLEVO_COACH_LED=1 (force on) or =0 (force off).
 *
 * In coach-led mode every signed-in athlete is treated as Pro for access
 * purposes. Pro's monthly AI allowances still apply, so a runaway client
 * cannot generate unbounded AI cost.
 */
export function coachLed(env = process.env) {
  const flag = String(env.ATHLEVO_COACH_LED ?? "").trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return Boolean(env.VERCEL);
}

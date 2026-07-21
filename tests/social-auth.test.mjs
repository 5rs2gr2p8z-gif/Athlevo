/*
 * Athlevo — Google/Apple authentication.
 *
 * Loads the REAL js/socialAuth.js and asserts against the REAL index.html
 * wiring. Proves the original defect (buttons that never authenticated)
 * cannot return, and that routing, cancellation and errors behave.
 *
 * Run: node tests/social-auth.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const src = readFileSync("./js/socialAuth.js", "utf8");

/* ── loader ─────────────────────────────────────────────────────────── */

function load({ origin = "https://athlevo.org", search = "", hash = "",
                oauthError = null, inAppBrowser = false, noClient = false } = {}) {
  const calls = { oauth: [], replaced: [], tracked: [], notice: 0 };
  const elements = {
    authBtnGoogle: { style: { display: "" } },
    authBtnApple: { style: { display: "" } }
  };
  const sandbox = {
    console: { log(){}, warn(){}, error(){}, debug(){} },
    document: { getElementById: (id) => elements[id] || null },
    URLSearchParams,
    URL,
    window: {
      location: { origin, search, hash, href: origin + "/" + search + hash,
                  pathname: "/" },
      history: { replaceState: (a, b, url) => calls.replaced.push(url) }
    },
    supabaseClient: noClient ? undefined : {
      auth: {
        signInWithOAuth: async (opts) => {
          calls.oauth.push(opts);
          return oauthError ? { error: oauthError } : { data: {}, error: null };
        }
      }
    },
    AthlevoEnv: {
      canonicalUrl: () => "https://athlevo.org",
      shouldWarn: () => inAppBrowser,
      showNotice: () => { calls.notice += 1; }
    },
    AthlevoAnalytics: { track: (n, m) => calls.tracked.push({ n, m }) }
  };
  const g = sandbox;
  new Function(...Object.keys(sandbox), "root",
    src.replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(...Object.values(sandbox), g);
  return { api: g.AthlevoSocialAuth, calls, elements };
}

/* ═════════════════ the original defect must not return ══════════════ */

section("Root cause: buttons must actually authenticate");
{
  const btnBlock = html.match(/<div class="w-btns">[\s\S]*?<\/div>/)[0];

  t("Google button no longer calls startOnboarding() directly",
    !/onclick="startOnboarding\(\)"[^>]*>[^<]*Google/i.test(btnBlock) &&
    !/Google[\s\S]{0,40}startOnboarding/i.test(btnBlock), btnBlock.slice(0, 160));
  t("Google button calls the OAuth handler", /continueWithGoogle\(\)/.test(btnBlock));
  t("Apple button no longer calls startOnboarding() either",
    !/Apple[\s\S]{0,40}startOnboarding/i.test(btnBlock));
  t("signInWithOAuth now exists in the codebase", /signInWithOAuth/.test(src));
  t("no provider button bypasses authentication",
    !/onclick="startOnboarding\(\)"/.test(btnBlock), btnBlock.slice(0, 200));
}

/* ══════════════════════════ starting flow ═══════════════════════════ */

section("Google sign-in start");
{
  const { api, calls } = load();
  const r = await api.signInWithGoogle();
  t("calls Supabase OAuth", calls.oauth.length === 1);
  t("with provider google", calls.oauth[0].provider === "google");
  t("reports it is redirecting", r.ok === true && r.redirecting === true);
  t("requests the account chooser (shared devices)",
    calls.oauth[0].options.queryParams.prompt === "select_account");
  t("tracks signup_started with the method",
    calls.tracked.some(e => e.n === "signup_started" && e.m.method === "google"));
}

section("Redirect target");
{
  t("production origin is used verbatim",
    load({ origin: "https://athlevo.org" }).api.redirectTarget() === "https://athlevo.org/");
  t("localhost works for development",
    load({ origin: "http://localhost:3000" }).api.redirectTarget() === "http://localhost:3000/");
  t("a Vercel preview uses its own origin",
    load({ origin: "https://athlevo-git-abc.vercel.app" }).api.redirectTarget()
      === "https://athlevo-git-abc.vercel.app/");
  t("a non-http origin falls back to canonical production",
    load({ origin: "file://" }).api.redirectTarget() === "https://athlevo.org/");
}

/* ═══════════════════════ Apple is gated off ═════════════════════════ */

section("Apple is disabled, not broken");
{
  const { api, calls, elements } = load();
  t("Apple is declared NOT enabled", api.PROVIDERS.apple.enabled === false);
  const r = await api.signInWithApple();
  t("Apple sign-in refuses cleanly instead of failing", r.ok === false);
  t("...with an honest message", /isn't available yet/i.test(r.message), r.message);
  t("...and never reaches Supabase", calls.oauth.length === 0);

  api.applyProviderVisibility();
  t("Apple button is hidden", elements.authBtnApple.style.display === "none");
  t("Google button stays visible", elements.authBtnGoogle.style.display === "");
  t("boot hides unconfigured providers", /applyProviderVisibility\(\)/.test(html));
}

/* ═════════════════════════ return outcomes ══════════════════════════ */

section("OAuth return — cancellation");
{
  const { api } = load({ search: "?error=access_denied&error_description=User+denied" });
  const p = api.readReturnError();
  t("cancellation is detected", p && p.cancelled === true);
  t("...phrased as a choice, not a failure", /cancelled/i.test(p.message) && !/error|fail/i.test(p.message));
}

section("OAuth return — provider errors");
{
  const cases = [
    { q: "?error=server_error", expect: /trouble right now/i },
    { q: "?error=invalid_request&error_code=bad_oauth_state", expect: /isn't configured for this address/i },
    { q: "?error=invalid_grant&error_description=otp_expired", expect: /expired/i },
    { q: "?error=unknown_thing", expect: /couldn't complete sign-in/i }
  ];
  for (const c of cases) {
    const p = load({ search: c.q }).api.readReturnError();
    t(`${c.q} → human message`, p && c.expect.test(p.message), p && p.message);
    t(`${c.q} → no raw code shown`, p && !/[?&]|error_code|invalid_grant/.test(p.message));
  }
}

section("OAuth return — errors in the hash fragment");
{
  const p = load({ hash: "#error=access_denied&error_description=denied" }).api.readReturnError();
  t("hash-fragment errors are detected too", p && p.cancelled === true);
}

section("OAuth return — success is left to Supabase");
{
  const p = load({ search: "?code=abc123" }).api.readReturnError();
  t("a successful return produces no error", p === null);
  t("detectSessionInUrl is enabled so Supabase exchanges the code",
    /detectSessionInUrl:\s*true/.test(html));
  t("we never hand-roll the token exchange",
    !/exchangeCodeForSession/.test(src));
}

section("Auth parameters are stripped");
{
  const { api, calls } = load({ search: "?code=abc&state=xyz", hash: "#access_token=secret" });
  api.clearAuthParams();
  t("history was rewritten", calls.replaced.length === 1);
  const url = String(calls.replaced[0]);
  t("code removed", !url.includes("code="));
  t("state removed", !url.includes("state="));
  t("access_token never left in the address bar", !url.includes("access_token"));
  t("isOAuthReturn recognises a real return",
    load({ search: "?code=abc" }).api.isOAuthReturn() === true);
  t("...and a normal page load", load({}).api.isOAuthReturn() === false);
}

/* ═══════════════════════ failure modes ══════════════════════════════ */

section("Start failures are human");
{
  const notEnabled = await load({ oauthError: { message: "Provider not enabled" } })
    .api.signInWithGoogle();
  t("provider-not-enabled → actionable message",
    !notEnabled.ok && /isn't switched on yet/i.test(notEnabled.message), notEnabled.message);
  t("...suggests the working alternative", /email and password/i.test(notEnabled.message));

  const badRedirect = await load({ oauthError: { message: "redirect_uri mismatch" } })
    .api.signInWithGoogle();
  t("redirect mismatch → points at the right address",
    !badRedirect.ok && /athlevo\.org/.test(badRedirect.message));

  const noClient = await load({ noClient: true }).api.signInWithGoogle();
  t("missing Supabase client fails gracefully", noClient.ok === false && !!noClient.message);

  const generic = await load({ oauthError: { message: "boom" } }).api.signInWithGoogle();
  t("unknown failures never leak internals",
    !/boom/.test(generic.message) && !/\b(4\d\d|5\d\d)\b/.test(generic.message));
}

section("In-app browsers");
{
  const { api, calls } = load({ inAppBrowser: true });
  const r = await api.signInWithGoogle();
  t("OAuth is not attempted inside a webview", calls.oauth.length === 0);
  t("the existing environment notice is shown instead", calls.notice === 1);
  t("marked handled so no duplicate toast appears", r.handled === true);
}

/* ═════════════════ routing / duplicate protection ═══════════════════ */

section("Routing — derived from the real index.html + onboarding.js");
{
  const route = html.match(/async function routeAfterAuth[\s\S]*?\n\}/)[0];
  const ob = readFileSync("./js/onboarding.js", "utf8");

  t("NEW Google user → profile onboarding (no profile row yet)",
    /if \(!completed\)\s*\{\s*startOnboarding\(\);\s*return;\s*\}/.test(route));
  t("...then guided training connection", /AthlevoConnect[\s\S]{0,80}\.start\(\)/.test(ob));
  t("EXISTING Google user with a complete profile → dashboard",
    /showScreen\("screen-today"\)/.test(route));
  t("routing runs from ONE place (session restore), not per-provider",
    (html.match(/await routeAfterAuth\(/g) || []).length <= 3);
  t("social auth adds no second routing path",
    !/routeAfterAuth|showScreen/.test(src));
}

section("Duplicate profiles are impossible");
{
  const ob = readFileSync("./js/onboarding.js", "utf8");
  t("social auth never inserts a profile row", !/from\("profiles"\)/.test(src));
  t("profile creation is a plain INSERT, never an overwrite",
    /\.from\("profiles"\)\s*\.insert\(/.test(ob) && !/\.from\("profiles"\)\s*\.upsert\(/.test(ob));
  t("keyed on the auth user id", /insert\(\{\s*id: user\.id/.test(ob));
  t("a duplicate-key race re-reads instead of creating a second row",
    /obIsDuplicateError\(createError\)/.test(ob));
  t("Google's name is reused rather than a second identity being invented",
    /user_metadata\?\.full_name/.test(ob));
  t("no account-merging by email", !/merge|link.*account/i.test(src));
}

section("Email/password login is untouched");
{
  t("signUp still present", /supabaseClient\.auth\.signUp\(/.test(html));
  t("signInWithPassword still present", /supabaseClient\.auth\.signInWithPassword\(/.test(html));
  t("both still route through startOnboarding/routeAfterAuth",
    /startOnboarding\(\);/.test(html) && /routeAfterAuth\(/.test(html));
  t("signup_completed tracking intact",
    (html.match(/trackFunnel\("signup_completed"\)/g) || []).length === 2);
}

section("Security");
{
  t("no Google client secret anywhere in client code",
    !/GOOGLE_CLIENT_SECRET|client_secret/i.test(src + html));
  t("no service-role key in client code", !/SERVICE_ROLE/i.test(src + html));
  t("only the publishable anon key is present",
    /sb_publishable_/.test(html) && !/sb_secret_/.test(html));
  t("no .env file is referenced", !/\.env/.test(src));
  t("errors log a code, never tokens",
    !/console\.(log|warn|error)\([^)]*access_token/.test(src));
}

section("Never a blank page");
{
  t("a failed sign-in is reported after routing settles, not on a timer",
    /reportAuthProblem\(\)/.test(html) && !/setTimeout\(function \(\) \{\s*if \(typeof toast/.test(html));
  t("...and returns the athlete to the entry screen",
    /if \(!athlevoSessionUserId && typeof openAppEntry === "function"\) openAppEntry\(\)/.test(html));
  t("the boot gate still lifts in a finally block", /\} finally \{[\s\S]{0,120}endBootGate\(\);/.test(html));
  t("auth params are stripped so a refresh cannot replay the error",
    /clearAuthParams\(\)/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

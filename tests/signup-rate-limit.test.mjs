/**
 * Signup request de-duplication and Supabase rate-limit messaging contract.
 * Run: node tests/signup-rate-limit.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const authSupport = readFileSync("./js/authSupport.js", "utf8");

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not close ${name}()`);
}

const mapAuthError = new Function(`
  ${extractFunction(authSupport, "mapAuthError")}
  return mapAuthError;
`)();

assert.deepEqual(
  mapAuthError({ status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" }, "signup"),
  {
    code: "AUTH_EMAIL_RATE_LIMIT",
    message: "Confirmation emails are temporarily limited. Please try again later or continue with Google."
  }
);
assert.deepEqual(
  mapAuthError({ __timeout: true, message: "Signup timed out" }, "signup"),
  {
    code: "AUTH_TIMEOUT",
    message: "Signup is taking longer than expected. Check your email, then wait a minute before trying again."
  }
);
assert.deepEqual(
  mapAuthError({ status: 429, code: "over_request_rate_limit", message: "too many requests" }, "signup"),
  {
    code: "AUTH_RATE_LIMIT",
    message: "Too many signup requests were made from this network. Please wait a few minutes and try again."
  }
);

const signupFlow = html.slice(
  html.indexOf("// ---- Signup ----"),
  html.indexOf("// ---- Login ----")
);
const signupMarkup = html.slice(
  html.indexOf("<!-- Signup -->"),
  html.indexOf("<!-- Login -->", html.indexOf("<!-- Signup -->"))
);

assert.equal((signupFlow.match(/supabaseClient\.auth\.signUp\(/g) || []).length, 1);
assert.equal((html.match(/supabaseClient\.auth\.signUp\(/g) || []).length, 1);
assert.equal(/auth\.resend\(/.test(signupFlow), false);
assert.match(signupFlow, /if \(signupInFlight\) return/);
assert.ok(signupFlow.indexOf("signupInFlight = true") < signupFlow.indexOf("supabaseClient.auth.signUp("));
assert.match(signupFlow, /btn\.disabled = true;[\s\S]*?btn\.textContent = 'Creating account\.\.\.';[\s\S]*?aria-busy/);
assert.match(signupFlow, /signupCompletedEmail = normalizedEmail/);
assert.match(signupFlow, /signupRetryBlockedUntil = Date\.now\(\) \+ 60000/);
assert.match(signupFlow, /Promise\.race cannot cancel Supabase's underlying fetch/);
assert.match(signupFlow, /signupCompletedEmail === normalizedEmail[\s\S]*?btn\.disabled = true;[\s\S]*?btn\.textContent = 'Check your email'/);
assert.equal(/<form\b|onsubmit=|addEventListener\(['"]submit/.test(signupMarkup), false);
assert.equal((signupMarkup.match(/onclick="doSignup\(\)"/g) || []).length, 1);

let resolveSignup;
let signupCalls = 0;
const elements = {
  suMsg: { style: {}, textContent: "" },
  suBtn: {
    disabled: false,
    textContent: "Create Account",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  },
  suName: { value: "Review Athlete" },
  suEmail: { value: "reviewer@example.com" },
  suPassword: { value: "SecurePass1" }
};
const signupRequest = new Promise(resolve => { resolveSignup = resolve; });
const withTimeoutSource = html.slice(
  html.indexOf("function withTimeout"),
  html.indexOf("// Live signup password validation")
);
const doSignupSource = html.slice(
  html.indexOf("async function doSignup"),
  html.indexOf("// ---- Login ----")
);
const runtime = new Function(
  "document", "window", "supabaseClient", "setTimeout", "clearTimeout",
  "trackEmailSignupFailure", "friendlyAuthError", "showLoginForm",
  "closeAuth", "startOnboarding",
  `
    let signupInFlight = false;
    let signupCompletedEmail = "";
    let signupRetryBlockedUntil = 0;
    let signupRetryTimer = null;
    ${withTimeoutSource}
    ${doSignupSource}
    return { doSignup };
  `
)(
  { getElementById: id => elements[id] || null },
  { location: { origin: "https://athlevo.org" } },
  {
    auth: {
      signUp() { signupCalls += 1; return signupRequest; },
      signInWithPassword: async () => ({ data: { session: null }, error: { code: "email_not_confirmed" } })
    }
  },
  setTimeout,
  clearTimeout,
  () => {},
  () => "Signup failed",
  () => {},
  () => {},
  () => {}
);

const firstSubmit = runtime.doSignup();
const duplicateSubmit = runtime.doSignup();
assert.equal(signupCalls, 1);
assert.equal(elements.suBtn.disabled, true);
assert.equal(elements.suBtn.textContent, "Creating account...");
assert.equal(elements.suBtn.attributes["aria-busy"], "true");

resolveSignup({
  data: { user: { id: "review-user", identities: [{ id: "email-identity" }] }, session: null },
  error: null
});
await Promise.all([firstSubmit, duplicateSubmit]);
assert.equal(elements.suBtn.disabled, true);
assert.equal(elements.suBtn.textContent, "Check your email");
assert.equal(elements.suBtn.attributes["aria-busy"], "false");

await runtime.doSignup();
assert.equal(signupCalls, 1);

console.log("PASS — signup sends one guarded request, locks confirmed accounts, and distinguishes Supabase limits");

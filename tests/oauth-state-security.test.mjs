import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  OAUTH_LEGACY_STATE_ACCEPT_UNTIL_MS,
  OAUTH_STATE_FUTURE_SKEW_MS,
  OAUTH_STATE_MAX_AGE_MS,
  OAUTH_STATE_MAX_LENGTH,
  createOAuthState,
  verifyOAuthState
} from "../lib/server/oauthState.js";
import {
  getAppReturnOrigin as getStravaAppReturnOrigin,
  getStravaRedirectUri
} from "../lib/server/stravaConfig.js";

process.env.OAUTH_STATE_SECRET = "oauth-state-test-secret";
process.env.INTERVALS_CLIENT_ID = "intervals-client";
process.env.INTERVALS_CLIENT_SECRET = "intervals-secret";
process.env.STRAVA_CLIENT_ID = "strava-client";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.APP_URL = "https://some-preview.vercel.app";

const secret = process.env.OAUTH_STATE_SECRET;
const now = Date.now();
const nonce = "a".repeat(32);
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function signRaw(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function validPayload(provider = "intervals", returnTarget = "web") {
  return {
    userId: "user-A",
    provider,
    issuedAt: now,
    nonce,
    returnTarget
  };
}

function verify(state, provider = "intervals", at = now) {
  return verifyOAuthState(state, secret, { provider, now: at });
}

await test("accepts exact web and iOS state schemas", () => {
  for (const provider of ["intervals", "strava"]) {
    for (const returnTarget of ["web", "ios"]) {
      const state = createOAuthState(
        validPayload(provider, returnTarget),
        secret
      );
      const payload = verify(state, provider);
      assert.equal(payload.returnTarget, returnTarget);
      assert.equal(payload.provider, provider);
      assert.equal(payload.legacy, false);
    }
  }
});

await test("rejects invalid return targets instead of defaulting", () => {
  for (const value of ["", "native", "IOS", "https://evil.example"]) {
    assert.equal(
      verify(signRaw({ ...validPayload(), returnTarget: value })),
      null
    );
  }
});

await test("rejects unknown, missing, and invalidly typed fields", () => {
  assert.equal(
    verify(signRaw({ ...validPayload(), next: "https://evil.example" })),
    null
  );
  const missing = validPayload();
  delete missing.nonce;
  assert.equal(verify(signRaw(missing)), null);
  assert.equal(
    verify(signRaw({ ...validPayload(), issuedAt: String(now) })),
    null
  );
  assert.equal(
    verify(signRaw({ ...validPayload(), nonce: "not-a-valid-nonce" })),
    null
  );
  assert.equal(
    verify(signRaw({ ...validPayload(), provider: "strava" })),
    null
  );
});

await test("rejects future-dated, expired, malformed, and oversized states", () => {
  assert.equal(
    verify(signRaw({
      ...validPayload(),
      issuedAt: now + OAUTH_STATE_FUTURE_SKEW_MS + 1
    })),
    null
  );
  assert.equal(
    verify(signRaw({
      ...validPayload(),
      issuedAt: now - OAUTH_STATE_MAX_AGE_MS - 1
    })),
    null
  );
  assert.equal(verify("not-a-signed-state"), null);
  assert.equal(verify(`${"a".repeat(OAUTH_STATE_MAX_LENGTH)}.x`), null);
});

await test("rejects forged signatures and modified signed payloads", () => {
  const state = createOAuthState(validPayload(), secret);
  const [body, signature] = state.split(".");
  const forgedLastCharacter = signature.endsWith("A") ? "B" : "A";
  assert.equal(
    verify(`${body}.${signature.slice(0, -1)}${forgedLastCharacter}`),
    null
  );

  const changed = {
    ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    userId: "user-B"
  };
  const changedBody = Buffer.from(JSON.stringify(changed), "utf8")
    .toString("base64url");
  assert.equal(verify(`${changedBody}.${signature}`), null);
});

await test("keeps concurrent signed states bound to their starting users", () => {
  const stateA = createOAuthState(validPayload(), secret);
  const stateB = createOAuthState({
    ...validPayload(),
    userId: "user-B",
    nonce: "b".repeat(32)
  }, secret);
  assert.equal(verify(stateA).userId, "user-A");
  assert.equal(verify(stateB).userId, "user-B");
  assert.notEqual(stateA, stateB);
});

await test("Strava production callbacks and app returns cannot downgrade to HTTP", () => {
  const previous = {
    redirect: process.env.STRAVA_REDIRECT_URI,
    app: process.env.APP_URL,
    site: process.env.SITE_URL,
    publicApp: process.env.PUBLIC_APP_URL,
    local: process.env.STRAVA_ALLOW_LOCALHOST
  };
  process.env.STRAVA_REDIRECT_URI = "http://athlevo.org/unsafe";
  process.env.APP_URL = "http://athlevo.org";
  delete process.env.SITE_URL;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.STRAVA_ALLOW_LOCALHOST;
  assert.equal(
    getStravaRedirectUri().uri,
    "https://athlevo.org/api/strava/callback"
  );
  assert.equal(getStravaAppReturnOrigin(), "https://athlevo.org");

  if (previous.redirect === undefined) delete process.env.STRAVA_REDIRECT_URI;
  else process.env.STRAVA_REDIRECT_URI = previous.redirect;
  if (previous.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previous.app;
  if (previous.site === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = previous.site;
  if (previous.publicApp === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = previous.publicApp;
  if (previous.local === undefined) delete process.env.STRAVA_ALLOW_LOCALHOST;
  else process.env.STRAVA_ALLOW_LOCALHOST = previous.local;
});

await test("supports only exact pre-returnTarget legacy states for ten minutes", () => {
  const legacyNow = Math.min(now, OAUTH_LEGACY_STATE_ACCEPT_UNTIL_MS - 1000);
  const intervalsLegacy = signRaw({
    userId: "legacy-A",
    provider: "intervals",
    issuedAt: legacyNow,
    nonce
  });
  const stravaLegacy = signRaw({
    userId: "legacy-B",
    issuedAt: legacyNow,
    nonce
  });
  assert.equal(verify(intervalsLegacy, "intervals", legacyNow).returnTarget, "web");
  assert.equal(verify(stravaLegacy, "strava", legacyNow).returnTarget, "web");

  const expiredLegacy = signRaw({
    userId: "legacy-A",
    provider: "intervals",
    issuedAt: legacyNow - OAUTH_STATE_MAX_AGE_MS - 1,
    nonce
  });
  assert.equal(verify(expiredLegacy, "intervals", legacyNow), null);
  assert.equal(
    verifyOAuthState(intervalsLegacy, secret, {
      provider: "intervals",
      now: legacyNow,
      allowLegacyWithoutReturnTarget: false
    }),
    null
  );
  assert.equal(
    verifyOAuthState(intervalsLegacy, secret, {
      provider: "intervals",
      now: OAUTH_LEGACY_STATE_ACCEPT_UNTIL_MS + 1
    }),
    null
  );
});

const stravaHandler = (await import("../api/strava/callback.js")).default;
const stravaConnectHandler = (await import("../api/strava/connect.js")).default;
const intervalsHandler = (await import("../api/providers/index.js")).default;

function responseDouble() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    redirect(code, location) {
      this.statusCode = code;
      this.headers.Location = location;
      return this;
    },
    end() {
      return this;
    }
  };
}

await test("connect endpoints reject unsupported return targets", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = async value => {
    if (String(value).includes("/auth/v1/user")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "user-A" })
      };
    }
    throw new Error(`Unexpected request: ${value}`);
  };
  console.log = () => {};
  try {
    const strava = responseDouble();
    await stravaConnectHandler({
      method: "POST",
      headers: { authorization: "Bearer session-token" },
      body: { return_target: "https://evil.example" }
    }, strava);
    assert.equal(strava.statusCode, 400);
    assert.equal(strava.body.code, "INVALID_RETURN_TARGET");

    const intervals = responseDouble();
    await intervalsHandler({
      method: "POST",
      headers: { authorization: "Bearer session-token" },
      query: { provider: "intervals", action: "connect" },
      body: { return_target: "native" }
    }, intervals);
    assert.equal(intervals.statusCode, 400);
    assert.equal(intervals.body.code, "INVALID_RETURN_TARGET");
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
});

await test("signed target alone selects fixed Strava web or iOS destinations", async () => {
  const web = responseDouble();
  await stravaHandler({
    method: "GET",
    body: { return_target: "ios" },
    query: {
      error: "access_denied",
      return_target: "ios",
      state: createOAuthState(validPayload("strava", "web"), secret)
    }
  }, web);
  assert.equal(web.headers.Location, "https://athlevo.org?strava=cancelled");

  const ios = responseDouble();
  await stravaHandler({
    method: "GET",
    body: { return_target: "web" },
    query: {
      error: "access_denied",
      return_target: "https://evil.example",
      state: createOAuthState({
        ...validPayload("strava", "ios"),
        nonce: "b".repeat(32)
      }, secret)
    }
  }, ios);
  assert.equal(
    ios.headers.Location,
    "athlevo://provider/callback?provider=strava&result=cancelled"
  );

  const forged = responseDouble();
  await stravaHandler({
    method: "GET",
    query: { error: "access_denied", state: "forged.state" }
  }, forged);
  assert.equal(forged.headers.Location, "https://athlevo.org?strava=invalid_state");
});

await test("signed target alone selects fixed Intervals web or iOS destinations", async () => {
  const realLog = console.log;
  console.log = () => {};
  try {
    const web = responseDouble();
    await intervalsHandler({
      method: "GET",
      body: { return_target: "ios" },
      url: "/api/providers?provider=intervals&action=callback",
      headers: {},
      query: {
        provider: "intervals",
        action: "callback",
        error: "access_denied",
        return_target: "ios",
        state: createOAuthState(validPayload("intervals", "web"), secret)
      }
    }, web);
    assert.equal(
      web.headers.Location,
      "https://athlevo.org/index.html?intervals=cancelled&message=Intervals.icu+connection+was+cancelled."
    );

    const ios = responseDouble();
    await intervalsHandler({
      method: "GET",
      body: { return_target: "web" },
      url: "/api/providers?provider=intervals&action=callback",
      headers: {},
      query: {
        provider: "intervals",
        action: "callback",
        error: "access_denied",
        return_target: "https://evil.example",
        state: createOAuthState({
          ...validPayload("intervals", "ios"),
          nonce: "c".repeat(32)
        }, secret)
      }
    }, ios);
    assert.equal(
      ios.headers.Location,
      "athlevo://provider/callback?provider=intervals&result=cancelled"
    );

    const forged = responseDouble();
    await intervalsHandler({
      method: "GET",
      url: "/api/providers?provider=intervals&action=callback",
      headers: {},
      query: {
        provider: "intervals",
        action: "callback",
        error: "access_denied",
        state: "forged.state"
      }
    }, forged);
    assert.match(forged.headers.Location, /^https:\/\/athlevo\.org\/index\.html\?intervals=failed/);
  } finally {
    console.log = realLog;
  }
});

console.log(`\n${passed} OAuth state security tests passed.`);

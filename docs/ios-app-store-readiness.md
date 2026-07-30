# Athlevo iOS / App Store readiness

Last reviewed: 2026-07-30

This document is preparation guidance, not evidence that Athlevo is ready for
submission. No Apple account, certificate, provisioning profile, App Store
record, Supabase setting, or production payment setting was changed.

## Architecture

Athlevo now uses a bundled Capacitor frontend:

- `npm run build:native` copies the static frontend to `dist/`.
- The native build copies Supabase's public browser client from
  `node_modules` instead of depending on the jsDelivr script at startup.
- Capacitor packages `dist/` into the iOS application.
- Serverless functions and secrets remain on `https://athlevo.org`.
- Native-only fetch handling rewrites relative `/api/...` requests to
  `https://athlevo.org/api/...`.
- There is no remote `server.url`; arbitrary remote content cannot replace
  the bundled application shell.

The bundled option was chosen over loading the live website because it gives
the app a deterministic local startup shell, keeps the main WebView out of
provider/payment pages, and reduces the risk of submitting a thin website
wrapper. Athlevo still requires network access for authenticated data,
coaching, synchronization, and plan APIs.

## Runtime and navigation boundaries

`js/runtimeEnvironment.js` is the single Capacitor-aware module.

Trusted Athlevo origins:

- `https://athlevo.org`
- `https://www.athlevo.org`

Approved external authentication/provider/payment hosts:

- `hqwdehqsllyvrcnlcytj.supabase.co`
- `accounts.google.com`, `google.com`, `www.google.com`
- `strava.com`, `www.strava.com`
- `intervals.icu`, `www.intervals.icu`
- `whop.com`, `www.whop.com`

Only HTTP(S) URLs on the allowlist can be opened. Unknown domains and
unsupported schemes are rejected. External destinations use Capacitor's
Browser plugin and do not replace the main WKWebView. Athlevo links remain
inside the app. The existing web/PWA behavior remains the fallback outside
native iOS.

Native runtime handling includes:

- native/PWA/Safari/Chrome/Facebook/Instagram detection;
- no PWA install UI or social in-app-browser handoff inside native iOS;
- network/offline and server-unavailable states;
- safe-area-aware app state UI;
- keyboard visibility handling;
- status-bar appearance;
- foreground session recheck;
- system-browser cancellation feedback;
- validated deep-link parsing;
- local session restoration through Supabase's persisted PKCE client.

## Authentication and deep links

Registered local scheme:

- `athlevo`

Implemented callbacks:

- `athlevo://auth/callback`
- `athlevo://provider/callback`

The native Google flow uses Supabase PKCE, `skipBrowserRedirect: true`, and the
Capacitor Browser plugin. Only an exact `athlevo://auth/callback` URL with a
bounded authorization code is accepted. The code is exchanged directly with
Supabase and is never sent to analytics or logged. Browser OAuth remains
unchanged.

Email/password login does not require a redirect. Email confirmation uses the
same native callback when running in the iOS container.

Before native Google/email-confirmation testing, add this exact redirect to
the Supabase Auth redirect allowlist:

```text
athlevo://auth/callback
```

Do not use a wildcard broader than the app callback. Confirm that the email
template uses `{{ .RedirectTo }}` where appropriate. These dashboard changes
were not made in this preparation.

Provider OAuth continues to use the existing verified HTTPS callbacks:

```text
https://athlevo.org/api/strava/callback
https://athlevo.org/api/providers?provider=intervals&action=callback
```

The signed OAuth state now carries an allowlisted `ios`/`web` return target.
For iOS, the verified callback returns only a categorical result (plus the
existing opaque, one-time Intervals completion token) to:

```text
athlevo://provider/callback
```

Strava/Intervals registered callback settings do not need a custom scheme and
were not changed. The native return code must be deployed with the client
before provider OAuth can be tested end to end.

For a later production hardening pass, prefer Universal Links:

```text
https://athlevo.org/auth/callback
https://athlevo.org/provider/callback
```

That requires an Apple Team ID, Associated Domains entitlement, and an
`apple-app-site-association` file on `athlevo.org`. Keep the custom scheme as a
strict fallback; do not configure Universal Links until the Apple identifiers
exist.

## Sign in with Apple

Google is offered as a primary account login. Apple App Review Guideline 4.8
requires an equivalent login option with limited collection, private-email
support, and no advertising-profile collection without consent. Athlevo's
email/password option does not provide private-email relay, so Sign in with
Apple should be implemented before submission unless Apple confirms an
exception applies.

Recommended implementation:

1. Join the Apple Developer Program and create the App ID/Services ID.
2. Configure Sign in with Apple in Supabase using server-side secrets.
3. Enable the existing gated Apple UI only after the provider is testable.
4. Use the same native PKCE/deep-link boundary as Google.
5. Revoke the Apple token during account deletion.

Do not add a nonfunctional Apple button.

## Account deletion

Status: **blocking — not implemented**.

Athlevo supports account creation but does not expose a complete in-app
account-deletion action or a server endpoint that deletes the Supabase Auth
user. RLS `DELETE` policies on individual tables are not an account-deletion
system.

A safe deletion architecture should include:

1. A clearly named Settings action, destructive confirmation, and recent
   reauthentication.
2. An authenticated, idempotent backend endpoint that derives the user only
   from the verified Supabase JWT.
3. A durable deletion job/outbox so partial provider/network failures can be
   retried without losing the request.
4. Provider-token revocation where supported, followed by deletion of
   encrypted Strava/Intervals credentials and pending connection records.
5. Deletion/anonymization of profile, onboarding, readiness, activities,
   plans, sessions, analyses, Coach conversations/memory, feedback,
   analytics identifiers, subscription associations, and every other
   user-owned training row discovered by a fresh data inventory.
6. Whop cancellation/association handling that does not silently promise a
   billing cancellation the system cannot perform.
7. Supabase `auth.admin.deleteUser` only from the service-role backend, after
   dependent cleanup has succeeded or been durably queued.
8. PostHog person deletion/anonymization using a server-side process.
9. A receipt/status screen and confirmation when deletion is complete.
10. A documented retention schedule for the minimum financial/security
    records legally required, with those records separated and anonymized
    where possible.

Never expose the service-role key to the client and never let a body
`user_id` select the deletion target.

## Legal, privacy, support, and data disclosures

- Privacy Policy and Terms are available inside Athlevo.
- A public, stable Privacy Policy URL is required in App Store Connect.
- A functional public Support URL and current contact details are required.
- Athlevo currently has no dedicated public support page/URL.
- The legal source had a malformed support email (`support@athlevo.org.com`);
  the source should use the confirmed operational address before deployment.

App Privacy answers must inventory at least:

- account identifiers and profile data handled by Supabase;
- workouts, provider identifiers, training history, readiness, soreness/pain,
  goals, and coaching records;
- PostHog product analytics and any link to user identity;
- Meta Pixel behavior (if it is present in the submitted app);
- OpenAI processing performed by server-side coaching endpoints;
- Whop subscription associations;
- Strava and Intervals data and tokens.

Athlevo handles fitness and self-reported pain/readiness data. The privacy
policy and review notes must explain purpose, retention, deletion, processors,
and that sensitive health/fitness data is not used for targeted advertising.
Review whether analytics consent/opt-out and App Tracking Transparency are
required before leaving analytics enabled in the iOS build.

## Payments and subscriptions

Status: **blocking/risk — do not submit the current checkout unchanged**.

Athlevo Performance unlocks digital functionality and the iOS source still
contains an explicit Whop checkout action. Apple Guideline 3.1.1 generally
requires In-App Purchase for digital feature unlocks. As of this review,
external purchase links have storefront-specific rules: US storefront links
are treated differently, while many other storefronts prohibit external
purchase calls to action unless an applicable entitlement is granted.

Before a global submission, choose and review one compliant design with
qualified counsel:

- implement StoreKit auto-renewable subscriptions and server-side App Store
  receipt/transaction entitlement updates; or
- remove purchase calls to action from the native app and make it a compliant
  stand-alone companion for already-entitled users; or
- use only an applicable approved external-purchase entitlement and obey its
  storefront, disclosure, API, and reporting terms.

If StoreKit is added, implement Restore Purchases, cross-device entitlement
reconciliation, App Store Server Notifications, subscription management,
refund handling, and account-deletion billing guidance. Whop remains unchanged
in this preparation.

## Other submission blockers and readiness items

- Install full Xcode 26+ and an iOS 15+ simulator runtime.
- Select Xcode with `xcode-select`; resolve Swift packages; compile and launch.
- Test login, signup confirmation, Google cancellation/success, both provider
  callbacks, relaunch, refresh-token expiry, offline/server recovery, keyboard
  behavior, dark mode, and all external links on a real iPhone.
- Add a stable public Privacy Policy URL and Support URL.
- Implement account deletion.
- Resolve Sign in with Apple.
- Resolve StoreKit/external-payment compliance.
- Complete App Privacy labels and analytics/health-data consent review.
- Provide a fully populated reviewer demo account and keep backend services
  available during review.
- Confirm icon/splash appearance on all supported devices.
- Add only the permission purpose strings for capabilities actually used.
  Current code requests no camera, microphone, location, photo, HealthKit, or
  Bluetooth permission.
- Answer App Store export-compliance questions for the app's HTTPS/TLS use;
  confirm the appropriate standard-cryptography exemption with counsel.
- Ensure IPv6-only networking works.
- Remove all beta/placeholder/incomplete content before submission.

Athlevo has meaningful product functionality beyond marketing, and the
bundled shell adds native lifecycle/network/auth handling. It is still
vulnerable to Guideline 4.2 review if the submitted binary feels like only a
web wrapper. Strong next native-value candidates are HealthKit import,
training reminders/local notifications, background refresh, widgets, and
Shortcuts, implemented only when the product is ready and with accurate
privacy disclosures.

## Local commands

```bash
npm install
npm run build:native
npm run ios:prepare
npm run ios:open
```

After Xcode is installed, select an iPhone simulator and Run the `App` scheme.
For a command-line attempt:

```bash
npx cap run ios
```

No paid Apple membership is required for the iOS Simulator.

## Primary references

- [Capacitor v8 installation](https://capacitorjs.com/docs/getting-started)
- [Capacitor v8 iOS requirements](https://capacitorjs.com/docs/ios)
- [Capacitor App/deep-link API](https://capacitorjs.com/docs/apis/app)
- [Capacitor Browser API](https://capacitorjs.com/docs/apis/browser)
- [Supabase native deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple account-deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app)

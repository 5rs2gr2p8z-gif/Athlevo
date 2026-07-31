# Acquisition and activation analytics contract

This is the production contract for Athlevo's no-trial funnel. PostHog is the
conversion system; `activation_events` is a privacy-safe, authenticated
milestone ledger. Analytics failures never block the product.

## Authoritative funnel

Successful provider path:

`landing_viewed` → `signup_cta_clicked` → `auth_screen_viewed` →
`google_signup_clicked` or `email_signup_clicked` →
`registration_completed` → `onboarding_started` →
`onboarding_completed` → `data_connection_started` →
`data_connection_completed` → `first_plan_generated` →
`first_value_viewed` → `activation_completed`

Provider skip replaces both connection events with one `provider_skipped`
milestone. Login is measured with `login_clicked` and must never enter the new
registration funnel.

## Activation and first value

`first_value_viewed` has one authoritative meaning: an authenticated, newly
registered athlete has a valid saved plan and the active, visible Train screen
has opened that plan. A generated plan that remains on the server or in a
hidden DOM tree is not a view.

`activation_completed` fires at the same visible moment, but only after the
required onboarding save is also confirmed. Its conditions are therefore:

1. confirmed new Supabase registration;
2. confirmed completed onboarding profile;
3. first usable plan saved with at least one dated session; and
4. that plan visibly opened on the active Train screen.

## Event contract

All call sites pass through `js/analytics.js` and the event-specific allowlist
in `js/analyticsRegistry.js`.

| Event | Production call site | Required condition / semantics | Identity | Deduplication and repeat policy | Allowed event properties |
|---|---|---|---|---|---|
| `landing_viewed` | `index.html` `showScreen()` → `trackScreenWhenVisible()` | Public landing is active, document visible, boot overlay gone | Anonymous allowed | Once per page load; a later page load is a new view | page URL stripped to attribution query only, path, referrer without query, attribution |
| `signup_cta_clicked` | `index.html` `landingStartFree()` | A logged-out visitor clicks a public signup CTA | Anonymous | Every real click; double-click is a separate action | approved CTA text, location, destination, attribution |
| `auth_screen_viewed` | `index.html` `showScreen()` → `trackScreenWhenVisible()` | Welcome/auth screen is active and visibly rendered | Anonymous allowed | Once per page load | entry source, safe previous page, attribution |
| `google_signup_clicked` | `js/socialAuth.js` `signIn()` | Logged-out visitor chooses Google; recorded before a real OAuth start or external-browser handoff | Anonymous | Per click | attribution |
| `email_signup_clicked` | `index.html` `showSignupForm()` / email continuation action | Visitor explicitly chooses the email signup path | Anonymous | Per click | attribution |
| `login_clicked` | `index.html` `openLogin()` | Existing-user login is explicitly selected | Anonymous | Per click; never treated as signup | entry source, attribution |
| `registration_completed` | `js/analytics.js` `completeRegistration()` / `completeOAuthRegistration()` called from `index.html` | Supabase returned a genuinely new email identity, or verified Google user timestamps prove a new OAuth account | Authenticated UUID | Once per user, durable local key plus deterministic PostHog insertion key; OAuth replay is ignored | signup method, user UUID, attribution |
| `onboarding_started` | `js/onboarding.js` `startOnboarding()` | Confirmed new registration or a newly created profile begins onboarding | Authenticated | Once per user | attribution |
| `onboarding_completed` | `js/onboarding.js` `obContinue()` after `obFinish()` | All required profile data saved successfully | Authenticated | Once per user | categorical experience level when available |
| `data_connection_started` | `js/onboardingConnect.js` `authorize()`; `index.html` `connectStrava()` | Authorization URL/connect operation has genuinely begun | Authenticated in product flow | Repeats for real reconnect attempts | provider, provider-connection surface, attribution |
| `data_connection_completed` | `index.html` `handleIntervalsResult("connected")`; `handleStravaResult("connected")` | Server-confirmed provider callback/persistence succeeded | Authenticated | Once per user as the first successful connection milestone; no event from an already-connected renderer | provider |
| `provider_skipped` | `js/onboardingConnect.js` `skip()` | Athlete explicitly continues without a provider | Authenticated | Once per user | onboarding surface |
| `first_plan_generated` | `js/planSetup.js` after successful generation or recovered timeout result | Response/snapshot contains a saved plan ID and at least one dated session; not an already-existing plan response | Authenticated | Once per user | user UUID, categorical goal distance, plan start date |
| `first_value_viewed` | `js/planSetup.js` `trackVisibleFirstValue()` | Valid plan plus active visible Train screen for a new registration | Authenticated | Once per user; hidden rendering cannot mark it | training-plan value type, Train surface, attribution |
| `activation_completed` | `js/planSetup.js` `trackVisibleFirstValue()` | First-value conditions plus confirmed onboarding completion | Authenticated | Once per user | training-plan value type, Train surface, attribution |
| `coach_message_submitted` | `js/coach.js` request submit path | One accepted, non-duplicate Coach submission starts | Authenticated | Per accepted request | access tier, Coach surface |
| `coach_message_completed` | `js/coach.js` successful response path | Coach response returned successfully | Authenticated | Per successful response | access tier, Coach surface |
| `upgrade_sheet_viewed` | `js/accessGuard.js` `showUpgradeSheet()` | Sheet transitions from closed to genuinely visible for free/paid-inactive access | Authenticated app user | Per real open; repeated later opens may repeat | feature, upgrade-sheet surface, access tier |
| `checkout_started` | `js/accessGuard.js` `checkout()` | Browser/native external handoff was successfully opened | Authenticated app user | Per successful explicit click | feature, upgrade-sheet surface |
| `subscription_activated` | `api/whop/webhook.js` verified activation branch | Valid signed Whop webhook persisted active paid state | Verified server UUID | Webhook/event idempotency plus milestone semantics | Whop source only |

## Failure events

`signup_failed`, `onboarding_failed`, `data_connection_failed`,
`plan_generation_failed`, `activation_failed`, `coach_request_failed`, and
`checkout_failed` are attempts that ended unsuccessfully. They never imply
completion. Only these categorical keys are permitted as applicable:
`stage`, `failure_category`, `provider`, `source_surface`, and `access_tier`.

Raw errors, stack traces, URLs, OAuth codes, tokens, email, names, Coach text,
health/readiness data, workouts, and provider payloads are prohibited.

## Identity, attribution, and deduplication

- PostHog begins anonymously. `identify(Supabase UUID)` runs only after verified
  Supabase authentication/new-registration confirmation, allowing the same
  browser's anonymous history to merge into the authenticated person.
- Logout calls both `posthog.reset()` and
  `AthlevoAnalytics.resetIdentity()`. Pending user events and signup/attribution
  state are cleared so a shared device cannot leak one athlete's context into
  another's.
- UTM fields and `fbclid` are allowlisted from the landing URL. They are saved
  in session storage and in a 30-day local-storage record so auth, onboarding,
  refresh, PWA close/reopen, and same-browser OAuth returns retain attribution.
- External-browser handoff includes only approved attribution parameters and
  the categorical handoff intent/browser. OAuth codes, tokens, arbitrary
  redirects, email, and URL fragments are removed.
- View events use active-screen, document-visibility, boot-gate, and viewport
  checks. Renderer execution alone is not a view.
- User milestones use durable user/event local keys, matching session keys, a
  deterministic non-reversible PostHog `$insert_id` for simultaneous-tab
  ingestion deduplication, and the existing Supabase unique user/event
  milestone index.
- Behavioral actions remain repeatable in later sessions.

Cross-browser limitation: Facebook/Instagram and Safari have separate storage
and PostHog anonymous identities. Attribution survives because it is copied in
the safe continuation URL, but the in-app-browser anonymous person cannot be
perfectly merged with Safari without a server-issued cross-browser handoff
identity. The authenticated conversion is still attributed after Supabase
identification.

## Fresh-account manual verification

Use a disposable test account and a URL such as:

`https://athlevo.org/?utm_source=qa&utm_medium=manual&utm_campaign=funnel_test&utm_content=google&fbclid=test-click`

For every environment below, clear site data first and inspect PostHog's live
event stream by the test UUID after registration:

| Environment | Google | Email | Existing login | Skip provider | Strava | Intervals | Cancel/fail | Refresh/reopen |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Facebook iOS → Safari | required | required | required | required | required | required | required | required |
| Instagram iOS → Safari | required | required | required | required | required | required | required | required |
| iPhone Safari | required | required | required | required | required | required | required | required |
| Android Chrome | required | required | required | required | required | required | required | required |
| Desktop Safari/Chrome | required | required | required | required | required | required | required | required |
| Installed PWA | required | required | required | required | required | required | required | required |
| Native Capacitor iOS | required | email where supported | required | required | required | required | required | required |

For one complete run, confirm the exact authoritative event order above, one
PostHog person after authentication, registration/activation attribution,
provider success only after callback confirmation, and a visible Train plan
before first value/activation. Then verify:

1. refreshing onboarding does not duplicate milestones;
2. replaying the OAuth callback does not repeat registration or connection;
3. cancel/failure creates only a categorical failure event;
4. closing before the Train result produces no first-value or activation event;
5. reopening and visibly opening the valid plan completes activation once;
6. existing login produces `login_clicked`, never `registration_completed`;
7. landing/auth/hidden app initialization produces no
   `premium_feature_viewed`;
8. event properties contain no sensitive or free-form data; and
9. logout followed by another login starts from a reset PostHog identity.

The schema migration in
`migrations/2026-07-31_acquisition_activation_events.sql` must be reviewed and
applied separately before the authenticated Supabase ledger can accept the new
event names. The application never applies it automatically.

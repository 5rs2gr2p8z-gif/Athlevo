# Trial Email Templates — Missing Infrastructure Report

## Status: Templates ready, no sending infrastructure exists

### What's here

Three HTML email templates for the cardless trial lifecycle:

| File | Trigger | Timing |
|------|---------|--------|
| `trial-started.html` | `cardless_trial_started` event | Immediately after trial creation |
| `trial-expiring-24h.html` | Scheduled job query | ~24 hours before `trial_end` |
| `trial-expired.html` | Scheduled job query | Shortly after `trial_end` passes |

### What's missing

The codebase has **no email sending infrastructure**. Specifically:

- No transactional email provider (SendGrid, Postmark, Resend, SES, Mailgun, etc.)
- No email-sending utility or API endpoint
- No scheduled job system for time-based email triggers (the expiring and expired emails require a cron/scheduler)

### Recommended next steps

1. **Choose a transactional email provider** — Postmark or Resend are good fits for low-volume transactional email
2. **Create a `lib/server/email.js` module** with a `sendTrialEmail(userId, templateName)` function
3. **Create a scheduled Vercel cron** (`vercel.json` cron config or external scheduler) that runs every hour to:
   - Query expiring trials: `WHERE provider='athlevo_trial' AND status='trialing' AND trial_end BETWEEN now() AND now() + interval '25 hours'`
   - Query expired trials: `WHERE provider='athlevo_trial' AND status='trialing' AND trial_end < now()`
   - Send the appropriate email (using subscription_events to prevent duplicate sends)
4. **Wire trial-started email** into `api/trial/start.js` after successful RPC call

### Template variables

All templates expect these variables (replace with your templating engine's syntax):

- `{{athlete_name}}` — display name or "there" fallback
- `{{trial_end_date}}` — formatted trial expiry (e.g., "July 30, 2026")
- `{{app_url}}` — link to open Athlevo
- `{{checkout_url}}` — Whop checkout URL (expiring + expired templates only)
- `{{unsubscribe_url}}` — email unsubscribe link

### Per the spec

> "If no safe scheduling system exists, prepare the templates and report the missing scheduling requirement instead of inventing a fragile solution."

This document fulfills that requirement.

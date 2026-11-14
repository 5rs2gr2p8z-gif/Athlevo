# Athlevo Sub-1 10k Challenge (/virtual-run)

An 8-week virtual running challenge with a working registration form: the runner picks a package, fills
in four short steps, pays through PayMongo Hosted Checkout, and sees a confirmation only after the
payment is confirmed. Staff review registrations and export a fulfillment CSV on a protected page.

Live at `https://athlevo.org/virtual-run` (the staff page is `https://athlevo.org/virtual-run/admin`).
The same paths on programs.athlevo.org redirect to athlevo.org.

**Registration is closed until you open it.** Closed is the default. The page is live and readable, the
form stays hidden and the server refuses registrations until every item in "Before registration can
open" is done. Nothing can take a payment by accident.

## What is where

| File | What it is |
| --- | --- |
| `content/virtualRun.mjs` | All wording, dates, deadline, limits, packages, prices, delivery and legal settings. **The one file to edit.** Both the page and the server read it. |
| `scripts/build-virtual-run-page.mjs` | The markup. Writes `virtual-run.html` and `virtual-run-admin.html` from the content file. |
| `virtual-run.html`, `virtual-run-admin.html` | Generated. Do not edit by hand; the next build overwrites them. |
| `virtual-run.css` | The page's styles (and the staff page's). Uses only `store.css` tokens: black, white, one red, Barlow Condensed and Inter. |
| `js/virtualRun.js` | The four-step form, quick checks, the hand-off to PayMongo and the confirmation screen. Holds no wording and decides nothing. |
| `js/virtualRunAdmin.js` | The staff page: sign-in, filters, table, CSV download. |
| `lib/server/virtualRun.js` | `register`, `status` and `availability`: validation, the opening checks, the server's own price, the pending row, the checkout session. |
| `lib/server/virtualRunPayments.js` | What a confirmed payment does: checks it, marks the row paid exactly once, sends the emails. |
| `lib/server/virtualRunAdmin.js` | The staff list and CSV (who may see it, filters, formula-safe export). |
| `lib/server/paymongoWebhookEndpoint.js` | The existing PayMongo webhook. It now also recognises Sub-1 payments and refunds. |
| `service-worker.js` | One word added to its list of non-app pages (`virtual-run`), so visiting the page never replaces the cached app. |
| `api/providers/index.js` | The existing gateway. Four new actions (`virtual_run_register`, `_status`, `_availability`, `_admin`). No new serverless function. |
| `migrations/2026-11-14_virtual_run_registrations.sql` | The table registrations are saved in. |
| `tests/virtual-run-server.test.mjs`, `tests/virtual-run-page.test.mjs` | Checks for the server and for the page, form, script and routing. |

## Change a date, a price, a package or any wording

Edit `content/virtualRun.mjs`, then rebuild and deploy:

```
node scripts/build-virtual-run-page.mjs
npm run test:virtual-run
```

The sections marked **EDIT THE DATES HERE** and **EDIT PACKAGES AND PRICES HERE** are the ones you will
touch. Prices are pesos x 100 (₱399 is `39900`). A forgotten rebuild is caught by `npm run test:virtual-run`.
Run the build after changing `virtual-run.css` or either script too: it stamps their addresses with a short
fingerprint (`?v=...`), so visitors whose browser keeps the site's files never mix a new page with an old script.

| To change | Edit |
| --- | --- |
| Challenge dates | `EVENT.startDate`, `EVENT.endDate`, then set `EVENT.datesConfirmed` to `true` |
| When registration opens, closes, and the most people | `REGISTRATION.opensAt`, `.deadline`, `.limit` |
| A package's price, bullets, limit, or to hide it | `PACKAGES` (`priceCents`, `features`, `limit`, `available`) |
| Delivery coverage and timing | `DELIVERY` (set `confirmed: true` when it is final) |
| Rules, waiver and privacy links | `LEGAL` (and bump `LEGAL.version` when the documents change) |
| Youngest age | `ELIGIBILITY.minAge` |
| Shirt and medal pictures | `MERCH_ASSETS` (an image path under `/assets/`) |
| Wording | `HERO`, `HOW`, `RESULTS`, `PACKAGES_COPY`, `MERCH`, `FAQ`, `FORM`, `CONFIRMATION`, `EMAIL` |

The price a runner pays is always the server's: the browser sends only a package id, and the server
works out the amount from `PACKAGES` and checks the paid amount again when PayMongo confirms.

## Before registration can open

Registration opens only when **all** of these are true. `GET /api/virtual-run/availability` says
`not_open` until they are.

1. `VIRTUAL_RUN_SIGNUP_ENABLED=true` in Vercel.
2. `EVENT.datesConfirmed` is `true` (the dates are final).
3. `REGISTRATION.deadline` is set.
4. `LEGAL.rulesUrl` and `LEGAL.waiverUrl` point to the published official event rules and waiver.
5. Supabase is configured (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and the table exists.
6. `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` are set, and production is not using a test key.

The Finisher Kit and Performance Bundle also need `DELIVERY.confirmed: true`. Until then they show
"Opens with registration" and cannot be bought, and the Digital Challenge can. Nobody pays for a shirt
and medal that has no confirmed way to reach them.

## One-time setup

1. **Create the table.** In Supabase, open the SQL editor and run
   `migrations/2026-11-14_virtual_run_registrations.sql`. It is safe to run twice. Row level security is on
   with no policies, so no browser can read or change registrations; only the server (service role) can.
2. **Set the environment variables** below in Vercel (Production, and Preview if you test there).
3. **Staff list.** Add the people who may open the staff page (see Staff access).
4. **PayMongo webhook.** Nothing new to add. The existing webhook (`/api/paymongo/webhook`) already
   receives `checkout_session.payment.paid` and refund events, and now also handles the Sub-1 payments.
   Make sure it is still enabled in PayMongo for the live key.
5. **Paste the Meta Pixel base code** between the `META PIXEL` comments in `virtual-run.html`. A rebuild
   keeps what you paste. Keep the PageView line. The page sends the Purchase event itself, with the
   package price, only after the server has confirmed the payment, so leave any Purchase or Lead line out.

## Environment variables

| Variable | Needed | What it does |
| --- | --- | --- |
| `VIRTUAL_RUN_SIGNUP_ENABLED` | yes, to open | Must be `true` for registration to open. Anything else keeps it closed. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | already set | Where registrations are saved. Shared with the other sign-ups. |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` | already set | Checkout and the signed webhook. Shared. A test key is refused on production. |
| `PAYMONGO_PAYMENT_METHODS` | optional, shared | Which payment methods checkout offers. |
| `RESEND_API_KEY` | optional, shared | Sends the runner's confirmation email and the owner's alerts. Without it registration still works and the page says nothing about an email. |
| `VIRTUAL_RUN_ALERT_EMAIL` | optional | Who gets "new registration" and "payment problem" alerts. Falls back to `SIGNUP_ALERT_EMAIL`. |
| `VIRTUAL_RUN_STAFF_EMAILS` | one of these two | Comma-separated staff emails (the account's email must be confirmed). |
| `VIRTUAL_RUN_STAFF_USER_IDS` | one of these two | Comma-separated Supabase user ids. `ADMIN_USER_IDS` also works. |
| `VIRTUAL_RUN_ASSESSMENT_URL` | optional | https link to the running assessment, shown on the confirmation screen and in the email. |
| `VIRTUAL_RUN_TRAINING_URL` | optional | https link to the training guide, shown the same way. |
| `VIRTUAL_RUN_SITE_URL` | optional | Overrides `https://athlevo.org` for the checkout return links (for example to test on a preview). |

No other new variables. The assessment and training links are optional; without them the confirmation
tells the runner the link will arrive by email.

## What happens when someone registers

1. The page asks `GET /api/virtual-run/availability`. Only `open` shows the form.
2. At the end of step 4 the browser posts the details (no price) to `POST /api/virtual-run/register`.
   The server re-checks everything, then: refuses if registration is not open or the package is full;
   refuses a second registration for the same runner (**the same email and the same name**, whatever the
   capitals, who already paid; a family or couple can share one email under different names); cancels that
   runner's earlier unpaid attempt so it stops holding a spot; saves a **pending** row (so the shipping
   details are kept) with the server's price and a one-hour hold on the spot; creates a PayMongo checkout
   session; and returns its URL.
3. The runner pays on PayMongo's page and comes back to `/virtual-run?payment=success&ref=...`. The page's
   first script moves `ref` out of the address and into that tab's storage before anything else (the Meta
   Pixel included) can read the address. A refresh in the same tab still shows the confirmation. Someone who
   pays in another app and returns in a different browser tab or browser still arrives with `ref` in the
   address and is handled the same way. The Meta Pixel `Purchase` event is identified by the public
   registration ID (`SUB1-...`), never by the secret reference.
4. The page asks `POST /api/virtual-run/status` for that reference every few seconds, for up to a minute.
   It shows the confirmation **only** when the server says `paid`. Otherwise it says the payment has not
   been seen yet and offers "Check again". The URL alone never produces a confirmation.
5. PayMongo calls the webhook. The server verifies the signature, finds the registration, checks the
   reference, package, amount, currency and checkout id, and marks it `paid` with a conditional update, so
   repeated callbacks do nothing. Then it sends the runner's confirmation email and the owner's alert, once.
6. A payment that arrives after the hold expired is still recorded (the money is real). A second, different
   payment for the same registration is acknowledged and flagged to the owner by email. If the same runner
   ends up with two paid registrations (they opened a second checkout and paid both), both are recorded, nothing
   is undone, and the owner gets a `second_registration_same_runner` alert naming both IDs so one can be refunded
   by hand in PayMongo. A refund marks the registration `refunded` and it is never turned back into `paid`.
7. If PayMongo delivers a payment again and the runner's confirmation email is not recorded as sent (the first
   attempt died before it went out), the repeat sends it. The emails carry idempotency keys, so a runner who
   already has theirs does not get another.

Test payments (PayMongo test mode) are saved with `livemode = false` and shown with a **Test** tag in the
staff page. They are not counted in the revenue figure.

## Staff access

Open `https://athlevo.org/virtual-run/admin`.

- **Who may open it:** only accounts on the staff list (`VIRTUAL_RUN_STAFF_EMAILS` or
  `VIRTUAL_RUN_STAFF_USER_IDS`). The server checks the sign-in token on every request and refuses everyone
  else with a 403. Hiding the page is not the protection; the API is.
- **How to sign in:** if you are already signed in to the Athlevo app in that browser, the page uses that
  session. Otherwise sign in on the page with your Athlevo email and password (kept for that tab only).
  An account that signs in only with Google can open the app first and then this page.
- **What you can do:** filter by package, payment status, or search by name, email or registration ID;
  tick **To ship** to see only paid Finisher Kit and Performance Bundle orders; open **Details** for the
  full row; **Export CSV** downloads the filtered list as a fulfillment sheet (registration ID, package,
  shirt size, recipient, mobile, email, address, barangay, city, province, postal code, paid time).
- The CSV is UTF-8 with a byte-order mark so Excel opens it correctly, and any cell that starts with a
  formula character is neutralised. It holds every matching order, read from the database a thousand at a
  time. The on-screen list shows at most the latest 1,000 (Supabase answers no more than that per request);
  narrow it with the filters or export the CSV for the rest.
- The counts at the top cover every registration whatever the filters. A `pending` registration whose hold
  has run out is counted as "not completed", not as awaiting payment.
- **Staff by email is the looser option.** An email on `VIRTUAL_RUN_STAFF_EMAILS` counts only when Supabase has
  confirmed it, but an email address can change hands. For the staff who see runners' addresses, prefer
  `VIRTUAL_RUN_STAFF_USER_IDS` (a user id never changes).

## Personal data

- Details are saved only in the Supabase table above, behind row level security with no policies.
- The status endpoint returns a name, registration ID and package **only** for a paid registration and only
  to someone who holds the secret reference from their own checkout return link. An unknown reference
  looks the same as a pending one.
- Staff alerts and the staff page do not include a date of birth in emails. The CSV has what fulfillment
  needs and no date of birth.
- Unpaid attempts: the migration ends with an optional, commented statement that deletes unpaid rows older
  than 30 days. Run it by hand when you want to; it is not scheduled.
- The "already registered" message tells someone who types a paid email that it is registered. It is rate
  limited (10 registrations per hour per visitor).

## Deploy

1. Run the migration in Supabase.
2. Set the environment variables (leave `VIRTUAL_RUN_SIGNUP_ENABLED` unset for now).
3. `node scripts/build-virtual-run-page.mjs && npm run test:virtual-run && npm run test:store`, then push.
   Vercel deploys the page, the stylesheet, the scripts and the four routes in `vercel.json`. The gateway
   function count is unchanged.
4. Check `https://athlevo.org/virtual-run` reads well and the form is hidden, and
   `https://athlevo.org/api/virtual-run/availability` answers `{"state":"not_open", ...}`.

## Pre-launch checklist

Content
- [ ] Final challenge dates set, `EVENT.datesConfirmed: true`
- [ ] `REGISTRATION.deadline` set (and `opensAt` and `limit` if you want them)
- [ ] Official event rules and waiver published; `LEGAL.rulesUrl`, `LEGAL.waiverUrl` and `LEGAL.version` set
- [ ] Privacy policy at `/privacy` covers registration data (names, dates of birth, addresses, personal bests)
- [ ] Delivery coverage and timing final; `DELIVERY.coverage`, `DELIVERY.timing`, `DELIVERY.confirmed: true`
  (and `DELIVERY.provinces` if you deliver to some provinces only)
- [ ] Approved shirt and medal pictures in `MERCH_ASSETS`; shirt sizes in `SHIRT_SIZES` match the real run
- [ ] Minimum age confirmed (`ELIGIBILITY.minAge`, 18 today) and what a parent or guardian must do for younger runners
- [ ] Wording for how and when rewards and certificates are sent confirmed
- [ ] A way for a runner to submit a result exists before the challenge ends (this page does not build it)

Payments and data
- [ ] Migration run in Supabase
- [ ] PayMongo live key and webhook secret set; the webhook is enabled for the live key
- [ ] One end-to-end payment in PayMongo **test mode** on a preview deployment (set `VIRTUAL_RUN_SITE_URL`
  to the preview address), then confirm: the row is `paid`, the confirmation screen shows, the email
  arrives, the staff page shows it with a Test tag
- [ ] A cancelled checkout leaves a `pending` row (its hold on the spot ends after an hour) and does not show a confirmation
- [ ] A small live payment, then refund it in PayMongo and check the row becomes `refunded`
- [ ] Resend sender is verified (confirmation email lands in an inbox, not spam)
- [ ] `VIRTUAL_RUN_ALERT_EMAIL` (or `SIGNUP_ALERT_EMAIL`) points to someone who reads it

Staff
- [ ] `VIRTUAL_RUN_STAFF_EMAILS` or `VIRTUAL_RUN_STAFF_USER_IDS` set; a staff member can open the page, a
  non-staff account gets "not on the staff list"
- [ ] CSV export opens in Excel with the right columns

Page
- [ ] Meta Pixel base code pasted (PageView only)
- [ ] `VIRTUAL_RUN_ASSESSMENT_URL` and `VIRTUAL_RUN_TRAINING_URL` set, or the email wording is fine without them
- [ ] Read the page on a phone and a laptop; walk the form to the PayMongo screen
- [ ] Finally set `VIRTUAL_RUN_SIGNUP_ENABLED=true` and redeploy

## Limits to know about

- **Capacity.** A limit counts paid registrations plus unpaid ones still inside their one-hour hold. Two people
  paying at the very same moment for the last spot can both get through, because the check and the saving are
  separate steps; payments are never refused after the fact, so the owner would refund the extra one. Leave a
  small margin on any hard limit.
- **Refund before payment.** A refund event that reaches the server before the payment event it belongs to
  finds nothing to mark; the payment is then recorded as paid and the refund is not applied. PayMongo sends
  payment first in practice. If a refunded registration shows as paid, mark it in Supabase by hand.
- **Same runner.** The "already registered" rule is the same email and the same name. A different spelling of
  the name on the same email is treated as another runner; the owner alert above is the safety net.

## What this does not do yet

- **Result submission, verification and the leaderboard.** The page promises "submit your result" as step 5,
  and the table has a `result_status` column for it, but the submission form, the check against the official
  rules and any leaderboard are separate work.
- **A new payment service.** It reuses PayMongo Hosted Checkout, the same as the other sign-ups.
- **Member accounts.** Registrants do not get an Athlevo login from this form.

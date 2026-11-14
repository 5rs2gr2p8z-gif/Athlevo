# Athlevo Sub-1 10k Challenge (/virtual-run)

An 8-week virtual running challenge with a working registration form: the runner picks a package, fills
in four short steps, pays through PayMongo Hosted Checkout, and sees a confirmation only after the
payment is confirmed. Staff review registrations and export a fulfillment CSV on a protected page.

Live at `https://athlevo.org/virtual-run` (the staff page is `https://athlevo.org/virtual-run/admin`).
The same paths on programs.athlevo.org redirect to athlevo.org.

**Registration is closed until you open it.** Closed is the default. The page is live and readable, the
form stays hidden and the server refuses registrations until every item in "Before registration can
open" is done. Nothing can take a payment by accident.

**The page can be marketed while registration is closed.** Until registration opens, the page is in its
"Registration opening soon" state: the hero says so, every button leads to the **priority list** (name and
email, with consent), the dates read "Dates to Be Announced", and the registration form is not on screen
at all. When registration opens the same page switches itself to the registration state. See "Opening soon
and the priority list".

## What is where

| File | What it is |
| --- | --- |
| `content/virtualRun.mjs` | All wording, dates, deadline, limits, packages, prices, delivery and legal settings. **The one file to edit.** Both the page and the server read it. |
| `scripts/build-virtual-run-page.mjs` | The markup. Writes `virtual-run.html` and `virtual-run-admin.html` from the content file. |
| `virtual-run.html`, `virtual-run-admin.html` | Generated. Do not edit by hand; the next build overwrites them. |
| `virtual-run.css` | The page's styles (and the staff page's). Uses only `store.css` tokens: black, white, one red, Barlow Condensed and Inter. |
| `js/virtualRun.js` | The page's behaviour: switches between the "opening soon" and registration states, the priority list form and leave panel, the four-step form, quick checks, the hand-off to PayMongo and the confirmation screen. Holds no wording and decides nothing. |
| `js/virtualRunAdmin.js` | The staff page: sign-in, the Registrations and Priority list tabs, filters, tables, CSV downloads. |
| `lib/server/virtualRun.js` | `register`, `status` and `availability`: validation, the opening checks, the server's own price, the pending row, the checkout session. |
| `lib/server/virtualRunPayments.js` | What a confirmed payment does: checks it, marks the row paid exactly once, sends the emails. |
| `lib/server/virtualRunWaitlist.js` | The priority list: join, leave, the confirmation email. Never touches payment. |
| `lib/server/virtualRunAdmin.js` | The staff lists and CSVs for registrations and for the priority list (who may see them, filters, formula-safe export). |
| `lib/server/paymongoWebhookEndpoint.js` | The existing PayMongo webhook. It now also recognises Sub-1 payments and refunds. |
| `service-worker.js` | One word added to its list of non-app pages (`virtual-run`), so visiting the page never replaces the cached app. |
| `api/providers/index.js` | The existing gateway. Five new actions (`virtual_run_register`, `_status`, `_availability`, `_admin`, `_waitlist`). No new serverless function. |
| `migrations/2026-11-14_virtual_run_registrations.sql` | The table registrations are saved in. |
| `migrations/2026-11-14_virtual_run_waitlist.sql` | The table the priority list is saved in. |
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
| Challenge dates | `EVENT.startDate`, `EVENT.endDate`, then set `EVENT.datesConfirmed` to `true` (see "Confirm the dates") |
| When registration opens, closes, and the most people | `REGISTRATION.opensAt`, `.deadline`, `.limit` |
| A package's price, bullets, limit, or to hide it | `PACKAGES` (`priceCents`, `features`, `limit`, `available`) |
| Delivery coverage and timing | `DELIVERY` (set `confirmed: true` when it is final) |
| Rules, waiver and privacy links | `LEGAL` (and bump `LEGAL.version` when the documents change) |
| Youngest age | `ELIGIBILITY.minAge` |
| Shirt and medal pictures | `MERCH_ASSETS` (an image path under `/assets/`) |
| The priority list (on or off, wording, consent sentence) | `WAITLIST`, `WAITLIST_EMAIL` |
| Wording | `HERO`, `HOW`, `RESULTS`, `PACKAGES_COPY`, `MERCH`, `FAQ`, `FORM`, `CONFIRMATION`, `EMAIL` |

The price a runner pays is always the server's: the browser sends only a package id, and the server
works out the amount from `PACKAGES` and checks the paid amount again when PayMongo confirms.

### Confirm the dates

Every date on the page, in the emails, in the search-engine data and in the server's rules comes from the
two blocks at the top of `content/virtualRun.mjs` (`EVENT` and `REGISTRATION`). Nothing else holds a date.

1. Fill in `EVENT.startDate` and `EVENT.endDate` (`YYYY-MM-DD`). The challenge is `EVENT.weeks` weeks (8), so
   the two days must be exactly 56 days apart counting both ends (December 1 to January 25 is right).
2. Set `REGISTRATION.deadline` (and `opensAt` if you want a timed opening), as a full time with the Manila
   offset, for example `2026-11-30T23:59:00+08:00`. It must fall before the challenge ends.
3. Set `EVENT.datesConfirmed` to `true`.
4. `node scripts/build-virtual-run-page.mjs`, then `npm run test:virtual-run`, then push.

What follows by itself: the hero shows the dates and "Registration closes <deadline>", the FAQ answers
"When is the challenge?" with them, the search-engine event data appears, the priority list email stops
saying the dates are pending, and the server stops refusing on dates. If the dates do not add up (an end date
that is not 8 weeks after the start, a day that does not exist, a deadline after the end) the build **stops
and says what to fix**, and the server keeps registration shut. Until `datesConfirmed` is `true` the page
shows **"Dates to Be Announced"** everywhere and publishes no date at all; the registration deadline shows as
"Date to Be Announced" and the hero's second fact reads "Registration: Opening soon".

## Before registration can open

Registration opens only when **all** of these are true. `GET /api/virtual-run/availability` says
`not_open` until they are.

1. `VIRTUAL_RUN_SIGNUP_ENABLED=true` in Vercel.
2. `EVENT.datesConfirmed` is `true` (the dates are final) and they add up (see "Confirm the dates").
3. `REGISTRATION.deadline` is set.
4. `LEGAL.rulesUrl` and `LEGAL.waiverUrl` point to the published official event rules and waiver.
5. Supabase is configured (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and the table exists.
6. `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` are set, and production is not using a test key.

The Finisher Kit and Performance Bundle also need `DELIVERY.confirmed: true`. Until then they show
"Opens with registration" and cannot be bought, and the Digital Challenge can. Nobody pays for a shirt
and medal that has no confirmed way to reach them.

## Opening soon and the priority list

**The two states of the page.** The page is built in its "opening soon" state (this is what search engines,
link previews and visitors without JavaScript get). In a browser it asks `GET /api/virtual-run/availability`
and switches to the registration state only when the server answers `open` (or `closed` / `sold_out`, so
the status line can say so), or when a runner is coming back from PayMongo. Nothing in the page can open
registration; only the server's answer can, and the server answers `open` only under the conditions above.

| | Opening soon (default) | Registration |
| --- | --- | --- |
| Hero | "Registration opening soon", button "Join the priority list" | "Register now" |
| Header button | "Join the list" | "Register now" |
| Package cards | "Join the priority list" link, "Opens with registration" | "Choose <package>" |
| Priority list section | shown | hidden |
| Registration form | not on screen | shown |

An old link to `/virtual-run#register` lands on the priority list while registration is not open.

**The priority list** collects a name and an email address from people who want to hear first.

- *Consent.* One unticked box: "Email me about the Athlevo Sub-1 10k Challenge, including when registration
  opens. I can unsubscribe at any time. I have read the privacy policy." The server refuses a sign-up where
  consent is not the plain `true`. It stores the **consent version** (`WAITLIST.consentVersion`) and the
  **time**. Change the version whenever that sentence or the privacy policy changes in a way that matters.
- *Confirmation and leaving.* Each sign-up gets one email: you are on the list, nothing has been charged,
  and a personal link to leave. The link opens the page and **asks**; nobody is removed until they press
  "Yes, remove me", so an email scanner that opens links cannot unsubscribe people. The secret in the link is
  moved out of the address before any pixel runs, like the payment reference. A person who leaves and
  joins again has agreed again and is put back.
- *Joining twice* changes nothing and looks exactly like the first time, so the form cannot be used to
  check whether someone is on the list.
- *Where it is stored.* `virtual_run_waitlist` in Supabase: name, lower-case email, consent version and time,
  an optional campaign label, status, and the secret leave token. No IP address, no browser details, no
  payment information. Row level security is on with no policies, so only the server and the staff page
  can read it.
- *Abuse.* A hidden spam-trap field, a limit of 10 sign-ups an hour per visitor, links or addresses in the
  name box refused, and the email check.
- *Campaign labels.* Put `?src=meta-launch` (or `utm_campaign=`, `utm_source=`) on an ad link and the label
  is kept with each sign-up (a short lower-case label, nothing personal), so you can see which ad brought them.
  It shows in the staff list and the CSV.
- *Meta Pixel.* After the server has saved a sign-up the page sends a `Lead` event, once per tab, with no
  name or email. Remove the `trackLead` call in `js/virtualRun.js` if you do not want it.
- *Staff.* The staff page has a **Priority list** tab (counts, the latest 200, status filter, search) and an
  export. The CSV holds only people **still on the list** unless you choose "Left the list", so nobody who
  left is mailed by mistake.
- *Switching it off.* `WAITLIST.enabled: false` removes the section and the buttons; the server also stops
  accepting sign-ups. `GET availability` reports `waitlist: false` if the database is not configured.
- *Not built:* sending campaigns. The list is a CSV (or the Supabase table) for whatever tool you use to
  email people. Send only to people who are still on the list, and include a way to leave.

## One-time setup

1. **Create the tables.** In Supabase, open the SQL editor and run
   `migrations/2026-11-14_virtual_run_registrations.sql` and `migrations/2026-11-14_virtual_run_waitlist.sql`.
   Both are safe to run twice. Row level security is on with no policies, so no browser can read or change
   either table; only the server (service role) can. **Run the waitlist one before the page goes live**, or
   sign-ups answer "could not save that" (the server log names the file to run).
2. **Set the environment variables** below in Vercel (Production, and Preview if you test there).
3. **Staff list.** Add the people who may open the staff page (see Staff access).
4. **PayMongo webhook.** Nothing new to add. The existing webhook (`/api/paymongo/webhook`) already
   receives `checkout_session.payment.paid` and refund events, and now also handles the Sub-1 payments.
   Make sure it is still enabled in PayMongo for the live key.
5. **Paste the Meta Pixel base code** between the `META PIXEL` comments in `virtual-run.html`. A rebuild
   keeps what you paste. Keep the PageView line. The page sends the `Lead` event itself when a sign-up has been
   saved, and the Purchase event with the package price only after the server has confirmed the payment, so
   leave any Purchase or Lead line out.

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
| `VIRTUAL_RUN_SITE_URL` | optional | Overrides the address used in the checkout return links and in the priority list email's leave link (default `https://athlevo.org`, or the preview's own address on a preview). |
| `SIGNUP_REPLY_TO_EMAIL` | optional, shared | Where a reply to any of these emails goes (default support@athlevo.org). |

The priority list needs only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and (for the confirmation email)
`RESEND_API_KEY`. No other new variables. The assessment and training links are optional; without them the confirmation
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
- **Two tabs.** *Registrations* (below) and *Priority list*: who asked to hear first, with the count on and off
  the list, a status filter, a search box and an export (see "Opening soon and the priority list").
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
- The priority list holds a name, an email, the consent version and time, an optional campaign label and a
  secret leave token. Nothing else. Delete it when the event is over (the migration ends with a commented
  statement for that), and write to it only while people are still on it.
- The "already registered" message tells someone who types a paid email that it is registered. It is rate
  limited (10 registrations per hour per visitor).

## Previews and publishing to production

How Vercel is set up for this project (read from the repository and its public GitHub deployment history):
every push to **any branch** creates a **Preview** deployment, and the **`main`** branch deploys to
**Production** (athlevo.org). Pushing `virtual-run` therefore never changes the live site. The repository
builds nothing: Vercel serves the committed `virtual-run.html`, which is why the page must be rebuilt and
the rebuilt file committed (`npm run test:virtual-run` fails if it was forgotten).

**Preview**

1. `git push -u origin virtual-run`.
2. GitHub shows a "Vercel" check on the commit with a link to the preview, and the
   deployment appears in the Vercel dashboard under Deployments (Environment: Preview, Branch:
   `virtual-run`). Open `<preview address>/virtual-run`.
3. Previews use the variables scoped to **Preview** in Vercel (Project, Settings, Environment Variables).
   If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are scoped to Production only, the priority list shows
   "not taking sign-ups right now" on a preview. If they are shared with Preview, a test sign-up goes into
   the **real** table: use an obvious test address and remove the row afterwards. Never put a live PayMongo
   key on Preview.
4. Preview addresses may sit behind Vercel's sign-in (Deployment Protection). Use them to check, never in ads.

**Production**

1. Run `migrations/2026-11-14_virtual_run_waitlist.sql` in Supabase (once, before the merge).
2. Check the preview (checklist below).
3. Open a pull request `virtual-run` into `main` on GitHub, look at the diff once, and merge it. Vercel
   deploys `main` to Production automatically.
4. Check `https://athlevo.org/virtual-run` and `https://athlevo.org/api/virtual-run/availability`
   (`{"state":"not_open","waitlist":true,...}`).
5. **What else ships in the merge:** the shared PayMongo webhook gained the Sub-1 payment handling in the
   earlier work (it is inert until a Sub-1 payment exists). Nothing else outside `/virtual-run` changes.

**Roll back.** In the Vercel dashboard, Deployments, open the last good Production deployment and choose
"Promote to Production" (instant, no code change). Or revert the merge commit on `main`.

**Never** set `VIRTUAL_RUN_SIGNUP_ENABLED` until the "Before registration can open" list is done. With it
unset, no code path can take a payment, whatever else is deployed.

## Marketing launch checklist (registration stays closed)

Before the first ad or post points at `https://athlevo.org/virtual-run`:

- [ ] `migrations/2026-11-14_virtual_run_waitlist.sql` run in Supabase
- [ ] Branch pushed, preview opened: hero says "Registration opening soon", "Dates to Be Announced", the
  priority list form works, the confirmation email arrives, its leave link asks first and then removes you
- [ ] Privacy policy (`legal/privacy-policy.md`, shown at `/privacy`) says you collect names and emails for
  event updates, who processes them (Supabase, Resend), the Meta Pixel on this page, how long you keep the
  list, and how to leave. The consent sentence links to it.
- [ ] Meta Pixel base code pasted into the page (PageView only); a link preview image decided
- [ ] Merged to `main`, production checked: `/virtual-run` loads, `/api/virtual-run/availability` says
  `not_open`, one real sign-up from a phone, staff page shows it on the Priority list tab
- [ ] `VIRTUAL_RUN_SIGNUP_ENABLED` is still **unset** in Production
- [ ] Ad links carry `?src=<label>` so sign-ups can be traced to the ad

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

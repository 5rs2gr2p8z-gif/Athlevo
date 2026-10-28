# Store sign-up: Athlevo Plan, Athlevo Coaching and Elite Coaching (programs.athlevo.org)

Lets a visitor pay for **Athlevo Plan** (₱1,998 per month) on `programs.athlevo.org/athlevo-plan`, **Athlevo Coaching**
(₱4,998 per month) on `/athlevo-coaching` or **Elite Coaching** (₱7,998 per month, coached directly by Dean)
on `/elite-coaching` without an Athlevo app account. Each offer is **off** until you turn it on, and you can
open any of them without the others. These four paths on `programs.athlevo.org` are the links to send to clients;
`athlevo.org/athlevo-plan`, `/athlevo-coaching` and `/elite-coaching` (and the old `athlevo.org/programs/...`
addresses) redirect to them (set in `vercel.json`; see `docs/programs-domain.md`).

| | Athlevo Plan | Athlevo Coaching | Elite Coaching |
|---|---|---|---|
| Price (owned by the server) | ₱1,998 | ₱4,998 | ₱7,998 |
| Page (on programs.athlevo.org) | `/athlevo-plan` | `/athlevo-coaching` | `/elite-coaching` |
| Server switch | `PLAN_SIGNUP_ENABLED` | `COACHING_SIGNUP_ENABLED` | `ELITE_SIGNUP_ENABLED` |
| Questionnaire link | `PLAN_QUESTIONNAIRE_URL` | `COACHING_QUESTIONNAIRE_URL`, or the Plan's when not set | `ELITE_QUESTIONNAIRE_URL`, or the Plan's when not set |
| Call-scheduling link (optional) | `PLAN_SCHEDULE_URL` | `COACHING_SCHEDULE_URL` | `ELITE_SCHEDULE_URL` |
| Agreement link (optional) | `PLAN_AGREEMENT_URL` | `COACHING_AGREEMENT_URL` | `ELITE_AGREEMENT_URL` |
| Page switch | `signUp.open` on the Plan in `js/storeCatalog.js` | `signUp.open` on the Coaching entry | `signUp.open` on the Elite entry |
| API paths | `/api/plan-signup/checkout`, `/status` | `/api/coaching-signup/checkout`, `/status` | `/api/elite-signup/checkout`, `/status` |
| Reference on PayMongo | `ATH-PL-...` | `ATH-CO-...` | `ATH-EL-...` |

All offers write to the same table, `plan_signups`; the `product_id` column says which one
(`ATHLEVO_PLAN_MONTHLY`, `ATHLEVO_COACHING_MONTHLY` or `ATHLEVO_ELITE_MONTHLY`).

## The flow

1. Visitor taps **Sign Up**. The page asks our API for a PayMongo hosted checkout and sends them there.
   The browser sends no price or product; the server owns both, and which offer it is comes from the
   endpoint that was called.
2. They pay on PayMongo (QRPh, Maya or GrabPay, whatever `PAYMONGO_PAYMENT_METHODS` allows).
3. PayMongo sends the signed webhook (`checkout_session.payment.paid`) to `/api/paymongo/webhook`.
   If it is a Plan, Coaching or Elite payment, one row is written to `plan_signups`.
4. When a payment is newly recorded, two emails go out (if you set them up, see step 3 under "Turn it on"): the
   buyer's next steps (reference, questionnaire link, scheduling link, agreement link if set, and a link back to the
   confirmation page) and an alert to you. A redelivered event never sends them again.
5. PayMongo returns the visitor to the offer's page with `?payment=success&ref=...`. That page asks the
   offer's status endpoint whether the webhook has recorded the payment, and only then shows the
   questionnaire link and the call-scheduling step. Being redirected back proves nothing by itself.

Payment is month to month with no automatic renewal. Month two is another checkout.

## Turn it on (in this order; repeat steps 2, 4 and 5 for each offer)

1. **Database (once).** Run `migrations/2026-10-15_plan_signups.sql` in the Supabase SQL editor. It serves both offers.
2. **Vercel environment variables** (Settings, Environment Variables). The PayMongo ones already exist for Athlevo Pro.
   - Questionnaire link, https, required. Current form:
     `https://docs.google.com/forms/d/e/1FAIpQLScnKgZvr86oITPSNEGEjSZTULQeIufXPUdiCIgO_AhqkUJFfg/viewform?usp=header`
     Set `PLAN_QUESTIONNAIRE_URL`. Coaching and Elite use the same link unless you also set `COACHING_QUESTIONNAIRE_URL`
     or `ELITE_QUESTIONNAIRE_URL` (if you set one it must be a valid https link, or that offer stays closed).
   - Scheduling link (optional): `PLAN_SCHEDULE_URL`, `COACHING_SCHEDULE_URL` and/or `ELITE_SCHEDULE_URL`. Without one, the
     page only says they will be asked to schedule a call. No offer borrows another's scheduling link.
   - Agreement link (optional): `PLAN_AGREEMENT_URL`, `COACHING_AGREEMENT_URL` and/or `ELITE_AGREEMENT_URL`, an https link
     to the agreement. When set, it appears on the confirmation page and in the buyer's email. No offer borrows another's.
   - The switch: `PLAN_SIGNUP_ENABLED=true`, `COACHING_SIGNUP_ENABLED=true` and/or `ELITE_SIGNUP_ENABLED=true`. An offer stays
     closed on the server unless its switch is `true` AND a questionnaire link is valid.
3. **Emails (optional, once, recommended).** Uses the Resend account the coach invites already use. All of these are
   Vercel environment variables, and nothing is sent until `RESEND_API_KEY` is set.
   - `RESEND_API_KEY`: already set if coach invites work.
   - `SIGNUP_ALERT_EMAIL`: where the alert goes. One address, or up to five separated by commas. No alert if unset.
   - `SIGNUP_FROM_EMAIL` (optional): the sender, e.g. `Athlevo <noreply@athlevo.org>`. Falls back to
     `ATHLEVO_INVITE_FROM_EMAIL`, then to that same default. The sender's domain must be verified in Resend.
   - `SIGNUP_REPLY_TO_EMAIL` (optional): where a buyer's reply goes. Default `support@athlevo.org`, so make sure that
     inbox exists, or set this to one you read.
   The buyer's email goes to the address PayMongo collected at checkout (it can be empty, and then only the alert is
   sent). It is separate from PayMongo's own receipt, which PayMongo still sends.
4. **Test it before the public can see it.** The server switch and the page switch are separate: with the page switch
   still `false` there is no Sign Up button, so nobody finds it. Either use PayMongo test keys on a Vercel preview
   deployment (with a test-mode webhook pointed at that preview; never scan the test QR with a real app), or pay once
   yourself with the live keys (₱1,998, ₱4,998 or ₱7,998) and refund it in the PayMongo dashboard (refunds mark the row
   `refunded`). See "Test keys and live keys" below. Check that a `plan_signups` row appears with the right
   `product_id` and that the confirmation page shows your links.
5. **Open it to the public.** In `js/storeCatalog.js` set that offer's `signUp.open` to `true`, then run
   `npm run build:store` and `node tests/store-route.test.mjs`. The build rewrites the banner (it names whichever
   offers are open), the FAQ answer and the static pages, so nothing is edited by hand. Deploy.

## Test keys and live keys (read before opening to the public)

The site takes real money only with PayMongo's **live** keys. In Vercel, **Production** must hold:

- `PAYMONGO_SECRET_KEY` = the **Live** secret key (starts `sk_live_`).
- `PAYMONGO_WEBHOOK_SECRET` = the signing secret of a webhook created in PayMongo's **Live** mode. Create it at
  Developers, Webhooks, with the URL `https://athlevo.org/api/paymongo/webhook` and these events:
  `checkout_session.payment.paid`, `payment.refunded` and `payment.refund.updated`. A Test-mode webhook has a different
  secret, and the site rejects a webhook whose signature mode does not match the event.

**Why this matters.** In test mode PayMongo's QR Ph codes are real, scannable codes. PayMongo's own docs: "In test mode,
QR Ph generates real QR codes. Do not scan and pay them, it will process a real transaction." A customer who pays one has
real money taken, but it never reaches the live account and no webhook is sent, so nothing is recorded or emailed, and
the payer's bank has to reverse it. A test-mode checkout page shows a **Simulate Payment** button under the QR code, and a live
one never does.

**The safeguard.** On the production deployment (`VERCEL_ENV=production`), a checkout is refused while
`PAYMONGO_SECRET_KEY` starts with `sk_test_`: every offer answers "Sign-up is not open yet", Athlevo Pro checkout in the app
answers "Local payment is unavailable", and the server log says "checkout refused: production is using a PayMongo test key". Previews and local runs may still use test keys, so keep
**Preview** on test keys and **Production** on live ones (give each environment its own value in Vercel). Changing an
environment variable only takes effect after a redeploy.

**Before telling anyone it is open**, make one small real payment yourself on the production site: the PayMongo page must
have no Simulate Payment button, the payment must appear under **Live** Payments, a `plan_signups` row with
`livemode = true` must appear, and the alert and buyer emails must arrive. Then refund it in the PayMongo dashboard.

## Seeing sign-ups

Supabase, Table Editor, `plan_signups`. Newest first by `paid_at`. Filter `product_id` to see one offer.
Test-mode payments have `livemode = false` (their alert subject starts with `[TEST]`). When an email was attempted,
`metadata.notifications` on the row says how each went: `buyer` and `owner` are `sent` or `failed`; a `no_email`
buyer means PayMongo gave no address, and `no_recipient` means `SIGNUP_ALERT_EMAIL` was not set. A `failed` email
does not affect the payment, which is recorded either way; check Resend's logs and, if needed, send the steps by hand.
Nothing is noted when no email was attempted (for example before `RESEND_API_KEY` is set). `customer_name`, `customer_email` and `customer_phone` come from what
PayMongo collected at checkout and can be empty; the PayMongo dashboard always has the payer's details.
`paid_through` is `paid_at` plus 30 days.

## Not built yet

- No retry or "resend" for a failed email, and no way to resend the steps from the site.
- No monthly reminder (deferred until the site is live). `paid_through` is there for it, and the page promises one.
- No renewal link. Month two is another Sign Up checkout.
- Nothing yet checks that a Coaching buyer's questionnaire or call happened; the confirmation page only shows the links.

## Partner discount codes (one unique code per runner)

For groups whose members get a discount (for example the runners of an event). Each runner gets **their own code**; it takes a
fixed percentage off **every** payment that runner makes with it, renewals included (month two is another Sign Up, and the
runner types the same code again; the welcome email reminds them). Nothing on the public site names a partner. Which
batch a code belongs to is an internal label that only you see (in the database and in your sign-up alert).

**How it works.** The Plan and Coaching pages have a small "Have a discount code?" link under each Sign Up button. The Elite
page has none (see "Which offers a code works on" below).
A runner types the code (or opens a link ending in `?code=ABCD-EFGH`, which fills it in and applies it) and sees the new
price before paying. The browser only ever sends the code text. The server looks the code up in `partner_codes`, works out
the price itself, opens the PayMongo checkout at that price, and tags the checkout with the code. The webhook then accepts
the payment only if it is exactly that discounted price. A code that is unknown, switched off, expired, not for that offer
or malformed all give the same answer ("That code isn't valid"), and an invalid code never silently becomes a full-price
checkout. Checking codes is rate limited (30 an hour per visitor), and codes are 8 characters from a 31-character
alphabet, so they cannot be guessed.

**Set up (once).** Run `migrations/2026-10-21_partner_codes.sql` in the Supabase SQL editor, before you give anyone a code.
It adds the `partner_codes` table and a few columns on `plan_signups`, and is safe to run twice.

**Which offers a code works on.** A code with no product list works on the Plan and Coaching only. Elite Coaching takes a code
only when that code's row names it in `product_ids` (make the batch with `--products elite`, or `plan,coaching,elite`, below),
so opening a new offer never quietly gives it a discount. The Elite page has no code box today, so the site cannot take an
Elite code until that is switched on in the page code (`takesCodes` on the Elite entry in `js/storeCatalog.js`). An Elite
checkout with a code that does not cover Elite is refused ("That code isn't valid"), never charged full price.

**Make a batch of codes.**

```
node scripts/generate-partner-codes.mjs --partner race-2026-11-24 --count 100
```

Options: `--percent 10` (default 10, up to 50), `--products plan,coaching,elite` (any of the three, comma separated;
default Plan and Coaching, which is also what naming exactly those two means), `--expires 2026-12-31`
(last day, Philippine time; default none), `--note "text"`, `--out folder` (default `partner-codes/`, which git ignores).
It writes two files and changes nothing else. Run the `.sql` file in the Supabase SQL editor to switch the codes on, and hand
out the codes in the `.csv` (written `ABCD-EFGH`; runners can type them in any case, with or without the hyphen). Make
another batch any time with a new label, for example `race-2027-01-12`. The label is yours to choose, in lower case.

**What gets recorded.** A payment made with a code is saved on its `plan_signups` row with `partner_code`, `partner` (the
label), `list_price_cents` and `discount_percent`, next to the amount actually paid. Your sign-up alert shows the amount paid,
the discount, the code and the batch (the subject ends with the batch label). Each code is remembered against the first
email that paid with it. If a later payment with that code comes from a different email, it is still accepted (they already
paid), but the alert says "this code may have been shared" and the row carries `code_email_mismatch`.

**Working out a partner's share** (Supabase SQL editor). A partner's share is normally on a runner's *first* payment only,
and the discount code stays on later payments, so look at each code's earliest payment. Replace `race-2026-11-24` with
your own batch label and `0.30` with the agreed share:

```sql
-- every payment made with this batch
select paid_at, partner_code, customer_name, customer_email, product_id,
       amount_cents / 100.0 as paid, list_price_cents / 100.0 as list_price, status
from public.plan_signups
where partner = 'race-2026-11-24' and livemode
order by paid_at;

-- the partner's share of first payments (refunded first payments are left out)
with first_payment as (
  select distinct on (partner_code) *
  from public.plan_signups
  where partner = 'race-2026-11-24' and livemode
  order by partner_code, paid_at
)
select count(*) as runners,
       sum(amount_cents) / 100.0 as first_payments_total,
       round(sum(amount_cents) * 0.30) / 100.0 as share_amount
from first_payment
where status = 'paid';

-- codes that may have been shared
select paid_at, partner_code, customer_email from public.plan_signups
where metadata->>'code_email_mismatch' = 'true' order by paid_at;
```

**Switching codes off.** One runner: `update public.partner_codes set active = false where code = 'KQ7MX4RT';`
A whole batch: `... where partner = 'race-2026-11-24';`. Set `active = true` again to restore. A payment already in flight
when you switch a code off is still recorded.

**If the migration has not been run yet.** Codes answer "unavailable" (503) and open no checkout, and normal full-price
sign-up carries on as before. A coded payment that reaches the webhook before the new columns exist is still recorded, with
the code in its `metadata`.

## Things to know

- **Changing a price.** The price lives in `lib/server/planSignup.js` and on the page. Change both together, and only when no
  checkout is open: a payment made at the old price is rejected by the webhook (it answers 400, so PayMongo keeps retrying
  and nothing is recorded). If that ever happens, find the payment in the PayMongo dashboard and record or refund it by hand.
- **One shared questionnaire link.** Coaching uses `PLAN_QUESTIONNAIRE_URL` unless `COACHING_QUESTIONNAIRE_URL` is set. If you
  later remove or change the Plan's link, Coaching changes with it; set the Coaching one to keep them apart.
- **A refund that arrives before its payment was recorded** (only possible if recording failed and PayMongo is still retrying)
  is not applied to the sign-up. The PayMongo dashboard is the source of truth for refunds; check it if a payment looks odd.

## Closing it again

Set that offer's `*_SIGNUP_ENABLED` to anything but `true` (starting a checkout then returns 503), and set its
`signUp.open` back to `false` and rebuild to hide the button. Anyone who already paid is still recorded and
can still open their confirmation page.

## Safety properties (all covered by tests)

- Amount and currency are fixed on the server per offer and checked again on the webhook. A wrong amount is rejected, and
  so is one offer's price on the other offer's payment or reference.
- Only a correctly signed PayMongo event records a payment. Test and live signatures are not interchangeable.
- The same event delivered twice records one row. Store payments never touch app subscriptions or the Pro ledger.
- No card or wallet details ever reach the site; payment happens on PayMongo.
- Payments are recognised by their own product tag, so Athlevo Pro payments and refunds follow the same path as before.
- One offer's status page can never show another offer's sign-up or links, and each offer has its own rate limits.
- Closing sign-up never drops a payment that was already in flight.
- A discount is worked out only on the server, from a code's own row. The browser sends the code text and nothing else,
  the webhook accepts only the exact discounted amount (or the full price with no code), and a code or percentage on its own
  is refused. A percentage is whole and at most 50. The partner label never reaches the browser, PayMongo or the buyer.
- Emails go out only for a newly recorded payment, from the signature-verified webhook, never from the browser. They
  never fail or roll back the payment, give up after a few seconds, and carry a Resend idempotency key per email.
- Everything PayMongo supplied (name, phone) is escaped in the HTML and stripped of line breaks in subjects, and the
  buyer's email goes only to one validated address. Links in the emails come only from your environment variables.

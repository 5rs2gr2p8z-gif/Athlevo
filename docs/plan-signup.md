# Store sign-up: Athlevo Plan, Athlevo Guided, Athlevo Coaching and Athlevo VIP Coaching (programs.athlevo.org)

Lets a visitor pay for one of four offers on `programs.athlevo.org` without an Athlevo app account:

- **Athlevo Plan** (₱999 per month): a personalized 4-week training plan built by an Athlevo coach, with no coaching call, on `/athlevo-plan`. Right after paying, the buyer is sent to the Athlevo app sign-up,
  `https://athlevo.org/signup`, to onboard and receive their plan there.
- **Athlevo Guided** (₱2,997 per month): the plan plus a coach to answer your questions, on `/athlevo-guided`. This is the
  offer that used to be called Athlevo Plan (₱1,998). Right after paying, the buyer is sent to the questionnaire (so are
  Coaching and VIP Coaching buyers).
- **Athlevo Coaching** (₱4,998 per month): everything in Guided, with frequent training adjustments, nutrition, recovery
  protocols and a hands-on coach, on `/athlevo-coaching`.
- **Athlevo VIP Coaching** (₱7,998 per month): everything in Coaching, with Dean as your coach and priority responses,
  on `/athlevo-vip-coaching`. This is the offer that used to be called Elite Coaching.

Each offer is **off** until you turn it on, and you can open any of them without the others. These four paths on
`programs.athlevo.org` are the links to send to clients; the same paths on `athlevo.org` (and the old
`athlevo.org/programs/...` addresses) redirect to them (set in `vercel.json`; see `docs/programs-domain.md`).
**`/athlevo-plan` is now the ₱999 plan.** A link or ad that sent people there for the old ₱1,998 Plan should point at
`/athlevo-guided` instead. The old `/elite-coaching` address redirects to `/athlevo-vip-coaching`, and `/hybrid-programming`
(dropped) redirects to `/programs`.

| | Athlevo Plan | Athlevo Guided | Athlevo Coaching | Athlevo VIP Coaching |
|---|---|---|---|---|
| Price (owned by the server) | ₱999 per month | ₱2,997 | ₱4,998 | ₱7,998 |
| Page (on programs.athlevo.org) | `/athlevo-plan` | `/athlevo-guided` | `/athlevo-coaching` | `/athlevo-vip-coaching` |
| Server switch | `PLAN_SIGNUP_ENABLED` | `GUIDED_SIGNUP_ENABLED` | `COACHING_SIGNUP_ENABLED` | `VIP_SIGNUP_ENABLED` |
| Where the buyer goes after paying | `https://athlevo.org/signup` (a constant in `lib/server/planSignup.js`; no questionnaire) | the questionnaire: `GUIDED_QUESTIONNAIRE_URL`, or `PLAN_QUESTIONNAIRE_URL` when not set | the questionnaire: `COACHING_QUESTIONNAIRE_URL`, or `PLAN_QUESTIONNAIRE_URL` when not set | the questionnaire: `VIP_QUESTIONNAIRE_URL`, or `PLAN_QUESTIONNAIRE_URL` when not set |
| Call-scheduling link (optional) | none: the Plan has no call | `GUIDED_SCHEDULE_URL`, or `PLAN_SCHEDULE_URL` when not set | `COACHING_SCHEDULE_URL` | `VIP_SCHEDULE_URL` |
| Agreement link (optional) | `PLAN_AGREEMENT_URL` | `GUIDED_AGREEMENT_URL`, or `PLAN_AGREEMENT_URL` when not set | `COACHING_AGREEMENT_URL` | `VIP_AGREEMENT_URL` |
| Page switch | `signUp.open` on the Plan in `js/storeCatalog.js` | `signUp.open` on the Guided entry | `signUp.open` on the Coaching entry | `signUp.open` on the VIP entry |
| API paths | `/api/plan-signup/checkout`, `/status` | `/api/guided-signup/checkout`, `/status` | `/api/coaching-signup/checkout`, `/status` | `/api/vip-signup/checkout`, `/status` |
| Reference on PayMongo | `ATH-TP-...` | `ATH-PL-...` | `ATH-CO-...` | `ATH-EL-...` |
| `product_id` in `plan_signups` | `ATHLEVO_TRAINING_PLAN` | `ATHLEVO_PLAN_MONTHLY` | `ATHLEVO_COACHING_MONTHLY` | `ATHLEVO_ELITE_MONTHLY` |

**Why Guided and VIP keep the old ids.** Guided is the old Athlevo Plan renamed and re-priced, and VIP Coaching is Elite Coaching
renamed, so they keep `ATHLEVO_PLAN_MONTHLY` / `ATH-PL` and `ATHLEVO_ELITE_MONTHLY` / `ATH-EL`. That way every payment already
recorded, every partner code made for "the Plan", and every confirmation link a buyer saved still belong to the right offer,
with nothing to migrate. The new ₱999 Athlevo Plan has ids of its own. A confirmation link that names the wrong page (for
example a saved `/athlevo-plan?payment=success&ref=ATH-PL-...`) opens under the offer its reference belongs to.

**VIP Coaching is locked for now (2026-10-31).** In `js/storeCatalog.js` its `signUp.open` is `false`, so its page and the in-app
Programs screen show it as not open, and the banner and FAQ leave it out. Keep `VIP_SIGNUP_ENABLED` at `false` (or unset) on the
server until it reopens, so the checkout endpoint refuses it too. To reopen: set `open` to `true`, run
`node scripts/build-store-pages.mjs`, then set `VIP_SIGNUP_ENABLED=true`, `VIP_SCHEDULE_URL` and `VIP_AGREEMENT_URL` and deploy.

**Switching over from the old lineup.** Guided is a new switch, so it stays closed on the server until `GUIDED_SIGNUP_ENABLED=true`
is set; the existing `PLAN_SIGNUP_ENABLED=true` now opens the ₱999 Plan. VIP Coaching reads `VIP_*` (Elite read `ELITE_*`, so rename
any `ELITE_*` variable you had set). Guided falls back to the matching `PLAN_*` questionnaire, scheduling and agreement links, so what
you already set up for the old Plan keeps working for it. Deploy when no checkout is open: a checkout started at ₱1,998 and paid after
the deploy is rejected by the webhook (see "Changing a price" below).

**Settings to change in Vercel (Production) before the single deploy.** Environment variables only apply to a new deploy, so
set these first and then deploy once:

| Setting | Why |
|---|---|
| `GUIDED_SIGNUP_ENABLED=true` | Guided is a new switch. Until it is set, the Guided page shows Sign Up but the server answers "Sign-up is not open yet." |
| `VIP_SIGNUP_ENABLED` | Leave at `false` while VIP Coaching is locked (see above). Set it to `true` only when it reopens. `ELITE_SIGNUP_ENABLED` is no longer read. |
| `VIP_SCHEDULE_URL`, `VIP_AGREEMENT_URL` | Needed when VIP reopens. Production had no `ELITE_*` values to copy (checked 2026-10-31), so these need the real links. VIP has no fallback for these two, so without them every VIP buyer's confirmation page and email arrive with no scheduling link and no agreement. |
| `GUIDED_AGREEMENT_URL` (optional) | Guided and the ₱999 Plan both fall back to `PLAN_AGREEMENT_URL`. Set Guided's own if the two should show different documents. |
| `PLAN_SIGNUP_ENABLED` | Already `true`? Then the **₱999 Plan opens the moment you deploy**, and any link or ad that still points at `/athlevo-plan` sells the ₱999 Plan instead of the old ₱1,998 one. Point those at `/athlevo-guided`, or set this to `false` until you want the Plan on sale. |

If a switch is missing, the server log says which one (`checkout refused: Athlevo VIP Coaching is closed on the server (needs
VIP_SIGNUP_ENABLED=true ...)`), and it says so when old `ELITE_*` settings are still present.

All offers write to the same table, `plan_signups`; the `product_id` column says which one.

## The flow

1. Visitor taps **Sign Up**. The page asks our API for a PayMongo hosted checkout and sends them there.
   The browser sends no price or product; the server owns both, and which offer it is comes from the
   endpoint that was called.
2. They pay on PayMongo (QRPh, Maya or GrabPay, whatever `PAYMONGO_PAYMENT_METHODS` allows).
3. PayMongo sends the signed webhook (`checkout_session.payment.paid`) to `/api/paymongo/webhook`.
   If it is a payment for one of the four offers, one row is written to `plan_signups`.
4. When a payment is newly recorded, two emails go out (if you set them up, see step 3 under "Turn it on"): the
   buyer's next steps (reference, the app sign-up link for the Plan or the questionnaire link for the others,
   scheduling link, agreement link if set, and a link back to the confirmation page) and an alert to you. A redelivered
   event never sends them again.
5. PayMongo returns the visitor to the offer's page with `?payment=success&ref=...`. That page asks the
   offer's status endpoint whether the webhook has recorded the payment. Only once it has, the page sends the buyer
   straight on (`redirect_url` in the status answer): the Plan to `https://athlevo.org/signup`, Guided, Coaching and VIP to
   their questionnaire. A "Continue" button stays on the page in case the browser blocks the redirect. Being redirected
   back from PayMongo proves nothing by itself, so nobody is sent on before the webhook has recorded the payment.

All four offers are month to month with no automatic renewal. Month two is another checkout. The Athlevo Plan works like the
others (each payment covers 30 days and its row carries a `paid_through` date), but it has no call step: after the questionnaire
the buyer's email and confirmation page say a coach builds the plan.

## Turn it on (in this order; repeat steps 2, 4 and 5 for each offer)

1. **Database (once).** Run `migrations/2026-10-15_plan_signups.sql` in the Supabase SQL editor. It serves all four offers.
2. **Vercel environment variables** (Settings, Environment Variables). The PayMongo ones already exist for Athlevo Pro.
   - Questionnaire link, https, required. Current form:
     `https://docs.google.com/forms/d/e/1FAIpQLScnKgZvr86oITPSNEGEjSZTULQeIufXPUdiCIgO_AhqkUJFfg/viewform?usp=header`
     The Plan does not use it (its buyers go to the Athlevo app sign-up). Guided, Coaching and VIP Coaching send buyers to it:
     set `GUIDED_QUESTIONNAIRE_URL`, `COACHING_QUESTIONNAIRE_URL` and `VIP_QUESTIONNAIRE_URL` (set in Production on 2026-10-31
     to the form's plain `/viewform` link), or leave them unset and they use `PLAN_QUESTIONNAIRE_URL`. It must be a valid
     https link, or that offer stays closed.
   - Scheduling link (optional): `GUIDED_SCHEDULE_URL`, `COACHING_SCHEDULE_URL` and/or `VIP_SCHEDULE_URL`. Without one, the
     page only says they will be asked to schedule a call. Only Guided borrows another's (it uses `PLAN_SCHEDULE_URL` when
     `GUIDED_SCHEDULE_URL` is not set, because it is the old Plan); Coaching and VIP do not. The Athlevo Plan has no call.
   - Agreement link (optional): `PLAN_AGREEMENT_URL`, `GUIDED_AGREEMENT_URL`, `COACHING_AGREEMENT_URL` and/or
     `VIP_AGREEMENT_URL`, an https link to the agreement. When set, it appears on the confirmation page and in the buyer's
     email. Guided uses `PLAN_AGREEMENT_URL` when its own is not set; Coaching and VIP do not borrow.
   - The switch: `PLAN_SIGNUP_ENABLED=true`, `GUIDED_SIGNUP_ENABLED=true`, `COACHING_SIGNUP_ENABLED=true` and/or
     `VIP_SIGNUP_ENABLED=true`. An offer stays closed on the server unless its own switch is `true` AND a questionnaire link
     is valid. A switch is never inherited.
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
   yourself with the live keys (₱999, ₱2,997, ₱4,998 or ₱7,998) and refund it in the PayMongo dashboard (refunds mark the row
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
- No monthly reminder (deferred until the site is live). `paid_through` is there for it, and all four pages promise one.
- No renewal link. Month two is another Sign Up checkout.
- Nothing yet checks that a buyer's questionnaire or call happened; the confirmation page only shows the links.

## Partner discount codes (one unique code per runner)

For groups whose members get a discount (for example the runners of an event). Each runner gets **their own code**; it takes a
fixed percentage off **every** payment that runner makes with it, renewals included (month two is another Sign Up, and the
runner types the same code again; the welcome email reminds them). Nothing on the public site names a partner. Which
batch a code belongs to is an internal label that only you see (in the database and in your sign-up alert).

**How it works.** The Guided and Coaching pages have a small "Have a discount code?" link under each Sign Up button. The Plan and
VIP Coaching pages have none (see "Which offers a code works on" below).
A runner types the code (or opens a link ending in `?code=ABCD-EFGH`, which fills it in and applies it) and sees the new
price before paying. The browser only ever sends the code text. The server looks the code up in `partner_codes`, works out
the price itself, opens the PayMongo checkout at that price, and tags the checkout with the code. The webhook then accepts
the payment only if it is exactly that discounted price. A code that is unknown, switched off, expired, not for that offer
or malformed all give the same answer ("That code isn't valid"), and an invalid code never silently becomes a full-price
checkout. Checking codes is rate limited (30 an hour per visitor), and codes are 8 characters from a 31-character
alphabet, so they cannot be guessed.

**Set up (once).** Run `migrations/2026-10-21_partner_codes.sql` in the Supabase SQL editor, before you give anyone a code.
It adds the `partner_codes` table and a few columns on `plan_signups`, and is safe to run twice.

**Which offers a code works on.** A code with no product list works on Guided and Coaching only (Guided is the offer that used to be
the Plan, so codes made before the rename keep working on it, at Guided's higher price: a 10% code now takes ₱299.70 off ₱2,997,
not ₱199.80 off ₱1,998. If an agreement with a partner was written against the old price, check it still says what you mean). The ₱999 Athlevo Plan and VIP Coaching take a code only when that
code's row names them in `product_ids` (make the batch with `--products training-plan`, `--products vip`, or a list such as
`guided,coaching,vip`, below), so opening a new offer never quietly gives it a discount. The Plan and VIP pages have no code box
today, so the site cannot take a code for either until that is switched on in the page code (`takesCodes` on that entry in
`js/storeCatalog.js`). A checkout with a code that does not cover the offer is refused ("That code isn't valid"), never charged
full price.

**Make a batch of codes.**

```
node scripts/generate-partner-codes.mjs --partner race-2026-11-24 --count 100
```

Options: `--percent 10` (default 10, up to 50), `--products guided,coaching` (any of `training-plan`, `guided`, `coaching`, `vip`, comma
separated; default Guided and Coaching, which is also what naming exactly those two means. `plan` is refused on purpose: it used
to mean the ₱1,998 offer, which is now `guided`, and the ₱999 Athlevo Plan is `training-plan`. The old name `elite` still works and
means `vip`), `--expires 2026-12-31`
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

- **Changing a price.** The price lives in `lib/server/planSignup.js` and in `js/storeCatalog.js` (a test fails if they differ). Change both together, and only when no
  checkout is open: a payment made at the old price is rejected by the webhook (it answers 400 and nothing is recorded). The
  server logs `payment NOT recorded (wrong_amount)` with the reference and payment id, and emails `SIGNUP_ALERT_EMAIL` "Payment
  received but NOT recorded". If that happens, find the payment in the PayMongo dashboard and record or refund it by hand.
  PayMongo retries a failed delivery up to 12 times over about 2 hours and then stops; it does not resend missed events, and
  if three events in a row use up all their retries it disables the webhook until someone re-enables it in the PayMongo
  dashboard. So after any price change, check PayMongo's webhook page and compare its payments with `plan_signups`.
- **Rows under `ATHLEVO_PLAN_MONTHLY` mix two prices.** Payments before the switch-over are ₱1,998 (the old Plan), payments after
  are ₱2,997 (Guided). Tell them apart by `amount_cents` or `paid_at`.
- **The questionnaire link.** Guided, Coaching and VIP Coaching use their own `*_QUESTIONNAIRE_URL` (set in Production on
  2026-10-31), falling back to `PLAN_QUESTIONNAIRE_URL`, which the Plan itself no longer uses.
- **Redirect after payment.** The confirmation page sends the buyer on immediately, so for Guided, Coaching and VIP the scheduling
  and agreement links reach the buyer by email (and through the form's own end screen), not on a page they linger on.
- **A refund that arrives before its payment was recorded** (only possible if recording failed and PayMongo is still retrying; it stops after about 2 hours)
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

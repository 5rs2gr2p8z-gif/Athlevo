# Store sign-up: Athlevo Plan and Athlevo Coaching (public /programs)

Lets a visitor pay for **Athlevo Plan** (₱1,998 per month) on `/programs/athlevo-plan` or **Athlevo Coaching**
(₱4,998 per month) on `/programs/athlevo-coaching` without an Athlevo app account. Each offer is **off** until you
turn it on, and you can open one without the other.

| | Athlevo Plan | Athlevo Coaching |
|---|---|---|
| Price (owned by the server) | ₱1,998 | ₱4,998 |
| Page | `/programs/athlevo-plan` | `/programs/athlevo-coaching` |
| Server switch | `PLAN_SIGNUP_ENABLED` | `COACHING_SIGNUP_ENABLED` |
| Questionnaire link | `PLAN_QUESTIONNAIRE_URL` | `COACHING_QUESTIONNAIRE_URL`, or the Plan's when not set |
| Call-scheduling link (optional) | `PLAN_SCHEDULE_URL` | `COACHING_SCHEDULE_URL` |
| Agreement link (optional) | `PLAN_AGREEMENT_URL` | `COACHING_AGREEMENT_URL` |
| Page switch | `signUp.open` on the Plan in `js/storeCatalog.js` | `signUp.open` on the Coaching entry |
| API paths | `/api/plan-signup/checkout`, `/status` | `/api/coaching-signup/checkout`, `/status` |
| Reference on PayMongo | `ATH-PL-...` | `ATH-CO-...` |

Both offers write to the same table, `plan_signups`; the `product_id` column says which one
(`ATHLEVO_PLAN_MONTHLY` or `ATHLEVO_COACHING_MONTHLY`).

## The flow

1. Visitor taps **Sign Up**. The page asks our API for a PayMongo hosted checkout and sends them there.
   The browser sends no price or product; the server owns both, and which offer it is comes from the
   endpoint that was called.
2. They pay on PayMongo (QRPh, Maya or GrabPay, whatever `PAYMONGO_PAYMENT_METHODS` allows).
3. PayMongo sends the signed webhook (`checkout_session.payment.paid`) to `/api/paymongo/webhook`.
   If it is a Plan or Coaching payment, one row is written to `plan_signups`.
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
     Set `PLAN_QUESTIONNAIRE_URL`. Coaching uses the same link unless you also set `COACHING_QUESTIONNAIRE_URL`
     (if you set that one it must be a valid https link, or Coaching stays closed).
   - Scheduling link (optional): `PLAN_SCHEDULE_URL` and/or `COACHING_SCHEDULE_URL`. Without one, the page only says
     they will be asked to schedule a call. Coaching does not borrow the Plan's scheduling link.
   - Agreement link (optional): `PLAN_AGREEMENT_URL` and/or `COACHING_AGREEMENT_URL`, an https link to the agreement.
     When set, it appears on the confirmation page and in the buyer's email. Neither offer borrows the other's.
   - The switch: `PLAN_SIGNUP_ENABLED=true` and/or `COACHING_SIGNUP_ENABLED=true`. An offer stays closed on the
     server unless its switch is `true` AND a questionnaire link is valid.
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
   deployment (with a test-mode webhook pointed at that preview), or pay once yourself (₱1,998 or ₱4,998) and refund it
   in the PayMongo dashboard (refunds mark the row `refunded`). Check that a `plan_signups` row appears with the right
   `product_id` and that the confirmation page shows your links.
5. **Open it to the public.** In `js/storeCatalog.js` set that offer's `signUp.open` to `true`, then run
   `npm run build:store` and `node tests/store-route.test.mjs`. The build rewrites the banner (it names whichever
   offers are open), the FAQ answer and the static pages, so nothing is edited by hand. Deploy.

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
- Emails go out only for a newly recorded payment, from the signature-verified webhook, never from the browser. They
  never fail or roll back the payment, give up after a few seconds, and carry a Resend idempotency key per email.
- Everything PayMongo supplied (name, phone) is escaped in the HTML and stripped of line breaks in subjects, and the
  buyer's email goes only to one validated address. Links in the emails come only from your environment variables.

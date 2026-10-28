# Webinar pages (/webinar and /webinar/thank-you)

A landing page and a thank-you page for the free online session for runners at Ignite the Grit Run
(November 22, 2026, with JCIR Events Management). The only conversion is the registration form.

Live at `https://programs.athlevo.org/webinar/` (the same paths on athlevo.org redirect there).

## What is where

| File | What it is |
| --- | --- |
| `content/webinar.mjs` | All the wording, the date and time, and the form's choices. **The one file to edit.** |
| `scripts/build-webinar-pages.mjs` | The markup. Writes the two HTML pages from the content file. |
| `webinar.html`, `webinar-thank-you.html` | Generated. Do not edit by hand; the next build overwrites them. |
| `webinar.css` | The few layout rules the storefront did not have (form, three cards, two columns). Uses only `store.css` tokens. |
| `js/webinar.js` | Quick field checks, submit, redirect to the thank-you page. Holds no wording. |
| `lib/server/webinarRegistration.js` | `POST /api/webinar/register`: honeypot, rate limit, validation, save, alert email. |
| `migrations/2026-10-27_webinar_registrations.sql` | The table registrations are saved in. |
| `tests/webinar-pages.test.mjs`, `tests/webinar-registration.test.mjs` | Checks for the pages and the endpoint. |

The look is the storefront's: `store.css` first, then `webinar.css`. The hero uses the same stretching
photo as /programs and the coach section uses the same photo of Dean.

## Set the date and time

Open `content/webinar.mjs` and change the two lines under **EDIT THE DATE AND TIME HERE**:

```js
export const SESSION = {
  date: "To be announced",
  time: "To be announced"
};
```

Then rebuild and push:

```
node scripts/build-webinar-pages.mjs
```

The date and time show in the details block on both pages. Until you change them both read
"To be announced". `npm run test:webinar` fails if the HTML pages and the content file disagree, so a
forgotten rebuild is caught before it ships.

## One-time setup

1. **Create the table.** In Supabase, open the SQL editor and run
   `migrations/2026-10-27_webinar_registrations.sql`. It is safe to run twice. Registrations are
   readable only in the Supabase table editor (no browser can read or change them).
2. **Check the alert email settings in Vercel.** The endpoint reuses the paid sign-up settings:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `SIGNUP_ALERT_EMAIL`
   (and `SIGNUP_FROM_EMAIL` if you set one). To send webinar alerts to a different address, add
   `WEBINAR_ALERT_EMAIL` (one address, or up to five separated by commas).
3. **Paste the Meta Pixel** (below).

## What happens when someone registers

1. Honeypot: a hidden field (`contact_website`) that people never see. If it has anything in it the
   sender is a bot. It gets a normal-looking "ok" and nothing is saved or emailed.
2. Rate limit: 20 registrations per hour per visitor (`webinar-register` in `lib/server/rateLimit.js`).
3. Validation on the server: name (2+ characters), mobile (7 to 15 digits, optional leading +),
   email (optional, must be valid if given), distance and training (one of the listed choices).
4. The registration is saved to `webinar_registrations` **and** you are emailed, at the same time.
   The runner sees "registered" if **either** one worked, so a missing setting never loses a lead.
   If both fail the runner sees the "Something went wrong" message and the log says
   `registration lost` (with no personal details in it).

With JavaScript off the form still works: it posts normally and the server redirects to the thank-you
page.

Each row has `status` (default `new`) and `notes` columns for your own follow-up ("contacted",
"attended"). Nothing in the code reads them.

## Meta Pixel

Both pages have a clearly marked spot near the top of `<head>`:

```html
<!-- ======================= META PIXEL ======================= ... -->
<!-- /META PIXEL -->
```

Paste the Pixel's base code (the `<script>` block and the `<noscript>` line from Events Manager) into that
spot in `webinar.html` **and** in `webinar-thank-you.html`, between the instruction comment and the closing
`<!-- /META PIXEL -->` line. This is the one place in the generated pages you may edit by hand: a rebuild
(for example after you set the date) keeps whatever is between those two markers. Keep the
`fbq('track', 'PageView')` line from Events Manager in; leave out any `Lead` line, because the thank-you
page sends it.

The **Lead** event fires on `/webinar/thank-you` after the Pixel has loaded. It does nothing until the
Pixel is installed. It fires once per browser session, so refreshing the thank-you page does not count
the same person twice.

## Changing the form's choices

Edit `DISTANCES` or `TRAINING` in `content/webinar.mjs` **and** the matching lists at the top of
`js/webinar.js`. The server reads the content file, so it accepts the new choice straight away. The
database does not restrict the values, so a new choice never makes a registration fail.
`npm run test:webinar` fails if the page, the script and the server disagree.

## Routing

`vercel.json`:

- `/webinar`, `/webinar/`, `/webinar/thank-you`, `/webinar/thank-you/` rewrite to the two HTML files.
- `/api/webinar/register` rewrites to the existing API gateway (`/api/providers?action=webinar_register`).
  The Vercel plan is at its function limit, so the endpoint lives inside the gateway instead of its own file.
- On `athlevo.org`, `/webinar` and everything under it redirects (temporary, query string kept) to
  `programs.athlevo.org`, where the canonical page lives.
- The programs site sends unknown paths back to athlevo.org; `webinar` and `webinar.css` are on its
  allow list so the pages and their stylesheet load.

`scripts/serve-web.mjs` (the local preview) serves the same routes.

## Tests

```
npm run build:webinar     rebuild the two pages
npm run test:webinar      pages + registration endpoint
```

The page test repeats the supplied copy word for word (the lines marked CONTRACT). If you change that
wording on purpose, change `content/webinar.mjs`, rebuild, and update the matching line in
`tests/webinar-pages.test.mjs`.

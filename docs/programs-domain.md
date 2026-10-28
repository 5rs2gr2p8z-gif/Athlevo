# programs.athlevo.org

The public program pages (the hub and the four offers) are served from their own host,
`programs.athlevo.org`; `athlevo.org` redirects the old addresses there. The app, its sign-in, the legal pages and the PayMongo webhook stay on
`athlevo.org`. It is one Vercel project and one deployment; the host in the request decides what answers.

## Addresses

| What | On programs.athlevo.org | Notes |
|---|---|---|
| Hub | `/programs` (`/` redirects there) | Vercel serves real files before it applies rewrites, and the app's `index.html` owns `/`, so the bare host cannot show the hub by itself. |
| Athlevo Plan | `/athlevo-plan` | The same four paths are the short links to send to clients. |
| Athlevo Coaching | `/athlevo-coaching` | |
| Hybrid Programming | `/hybrid-programming` | |
| Elite Coaching | `/elite-coaching` | |
| Anything else | redirected (307) to the same path on `athlevo.org` | Only program pages, `/api/`, `/assets/`, `/athlevo-assets/`, `/js/`, `/store.css`, `robots.txt` and the sitemaps are served here. |

`/programs/<slug>` on the new host redirects (308) to `/<slug>`. Query strings, including `?code=`, are kept.
On every other host (athlevo.org, previews, local) an offer is still `/programs/<slug>`; `js/storefront.js`
chooses by `location.hostname` (`FLAT`), and the build script does the same from `SITE_URL`.

The rules are in `vercel.json` (every host-only rule is keyed on exactly `programs.athlevo.org`) and are
mirrored by `scripts/serve-web.mjs` for local preview. `tests/store-route.test.mjs` (section 11) runs one
table of requests through both and fails if they disagree, and checks that everything the store pages load
or link to still works from the new host.

## Rollout

**Step 1: routing only (nothing changes for visitors).** Deploy the rules. Canonical tags, the sitemap, the
checkout return links and the athlevo.org addresses are all unchanged; the new host is just a second way in.

1. Merge and deploy.
2. Vercel project, Settings, Domains: add `programs.athlevo.org`.
3. At the DNS provider (Name.com): add the record Vercel shows (a `CNAME` named `programs`).
4. Check on the new host: `/` ends at `/programs`; each of `/athlevo-plan`, `/athlevo-coaching`,
   `/hybrid-programming`, `/elite-coaching` opens; `/athlevo-plan?code=XXXX` keeps the code;
   `/privacy` lands on `https://athlevo.org/privacy`.

**Step 2: switch over (done).** What now points at the new host, all in one commit:

- `SITE_URL` in `js/storeCatalog.js` is `https://programs.athlevo.org` (`APP_URL`, `https://athlevo.org`, is kept for
  the one thing that is not a program page: the Organization in the JSON-LD). `npm run build:store` writes the
  canonicals, `og:url`, JSON-LD and the offer links from it, and two sitemaps: `sitemap.xml` (the home page, on
  athlevo.org) and `sitemap-programs.xml` (the hub and the four offers, on programs.athlevo.org). `robots.txt`
  names both. The store footer's Privacy, Terms and Support links are absolute `https://athlevo.org/...` links.
- `PLAN_PAGE_PATH`, `COACHING_PAGE_PATH` and `ELITE_PAGE_PATH` in `lib/server/planSignup.js` are `/<slug>`, and the
  default of `planSiteUrl()` is `https://programs.athlevo.org`, so PayMongo returns the buyer, and the emails link,
  to `programs.athlevo.org`. A Vercel preview deployment still returns to itself (its short links reach the page).
  `PLAN_SIGNUP_SITE_URL` is not set in Vercel; if it ever is, it overrides this.
- On `athlevo.org`, `/programs`, `/programs/<slug>`, `/programs/<anything else>` and the four short links redirect (307,
  one hop, query kept) to the same page on `programs.athlevo.org`. The legacy `/store...` paths take their old first
  hop to `/programs...`, then these. A checkout started before the switch returns to the old address and lands
  in the right place through the same redirect. Other hosts (previews, local) are unchanged.
  Every one of these rules is keyed on `athlevo.org` and excludes `programs.athlevo.org`, so they can never loop.

**Make the redirects permanent later.** They are temporary (307) so the move is easy to undo. Once it has run
for a while, change `"permanent": false` to `true` on the ten rules in `vercel.json` that have `"value": "athlevo.org"`
(browsers remember a 308 for a long time, which is why this is a separate, later step).

**Rollback.** Revert the Step 2 commit. Nothing else changes: the new host keeps working, the old addresses serve the
pages again, and checkouts return to `athlevo.org/programs/<slug>`. If `PLAN_SIGNUP_SITE_URL` was ever set, put it back.

## Why the redirect for everything else

Without it the new host would answer for the whole app, a second copy of `athlevo.org` for search engines
and for anyone who guesses a path. The rule is an allow-list written as a negative look-ahead; the test checks
every link, file and API call on the store pages against it, so a new asset folder fails the test, not a visitor.

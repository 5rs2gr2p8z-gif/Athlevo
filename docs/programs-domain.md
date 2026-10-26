# programs.athlevo.org

The public program pages (the hub and the four offers) are also served from their own host,
`programs.athlevo.org`. The app, its sign-in, the legal pages and the PayMongo webhook stay on
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

**Step 2: switch over.** Change what points at the new host, in one commit:

- `SITE_URL` in `js/storeCatalog.js` becomes `https://programs.athlevo.org`, then `npm run build:store`
  (canonicals, `og:url`, JSON-LD and the offer links in the built pages follow).
- `PLAN_PAGE_PATH`, `COACHING_PAGE_PATH`, `ELITE_PAGE_PATH` in `lib/server/planSignup.js` become `/<slug>` and
  the default of `planSiteUrl()` becomes the new host, so PayMongo returns the buyer, and the emails link,
  to `programs.athlevo.org`. If `PLAN_SIGNUP_SITE_URL` is set in Vercel it must be changed too.
- On `athlevo.org`, `/programs`, `/programs/:slug`, `/store...` and the short links redirect to the new host.

**Rollback.** Revert the step 2 commit (and `PLAN_SIGNUP_SITE_URL` if it was changed). Step 1 can stay.

## Why the redirect for everything else

Without it the new host would answer for the whole app, a second copy of `athlevo.org` for search engines
and for anyone who guesses a path. The rule is an allow-list written as a negative look-ahead; the test checks
every link, file and API call on the store pages against it, so a new asset folder fails the test, not a visitor.

# method.athlevo.org (the Athlevo Method lessons)

Public lessons from the Athlevo Method, written so a runner who searches for coaching, training zones, heat
running or threshold training can find them. The pages are plain static HTML with no JavaScript. They are served
from their own host, `method.athlevo.org`, by the same Vercel project and deployment as the app and the program
pages (one project, one deployment; the host in the request decides what answers).

What the site can and cannot do: it makes each lesson eligible to be found, with one clear topic per page, a
title and description written for the search result, structured data, internal links and a sitemap. It does not
decide the ranking, and nothing here can promise that every runner who searches for coaching will see it. Ranking
depends on how useful the pages are, who links to them, how much competition there is and time. Measure it with
Search Console (see Rollout).

## Addresses

| What | On method.athlevo.org | Notes |
|---|---|---|
| Hub | `/lessons` (`/` redirects there, 308) | Vercel serves real files before it applies rewrites, and the app's `index.html` owns `/`, so the bare host cannot show the hub by itself. The 308 is permanent on purpose: the hub is the front page of this host. |
| Lessons | `/lessons/<slug>` (eleven) | `training-zones`, `training-week`, `training-block-phases`, `total-cost-training-load`, `running-in-the-heat`, `conversion-run`, `threshold-training`, `pace-ladder`, `hill-sprints-speed-reserve`, `athlete-assessment`, `coaching-rules`. A trailing slash works. |
| Files | `/method.css`, `/assets/...`, `/athlevo-assets/...`, `/robots.txt`, `/sitemap-method.xml`, `/favicon.ico` | Served here. |
| Anything else | redirected (307) to the same path on `athlevo.org` | The app, the programs, the Sub-1 10k Challenge and the legal pages stay where they are. |

On `athlevo.org`, `/lessons` and `/lessons/<slug>` redirect (307, one hop, query kept) to the method host. On every
other host (a Vercel preview, local) the lessons are served at `/lessons`, so they can be reviewed before the domain
exists. The lesson rewrites carry no host condition for that reason.

The rules are in `vercel.json` and are mirrored by `scripts/serve-web.mjs` for local preview.
`tests/method-site.test.mjs` runs one table of requests through `vercel.json` and through the preview server and
fails if they disagree. `tests/store-route.test.mjs` (section 11) still checks the other two hosts.

## Where the content lives

- `content/method.mjs` is the only place the words are written: the site facts, the hub (groups, ideas, FAQ,
  call to action) and the eleven lessons (title, H1, description, lead, "In short" points, body blocks, related
  lessons, a note on what is Athlevo's own design, sources).
- `scripts/build-method-pages.mjs` turns it into `method-pages/lessons.html`, `method-pages/lessons/<slug>.html` and
  `sitemap-method.xml`. These generated files are committed, because the Vercel project has no build command.
- `method.css` is hand-written (Barlow Condensed bold for headlines, Inter for text, black, white and the one red).

To change a lesson: edit `content/method.mjs`, then

```
npm run build:method      # writes the files
npm run test:method       # checks them
```

`node scripts/build-method-pages.mjs --check` fails if the committed files are out of date. When a lesson changes in
substance, update `SITE.updated` (it feeds the visible date, `dateModified`, and the sitemap `lastmod`). Do not
change it for a typo.

## SEO design

- One topic per page, one H1, a title of 65 characters or fewer and a description of 160 or fewer, all different.
  The title uses the words a runner searches for ("running training zones", "running in the heat"); the H1 can be
  more natural.
- Canonical on the method host, Open Graph and Twitter tags, `robots` meta that allows indexing and rich snippets.
- JSON-LD: Organization and Person (the same ids the program pages use, so the entities tie together), WebSite and
  CollectionPage with an ItemList on the hub, Article and BreadcrumbList on each lesson. There is no FAQ, review,
  rating or price markup, and nothing in the markup is missing from the visible page.
- Each lesson has a short answer ("In short"), a table of contents when it has three or more sections, a byline
  with the date, previous and next lessons, related lessons, a sources list and the same footer list of all eleven
  lessons, so every page links to every other one and none is an orphan.
- The sitemap lists the hub and the eleven lessons with `lastmod`. `robots.txt` (shared by all hosts) names all three
  sitemaps, as it already did for the programs host.
- The pages ship no JavaScript and one stylesheet, so they are fast to load and nothing waits on a script to render.

## Rollout

**Step 1: deploy.** Merge. The lessons already work at `<preview>/lessons`. Nothing changes for visitors of
`athlevo.org` or `programs.athlevo.org`, apart from `/lessons` on `athlevo.org` now redirecting to the new host
once it exists.

**Step 2: add the domain (needs you).**

1. Vercel project, Settings, Domains: add `method.athlevo.org`.
2. At the DNS provider (Name.com): add the record Vercel shows (a `CNAME` named `method`).
3. Check on the new host: `/` ends at `/lessons`; each lesson opens; `/privacy` lands on `https://athlevo.org/privacy`;
   `https://athlevo.org/lessons/training-zones` lands on the method host.

**Step 3: tell the search engines (needs you).**

1. Google Search Console: add `athlevo.org` as a Domain property, verified with a DNS TXT record. It covers every
   subdomain, so it covers this host. (Do not use the HTML-file method: unknown paths on this host redirect to
   `athlevo.org`, so a verification file would not be found.) If a Domain property for `athlevo.org` already exists,
   this host is already in it.
2. Submit `https://method.athlevo.org/sitemap-method.xml` under Sitemaps.
3. Bing Webmaster Tools: add the site (it can import from Search Console) and submit the same sitemap.
4. Use the URL Inspection tool on the hub and one lesson to ask for indexing. Then wait: new pages usually take
   days to weeks to appear, and longer to settle in the ranking.
5. After a month, read the Performance report for the queries and pages that are shown. It shows what runners
   actually search for, which is better evidence for the next lessons than any guess here. This session could not
   look up search volumes, so none are claimed anywhere.

**What helps ranking and is not code:** links from places runners already read (the program pages, the webinar, the
Sub-1 10k Challenge page, Instagram bio, race and club pages), and more lessons that answer real questions.
The programs host and the Challenge page can link to the hub; that was not changed here.

## Research and claims

The lessons are written from the course material plus sources that were read and checked while writing. What the
lessons say about research is limited to what those pages said, and each lesson lists its sources. Where the course
and the research disagreed, or a source could not be read, the claim was left out or softened:

- **Left out of the public lessons:** the 12-week sample block, communication details beyond three short examples
  of how a coach explains a decision, the ASR reference ranges, the claim about hill impact on running economy
  (the source could not be read), and Athlevo's own taper percentage.
- **Taper:** the lesson states the range from the 2023 PLoS One meta-analysis (volume cut by 41 to 60% over 21
  days or less). The course gives a different number. Decide which number Athlevo teaches before either is
  published as Athlevo's.
- **Heat training and VO2max:** stated as one 2010 trial of trained cyclists, with the caveat from the review that
  later work does not agree.
- **Norwegian model, funnel periodization:** described as usually reported, with sources, and marked as not
  Athlevo's own. The biographical detail about named coaches could not be confirmed from a primary source and is
  not stated as fact.
- **Athlevo's own design** (zone names and ranges, the 30°C and 65% humidity rule, the five capacity levels, the
  sessions) is marked as Athlevo's own on each lesson, so it is not presented as research.

## Decisions for you

- **Public or gated.** All eleven lessons are public, because gated pages cannot rank. The 12-week sample block is
  the obvious thing to offer in exchange for an email, but that needs a form and a handler, which this static site
  deliberately does not have (the project is at the 12-function limit of the Vercel Hobby plan).
- **Open Graph image.** None exists, so shares show a text card (`twitter:card` is `summary`). Add a 1200 by 630
  image and an `og:image` tag when there is one.
- **Analytics and the Meta Pixel.** Neither is on the method pages, so visits there are not counted by the
  tools used on the app. Search Console gives search data without adding any script.
- **Privacy policy.** Unchanged. The method pages set no cookies and collect nothing, apart from the Google Fonts
  request every Athlevo page already makes.
- **Preview protection.** If Vercel Deployment Protection is on for previews, the preview lessons ask for a login.
  That is a Vercel setting and was not checked.
- **The `/` redirect is permanent (308).** Browsers remember it. If the host ever needs a different front page,
  change the rule and expect a delay for people who visited before.

## Never touched

No payments, sign-ups or API routes were added or changed, and `VIRTUAL_RUN_SIGNUP_ENABLED` is untouched. The
service worker has one changed token: `lessons` joined the paths it does not cache as the app shell (so a preview
visitor to `/lessons` does not overwrite the cached app).

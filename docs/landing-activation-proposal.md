# Proposal: make the marketing landing the public `/` (NOT applied)

Goal: `/` → marketing landing; `/ai` → app/Coach; `/privacy`, `/terms`, `/support` unchanged.

## Today
- `/` is served by `index.html`; `index.html` treats `""` like `/ai` (anonymous Coach entry).
- `/landing-preview` → `landing-preview.html` (noindex, preview bar, internal review notes, placeholders).
- `manifest.webmanifest`: `start_url "/?source=pwa"`, `scope "/"`.
- `service-worker.js` (`athlevo-shell-v88`) puts every OK navigation response into the cache as `/index.html`.
- Native (Capacitor) apps load their own bundled `dist/index.html`; Vercel routing does not affect them.

## Proposed vercel.json change
```json
{ "source": "/", "destination": "/landing.html" }
```
added to `rewrites` (after the existing ones; nothing else touched), where `landing.html` is a cleaned
copy of `landing-preview.html`. Keep `/landing-preview` until launch, then remove.

## Required before activation (blockers)
1. **Service worker:** a navigation to `/` returning `landing.html` would be cached as the offline
   `/index.html` shell, so the installed PWA/offline start would show marketing. Restrict that
   `cache.put("/index.html", …)` to app-shell routes (or skip `/`), and bump `CACHE_VERSION`.
   (The same latent issue already exists for `/landing-preview`.)
2. **PWA start_url:** change `"/?source=pwa"` → `"/ai?source=pwa"` (keep `"id": "/"` so installed
   identity does not change), otherwise installed users open the marketing page.
3. **Landing content cleanup** (`landing.html`): remove the preview bar, `noindex`, the
   `internal-review-notes` section, `[REVIEW PLACEHOLDER]` demo fields, `review-tag` chips, the
   "for review" integration note, and the inactive social link placeholder.
4. **Tests to update deliberately:** `landing-preview-route`, `landing-performance-identity`,
   `terms/privacy/support-public-route` (they hash `index.html` and assert preview constraints), and any
   test asserting `/` → Coach. `index.html` itself needs no change.
5. Signed-in web users hitting `/` will see marketing; if undesirable, add a tiny landing-side check
   (session present → `/ai`) — separate decision.
6. Decide the old in-app `/landing` route (unchanged by this proposal).

## Order at launch
APK uploaded + `npm run android:release-check` passes → apply blockers 1–4 → add the `/` rewrite → preview
deploy → check `/`, `/ai`, `/privacy`, `/terms`, `/support`, `/download/android`, installed-PWA start → promote.

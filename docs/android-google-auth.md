# Android Google sign-in — how it returns to the app

Native Android (Capacitor) flow, as implemented and covered by
`tests/android-google-auth-return.test.mjs`:

```
Sign in with Google (WebView)
  → supabase.auth.signInWithOAuth({ redirectTo: "athlevo://auth/callback", skipBrowserRedirect: true })   [PKCE]
  → Capacitor Browser opens the Supabase authorize URL in a Chrome Custom Tab
  → Google → Supabase /auth/v1/callback
  → Supabase 302 → athlevo://auth/callback?code=…          ← needs the redirect allow-list entry below
  → Android intent-filter (MainActivity, singleTask) resumes the installed app
  → App "appUrlOpen" → AthlevoRuntime.handleCallback → exchangeCodeForSession(code)
  → "athlevo:native-auth-complete" → restoreSession → routeAfterAuth (once per user)
```

Web is unchanged: `redirectTarget()` returns the page origin (`https://athlevo.org/…`), the client uses
the implicit flow, and the custom scheme is never sent from a browser.

## Release prerequisite (not in this repo)

Supabase only redirects to a URL that is on its allow-list; for any other `redirect_to` it **silently
falls back to the project Site URL** (`https://athlevo.org`). From the athlete's side that looks exactly
like "Google sign-in worked but I landed on the website in the browser".

Supabase Dashboard → Authentication → URL Configuration → **Redirect URLs** must contain, exactly:

```
athlevo://auth/callback
```

(no wildcard needed). `athlevo://provider/callback` is only for Strava/Intervals and is not used by Google
sign-in. Check this before every Android release; it cannot be verified from the codebase.

## Telling the two failure modes apart on a device

1. Deep link alone (no Google): with the app installed and signed out, run
   `adb shell am start -a android.intent.action.VIEW -d "athlevo://auth/callback?error=access_denied" org.athlevo.app`
   → Athlevo should open/resume and show "Sign-in cancelled." If it does, the manifest and `appUrlOpen` leg are fine.
2. Full flow: after Google, if the browser ends on `https://athlevo.org/?code=…`, Supabase rejected the
   redirect (allow-list / Site URL). If the browser stops on a blank/`athlevo://` page and nothing opens the
   app, the intent-filter or the installed build is at fault.

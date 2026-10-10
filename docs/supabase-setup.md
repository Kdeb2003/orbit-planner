# Supabase setup and authentication (Phase 3A)

ORBIT can sign users in with Supabase Auth (email + password). Without configuration it runs in **local-only mode** exactly as before.

> **Verified live (Phase 3A):** the migrations are deployed to the hosted project (`npx supabase db push`). Against the real Supabase API: the signed-in session is accepted by the Auth server; authenticated `SELECT` on `events`, `recurring_series` and `series_exceptions` returns HTTP 200 with 0 rows; anonymous `SELECT` on all three returns HTTP 401 / PostgreSQL `42501` (permission denied). The dashboard's “0 of 3 tables exposed” indicator does not block the grants-based access above. **Not yet verified on the hosted project:** cross-user isolation and insert/update/delete through the API (manual live procedure in [cloud-sync.md](cloud-sync.md)). No local calendar data has been uploaded or migrated.

> Sign-in (Phase 3A) is verified live. Cloud calendar read/write (Phase 3B) was also verified against the hosted project with temporary synthetic rows (since deleted); two-account isolation, session expiry, real outages and Realtime are not yet tested. See [cloud-sync.md](cloud-sync.md) for the verification status.

## 1. Configure the app

```bash
cp .env.example .env.local     # .env.local is git-ignored
```

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Project URL, `https://<ref>.supabase.co` (Dashboard → Project Settings → API) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The **publishable** key (`sb_publishable_…`) |
| `VITE_ENABLE_SIGNUP` | Optional. `false` hides the “Create account” UI (cosmetic; see §4) |

Restart `npm run dev` after editing. The app refuses to start sign-in if the URL is not https (http is allowed only for `localhost`) or if the key looks like a secret/service-role key.

**Never** put any of these in the frontend, in `.env.example`, or in Git: the `sb_secret_…` / `service_role` key, the database password, a personal access token. The publishable key is safe in the browser *only because* Row Level Security protects the data (see `supabase/README.md`).

## 2. Redirect URLs (Dashboard → Authentication → URL Configuration)

ORBIT uses HashRouter (`/#/calendar`) and Supabase's **PKCE** flow. Email links come back to the **site root with a query string** (`/?code=…`), never to a hash route, so they cannot collide with the router. supabase-js exchanges the code and removes it from the address bar.

* **Site URL:** `http://localhost:5173/` for development (switch to the GitHub Pages URL after deployment).
* **Redirect URLs (allow-list):**
  * `http://localhost:5173/**`
  * `https://<user>.github.io/orbit-planner/**` (when deployed; the path must match Vite's `base`)

The app asks Supabase to redirect to `window.location.origin + import.meta.env.BASE_URL`. If you set Vite `base: '/orbit-planner/'` for GitHub Pages, that value is picked up automatically.

Notes:
* A confirmation/recovery link should be opened in the **same browser** that requested it (PKCE keeps a one-time verifier there). If a confirmation link is opened elsewhere, the email is still confirmed; just sign in normally.
* Failed links (expired/used) arrive as `#error=…` in the fragment. ORBIT detects this, shows a message on the sign-in page and resets the hash to `#/login`.

## 3. Recommended Auth settings (Dashboard → Authentication)

* Email provider enabled, **Confirm email = on** (already done).
* Minimum password length: **12** (the app also enforces 12 on sign-up and reset; keep both in sync). Consider enabling leaked-password protection if your plan has it.
* Rate limits: keep the defaults.
* Email templates: default templates work with the redirect URLs above.

## 4. Closing public registration later

Once your own account exists: Dashboard → Authentication → Sign In / Providers → **disable “Allow new users to sign up”**. Existing users keep signing in; new sign-ups return `signup_disabled`, which ORBIT shows as “New registrations are currently closed.” Setting `VITE_ENABLE_SIGNUP=false` additionally hides the form, but it is **only cosmetic**: the dashboard setting is the real control.

## 5. How the app is structured

```
src/lib/supabaseConfig.ts   pure env validation (+ secret-key refusal)
src/lib/supabase.ts         the single client (null when unconfigured); PKCE, persisted session
src/auth/authController.ts  observable auth state machine over the client (unit-tested with a fake)
src/auth/AuthProvider.tsx   React context; handles error fragments in the URL
src/auth/guards.tsx         RequireAuth (app routes) and AuthRoute (login/register/forgot)
src/pages/auth/*            sign-in, register, forgot-password, reset-password, setup-required
```

* States: `unconfigured` (local-only) · `loading` · `signed-out` · `signed-in` · `recovery`.
* Tokens live in supabase-js's own storage entry (`sb-…-auth-token`). ORBIT never stores passwords or tokens itself and the auth layer never touches `orbit.*` keys.
* Sign-out is local to the current browser (`scope: 'local'`); other devices stay signed in.
* When signed in, calendar data comes from the user's cloud account only. The old browser storage is not per-user and is therefore never displayed once signed in; it is reachable only through the explicit import in Settings.

## 6. Manual steps for you

1. Create `.env.local` from `.env.example` with the project URL and **publishable** key.
2. Set Site URL and Redirect URLs (§2).
3. Set the minimum password length to 12 (§3).
4. Register your account in the app, click the confirmation email, sign in.
5. ~~Review and apply the migrations~~ Done: reviewed, audited and deployed with `npx supabase db push`. Do not edit the applied files; add new migrations instead.
6. After your account works, disable public sign-ups (§4).

## 7. Tests

| Command | What it covers | Real Supabase? |
|---|---|---|
| `npm test` | config validation, URL handling, error mapping, auth controller, guards/pages (jsdom), SQL migrations + RLS isolation (PGlite) | No: fake client / simulated Postgres |
| `npm run test:e2e` | real browser, real supabase-js against a mocked Auth API: login, wrong password, session restore, logout, protected routes, register, reset/recovery, expired link, multi-tab sign-out, mobile + desktop | No: Auth API mocked, no network |

Automated tests never touch the hosted project. Hosted checks were done by hand: in Phase 3A a read-only check (signed-in `SELECT` = HTTP 200/0 rows; anonymous = 401 / `42501`), and in Phase 3B a click-through of synthetic CRUD, series/exception, DST, concurrency, import and cleanup scenarios (summarised in cloud-sync.md; the temporary tooling was removed). Cross-user isolation on the hosted project is **not** covered and needs two real test users.

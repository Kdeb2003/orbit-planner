# Deploying ORBIT to GitHub Pages (Phase 3C)

ORBIT is deployed by [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) to:

**https://kdeb2003.github.io/orbit-planner/**

This is a GitHub Pages **project page** (not `kdeb2003.github.io` itself), so the production build is served under the `/orbit-planner/` path. `vite.config.ts` sets Vite's `base` to `/orbit-planner/` for both `vite build` and `vite preview` (via Vite's `isPreview` flag — `vite preview` resolves with `command: 'serve'`, the same as `vite dev`, so `command` alone can't tell them apart); `npm run dev` keeps the default `/`. `src/auth/authUrls.ts` already builds Supabase auth-redirect URLs from `import.meta.env.BASE_URL`, so this is picked up automatically — no auth code changes were needed for deployment.

## 1. GitHub Actions setup

The workflow (`.github/workflows/deploy.yml`):

1. Checks out the repo, installs Node 24 and dependencies (`npm ci`).
2. Runs `npm run lint` and `npm test -- --run`.
3. Builds with `npm run build`, passing the two repository variables below and `VITE_ENABLE_SIGNUP=false`.
4. Verifies `dist/index.html` exists and references `/orbit-planner/assets/` — this fails the build clearly if the base-path configuration ever regresses, instead of silently deploying a broken app.
5. Uploads `dist/` as the Pages artifact (`actions/upload-pages-artifact`) and deploys it (`actions/deploy-pages`) in a separate job scoped to the `github-pages` environment.

No GitHub Pages build (Jekyll or otherwise) is used — Pages is configured to deploy from GitHub Actions (Settings → Pages → Source → **GitHub Actions**), which the user has already set.

## 2. Required repository variables

Settings → Secrets and variables → Actions → **Variables** tab (not Secrets — these values are not secret; the publishable key is designed to be public and RLS is the real boundary):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<your-project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The **publishable** key (`sb_publishable_…`) |

If these are left unset, the workflow still succeeds and deploys ORBIT in **local-only mode** (a GitHub Actions `::notice::` explains this in the "Check Supabase configuration" step's log). `VITE_ENABLE_SIGNUP` is hardcoded to `false` in the workflow and is not a variable to set.

**Never** add `VITE_SUPABASE_SECRET_KEY`, a `service_role` key, or a database password anywhere in the repository, workflow, or as an Actions secret for this purpose — ORBIT's frontend must only ever hold the publishable key (`getSupabaseConfig` refuses to build with a secret/service-role key, but don't rely on that as the only safeguard).

## 3. Workflow trigger behaviour

* Runs on every push to `main`, and on manual **Run workflow** (Actions tab → Deploy to GitHub Pages → Run workflow).
* Does **not** run on pull requests, so an external contributor's PR cannot trigger a deployment or see the repository variables.
* `concurrency: group: pages` means a second push while a deployment is running queues behind it rather than racing it; the in-progress deployment is not cancelled.

## 4. GitHub Pages URL

https://kdeb2003.github.io/orbit-planner/ — confirmed reachable once the first deployment completes (Settings → Pages shows the live URL and last deployment time).

## 5. Supabase URL Configuration changes (manual, in the Supabase dashboard)

Dashboard → Authentication → URL Configuration:

* **Site URL:** add `https://kdeb2003.github.io/orbit-planner/` (keep `http://localhost:5173/` too if you still develop locally).
* **Redirect URLs (allow-list):** add `https://kdeb2003.github.io/orbit-planner/**`. Keep the existing `http://localhost:5173/**` entry — this does not remove local sign-in.

Without this, email confirmation and password-reset links sent for accounts created through the production site will fail to redirect correctly (Supabase rejects a redirect target that isn't on the allow-list and falls back to the Site URL, which — if not the Pages URL — would send users to the wrong place). This is the exact URL the app computes itself (`window.location.origin + import.meta.env.BASE_URL`), verified by `src/auth/auth.test.ts`.

## 6. How to verify a successful deployment

1. Actions tab → the latest "Deploy to GitHub Pages" run is green, with "build" and "deploy" both succeeded.
2. Settings → Pages shows "Your site is live at https://kdeb2003.github.io/orbit-planner/".
3. Open that URL in a normal (non-cached) browser tab or incognito window:
   * The app loads with no console errors (DevTools → Console) and no 404s (DevTools → Network, filter by status ≥ 400).
   * If Supabase is configured: `/#/login` shows the sign-in form (not "Sign-in isn't set up"); sign in and confirm the calendar loads.
   * If Supabase is not configured: the app runs local-only, as documented.
4. Hard-refresh on a non-root route (e.g. `/#/calendar`) — this must not 404 (GitHub Pages serves the one `index.html` for any path under `/orbit-planner/`; the hash is irrelevant to the server).

These are the same checks the local `pages` Playwright project automates against `vite preview` (see §9) — they are a close approximation, not a substitute for actually opening the deployed URL.

## 7. How to test on a phone

* Open `https://kdeb2003.github.io/orbit-planner/` directly in the phone's browser (no local network access needed — it's a public URL).
* Confirm layout at the phone's real width (ORBIT is tested locally at 390px and 320px viewports; a phone is normally at or above 360px).
* If testing sign-in: use a real or disposable test account — **never** the production account's credentials on a device you don't trust, and never import real calendar data as part of this check.
* Add the page to the home screen to preview how it will look once Phase 4 (PWA) adds a manifest and install prompt — there is no manifest yet, so this is just a bookmark, not an installable app.

## 8. How to roll back a failed deployment

GitHub Pages (Actions-sourced) keeps the previously deployed artifact live until a new deployment succeeds — a failed workflow run (lint/test/build failure) never overwrites the live site, since the `deploy` job only runs after `build` succeeds.

If a deployment **succeeds** but the result is broken in production:

1. Fastest: push a revert commit for the breaking change to `main` (`git revert <sha>`) and let the workflow redeploy — this is the normal, reviewable fix.
2. Faster, manual: Actions tab → "Deploy to GitHub Pages" → find the last known-good run → **Re-run all jobs**. This rebuilds and redeploys that same commit's code (not a true instant rollback — it re-runs the workflow from that historical commit).
3. Settings → Pages also lists past deployments; GitHub does not currently offer a one-click "restore this deployment" button, so (1) or (2) are the supported paths.

Do not force-push `main` to roll back history as a substitute for a revert commit, since that rewrites shared history other branches/PRs may depend on.

## 9. Remaining security and functionality checks

Everything already documented as **not yet verified** in [cloud-sync.md](cloud-sync.md) and [supabase-setup.md](supabase-setup.md) remains true after deployment and is not changed by this phase:

* Cross-user isolation on the hosted project (needs two real accounts).
* Session expiry / revoked token handling under real conditions.
* Behaviour under a real network outage (only simulated in Playwright).
* Automatic cross-tab refresh without a manual reload (expected via the 60 s poll / focus refresh, not independently confirmed).
* Realtime (off by default).

Before relying on the deployed app for **real personal data** (your actual timetable, work shifts, etc.), run this manual check once, signed in as yourself on the production URL:

1. Create one real event, reload the page, confirm it persists and the header chip reads "Saved to cloud".
2. Sign out, confirm the calendar is empty / shows the sign-in page (no leftover data visible).
3. Sign back in, confirm your event is still there.
4. In Settings, confirm "Local-only mode" is **not** shown (you should see the cloud-sync / import card instead) — this confirms the deployed build is actually using your Supabase project, not running local-only by accident (e.g. a missing repository variable).
5. Only then consider importing existing browser-saved events or university timetable data, using the explicit, previewed, confirmed import flow in Settings — never anything automatic.

## Local verification performed for this phase (see also the final report)

* `npm run build` with `base: '/orbit-planner/'` produces `dist/index.html` referencing `/orbit-planner/assets/*` and `/orbit-planner/favicon.svg`.
* `npm run preview` serves the build correctly under `/orbit-planner/` (verified by curl and by a dedicated Playwright project, `pages`, in `playwright.config.ts` / `e2e/pages-deploy.e2e.ts`): no 404s for JS/CSS/favicon, HashRouter routes resolve including a hard refresh, the sign-in route renders, and there's no horizontal overflow at 390px/320px.
* `npm test -- --run`, `npm run lint`, and `npm run build` all pass (see the final report for exact output).
* No deployment was triggered, no code was pushed, and no Supabase settings were changed as part of this work — see the Restrictions in the task brief.

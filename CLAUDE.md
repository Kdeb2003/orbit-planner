# CLAUDE.md — ORBIT

## Purpose
ORBIT is a personal planning app for one user: university classes and timetables, part-time work shifts, study sessions and goals, research tasks, German classes, personal commitments, and deadlines. It must be responsive, dark-themed, and later installable as a PWA.

## Tech stack
- React 19 + TypeScript + Vite
- Tailwind CSS v4 (`@tailwindcss/vite`, theme tokens in `src/styles/index.css`)
- React Router (`HashRouter`, so it works on GitHub Pages)
- lucide-react icons
- ESLint (typescript-eslint, react-hooks)
- Vitest for unit tests (`npm test`)

## Folder conventions
```
src/
  components/   Reusable components; components/ui = small generic primitives
  pages/        One file per route (TodayPage, CalendarPage, ...)
  layouts/      App shell (sidebar, header, bottom nav) and nav config
  hooks/        Custom hooks (useNow, useSaveError, useEventEditor)
  calendar/     Data-source layer: CalendarSource (local | cloud), per-user session manager, auto-refresh, useCalendar()
  cloud/        Supabase repository (cloudApi), model<->row mappers, validation, id mapping, error mapping, FakeCloud (tests)
  migration/    Explicit local->cloud import: backup, preview plan, upload + verify, progress marker
  storage/      Persistence (collection.ts generic localStorage array; eventStore, seriesStore, saveStatus). No React.
  utils/        Pure helpers: time.ts (Berlin/DST, date keys), events.ts (filtering, form validation),
                recurrence.ts (series -> occurrences), schedule.ts (events + series expansion, conflict lookup), conflicts.ts
  types/        Shared TypeScript types
  mock/         Demonstration data ONLY (Study Planner / Insights only; never saved to the calendar)
  styles/       Global CSS and Tailwind theme tokens
```

## Event model and storage
- `CalendarEvent` (src/types): id, title, category, `start`/`end` as UTC ISO instants, `timeZone`, optional location/description, createdAt/updatedAt. Categories: university, work, study, german, research, personal, deadline.
- Instants are stored in UTC; wall-clock times are derived with `Intl` in the event's zone. Never store local times without a zone. Days are `DateKey` strings ('YYYY-MM-DD') and are bucketed in Europe/Berlin, so DST days (23/25 h) and midnight-spanning events work.
- `src/storage/eventStore.ts` owns persistence (localStorage key `orbit.events.v1`). It validates records on load, drops invalid ones, backs up unreadable data to `orbit.events.v1.backup`, and exposes subscribe/getSnapshot for `useSyncExternalStore`. UI must go through `useEvents()`, never touch localStorage directly. To move to Supabase, replace the store implementation behind the same create/update/remove/subscribe surface (it will become async).
- The add/edit dialog is global: call `useEventEditor().openNew(day)` / `openEdit(event)`.

## Recurring schedules (Phase 2B)
- **Model:** a weekly series is ONE `RecurringSeries` record (separate from one-off `CalendarEvent`s): weekdays, `startDate`/`untilDate` (inclusive), local `startTime`/`endTime` in `timeZone`, `endDayOffset` (0-6, 1 = overnight), and embedded `exceptions`. Occurrences are generated on demand for a bounded date range (`expandSeries` / `expandItems`); they are never stored.
- **Why separate records (not extra fields on events):** one-off events and `orbit.events.v1` stay byte-for-byte compatible, a series is a single row to sync, and exceptions travel atomically with their series.
- **Wall-clock rule:** occurrences are computed per date from local time (`resolveLocalTime`), never by adding 7×24 h to UTC. A 09:00 class stays 09:00 Europe/Berlin across DST.
- **Occurrence identity:** `ScheduledItem.id = "<seriesId>:<originalDate>"`, where `originalDate` is the date the schedule would have put it on. This is the React key and the exception key.
- **Exceptions:** `{ originalDate, cancelled?, override? }`. `override` holds only differing fields (`title`, `category`, `location`, `description`, and `start`+`end` together when moved). Moved occurrences appear only at their new position. Cancel = `cancelled: true` (restorable from the calendar day list); "Reset to series" deletes the exception. Editing the whole series keeps exceptions whose `originalDate` still fits the schedule; the rest ("orphans") are listed in a warning and removed only after the user confirms.
- **DST policy:** a skipped time (e.g. 02:30 on the spring-forward day) is rejected for one-off events; in a series the occurrence is shifted forward and flagged (`dstAdjusted`) and the dialog warns. An ambiguous time (repeated at fall-back) resolves to the FIRST occurrence, with a note in the form.
- **Conflicts:** `conflicts.ts` + `conflictsFor` compare real UTC instants with strict overlap (touching ends do not conflict). Deadlines never conflict. Cancelled occurrences and the item(s) being edited are ignored. Conflicts are non-blocking: the dialog lists them and offers "Save anyway".
- **Storage keys:** events `orbit.events.v1` (unchanged since Phase 2A, no migration), series `orbit.series.v1`. Each has a `.backup` key written once if records had to be dropped or the JSON was unreadable. Both stores are plain arrays with per-record validation; invalid records are dropped, invalid exceptions are dropped from an otherwise valid series.
- **Save failures:** writes that fail (quota, blocked storage) are reported through `saveStatus` and shown as a banner in the app shell; in-memory data is kept but not claimed as saved.
- **University metadata:** optional `courseCode`, `sessionType` (main, tutorial, seminar, practical, other) and `groupLabel` exist on one-off events, series and per-occurrence overrides (`""` clears an inherited value). They are shown in the dialog when the category is University, and listed after the location on event rows. No real timetable data is bundled.
- **Tests:** Vitest covers the pure logic and storage (`src/**/*.test.ts`); Playwright (`e2e/*.e2e.ts`) drives the real app: CRUD, recurrence, exceptions, conflicts, Today with a mocked clock, DST, storage safety, cross-tab, and four viewport sizes. Deadlines are excluded from conflicts by design (reminders, not time blocks); this is covered by a unit and a browser test.
- **Limitations:** weekly only; no "this and following"; series length ≤ ~3 years and ≤ 7 days per occurrence; "Up next" looks 120 days ahead; two tabs saving at the same moment is last-write-wins (the other tab refreshes on the `storage` event).
- **Future Supabase:** `recurring_series` table (JSONB `recurrence`, `timezone`) and `series_exceptions(series_id, original_date, cancelled, override jsonb)` with PK `(series_id, original_date)`; events map to `events`. Keep the store interfaces; they will become async. Add RLS per `user_id`.

## Supabase and authentication (Phase 3A)
- Setup, env vars, redirect URLs and manual steps: [docs/supabase-setup.md](docs/supabase-setup.md). Schema, RLS and how to apply: [supabase/README.md](supabase/README.md).
- Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (+ optional `VITE_ENABLE_SIGNUP`) in git-ignored `.env.local`. `getSupabaseConfig` validates them and refuses secret/service-role keys. NEVER add a secret key, DB password or service-role key to the frontend, tests, docs or Git.
- Unconfigured = local-only mode (app works, sign-in routes show setup help). Configured = every app route is behind `RequireAuth`.
- Auth is PKCE (`?code=` callbacks) because HashRouter owns the URL fragment. Email redirect = `origin + BASE_URL`. Do not use implicit flow or hash redirects.
- `src/auth/authController.ts` is the only code that talks to `supabase.auth`; UI uses `useAuth()`. It never reads/writes `orbit.*` storage keys, and ORBIT never stores passwords/tokens (supabase-js owns the session).
- The SQL in `supabase/migrations/` is **deployed to the hosted project** (applied files are immutable: change the schema only with NEW migrations). It is exercised in `supabase/tests/migrations.test.ts` (PGlite simulation). Verified live: anonymous SELECT/INSERT denied; owner CRUD, series/exceptions, DST, stale-edit rejection and synthetic import with temporary rows (see docs/cloud-sync.md). NOT verified live: cross-user isolation (needs two accounts), session expiry, real outage, Realtime, automatic cross-tab refresh. Never run SQL against, or write to, the hosted project, or use a service-role key, without explicit approval. `supabase/.temp/` (CLI link metadata) is git-ignored; never commit it.
- Signed-in calendar data comes from the user's cloud account (see the Cloud sync section). The legacy browser storage is NOT per-user: it is never displayed when signed in. Local mode (Supabase unconfigured) is unchanged and must stay labelled "Local only" — never call local data synced.
- E2E: the `auth` Playwright project serves the app with a dummy config pointing at its own origin and mocks `/auth/v1/*`; the `local` project forces Supabase to unconfigured (empty env). Real credentials are never used in tests.

## Cloud sync (Phase 3B) — see [docs/cloud-sync.md](docs/cloud-sync.md)
- Views and the editor talk ONLY to `useCalendar()` (a `CalendarSource`); never to `eventStore`/`seriesStore`/Supabase directly. Local mode wraps the old stores; cloud mode is `createCloudSource(api)`, one per signed-in user, disposed on sign-out/account switch.
- All mutations are async and pessimistic: `{ok:true}` = confirmed by the server; `{ok:false}` = NOT saved (the dialog stays open and shows why). No optimistic updates. Do not add any that cannot be rolled back and tested.
- Known limits (do not claim them solved): exception last-writer-wins, non-atomic series update + exception cleanup, no offline write queue, Realtime off by default.
- Events/series use optimistic concurrency on the raw `updated_at`; exceptions are last-writer-wins; series+exception removal is not transactional (documented). Changing that needs a new migration and user approval.
- Cloud code must never touch `orbit.events.v1` / `orbit.series.v1` (enforced by a static test); legacy local data is only reachable through the explicit import (`src/migration`), which never modifies or deletes it. Never auto-upload or auto-merge.
- Tests: `FakeCloud` (unit) and `e2e/cloudMock.ts` (mock PostgREST for Playwright) are MOCKS. Hosted behaviour (CRUD, series/exceptions, DST, stale-edit rejection, synthetic import, reload persistence, anonymous denial) was verified once against the real project with temporary synthetic rows that were deleted; see the verification status in docs/cloud-sync.md for what is still NOT tested (two-account isolation, session expiry, real outage, Realtime, automatic cross-tab refresh). Never use real credentials in tests, never write to the hosted project without explicit approval, never import real calendar data without the user's explicit confirmation.
- Never send `user_id`/`updated_at` from the client; `created_at` only from the explicit import.

## Coding standards
- TypeScript everywhere; no `any`.
- Function components, named exports (default export only for `App`).
- Style with Tailwind utilities and the theme tokens (`bg-base`, `bg-surface`, `text-muted`, `accent`); do not hardcode hex values in components.
- All times are shown in `Europe/Berlin` via `src/utils/time.ts`.
- Unfinished features must be visibly disabled or marked "Coming soon" — never fake functionality.
- Demo data must be labelled "Demo data" in the UI and never contain real personal information.
- Keep it simple; add abstractions only when needed twice.

## Development workflow
- `npm run dev` — start dev server
- `npm test`, `npm run lint` and `npm run build` must all pass before committing
- `npm run test:e2e` — Playwright browser tests (system Chrome, own dev server on port 5199, fresh browser contexts, fixed clock). Run before merging UI changes. Output goes to the git-ignored `e2e-artifacts/`
- Browser tests use `data-date` / `data-count` attributes on calendar cells; keep them.
- Dialogs: focus the element marked `data-autofocus` after `showModal()` (React `autoFocus` runs too early).
- Work on feature branches; the user handles commits, pushes, and PRs

## Security rules
- No secrets, API keys, or credentials in the repo. Use untracked `.env.local` for local config.
- Only `VITE_`-prefixed vars reach the browser; treat them as public.
- No real personal data in mock data, screenshots, or commits.
- When Supabase is added: enable Row Level Security on every table, use only the anon key client-side.

## Planned architecture
1. Phase 1 (done): app shell, dark UI
2. Phase 2A (current): event model, localStorage persistence, working calendar and event CRUD
2b. Phase 2B: recurring timetables and exceptions
3a. (done) Supabase sign-in, schema + RLS migrations (unapplied)
3b. (done, pending merge) Cloud CRUD + sync (laptop and phone), safe local import
4. PWA install, offline support
5. GitHub Pages deployment
6. Later: schedule import

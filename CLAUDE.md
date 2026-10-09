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
  hooks/        Custom hooks (useNow, useEvents, useEventEditor)
  storage/      Persistence layer (eventStore: localStorage, no React)
  utils/        Pure helpers (time.ts: Berlin/DST + date keys; events.ts: filtering, form validation)
  types/        Shared TypeScript types
  mock/         Demonstration data ONLY (Study Planner / Insights only; never saved to the calendar)
  styles/       Global CSS and Tailwind theme tokens
```

## Event model and storage
- `CalendarEvent` (src/types): id, title, category, `start`/`end` as UTC ISO instants, `timeZone`, optional location/description, createdAt/updatedAt. Categories: university, work, study, german, research, personal, deadline.
- Instants are stored in UTC; wall-clock times are derived with `Intl` in the event's zone. Never store local times without a zone. Days are `DateKey` strings ('YYYY-MM-DD') and are bucketed in Europe/Berlin, so DST days (23/25 h) and midnight-spanning events work.
- `src/storage/eventStore.ts` owns persistence (localStorage key `orbit.events.v1`). It validates records on load, drops invalid ones, backs up unreadable data to `orbit.events.v1.backup`, and exposes subscribe/getSnapshot for `useSyncExternalStore`. UI must go through `useEvents()`, never touch localStorage directly. To move to Supabase, replace the store implementation behind the same create/update/remove/subscribe surface (it will become async).
- Recurrence is NOT implemented. Phase 2B should add optional fields (e.g. `recurrence`, `exceptions`) to `CalendarEvent` and expand occurrences in `eventsOnDay`; existing records stay valid.
- The add/edit dialog is global: call `useEventEditor().openNew(day)` / `openEdit(event)`.

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
3. Supabase auth + sync (laptop and phone), RLS
4. PWA install, offline support
5. GitHub Pages deployment
6. Later: schedule import

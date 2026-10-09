# CLAUDE.md — ORBIT

## Purpose
ORBIT is a personal planning app for one user: university classes and timetables, part-time work shifts, study sessions and goals, research tasks, German classes, personal commitments, and deadlines. It must be responsive, dark-themed, and later installable as a PWA.

## Tech stack
- React 19 + TypeScript + Vite
- Tailwind CSS v4 (`@tailwindcss/vite`, theme tokens in `src/styles/index.css`)
- React Router (`HashRouter`, so it works on GitHub Pages)
- lucide-react icons
- ESLint (typescript-eslint, react-hooks)

## Folder conventions
```
src/
  components/   Reusable components; components/ui = small generic primitives
  pages/        One file per route (TodayPage, CalendarPage, ...)
  layouts/      App shell (sidebar, header, bottom nav) and nav config
  hooks/        Custom hooks (useNow, ...)
  utils/        Pure helpers (time/date formatting)
  types/        Shared TypeScript types
  mock/         Demonstration data ONLY
  styles/       Global CSS and Tailwind theme tokens
```

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
- `npm run lint` and `npm run build` must both pass before committing
- Work on feature branches; the user handles commits, pushes, and PRs

## Security rules
- No secrets, API keys, or credentials in the repo. Use untracked `.env.local` for local config.
- Only `VITE_`-prefixed vars reach the browser; treat them as public.
- No real personal data in mock data, screenshots, or commits.
- When Supabase is added: enable Row Level Security on every table, use only the anon key client-side.

## Planned architecture
1. Phase 1 (current): app shell, dark UI, demo data
2. Event model, local persistence, real calendar and recurring timetables
3. Supabase auth + sync (laptop and phone), RLS
4. PWA install, offline support
5. GitHub Pages deployment
6. Later: schedule import

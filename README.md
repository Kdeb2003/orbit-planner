# ORBIT

A personal planner for classes, work shifts, study sessions, and deadlines. Dark, responsive, and (eventually) installable on your phone.

> Status: Phase 2B — a working calendar with one-off and weekly repeating events, per-occurrence exceptions and overlap warnings. Data is saved **in this browser only** (localStorage); there is no sync or account yet. Study Planner and Insights still show demo data.

## Features

- Month and week calendar, Today dashboard with live Europe/Berlin clock
- Add, edit and delete events; categories University, Work, Study, German, Research, Personal, Deadline
- **Weekly repeating events** (choose weekdays and a repeat-until date). A 09:00 class stays at 09:00 after daylight saving changes; overnight events are supported
- **Edit one occurrence or the whole series**: cancel, restore, move or edit a single occurrence; change or delete the series
- **Overlap warnings** (non-blocking) for one-off and repeating events
- Optional university details: course code, session type (main, tutorial, seminar, practical, other) and group label
- If the browser cannot save, a banner says so instead of pretending it worked

## Local development

Requires Node.js 20+.

```bash
npm install
npm run dev      # start dev server
npm test         # unit tests (Vitest)
npm run lint     # ESLint
npm run test:e2e  # browser tests (Playwright + system Chrome; first run: npm i)
npm run build    # type-check + production build
npm run preview  # serve the production build
```

## Roadmap

1. App shell and dark UI (done)
2. Calendar and event management with local storage (done)
2b. **Recurring schedules, exceptions and conflicts (current)**
3. Supabase authentication and sync between devices
4. PWA install and offline support
5. GitHub Pages deployment
6. Schedule import

See [CLAUDE.md](CLAUDE.md) for conventions and architecture notes.

## Data storage

Everything is in your browser's `localStorage`: one-off events under `orbit.events.v1` (unchanged since Phase 2A) and repeating series under `orbit.series.v1`. A series is a single record with its exceptions embedded; occurrences are generated when needed. Clearing site data erases it. See [CLAUDE.md](CLAUDE.md) for the schema, limitations and Supabase plans.

# ORBIT

A personal planner for classes, work shifts, study sessions, and deadlines. Dark, responsive, and (eventually) installable on your phone.

> Status: Phase 3B — with Supabase configured, signed-in users get their own **cloud calendar** (events, repeating schedules, exceptions) that syncs between devices, plus an explicit, opt-in import of events saved earlier in the browser. Tested with mocks **and against the real hosted project** using temporary synthetic records (since deleted); **no existing calendar data has been uploaded** and hosted cross-user isolation is not yet tested. Without Supabase configuration ORBIT stays local-only.

## Features

- Month and week calendar, Today dashboard with live Europe/Berlin clock
- Add, edit and delete events; categories University, Work, Study, German, Research, Personal, Deadline
- **Weekly repeating events** (choose weekdays and a repeat-until date). A 09:00 class stays at 09:00 after daylight saving changes; overnight events are supported
- **Edit one occurrence or the whole series**: cancel, restore, move or edit a single occurrence; change or delete the series
- **Overlap warnings** (non-blocking) for one-off and repeating events
- Optional university details: course code, session type (main, tutorial, seminar, practical, other) and group label
- If the browser cannot save, a banner says so instead of pretending it worked

## Cloud calendar

Signed-in users read and write their own data in Supabase (Row Level Security enforces ownership). The calendar refreshes on sign-in, after saves, when the tab regains focus, when the network returns and every minute, so changes from another device appear without signing out. Saves are confirmed by the server before they appear; a failed save is shown as **not saved** and can be retried. Events saved in this browser *before* signing in are **not** mixed in: Settings offers a backup download and a previewed, confirmed, verified, repeat-safe import that never changes or deletes the browser data. Known limits (last-writer-wins exceptions, non-atomic series update, no offline write queue) and exactly what was verified live versus mocked: [docs/cloud-sync.md](docs/cloud-sync.md).

## Sign-in (optional)

Without configuration ORBIT runs in **local-only mode**. To enable Supabase sign-in, copy `.env.example` to `.env.local` and add your project URL and **publishable** key (never a secret/service-role key). Full guide, redirect URLs and manual steps: [docs/supabase-setup.md](docs/supabase-setup.md). Database design and Row Level Security: [supabase/README.md](supabase/README.md) (migrations applied to the hosted project; see the verification notes there).

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
2b. Recurring schedules, exceptions and conflicts (done)
3a. Supabase sign-in + secure schema, deployed and verified (done; nothing synced yet)
3b. **Cloud CRUD, cross-device sync, safe local-data import (implemented; hosted CRUD/DST/concurrency/import verified with synthetic data; two-account isolation still untested)**
4. PWA install and offline support
5. GitHub Pages deployment
6. Schedule import

See [CLAUDE.md](CLAUDE.md) for conventions and architecture notes.

## Data storage

Everything is in your browser's `localStorage`: one-off events under `orbit.events.v1` (unchanged since Phase 2A) and repeating series under `orbit.series.v1`. A series is a single record with its exceptions embedded; occurrences are generated when needed. Clearing site data erases it. See [CLAUDE.md](CLAUDE.md) for the schema, limitations and Supabase plans.

# ORBIT

A personal planner for classes, work shifts, study sessions, and deadlines. Dark, responsive, and (eventually) installable on your phone.

> Status: Phase 2A — a working calendar with event add/edit/delete. Events are saved **in this browser only** (localStorage); there is no sync or account yet. Study Planner and Insights still show demo data.

## Local development

Requires Node.js 20+.

```bash
npm install
npm run dev      # start dev server
npm test         # unit tests (Vitest)
npm run lint     # ESLint
npm run build    # type-check + production build
npm run preview  # serve the production build
```

## Roadmap

1. App shell and dark UI (done)
2. **Calendar and event management with local storage (current)**; next: recurring timetables

3. Supabase authentication and sync between devices
4. PWA install and offline support
5. GitHub Pages deployment
6. Schedule import

See [CLAUDE.md](CLAUDE.md) for conventions and architecture notes.

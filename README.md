# ORBIT

A personal planner for classes, work shifts, study sessions, and deadlines. Dark, responsive, and (eventually) installable on your phone.

> Status: Phase 1 — app shell and UI foundation. All schedule data is **demonstration data**.

## Local development

Requires Node.js 20+.

```bash
npm install
npm run dev      # start dev server
npm run lint     # ESLint
npm run build    # type-check + production build
npm run preview  # serve the production build
```

## Roadmap

1. **App shell and dark UI** (current)
2. Event model, local storage, working calendar and recurring timetables
3. Supabase authentication and sync between devices
4. PWA install and offline support
5. GitHub Pages deployment
6. Schedule import

See [CLAUDE.md](CLAUDE.md) for conventions and architecture notes.

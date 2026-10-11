# Recovery scripts (never applied automatically)

Files here are **manual recovery tools**. They are deliberately outside `supabase/migrations/`: `supabase db push` and `supabase db reset` never read this folder, and `supabase/tests/migrations.test.ts` does not load it. Run one only by hand, on purpose, after reading it.

| File | Purpose |
|---|---|
| `20261015120000_event_imports.rollback.sql` | Removes only what `migrations/20261015120000_event_imports.sql` added. Calendar events stay as ordinary events. **Refuses to run while any provenance data exists** unless the transaction explicitly confirms (`orbit.confirm_drop_provenance`), because dropping the tables destroys import history; a later import could then duplicate events already in the calendar. Rolled back and re-applied in `supabase/tests/import-provenance.test.ts`. |
| `20261020120000_courses.rollback.sql` | Removes only `public.courses` and its two `orbit_private` helpers. **Refuses to run while any course row exists** (error 55000) unless the transaction sets `orbit.confirm_drop_courses = yes` (transaction-local); a backup before confirming is recommended (the script's header shows how) but is not enforced; refuses non-owner roles (42501); never uses CASCADE, so later tables referencing courses must be rolled back first. Not applied anywhere. Tested in `supabase/tests/courses.test.ts`. |

Status of the forward migration (`migrations/20261015120000_event_imports.sql`): validated on local Supabase (PostgreSQL 17.11) and in PGlite; tracked in the repository; **applied to the hosted project and verified there** (two-account check: 79 passed, 0 failed). Timetable saving is enabled in the production workflow (`VITE_ENABLE_TIMETABLE_SAVE: 'true'`). The courses migration (`migrations/20261020120000_courses.sql`) is tested locally only and is **not applied to the hosted project**.

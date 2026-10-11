# Recovery scripts (never applied automatically)

Files here are **manual recovery tools**. They are deliberately outside `supabase/migrations/`: `supabase db push` and `supabase db reset` never read this folder, and `supabase/tests/migrations.test.ts` does not load it. Run one only by hand, on purpose, after reading it.

| File | Purpose |
|---|---|
| `20261015120000_event_imports.rollback.sql` | Removes only what `migrations/20261015120000_event_imports.sql` added. Calendar events stay as ordinary events. **Refuses to run while any provenance data exists** unless the transaction explicitly confirms (`orbit.confirm_drop_provenance`), because dropping the tables destroys import history; a later import could then duplicate events already in the calendar. Rolled back and re-applied in `supabase/tests/import-provenance.test.ts`. |

Status of the forward migration (`migrations/20261015120000_event_imports.sql`): validated on local Supabase (PostgreSQL 17.11) and in PGlite; tracked in the repository; **NOT yet applied to the hosted project**. The production save feature stays disabled (`VITE_ENABLE_TIMETABLE_SAVE` is pinned to `'false'` in the deploy workflow).

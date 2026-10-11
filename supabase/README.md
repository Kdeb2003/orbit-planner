# ORBIT database (Supabase / PostgreSQL)

**Status: the first two migrations (core schema, RLS policies) are deployed to the hosted ORBIT project (`npx supabase db push`).**
The app reads and writes these tables for signed-in users (Phase 3B). Hosted CRUD, series/exceptions, DST, optimistic concurrency, synthetic import and anonymous denial were verified with temporary synthetic rows (deleted); two-account isolation is not yet tested (see [docs/cloud-sync.md](../docs/cloud-sync.md)).

**Verified live (Phase 3A):** the migrations are deployed to the hosted project (`npx supabase db push`). Against the real Supabase API: the signed-in session is accepted by the Auth server; authenticated `SELECT` on `events`, `recurring_series` and `series_exceptions` returns HTTP 200 with 0 rows; anonymous `SELECT` on all three returns HTTP 401 / PostgreSQL `42501` (permission denied). The dashboard's “0 of 3 tables exposed” indicator does not block the grants-based access above. **Not yet verified on the hosted project:** cross-user isolation and insert/update/delete through the API (Phase 3B integration testing). Cloud calendar sync is **not implemented**, and no local calendar data has been uploaded or migrated.

The Supabase CLI writes link metadata (project ref, pooler host) to `supabase/.temp/`; it is git-ignored and must never be committed.

## Files

| File | Purpose |
|---|---|
| `migrations/20261009120000_core_schema.sql` | Private helper schema, tables (RLS **enabled and client privileges revoked immediately**), constraints, indexes, triggers |
| `migrations/20261009120100_rls_policies.sql` | Grants the minimum privileges to `authenticated` and installs all ownership policies |
| `migrations/20261015120000_event_imports.sql` | Import provenance (Phase 4A.3): `event_imports`, `event_import_links`, `orbit_import_sessions`, `orbit_forget_import_history`. **Validated locally (PostgreSQL 17.11) and in PGlite, then applied to the hosted project and verified there (two-account check: 79 passed, 0 failed). Timetable saving is enabled in the production workflow (`VITE_ENABLE_TIMETABLE_SAVE: 'true'`).** |
| `migrations/20261020120000_courses.sql` | Planner courses (Phase 4B.1b): `courses`, `orbit_private.orbit_normalise_key`, generic `orbit_private.orbit_protect_owned_row`. **Tested locally only (PGlite and a rolled-back transaction on local Supabase, PostgreSQL 17.11); NOT applied to the hosted project.** |
| `tests/courses.test.ts` | PGlite tests of the courses migration (constraints, rule N vectors, uniqueness, identity protection, isolation, rollback). |
| `recovery/` | Manual recovery scripts (the provenance rollback). Never read by `db push`/`db reset` or the migration tests. |
| `tests/import-provenance.test.ts` | PGlite tests of the provenance migration (isolation, ownership FKs, RPC, rollback). |
| `tests/migrations.test.ts` | Runs the real SQL in an in-memory PostgreSQL (PGlite): constraints, cross-user isolation, the state after migration 1 only, function exposure. Part of `npm test`. |

## Deployment safety (fail closed)

* Migration 1 enables RLS on each table **in the same file, right after `create table`**, and revokes every privilege from `PUBLIC`, `anon` and `authenticated`. If only migration 1 is ever applied (or migration 2 fails half-way), nobody but the table owner / `service_role` can touch the data: privileges are absent *and* RLS with no policy denies even if privileges were re-granted. Both layers are tested.
* Migration 2 then grants `SELECT/INSERT/UPDATE/DELETE` to `authenticated` only and creates 12 policies. `anon` never receives privileges or policies.
* Run each file as a single transaction (the SQL editor does; with the CLI, `db push` does).

## Tables

### `events` — one-off events (TypeScript `CalendarEvent`)
`id uuid pk` · `user_id → auth.users (cascade)` · `title` · `category` · `starts_at`/`ends_at timestamptz` (absolute UTC instants) · `time_zone` · `location` · `description` · `course_code` · `session_type` · `group_label` · `created_at` · `updated_at`. `ends_at >= starts_at` (zero-length deadlines allowed). Client-generated UUIDs are accepted so Phase 3B can import idempotently.

### `recurring_series` — one row per weekly schedule (TypeScript `RecurringSeries`)
`id` · `user_id` · `title` · `category` · `time_zone` · metadata · `frequency` (`'weekly'`) · `weekdays smallint[]` (Mon=0…Sun=6, 1–7 unique) · `start_date`/`until_date date` (inclusive, ≤ 1100 days apart) · `start_time`/`end_time time` (**local wall-clock** in `time_zone`) · `end_day_offset` (0–6; 1 = overnight) · timestamps.

**Duration rule:** `end_day_offset > 0 OR end_time > start_time`: a same-day occurrence must end strictly after it starts; overnight and multi-day occurrences may use any end time (22:00→02:00, or exactly 24 h 10:00→10:00).

Occurrences are never stored; the app generates them. Local times + an IANA zone keep 09:00 Europe/Berlin at 09:00 across DST.

### `series_exceptions` — changed occurrences (TypeScript `SeriesException`)
Primary key `(series_id → recurring_series, original_date date)`. `original_date` is the date the schedule would have used, so an exception stays attached when its occurrence is moved. `cancelled boolean`, `override jsonb`.

* **Override** keys: `title, category, start, end, location, description, courseCode, sessionType, groupLabel`; every value a string; `''` clears an inherited value. `start`/`end` come as a pair and must be **real UTC instants** written like `Date.toISOString()` (`2026-10-22T07:00:00.000Z`) with `end > start`. They are validated by *parsing* (`orbit_utc_ts`: explicit range checks for month/day/hour/minute/second plus a print-back round trip), not by the text pattern, and ordered as timestamps, not strings. Any malformed value makes the validator return `false` (it never raises), so the constraint rejects it cleanly.
* **No-op rule:** `cancelled OR (override IS NOT NULL AND override <> '{}')`. A non-cancelled exception with a NULL or empty override is rejected; cancellations (even with `{}`) and real modifications (including `{"location": ""}`) are accepted.
* No `user_id` column: ownership comes from the parent series. Deleting a series cascades.

Type mapping for Phase 3B: `'HH:mm'` ↔ `time`, `'YYYY-MM-DD'` ↔ `date`, ISO strings ↔ `timestamptz`, camelCase ↔ snake_case, `undefined` ↔ `NULL`.

## Row Level Security
* RLS enabled on all three tables (migration 1); policies in migration 2.
* `events`, `recurring_series`: four policies each (`TO authenticated`), `user_id = (select auth.uid())`; UPDATE has `USING` and `WITH CHECK`, so rows cannot be handed to another user.
* `series_exceptions`: four policies, each requiring `EXISTS (parent series with id = series_id AND user_id = auth.uid())`.
* Trigger `orbit_protect_row`: `id`, `user_id` (and exceptions' `series_id`/`original_date`) immutable; `created_at` preserved; `updated_at` set by the server.
* Trigger `orbit_validate_zone`: `time_zone` must exist in `pg_timezone_names` (real IANA name; rejects `UTC+9`, typos).
* No views, no `SECURITY DEFINER` functions.

## Helper function exposure
All helpers live in schema **`orbit_private`**, not `public`, so PostgREST does not publish them as `/rpc/...` endpoints. **Never add `orbit_private` to the project's “Exposed schemas”.** `EXECUTE` is revoked from `PUBLIC` and `anon` (trigger functions: from everyone); the three validators are granted to `authenticated` (and `service_role` if it exists) because CHECK constraints run with the caller's privileges. `anon` has no `USAGE` on the schema. Validators are `IMMUTABLE`, read no tables and pin `search_path`.

## TypeScript ↔ SQL consistency

Matching: categories, session types, override keys, title 1–120, location 120, notes 2000, course code 30, group label 40, weekday range, `endDayOffset` 0–6, ≤ 1100-day span, event `end >= start`, series same-day end > start, exception-must-have-effect (the frontend loader now also drops empty/no-op exceptions).

Intentional differences (handled by the Phase 3B sync layer in `src/cloud/mappers.ts`, `src/cloud/ids.ts` and `src/migration/`; see [docs/cloud-sync.md](../docs/cloud-sync.md)):
1. **Ids:** SQL needs UUIDs; the app only requires non-empty strings. Real ids come from `crypto.randomUUID()`; legacy/test ids like `e1` must be re-keyed on import.
2. **Optional text:** the app omits empty optional fields; SQL also allows `''`. Map `undefined` ↔ `NULL` and trim.
3. **Override lengths:** SQL caps override `title` at 120 and others like the base fields; the frontend loader only requires a non-empty title.
4. **Time zone:** the app accepts any non-empty string; SQL requires a real IANA name ≤ 64 chars.
5. **Span limit:** the form enforces ≤ 1100 days; the local loader does not re-check it.
6. **Orphan exceptions:** the app tolerates exceptions whose date no longer fits the schedule (and offers to remove them); SQL does not check this.
7. **Timestamps:** `updated_at` is always server-set on UPDATE; on INSERT the client may supply `created_at`/`updated_at` (needed to preserve history on import).
8. **Nonexistent / ambiguous local times** (DST gaps/overlaps) are an app-level concern; SQL stores the local time as entered.

## Verification performed
`npm test` runs both migrations against PGlite with a minimal simulation of Supabase's `auth.uid()` and the `anon`/`authenticated` roles (and Supabase-style broad default privileges): RLS everywhere, policy set, anon denied, A cannot read/update/delete/insert-as B, exceptions reachable only through an owned series, immutable identity, cascades, every constraint, the state after migration 1 only (including “privileges wrongly re-granted”), and function exposure. This is a **simulation**, not Supabase itself: before relying on it, repeat on a disposable local stack (`supabase start`, `supabase db reset`) or a throw-away hosted project.

## How to apply (after the SQL has been reviewed and approved)

Do **not** run anything against the production project until you have read both files.

* SQL editor: run `20261009120000_core_schema.sql`, then `20261009120100_rls_policies.sql`. Confirm in *Table Editor* that all three tables show “RLS enabled” and *Authentication → Policies* lists 12 policies; confirm `orbit_private` is **not** under *Settings → API → Exposed schemas*.
* CLI: `supabase link --project-ref <ref>` then `supabase db push` (asks for the DB password interactively; never store it in the repo).

Rollback (only if nothing important is stored): `drop table public.series_exceptions, public.recurring_series, public.events cascade; drop schema orbit_private cascade;`

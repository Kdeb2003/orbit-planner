# Proposal: secure cloud import with durable provenance (Phase 4A.3)

Status: **design, SQL proposal and offline tests only (revision 2, after an independent security review).** Nothing was applied to the hosted project, the migration is now tracked in `supabase/migrations/` (validated locally, NOT applied to hosted; production saving stays disabled), and no real calendar data was touched. Items marked **VERIFIED (offline)** were exercised by tests in this repository; everything else is a **proposal**. Items that need the hosted project are **PENDING**.

* SQL (tracked migration, validated locally, NOT yet applied to hosted): [`supabase/migrations/20261015120000_event_imports.sql`](../../supabase/migrations/20261015120000_event_imports.sql); manual rollback (not a migration): [`supabase/recovery/20261015120000_event_imports.rollback.sql`](../../supabase/recovery/20261015120000_event_imports.rollback.sql)
* Pure TypeScript building blocks (not wired into the app): `src/timetable/provenance/`
* Hosted two-account procedure and script review: [hosted-two-user-rls-verification.md](hosted-two-user-rls-verification.md)

## 0. What the review changed (revision 2)

| # | Finding in revision 1 | Correction (all with regression tests) |
|---|---|---|
| 1 | `authenticated` had full INSERT/UPDATE/DELETE on both tables. RLS only separates users; inside one account a script or bug could rewrite source keys and snapshots, forge tombstones, re-point links, delete history. | Column-level privileges plus triggers (§3). Direct API calls can now only: create a batch (identity columns), change a batch `status`, retire a link. Link inserts/deletes require the supported functions; identity, snapshots and `event_id` are immutable. |
| 2 | The link→batch foreign key checked user but not `source_slug`. | `(batch_id, user_id, source_slug) → event_imports (id, user_id, source_slug)`: lineage is a database-enforced relationship. |
| 3 | `written_count` was a client-visible counter that the RPC silently clamped (`least(...)`); `completed` could be set by any client. | The counter is gone (derived by counting links). Status is a trigger-enforced state machine: `written` needs exactly `planned_count` links, `verified` needs every event to exist and still equal the imported snapshot. A batch cannot receive more than it planned (error, never clamped). |
| 4 | RPC read the batch status before taking the lock; `failed` batches could be written to; duplicates within one payload were not rejected. | Lock first, then read; only `in_progress` accepts sessions; duplicate keys/ids in a payload are rejected; the status trigger takes the same lock. |
| 5 | The hosted script could not clean up provenance once deletion is restricted, did not cover series/exceptions or same-user integrity, and did not track rows a failing check might create. | Rewritten (see the hosted document). |
| 6 | PostgreSQL version assumptions were implicit. | Reviewed against 15; one feature needs 15 (§6). Static test added. |
| 7 | Rollback did not say what is lost once data exists. | Rollback refuses to run when provenance rows exist unless explicitly confirmed (§7). |
| 8 | *Final self-review of revision 2.* (a) An item with a **missing** `source` key slipped through the shape test (`jsonb_typeof(NULL) <> 'object'` is NULL, not true) and was stopped only by a later NOT NULL violation. (b) The hosted script accepted `http://localhost.evil.example` (unanchored host test), probed table existence with a HEAD request (whose error has no code, so a missing table could look present), and its cleanup `LIKE` treated `_` as a wildcard. (c) The script never checked event-id collisions or malformed RPC payloads on the hosted API, and its refusal guards were only claimed to work, not tested. | (a) `coalesce(...)` on both type tests, regression test for missing `source`/`event`/non-object items. (b) anchored host test, plain GET probe (404/PGRST205/42P01 = missing), escaped `LIKE`. (c) new hosted checks (own and foreign event-id collisions, six malformed payloads, "rejected requests wrote nothing"), and `tests/utn/hosted-script-guards.test.ts` runs the real script as a child process for every refusal guard. Mutation-checked: reverting (a) or the URL anchor fails a test. |
| 9 | *Final hosted-verification and rollback hardening.* The rollback tested `to_regclass(links) is not null and (rows in links or rows in batches)`, so a missing links table hid rows in the batches table; the confirmation was suggested as a session-wide `set_config(..., false)` that outlives the rollback; under RLS the emptiness test could not be trusted. The hosted script ignored cleanup failures in its exit code, silently skipped provenance after the migration, and tested a foreign-user exception edit that may be invalid on its own. | Rollback: each table checked on its own (dynamic SQL, so a missing table cannot break or bypass the guard), refuses unless run as the table owner / an RLS-bypassing role, one explicit transaction with a **transaction-local** confirmation, never deletes events. Hosted script: verified cleanup that fails the run, `--require-provenance`, valid exception edit with an owner control (see [hosted-two-user-rls-verification.md](hosted-two-user-rls-verification.md) §E2). |

## 1. What exists today (audit)

| Area | Finding | Reuse in the import |
|---|---|---|
| `events` table | `id uuid pk` (client-supplied ids accepted), `user_id` server-defaulted to `auth.uid()`, title ≤120, category, `starts_at`/`ends_at timestamptz`, `time_zone`, location ≤120, description ≤2000, course_code ≤30, `session_type` ∈ {main, tutorial, seminar, practical, other}, group_label ≤40, `created_at`, `updated_at`. **No source/provenance column.** Trigger `orbit_protect_row` makes `id`/`user_id` immutable and sets `updated_at = now()` on **every** update. | Imported sessions are ordinary events. No column of `events` changes. |
| RLS | 4 policies per table, `TO authenticated`, `user_id = (select auth.uid())`; `anon` has no privileges; no `SECURITY DEFINER`; helpers in non-exposed `orbit_private`. Exceptions inherit ownership through the parent series. | Same model for the new tables, plus the integrity layer in §3. |
| `CloudApi` (`src/cloud/cloudApi.ts`) | The only PostgREST builder. `insertEventsIgnoreDuplicates` (ON CONFLICT DO NOTHING by id), conditional update/delete on the raw `updated_at`, `loadEvents` (paged). Errors are normalised by `mapCloudError` into `CloudError` kinds. | `loadEvents`, `CloudError`, the conditional update/delete for the later reconciliation checkpoint. |
| `src/cloud/mappers.ts`, `ids.ts` | `eventToWrite` / `eventPatch` / `rowToEvent` (canonical ISO timestamps, `''` ↔ NULL), `validateEventForCloud`, `deterministicUuid(namespace, name)` (SHA-1, v5 layout, namespace includes the user id). | **Reused as is**: ids and canonical event content. |
| `src/migration/` (local → cloud) | Plan → chunked `ON CONFLICT DO NOTHING` upload → read-back verification → progress record, repeat-safe, never overwrites. The progress marker is a per-device `localStorage` record. | The pattern (plan, chunks of 50, progress, read-back verify, retry) is reused. **The per-device marker is not reused as history**: provenance is stored in the database. |
| `src/calendar/` | `CalendarSource` (local/cloud), pessimistic mutations (`{ok:false}` = not saved), `refresh()`, auto-refresh. | After an import the app calls `source.refresh()`. The import does **not** go through `createEvent` (one request per event, no provenance, no atomicity). |
| Timetable code | `src/timetable/utn/` (parse, review model, `sourceKey`), `src/timetable/import/loadTimetable.ts`, review UI; `sourceKey = utn-wise2627\|date\|start-end\|codes\|normalised type` (no page, coordinates or room). The preview is guarded by a static test: no storage, network, Supabase or calendar code. | Identity, mapping and the review state. The new modules live in a **separate folder** so the preview guard stays strict. |
| Tests | Vitest; PGlite SQL tests with a simulated `auth.uid()`; `FakeCloud` and `e2e/cloudMock.ts`. Hosted cross-user isolation is **not yet verified**. | New SQL test follows the PGlite approach. |

## 2. Recommended schema

```
event_imports            one row per import attempt (batch)
  id, user_id, source_slug ('utn-wise2627'), source_label, source_sha256, source_published_on,
  parser_version, selection text[], planned_count, status, created_at, updated_at, written_at, verified_at
  unique (id, user_id, source_slug)

event_import_links       one row per imported SOURCE SESSION
  id, user_id, batch_id, source_slug, source_key, event_id (nullable), imported_snapshot jsonb,
  source_snapshot jsonb, retired_at, retired_reason, created_at, updated_at
  unique (user_id, source_slug, source_key)               -- a source session is imported once
  unique (event_id)                                       -- an event belongs to at most one source session
  FK (batch_id, user_id, source_slug) -> event_imports (id, user_id, source_slug)   -- same user AND lineage
  FK (event_id, user_id)              -> events (id, user_id) ON DELETE SET NULL (event_id)

public.orbit_import_sessions(p_batch, p_items)        insert-only, atomic per chunk, SECURITY INVOKER
public.orbit_forget_import_history(p_slug)            the one supported way to delete provenance, SECURITY INVOKER
```

Only the SHA-256 of the PDF is stored. The only change to an existing table is the additive unique key `events (id, user_id)`.

### Why a separate association table, not columns on `events`

| Concern | Columns on `events` | Link table (recommended) |
|---|---|---|
| User deletes an imported event | provenance disappears with the row; the next import silently **re-creates** it | the link survives as a tombstone (`event_id` NULL); the importer sees "previously imported, deleted by you" |
| Snapshot for edit detection | two jsonb columns on a table every calendar read selects | kept out of the hot calendar query |
| Existing code and tests | `EventRow`, mappers, FakeCloud, mocks and editor all see new columns | zero change to `events` columns, mappers or UI |
| Same session in two revisions / after a move | one row, one key | link can be retired, re-keyed or restored without touching the event |
| Integrity rules | triggers on a shared table | triggers only on the new tables |

### Scenario table

| Scenario | Behaviour |
|---|---|
| **Multiple revisions of one timetable** | Same `source_slug`, different `source_sha256` per batch; links are per `(user, slug, source_key)`, independent of the batch, so revision N+1 is diffed against everything ever imported from the lineage. `source_published_on` lets the UI warn when an *older* PDF is imported after a newer one. |
| **Same session imported twice** | unique key + deterministic event id → `already-linked`. **VERIFIED (offline)** |
| **Class moved to another time** | `source_key` contains the time, so a move is *removed + new*; the diff pairs them only as a **possible move** (§5). |
| **Manually edited events** | Detected field by field against `imported_snapshot` (not `updated_at`). Never overwritten by the insert-only RPC or by the diff. **VERIFIED (offline)** |
| **Deleted events** | Tombstone link, not recreated. **VERIFIED (offline)** |
| **Interrupted imports** | Each RPC call is one transaction; a failed batch is resumed (`failed → in_progress`) and the diff shows exactly the sessions without a link. **VERIFIED (offline)** |
| **Concurrent imports (two devices)** | Per user+lineage advisory lock (chunks, status changes, forget); unique keys make the second writer harmless; the loser can only end `written_partial`, never `written`. Interleaved sequential chunks and constraint violations are **VERIFIED (offline)**; truly parallel transactions are **PENDING** (hosted). |
| **Partial database failure** | A failing item aborts its chunk with nothing written; committed chunks stay and are recognised on resume. **VERIFIED (offline)** |
| **Stable source identity** | `sourceKey` (content only); event id `deterministicUuid(user + ':event', sourceKey)`. **VERIFIED (offline)** |
| **Referential integrity and ownership** | Composite FKs include `user_id`; the batch FK also includes `source_slug`. Hold even for a role that bypasses RLS. **VERIFIED (offline)** |
| **Metadata after event deletion** | Survives as a tombstone; removed only by `orbit_forget_import_history`, or by account deletion (cascade). |
| **Cleanup and retention** | Attempts that never wrote anything (`in_progress`/`failed`/`abandoned`) can be deleted directly; written history is protected. No automatic expiry: provenance is the user's history (~1.5 KB per session). |

Compatibility with existing data is **VERIFIED (offline)**: applying the proposal to a database that already holds events leaves every row and column unchanged, and manual create/edit/delete behaves as before.

## 3. Security and integrity design

RLS (`user_id = auth.uid()`) separates users. It does **not** stop a signed-in browser (a bug, injected script) from corrupting that same user's provenance, so revision 2 adds three layers.

**Layer 1: ownership by foreign key** (independent of RLS): a link can only reference a batch of the same user *and* source lineage, and an event of the same user. **VERIFIED (offline, also as the table owner)**.

**Layer 2: column privileges.** `authenticated` receives only:

| Table | Direct privileges |
|---|---|
| `event_imports` | `SELECT`; `INSERT` of `id, source_slug, source_label, source_sha256, source_published_on, parser_version, selection, planned_count` (status, timestamps and `user_id` come from defaults); `UPDATE (status)`; `DELETE` |
| `event_import_links` | `SELECT`; `UPDATE (retired_at, retired_reason)`; `INSERT` and `DELETE` (granted only because the two SECURITY INVOKER functions run with the caller's privileges; see layer 3) |

A test pins this grant matrix exactly.

**Layer 3: triggers that re-check the real state** (no SECURITY DEFINER needed):

| Rule | Mechanism |
|---|---|
| Status can only follow `in_progress → failed/abandoned/written/written_partial`, `failed → in_progress/abandoned/written/written_partial`, `written → verified` | `orbit_guard_batch_write` |
| `written` only if `count(links of the batch) = planned_count`; `written_partial` only if fewer; `verified` only if every link's event exists and `orbit_event_snapshot(event) = imported_snapshot` | same trigger, under the advisory lock |
| Everything else in a batch row is immutable; `written_at`/`verified_at` are set by the trigger | same trigger + no column privilege |
| A link may be **inserted** only by `orbit_import_sessions` (transaction-local gate `orbit.import_op = 'import'`), into an `in_progress` batch, for an event that exists, was created **after the batch started** and **equals the snapshot**, with `event_id` set and no retirement, without exceeding `planned_count` | `orbit_guard_link_insert` |
| Link identity, batch, slug, key, both snapshots, timestamps are immutable; `event_id` can change only to NULL by the foreign key's ON DELETE action (nested trigger **and** the event is really gone), so a tombstone cannot be forged and a link cannot be re-pointed | `orbit_guard_link_update` |
| Links are **deleted** only by `orbit_forget_import_history` (gate `'forget'`) or by cascade (account deletion); written/verified batches likewise | `orbit_guard_link_delete`, `orbit_guard_batch_delete` |

About the gate: `orbit.import_op` is a transaction-local setting that only the two functions set, and they clear it before returning. PostgREST clients cannot set it (`set_config` is not an exposed function, and the Supabase API gives no raw SQL to the user's role). The gate defends the table API against accidental or scripted misuse; it is **not** a defence against someone who can run arbitrary SQL as the user's role, which Supabase does not offer. `SECURITY DEFINER` is not used anywhere (asserted by a test).

### Operations matrix

| Operation | Direct table API | Via validated function |
|---|---|---|
| Create a batch | yes (identity columns only; starts `in_progress`) | – |
| Resume (`failed → in_progress`), mark `failed` / `abandoned` | yes (`UPDATE status`; transition checked) | – |
| Declare `written` / `written_partial` / `verified` | yes, but the trigger recomputes the truth and rejects false claims | – |
| Write sessions (events + links) | **no** (link insert rejected) | `orbit_import_sessions` (insert-only, atomic per chunk) |
| Retire/dismiss a session | yes (`UPDATE retired_*`) | – |
| Read batches and links | yes (own rows) | – |
| Rewrite key, snapshots, batch, slug, event, forge or clear `event_id` | **no** | – |
| Delete links, delete written/verified batches | **no** | `orbit_forget_import_history(slug)` |
| Delete an attempt that wrote nothing | yes | – |
| Update an event to match a revised PDF, re-key a confirmed move, restore a deleted event | **no (not in this checkpoint)** | future, reviewed RPCs in checkpoint 4 (they can set a new gate value; no table grants need to widen) |

### Threats

| Threat | Protection | Status |
|---|---|---|
| Read/modify/delete another user's records | RLS on all operations, `TO authenticated` only | **VERIFIED (offline)**; hosted **PENDING** |
| Create records attributed to someone else | `WITH CHECK`, no `user_id` privilege, default `auth.uid()` | **VERIFIED (offline)** |
| Link A's batch/event with B's link; link across source lineages | composite FKs | **VERIFIED (offline)** |
| Rewrite identities / snapshots, forge tombstones, re-point links, delete history (same user) | layers 2 + 3 | **VERIFIED (offline)** |
| Add links to a finished batch; exceed the plan | link trigger + RPC status check | **VERIFIED (offline)** |
| Falsify a completed/verified result | status trigger | **VERIFIED (offline)** |
| Anonymous access | no grants, no policy, `EXECUTE` revoked from `public`/`anon` | **VERIFIED (offline)**; hosted PENDING |
| Link a pre-existing manual event | event must be created after the batch started and equal the snapshot, and only the RPC can insert | **VERIFIED (offline)** |
| PDF leakage | only the SHA-256 is stored | by design |

Trade-offs: (1) the two functions are `/rpc` endpoints (the earlier phases kept the API surface small); atomic event+link writing cannot be done with plain PostgREST calls, and with `SECURITY INVOKER` plus the gates they grant nothing a user could not already do with direct inserts. (2) `INSERT`/`DELETE` privileges on links exist only so that invoker functions can work; the triggers are therefore load-bearing and are tested with a mutation check (removing the gate or the `written` rule makes tests fail). (3) `event-id-taken` reveals only that a UUID is in use (the ids are derived from the user id, so a collision with another user's event cannot happen by accident).

## 4. Import workflow (design)

`PDF → extraction → course selection → session review → **Confirmation** → batch → chunked RPC → read-back verification → calendar refresh`

Nothing is written before the explicit confirmation. The confirmation screen is a *diff*, the same for a first import and a revision:

| Section | Source | Default |
|---|---|---|
| **New** events to create | `diff.new` | included |
| **Already imported, identical** | `diff.unchanged` | nothing to do |
| **Changed in the PDF** (old/new value; "you edited this event too" for conflicts) | `diff.sourceChanged` | not applied |
| **No longer in the PDF** (never deleted) | `diff.removed` | keep |
| **Possible moves** with confidence and reason | `diff.possibleMoves` | treated as separate |
| **Ambiguous matches** | `diff.ambiguous` | nothing done; listed |
| **Deleted by you earlier** | `diff.deletedByUser` | not recreated |
| **Blocked** (event id already used) | `diff.blocked` | not imported |
| **Overlaps** among sessions to be written and existing events | review model | warning only; both events are written |
| **Excluded / invalid / needs review** | `buildImportItems().skipped` | not imported |
| **Manually corrected** sessions | `ImportItem.corrected` | imported with the corrected values |

Then an explicit "I confirm" and a summary of exactly what will be written. Sessions are one-off dated events in Europe/Berlin (never weekly recurrences); overlapping classes stay separate events.

**Write phase (checkpoint 3), lifecycle:**
1. `insert event_imports (… planned_count = N)` → `in_progress`.
2. Chunks of 50 through `orbit_import_sessions`, with progress. Outcomes: `created`, `already-linked`, `event-id-taken`.
3. `update status = 'written'` (all N created) or `'written_partial'` (some already linked/blocked). **The database refuses a false claim.**
4. Client read-back compares the server rows with its plan (same approach as `verifyImport`), then `update status = 'verified'`. The database independently re-checks that every event exists and still equals the imported content. A user edit between write and verify makes verification fail; the batch stays `written`, which is honest.
5. `source.refresh()`.
6. On error or browser crash: the batch stays `in_progress` (or is set `failed`); resume = recompute the diff from the server, send `diff.new` into the same batch (`failed → in_progress` first).

## 5. Re-import algorithm (pure function `diffRevision`, offline-tested)

Inputs: `incoming` (reviewed items of the new PDF), `links` (all links of the lineage), `events` (current calendar). Per session:

1. **Exact identity** (`source_key` present in links): tombstone → `deletedByUser`; event missing from the read although the link points to it → `ambiguous` (a stale read must not look like a deletion); otherwise compare PDF facts with `source_snapshot` and the event with `imported_snapshot`: PDF unchanged → `unchanged` (user edits kept and listed); PDF changed + event untouched → `sourceChanged/safe`; PDF changed + event edited → `sourceChanged/conflict` (never automatic).
2. **No link** → `new`, unless an event with the deterministic id exists (`blocked`, never adopted).
3. **Links the PDF no longer prints** (not retired) are candidates for `removed`, after step 4.
4. **Moved classes** (the key contains the time): a vanished link and a new session are paired only if the match is *mutual and unique*; required: identical key tail (course code(s), type, group); **high** = same date, other time; **medium** = same time slot, other date ≤ 7 days apart; anything else is not a candidate; several candidates (component larger than 1+1) → `ambiguous`, nothing paired. A pair is a **possible move**, never definite; defaults keep both sides, so a wrong guess costs nothing.
5. Leftover vanished links → `removed` (never deleted automatically; user-edited ones flagged).

**VERIFIED (offline)**: first import, identical re-import, resume, room change (safe and conflict), user-edited kept, removed, time move (high), date move (medium), far move (new + removed), ambiguous, different course/type never pairs, tombstone, blocked id, missing event, retired/reappeared.

## 6. PostgreSQL compatibility

Reviewed against PostgreSQL 15; the hosted version is **unverified** and must be checked before checkpoint 2 (`select version();` in the SQL editor, or Project Settings → Infrastructure).

| Feature | Introduced | Note |
|---|---|---|
| `FOREIGN KEY … ON DELETE SET NULL (event_id)` | **PostgreSQL 15** | the only post-14 feature; on 14 or older the migration fails at creation. A plain `SET NULL` is not an option (it would null the NOT NULL `user_id`). |
| `gen_random_uuid()` (core), `pg_advisory_xact_lock`, `hashtextextended` | 13 / 8.2 / 11 | fine |
| `EXECUTE FUNCTION` in triggers, `jsonb_*` functions, `regexp_match`, `to_char`, `pg_trigger_depth()`, column-level `GRANT`, partial/unique constraints | ≤ 11 | fine |
| `UNIQUE NULLS NOT DISTINCT` (15), `MERGE` (15), SQL/JSON constructors and `IS JSON` (16), `JSON_TABLE` (17), `RETURNING OLD/NEW` (18), `uuidv7` (18) | 15–18 | **not used** (a static test scans the SQL) |

Statements that need no later version but are worth knowing for a real server: `CREATE TABLE … REFERENCES` on a composite unique key requires that key to exist first (it does: `events_id_user_key`, `event_imports_lineage_key`); column-level `GRANT` and `pg_trigger_depth()` behave the same in 13–18. Whether a failing migration file is rolled back as a whole depends on how it is applied (a dry run on a disposable project should confirm this); do not assume it.

The offline database (PGlite 0.5.8) is PostgreSQL **18**, so PostgreSQL 15 behaviour could only be checked statically; executing the SQL on a real PostgreSQL 15 instance is **PENDING** (checkpoint 2 should run the PGlite suite, then a dry run in a disposable Supabase project or local `supabase start` on the same major version).

## 7. Rollback

The rollback SQL removes only what the proposal added; imported events stay in the calendar as ordinary events.

* **Before any import data exists** (both provenance tables empty): lossless; run it as is. It is also safe to re-apply the proposal afterwards. **VERIFIED (offline)**
* **A half-installed or half-removed state** (only one provenance table exists) is guarded table by table: rows in *either* table block the rollback, and a missing table counts as empty only for itself. The script refuses to run as a role that cannot see all rows (under RLS an empty-looking table proves nothing). The confirmation is `select set_config('orbit.confirm_drop_provenance', 'yes', true)` placed after the file's own `begin;`: **transaction-local**, so it cannot leak into a later session. If the script refuses, run `rollback;` to leave the aborted transaction. No calendar event, series or exception is ever deleted (asserted by a test that scans the file).
* **After real imports exist**: dropping the tables **destroys the provenance** (which session each event came from, the snapshots, the tombstones of events the user deleted, the batch history). That cannot be undone by the script. Afterwards the app would no longer know what was imported and a later import could create duplicates of events still in the calendar (their deterministic ids would be found "taken", so they would be skipped, but moved/edited ones could not be matched). Therefore the script **refuses to run** while rows exist unless `orbit.confirm_drop_provenance = yes` is set deliberately in the same session; an optional backup into a separate schema is documented in the file. **VERIFIED (offline): refusal drops nothing; with confirmation only provenance is removed.**
* A "safe reversal without losing provenance" does not exist for the tables themselves; the practical alternative to a rollback after use is a forward fix migration.

## 8. Offline verification (run in this repository)

| Suite | Result |
|---|---|
| `supabase/tests/import-provenance.test.ts` (PGlite: real SQL + real TypeScript builders) | 50 tests (45 + the two resume/second-device scenarios and three rollback-hardening tests; rollback now: lossless before import, refusal and transaction-local confirmation after, half-installed state, non-owner role, no calendar rows deleted) (the malformed-request test now also covers missing `source`/`event` keys and non-object items): exposure and exact grant matrix, compatibility, first import, duplicates, concurrency by constraint, id collisions (own and foreign), user edits, deletions and tombstone forging, same-account integrity (direct inserts/updates/deletes), batch lifecycle (earned success, transitions, no clamping, lock), forget, partial failure, malformed requests, cross-user isolation, account deletion, rollback (with/without data), PG15 static review. A mutation check (disabling the link gate and the `written` rule) makes 4 tests fail. |
| `src/timetable/provenance/provenance.test.ts` | 23 tests: identity, Berlin/DST times, corrections vs source facts, skipped/duplicate sessions, payload limits, batch validation, snapshot equality, every diff scenario |
| `tests/utn/provenance-isolation.test.ts` | the new TypeScript is pure, not imported by the app or preview, the proposal is not in `migrations/` |
| `tests/utn/hosted-script-guards.test.ts` | 28 tests (13 below, plus 15 for verified cleanup that fails the run, `--require-provenance`, the exit code and the script wiring): the real hosted-check script is executed as a child process; it refuses a missing/wrong confirmation, missing variables, secret or service-role keys, non-https or look-alike-local URLs and identical accounts before any request, accepts a valid `--dry-run`, never prints credentials; static checks: publishable key only, no file writes, scoped deletes with escaped `LIKE`, cleanup in `finally` through the supported forget function, coverage of every table and both RPCs for two users and anonymous |

Not verified: parallel transactions, PostgREST/JWT behaviour, the real Supabase PostgreSQL version and extensions, anything on the hosted project. `scripts/hosted-two-user-rls-check.mjs` is syntax-checked and its refusal guards run; its network logic has never run.

### Re-import and multi-device scenarios (all VERIFIED offline in `supabase/tests/import-provenance.test.ts`)

| Scenario | Expected result | Test |
|---|---|---|
| Re-importing the identical PDF | zero new events, zero new links; the repeat batch writes 0 links | "repeating the import creates nothing" |
| Interrupted batch resumed with its **original** batch id | `failed → in_progress`, only `diff.new` is sent, then `written` → `verified`; a failed batch accepts nothing until resumed and cannot claim success while incomplete | "the same interrupted batch can also be resumed with its ORIGINAL batch id" and "a chunk with one bad item…" |
| Second device creates a **new** batch for only the missing sessions | planned count = missing count; `written` → `verified`; total events = PDF sessions; diff shows nothing new | "interrupted on device 1, finished by device 2 in a NEW batch…" |
| Partially written original batch | stays labelled `written_partial`; `written`/`verified` are refused; it accepts no more sessions | same test |
| Cross-device duplicate prevention | two devices racing on the same file end with exactly one copy; the loser can only be partial; duplicates are refused by constraints even if the trigger were off | "two devices importing the same file end with exactly one copy" |
| Hosted verification reports FAIL when cleanup fails; refuses to skip required provenance checks | exit code 1 | `tests/utn/hosted-script-guards.test.ts` |

## 9. Remaining risks and trade-offs

1. The gate relies on the Supabase API not exposing raw SQL or `set_config`. If a future exposed function or extension allowed arbitrary `set_config`, same-account provenance could be rewritten again (RLS would still hold). Mitigation: keep `orbit_private` unexposed, review any new `public` function.
2. `INSERT`/`DELETE` privileges on links are required for invoker functions, so correctness rests on triggers (tested, mutation-checked).
3. `source_key` embeds the time; moves are heuristics, made harmless by keeping both sides.
4. Snapshots duplicate data already in `events` (≈1.5 KB per session) to avoid a per-device store.
5. If the user edits an event *and* the PDF changes, the user decides; there is no automatic merge.
6. `written_partial` is a label, not proof of why sessions were skipped (already linked by another batch, or blocked). The diff, not the batch, is the source of truth.
7. Hosted cross-user isolation (existing and new tables) and PostgreSQL 15 execution remain unverified.
8. Checkpoint 4 needs further reviewed RPCs (update an untouched event, re-key a confirmed move, restore) because direct updates are intentionally impossible.
9. **`planned_count` is declared by the client.** `written` proves "exactly the declared number of links exist", `verified` proves "and every event is still as imported"; neither proves the batch covered the whole PDF. A buggy or hostile client could declare a small plan. The authority for completeness is the diff against the reviewed PDF items (the next import shows anything missing), not the batch label.
10. **`source_snapshot` and `source_key` are client-asserted.** The database derives `imported_snapshot` from the event it actually stored, but it cannot know what the PDF said. A script running as the signed-in user can therefore create *new* events with fabricated provenance through `orbit_import_sessions` (insert-only; it can never touch an existing event or another user's data, and it could equally insert plain events today). It can pre-empt a real `source_key` for that user only, which makes a later genuine import report `already-linked` for it; `orbit_forget_import_history` undoes that.
11. `orbit_forget_import_history` deliberately drops tombstones: after it, a re-import recreates events the user had deleted. It must be a confirmed user action with that sentence in the dialog.
12. Adding `events_id_user_key unique (id, user_id)` builds an index on `events` and takes a short exclusive table lock; trivial for a personal calendar, but run it outside busy hours. It is dropped by the rollback.

## 10. Checkpoints

| # | Scope | Needs from the user |
|---|---|---|
| **2** | Confirm PostgreSQL ≥ 15 on the hosted project; review this revision; `git mv` the SQL into `supabase/migrations/` with a new timestamp; run the PGlite suite and (if possible) the SQL on a disposable PG15 project; **apply** after explicit approval; create the second test account; run the hosted check (two normal accounts, synthetic rows) | approve the SQL, approve applying, create the 2nd account, approve the hosted run |
| **3** | Confirmed cloud creation: batch → chunked RPC → `written` → read-back → `verified`, progress, retry/resume, `source.refresh()`; confirmation screen for the first import; mocked tests (FakeCloud + a Playwright mock of the RPC and status updates), no real data | none beyond approving the PR |
| **4** | Revision import: diff screen (§4), reviewed RPCs for safe actions, never delete automatically | decisions below |
| **5** | Production test with disposable synthetic data, then **the user's explicit real timetable import** | the user's go-ahead |

## 11. Decisions needed from the user

1. Approve the link-table design, the two SECURITY INVOKER functions and the trigger/gate model.
2. Confirm the hosted PostgreSQL major version (needs 15+).
3. Week 23 Saturday: unresolved dates stay out of the import (current behaviour). Confirm.
4. "Forget import history" as a user action in Settings: wanted?
5. Create the second test account (see the procedure) and approve the hosted check.

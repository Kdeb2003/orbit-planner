# Cloud persistence and synchronisation (Phase 3B)

When Supabase is configured and a user is signed in, ORBIT reads and writes **that user's own** calendar in the hosted database. Without configuration it keeps the local-only behaviour (browser storage).

> **Status:** implemented, unit/browser-tested against mocks, **and verified against the real hosted Supabase project** with temporary synthetic records (see “Verification status”). Hosted cross-user isolation, session expiry, a real network outage, Realtime and automatic cross-tab refresh are **not** confirmed. **No real calendar data (browser-saved events, university timetable) has been uploaded.** Options for the known limits: [proposals/cloud-sync-hardening.md](proposals/cloud-sync-hardening.md) (a proposal, not implemented).

## Architecture

```
React views / EventDialog
        │  useCalendar()  (snapshot + async operations)
        ▼
  CalendarSource  ──────────────┬────────────────────────────┐
  (src/calendar/types.ts)       │                            │
  local:  localSource.ts        cloud: cloudSource.ts        none: emptySource
  browser stores (unchanged)    per-user, async, validated   signed-out / not loaded
                                        │
                                  CloudApi (src/cloud/cloudApi.ts)  ← the only code that builds PostgREST requests
                                        │  supabase-js (publishable key + the signed-in user's session; RLS decides)
                                        ▼
                                events · recurring_series · series_exceptions
```

* `CalendarProvider` picks the source: **unconfigured → local**, **signed in → that user's cloud source**, **anything else → empty** (a signed-out visitor never gets calendar data or even a request).
* `calendarManager` owns the single per-user session (create on sign-in, **dispose on sign-out/account switch**, which clears every private record from memory). The provider additionally refuses to expose a session whose `userId` differs from the current user.
* The scheduling logic (recurrence expansion, conflicts, summaries) is untouched and operates on the arrays the source provides.
* All mutations are **asynchronous and pessimistic**: they resolve `{ok:true}` only after the server confirmed the write, and the visible data changes only from the server's returned row. There are no optimistic updates, so there is nothing to roll back and a failed write can never look saved.

## Data mapping (`src/cloud/mappers.ts`)

| Topic | Handling |
|---|---|
| UUID ids | New rows get `crypto.randomUUID()`. The dialog keeps **one id per dialog**, so a retried save addresses the same row (insert is `ON CONFLICT (id) DO NOTHING`, then verified) and cannot duplicate. Legacy ids (import only) → deterministic UUID (SHA-1, v5 layout) from `user:kind:legacyId`; real UUIDs are kept. |
| Optional ↔ NULL | blanks → `NULL` on write (trimmed); `NULL` → field absent on read. |
| Length limits | validated before any request (title 1–120, location 120, notes 2000, course code 30, group label 40) with a clear message. |
| Time zones | must be a real IANA name ≤ 64 chars (also enforced by a DB trigger). |
| Recurrence span | ≤ 1100 days, weekdays 0–6 unique, same-day end > start, offset 0–6. |
| Orphaned exceptions | tolerated, **kept** and reported; only removed after the user confirms in the series dialog. The import keeps them unchanged and counts them in the preview. |
| Server timestamps | `updated_at`/`user_id` are never sent. `updated_at` is stored **raw** and used as the version token. `created_at` is sent only by the explicit import. |
| DST | one-off events: UTC instants. Series: local `HH:mm` + zone (`time` columns), so 09:00 Europe/Berlin stays 09:00; a test proves a series mapped through the DB shape generates identical instants across the spring change. |
| University metadata | `courseCode`/`sessionType`/`groupLabel` ↔ `course_code`/`session_type`/`group_label`, also inside exception overrides. |

## Synchronisation

* **Loads:** on sign-in; after every successful write; on tab focus, visibility, `online`; every 60 s while the tab is visible (min. 2 s between refreshes); and via the Retry controls. Reads page through all rows (PostgREST caps responses at 1000).
* **Stale protection:** a read that started before a write finished is discarded and repeated, so an old snapshot never overwrites newer data (tested, including a mutation check). Responses for a disposed (signed-out / switched) session are ignored.
* **Realtime (optional, off by default):** `VITE_ENABLE_REALTIME=true` subscribes to the three tables and simply triggers the same refresh (debounced). It needs the tables in the `supabase_realtime` publication (Dashboard → Database → Publications); no SQL migration is added. It is **untested against the hosted project**; polling is the dependable path.
* **Conflicts (what is and is not enforced):**
  * Events and series: **optimistic concurrency** on `updated_at` (`UPDATE/DELETE … WHERE id = ? AND updated_at = ?`). A stale edit is rejected with “This changed on another device…”, the latest data is reloaded and nothing is overwritten.
  * Exceptions: **last writer wins** per occurrence (primary key `(series_id, original_date)`), no version check.
  * Saving a series update and removing its outdated exceptions are **two requests, not a transaction**. The schedule is saved first, then the confirmed exceptions are deleted; if the second half fails the series is saved, the leftovers stay as harmless orphans and an error says so.
  * Not enforceable with the current schema: atomic multi-row changes and conflict detection for exceptions. A future migration could add an RPC (transactional series+exceptions update) and a version column on exceptions. **Not added; needs your approval.**
* **Offline:** reads keep the last good data and show “Offline”; writes fail with a clear message (nothing is queued). Requests time out after 20 s; the outcome is then treated as unknown and the calendar is re-read.

## UI indicators

Header chip: `Local only` (browser storage, never called synced) · `Loading calendar…` · `Saving…` · `Saved to cloud` · `Sync error · Retry` · `Offline · Retry`. A banner with Retry/Dismiss appears for a failed load/refresh/restore. A failed save keeps the dialog open with “Not saved. …” and a retry. Routine successes are silent.

## Local backup and explicit import (Settings → “Import events saved in this browser”)

Existing local data is **never merged automatically** and is **never shown as the account's data**. Procedure:

1. **Download backup (JSON)** – byte-exact raw values of `orbit.events.v1` / `orbit.series.v1` plus readable copies and counts.
2. **Preview import** – reads the cloud, shows how many events/series/exceptions are *new*, *already in the cloud*, *conflicting* (same id, different content → skipped, never overwritten), *invalid* (with reasons) and how many exceptions no longer match their schedule (kept). Nothing is sent.
3. **Confirm** – the upload button needs the backup download **and** an explicit checkbox.
4. **Upload** – events, then series, then exceptions, in chunks, with `ON CONFLICT DO NOTHING` inserts keyed by deterministic ids.
5. **Verify** – the cloud is read back and every imported record is compared. Only then is the marker (`orbit.cloudImport.v1`, own key, includes the id map) set to *verified* (or *verified with skips*). A failure at any point is shown, recorded as *failed*, and the import can simply be run again: ids are deterministic, so completed parts become “already in the cloud” and only the missing part (e.g. exceptions after an interrupted series) is uploaded.

The browser data is **never deleted or modified** by the import (a static test forbids delete/clear code in these modules).

## Error handling

Every failure becomes a `CloudError` (`network | auth | permission | conflict | validation | unknown`) with a user-safe message (no URLs, tokens or SQL details). Validation runs before the network. Nothing is swallowed: failed writes return `ok:false`, keep the dialog open and set the visible error state.

## Security assumptions

* Browser uses only the publishable key + the user's own session; **RLS** (deployed) is the authority. No service-role key, DB password or token is in code, logs or tests.
* The client never sends `user_id`; the database default (`auth.uid()`) and the policies assign/check it.
* Sign-out and account switch dispose the cloud session and drop all private data from memory; cloud code never touches `orbit.events.v1` / `orbit.series.v1` (static test).
* Legacy local storage is not per-user; that is why it is never displayed once signed in and only reachable through the explicit import.

## Verification status

### Tested against the REAL hosted Supabase project (temporary synthetic rows titled `ORBIT_QA_CLOUD_SYNC_…`, signed in as the owner)

| Area | Result |
|---|---|
| One-off event create → read back → update → delete (row absent afterwards) | PASS |
| Recurring series (Mon/Wed) create/read, exceptions: cancel, move, restore, replace, delete series | PASS |
| Berlin DST: 09:00 local stays 09:00 across the spring change (08:00Z before, 07:00Z after) from rows read back from the database | PASS |
| Duplicate-create prevention (same id twice → one row) | PASS |
| Optimistic concurrency on the raw `updated_at` (microsecond text round-trips): a stale event edit and a stale series edit are rejected, nothing overwritten | PASS |
| Series update where step 2 (exception cleanup) fails — the failure was **injected** after a real step 1 — reports partial completion, loses nothing, retry completes | PASS |
| Synthetic import (in-memory records through the real import code): preview without writes, upload, read-back verification, repeat creates no duplicates, interrupted upload (**injected**) resumed, a deleted record detected by verification | PASS |
| Anonymous SELECT and INSERT denied (publishable key, no session) | PASS |
| Records appear in Today and Calendar; records survive a browser reload | PASS |
| A rename in one tab was seen in another tab | Observed, **but it was not confirmed whether it appeared without a manual refresh**, so automatic cross-tab refresh is *not* claimed as verified |
| Cleanup: tracked rows deleted, and a scan for the prefix found none | PASS (no test rows remain) |

The temporary console used for this run has been removed from the code base; its scenarios are not part of the app.

### Mocked only (unit tests with an in-memory cloud, Playwright with a mocked REST API, PGlite SQL simulation)

Account switching and sign-out clearing, stale/late responses, timeouts, offline reads and failed writes, the status chip and banners, auto-refresh on focus/online/poll, optional Realtime, the Import card UI (backup download, preview, confirmation, progress), invalid/conflicting import records, phone-sized layouts.

### NOT tested yet

* **Cross-user isolation on the hosted project** (needs two different real accounts; public sign-up is closed, so create a temporary user in *Authentication → Users → Add user* or use a disposable project, check that it sees none of your rows and vice-versa, then delete that user).
* **Session expiry / revoked token** mid-use. Manual: sign out and confirm the sign-in page shows no calendar text; sign in again and the data returns.
* **A real network outage.** Manual: DevTools → Network → *Offline*, try to save (“Not saved”, dialog stays open), go *Online*, save again → exactly one row.
* **Automatic cross-tab refresh** without a manual reload (expected within the focus/60 s polling window; unconfirmed).
* **Realtime** (off by default).
* The **real Import card with real browser data**. The user's actual browser calendar and university timetable have **not** been imported.

## Known limitations (all still present; none was changed in this checkpoint)

1. **Exceptions are last-writer-wins.** Two devices editing the same occurrence at nearly the same time: the later write replaces the earlier one without a warning.
2. **A series update and its exception cleanup are not atomic** (two requests). If the second fails the series is saved, the exceptions are kept, an error says so and a retry is safe.
3. **Offline writes are not queued.** A failed save is reported and must be retried by the user.
4. **Realtime is optional and disabled by default** (`VITE_ENABLE_REALTIME=true`, needs the tables in the realtime publication); polling and focus refresh are the dependable path.
5. **Hosted cross-user isolation has not been tested with two accounts** (RLS is covered by the PGlite simulation and the anonymous denial above).
6. **Automatic cross-tab refresh is unconfirmed** on the hosted project.
7. A rejected-but-not-expired token shows an error and the last data until supabase-js signs out; legacy browser storage is not per-user (hence never shown when signed in); the bundle is ≈590 kB (170 kB gzip).

## Remaining before deployment

Cross-user isolation test · decide on the proposals (exception versioning is possible client-side without a migration; an atomic series update would need one; both need approval) · optional manual checks above · the user's own explicit, backed-up import when wanted · per-user namespacing or cleanup of legacy browser storage · PWA/offline queue (Phase 4) · GitHub Pages deployment and redirect URLs (Phase 5).

# Confirm & Save to Calendar (Phase 4A.3, checkpoint 3)

The last step of the UTN importer ("Summary") can save the reviewed sessions into the signed-in user's cloud calendar. It uses the approved provenance design ([../proposals/timetable-import-provenance.md](../proposals/timetable-import-provenance.md)) and the RPC `orbit_import_sessions`; it never writes events or links directly.

## Availability (read this first)

* **OFF by default in source; ON in the production deploy workflow.** The provenance migration is applied to the hosted project and the hosted two-account RLS/provenance check passed (79 passed, 0 failed). The Save area only exists when the build sets `VITE_ENABLE_TIMETABLE_SAVE=true`; otherwise the page is exactly the preview with its "Preview only" notice.
* **Even when enabled it probes the server** (both tables and the RPC, read-only). If they are missing the card says "Saving is not available here" and offers nothing to click.
* **Needs a signed-in cloud account.** In local mode / signed out it shows "Sign in to save".

## Trying it LOCALLY (local Docker Supabase only)

Use process environment variables so `.env.local` (your hosted settings) is never touched; Vite gives them priority:

```powershell
$env:VITE_SUPABASE_URL = 'http://127.0.0.1:54321'
$env:VITE_SUPABASE_PUBLISHABLE_KEY = '<local publishable/anon key from `supabase status`>'
$env:VITE_ENABLE_TIMETABLE_SAVE = 'true'
npm run dev
```

Sign in with a LOCAL test user, open Import timetable, load a PDF, review, go to step 4 · Summary, press **Review what will be saved**, then **Confirm & Save to Calendar**. Close the shell afterwards. Do not point this at the hosted project until the migration has been reviewed and applied there.

## What happens on "Confirm & Save to Calendar"

1. **Review what will be saved** reads (never writes) your cloud events, the provenance links and open batches, builds the import items from the *selected, ready* sessions only and runs the diff. The confirmation shows: sessions to create, already in your calendar, skipped (excluded / needing review), overlapping sessions, plus notes: edited imported events kept, sessions not recreated (event you deleted, or an id owned by another event), differences from an earlier import (listed, never applied).
2. **Confirm** re-plans from the server (so a retry or a second device only sends what is still missing), then:
   1. closes interrupted batches that cannot be continued (`written_partial` if they wrote something, otherwise `abandoned`); a *fresh* `in_progress` batch from another tab/device (< 15 min) blocks the save instead of racing it;
   2. creates the batch (`planned_count` = the number of NEW events this batch will write, not the PDF total) or resumes the interrupted batch of the same file when `planned = already written + still missing`;
   3. sends the missing sessions in chunks of 50 through `orbit_import_sessions` (progress shown);
   4. asks the server for `written` (accepted only when exactly `planned_count` links exist) or `written_partial` (fewer);
   5. reads events and links back and compares every saved session with what was reviewed (event content and the PDF facts);
   6. asks the server for `verified` (re-checks that every event still equals what was imported);
   7. refreshes the calendar.
3. **"Saved and verified" is shown only after steps 4, 5 and 6 all succeeded.** A partial batch is labelled "Partly saved"; a read-back mismatch is "Saved, but not verified"; a server refusal or an error is "Not fully saved".

## Duplicate prevention and retry

* Event ids are deterministic per user and source session, links are unique per `(user, source, session key)`, and the RPC is insert-only: re-sending a chunk yields `already-linked`.
* Re-importing the identical PDF: the diff has nothing new, so **no batch and no events are created** ("Nothing new to save").
* Failure midway: the batch is marked `failed`, the UI says how many sessions were saved and offers **Retry**, which resumes the **same batch** and sends only the missing sessions. A lost acknowledgement when creating the batch is detected by re-reading, not by creating a second batch.
* Manual events, edited imported events and events from earlier imports are never updated, adopted or deleted. An event you deleted after importing stays deleted (tombstone).

## Tests

| Suite | What it proves |
|---|---|
| `supabase/tests/save-import.test.ts` (17, PGlite, the REAL SQL) | first save; only selected sessions; planning writes nothing; identical re-import; manual/edited/deleted events; id collisions; race ending partial; two users; failure + same-batch retry; failure while finishing; lost batch acknowledgement; changed selection; other device running; read-back tamper; server refusing `verified`; feature not installed |
| `src/components/timetableSave/SaveCard.ui.test.tsx` (8, jsdom, mocked backend) | no account; unavailable backend; loading and counts before any write; confirm → verified → calendar refreshed; identical re-import; failure + retry; refused verification; other device |
| `tests/utn/provenance-isolation.test.ts`, `preview-isolation.test.ts` | the provenance modules stay pure; only the reviewed save files use them and only `src/cloud/importApi.ts` touches the tables/RPC; saving is off by default; the preview code still has no storage/network/calendar code |

## Limits

* Verified locally against PGlite (PostgreSQL 18), not against a real PostgREST/JWT stack from the browser UI; manual local UI testing is the next step.
* Only creating new events is supported. Applying PDF changes to existing events, confirmed moves and restoring deleted events need the later reviewed RPCs (checkpoint 4).
* `published_on` is not extracted from the PDF yet (stored as null); the label comes from the semester printed in the PDF.

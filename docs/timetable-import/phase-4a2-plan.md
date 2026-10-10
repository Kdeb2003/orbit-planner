# Phase 4A.2 plan: importing the timetable through the app

> **Progress:** checkpoint 1 (steps 1-5 below, preview only) is implemented, see [import-review-ui.md](import-review-ui.md). Steps 6-8 (confirmation, cloud write, updated-timetable diff) and durable course preferences are **not** implemented, and no migration was added.

Goal: the user picks the timetable PDF in ORBIT, reviews what was found, and explicitly confirms; only then are dated one-off events written to their own cloud calendar. Everything below builds on `src/timetable/utn/` (Phase 4A.1) and the existing cloud/migration layers.

## Decisions already taken (carry over unchanged)

* Preserve what the source shows: no invented LLM x Robotics clash on 20 Oct; all 29 clashes are kept and shown, never filtered; week 23 Saturday stays flagged and unresolved; AI Group A excluded, Group B included; German A2 imported as the actual dated sessions (incl. the March blocks); identical consecutive slots merged by default with the slot provenance kept; the timetable is preliminary.
* Dated one-off events, never inferred weekly series.

## Flow

1. **Choose PDF** (`<input type="file">`, Settings or a new "Import timetable" card next to the existing import card). Read with `FileReader`/`arrayBuffer`, parse in the page with PDF.js (`extractFromPdf`). No network request carries the file; a Playwright test asserts no request leaves the origin during parsing.
   * PDF.js needs its worker. Bundle the worker and load PDF.js lazily (dynamic `import()`) so the main bundle (≈590 kB) is unchanged; standard-font data is not needed (verified).
2. **Gate on `extraction.supported`**. If `problems` has an error (scan, other layout, no weeks) show it and stop; never show partial sessions from an unsupported document.
3. **Select courses.** Course choices become a user setting (today hard-coded in `selection.ts`): list the codes found (with legend titles, German courses by code), tick courses, and for courses with groups choose the group (AI: A or B; default B for this user). Persist the choice with the account, not in the repo.
4. **Review list**: sessions grouped by date with weekday, time, course, type, group, room/online, week and PDF page, a confidence badge, `needs-review` reasons, a clash badge per day, and the date range / counts per course. Anomalies from the source (week 1 undated, week 23 Saturday) shown prominently with "not importable until you confirm the date".
5. **Per-session control**: exclude, or correct (time, room, title) before import. A corrected session is marked `edited` and keeps the original extracted values for the diff. Sessions without a usable date cannot be selected until the user enters a date.
6. **Confirm**: summary ("168 new events, 0 changed, 0 unchanged, 3 weeks undated") and an explicit checkbox, like the existing backup-then-confirm import. No write happens before this. Offer "merge identical consecutive slots" (default on) vs one event per slot.
7. **Write**: through the existing cloud source only (`createCloudSource(api)`), with ids from `deterministicUuid(`${userId}:event`, importKey)`, the same `ON CONFLICT (id) DO NOTHING` + read-back verification and progress/failure reporting as `src/migration`. Repeating the import creates nothing new.
8. **Updated timetable**: extract again, compute a diff by `sourceKey` against what the user previously imported, and show Added / Removed / Changed (room, title) / Unchanged. Only Added is selected by default. **Never** overwrite an event that the user edited and **never** delete automatically: "Removed" and "Changed" are listed with explicit per-item actions (keep, update, delete) and deletion needs its own confirmation.

## Identity and "was it edited?"

* `sourceKey` (course, date, time, type/group) is the identity. A room change keeps the same id; a time change creates a different key and appears as removed + added (shown together as a likely move).
* To tell "changed in the new PDF" from "edited by the user" the importer needs the **content as imported**. Current schema has no field for that (below), so the MVP records, per user, a local snapshot (`orbit.timetableImport.v1`: `sourceKey`, the id, the written content hash and the `updated_at` returned by the server). An event whose current `updated_at` differs from the recorded one was edited and is never touched. Limitation: the snapshot is per browser/device.

## Schema review (no migration proposed yet)

`events` columns: `title` (1-120), `category`, `starts_at`, `ends_at`, `time_zone`, `location` (<=120), `description` (<=2000), `course_code` (<=30), `session_type` in (`main`, `tutorial`, `seminar`, `practical`, `other`), `group_label` (<=40), `created_at`, `updated_at`; `user_id` is server-assigned; applied migrations are immutable.

| Need | Fits today? | Limitation / workaround |
|---|---|---|
| Course code, group, location, times, DST | Yes | `W26M-Deutsch A2` (15) fits the 30-char limit |
| Session type project / excursion / German | No | map to `other` (loses nothing important; the type text can go into the description) |
| Source version / import provenance | Partly | no source columns. Put a short human-readable line in `description` (source name, "preliminary 28 Sep 2026", week, page). It is user-editable, so it is informational, not authoritative |
| Detect user edits / diff against previous import | Partly | needs the imported content: local snapshot (per device) or a new table |
| Multiple source slots per merged event | No | keep only in description / local snapshot |
| Link event to import batch and source hash | No | would need new columns or table |

**If** cross-device edit detection and durable provenance are wanted, propose (needs explicit approval, new migration only): `event_imports(id, user_id, source_label, source_sha256, imported_at)` and nullable `events.import_id` + `events.source_key` (+ unique `(user_id, source_key)` partial index), with RLS per `user_id` like the existing tables. Recommendation: **ship 4A.2 without a migration** (deterministic ids + local snapshot + description line), decide on the migration after real use.

## Safety and tests to include

* Parsing makes no network request; no PDF bytes, session lists or file names are logged or stored remotely.
* Pessimistic writes only (`{ok:true}` after server confirmation); a failed batch is reported and resumable, never claimed saved.
* Playwright: upload the committed fixture rendered to a small test PDF (or inject `PageLayout` through a test hook), review, exclude one session, confirm, assert events appear in the mocked cloud; re-import creates nothing; changed-room diff; an edited event is never overwritten; unsupported PDF shows the error; phone width 390/320.
* Unit: course/group selection settings, diff algorithm (added/removed/changed/edited), key stability across room changes.

## Open questions for the user before building

1. Week 23 Saturday: confirm the intended date (06.03.2027?) or leave excluded.
2. Merge default (one event per block) acceptable, or one per slot?
3. Is an optional migration for provenance wanted, or is the local snapshot plus description line enough?

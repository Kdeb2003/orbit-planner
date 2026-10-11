# Phase 4B — Future integration architecture

**Nothing here is built in Phase 4B.** This document fixes the *boundaries* so later phases need no rewrite. Labels: **[Fact]** · **[Rec]** · **[Open]** ([OPEN_DECISIONS.md](OPEN_DECISIONS.md)). Data model: [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [DATABASE_PROPOSAL.md](DATABASE_PROPOSAL.md).

## 0. Shared principles

1. **Import = preview → review → confirm → idempotent write → provenance.** Proven by the UTN importer [Fact: `src/timetable/`, `event_imports`, `event_import_links`]. Every new importer reuses this shape; none writes on its own.
2. **Stable external identity scoped to a provider instance:** `(external_source, external_instance, external_id)` on tasks and exams (all three or none), unique per user. Identifiers are only unique within one installation — two institutions' Canvas sites (or two ICS feeds) must never share a namespace, so `external_instance` names the specific instance (e.g. the Canvas host name, or a user-chosen label for an ICS file whose host is unknown). Reserved in 4B, unused by the MVP.
3. **Never overwrite a user's edit.** Imported fields are compared against an `imported_snapshot`; a differing field is a *proposed change* shown to the user, never applied silently [Fact rule from provenance].
4. **Secrets never reach the browser.** Anything needing a provider key or a user's third-party token runs server-side (Supabase Edge Function or similar), authenticated with the user's Supabase JWT, with per-user rate/cost limits. The browser only holds the publishable key [Fact rule].
5. **Private by default.** Source files (PDF/image) are processed and discarded; only extracted, user-confirmed rows and a SHA-256 are stored [Fact pattern: provenance stores SHA-256 only].
6. **Human in the loop** for anything uncertain; confidence is shown, not hidden.

## 1. Canvas LMS

### 1.1 Stage 1 — ICS import (recommended first; no credentials)
* Input: the user's Canvas **calendar feed (.ics) file or pasted URL contents**. Prefer **file upload / paste** over server-side URL fetching: a subscription URL contains a secret token, and fetching it from the browser is blocked by CORS anyway.
* Parse in the browser (pure TypeScript module under `src/integrations/canvas/ics/`, same isolation rules as `src/timetable/utn`). Extract VEVENT: `UID`, `SUMMARY`, `DTSTART`, `DTEND`, `DESCRIPTION`, `URL`, `CATEGORIES`, `LAST-MODIFIED`.
* **Classification is evidence-based, never "everything from Canvas is an assignment".** Each VEVENT becomes a *candidate* classified as `assignment-deadline`, `calendar-event` (class, office hour…), `possible-exam` or `unclassified`, with the evidence shown in review (e.g. UID pattern, URL path, `CATEGORIES`, keywords such as "exam"/"quiz"). The concrete Canvas feed markers are **not assumed here and must be verified against a real feed during that phase**. Default for `unclassified` is "skip"; the user decides per item.
* Mapping after review: confirmed assignment deadlines → **tasks** (`kind=assignment`, `external_source='canvas'`, `external_instance=<host or chosen label>`, `external_id=UID`, `external_url=URL`); calendar-type items → offered as events (through the existing event path), never as tasks; exams are never created automatically (the user marks a candidate as an exam → an exam row). Course is matched by the same normalised-code rule (DOMAIN §6) or chosen by the user.
* Date handling: `VALUE=DATE` → date-only task; `DTSTART` with `Z` or `TZID` → instant → converted to `due_date`+`due_time`+zone [uses time utils].
* Duplicate detection / update: key `(user_id, 'canvas', external_instance, UID)`. Re-import classes each item: **new**, **unchanged**, **changed upstream** (title/due moved), **changed locally** (user edited), **conflict** (both). Only *new* are pre-selected; *changed upstream* are offered as per-field "apply Canvas change" choices; local edits are kept.
* Provenance (future migration, modelled on 4A.3): `external_imports` (batch, source hash, counts) + `external_import_links` (UID ↔ task/exam, `imported_snapshot`, `source_snapshot`, tombstone when the user deletes the task so it is not resurrected).
* Removal upstream: an item missing from a newer feed is **flagged** ("no longer in Canvas"), never deleted.

### 1.2 Stage 2 — Canvas API (optional, later)
* Needs a per-user access token or OAuth. **Tokens are credentials**: stored server-side only (encrypted, per user, RLS-isolated, never selectable by the client), revocable from Settings; a separate threat model and explicit approval precede any implementation. No token is requested in 4B or 4C.
* Same mapping, review and provenance as ICS; API adds submission status, points, announcements (all out of scope initially).
* Institution-specific base URL is part of the integration record, supporting multiple institutions.

## 2. Work-roster import (screenshots, photos, PDFs, CSV)

Architecture: **Acquire → Extract → Normalise → Review → Save**.

| Stage | Design |
| --- | --- |
| Acquire | Image (PNG/JPEG/HEIC), PDF, or CSV chosen by the user; size/type limits like `loadTimetable.ts` (25 MB, magic-number check) [Fact]. Camera capture on mobile via file input |
| Extract | Pluggable `RosterExtractor` returning candidate rows with per-field confidence and bounding regions. CSV/PDF-with-text extractors are deterministic and local. Image OCR/vision is a separate, optional server-side extractor (cost, privacy) [Open] O-8 |
| Normalise | Pure module: dates, overnight shifts (end ≤ start ⇒ next day, mapped to `endDayOffset`), time zone, employer, role |
| Multiple employees | The roster is a **table of people × days**. Extraction produces *all* rows; the review step makes the user pick **their own name/row** (remembered as a non-sensitive alias on the device/account). Rows of other people are discarded in memory and never stored or sent anywhere beyond the extractor |
| Uncertainty | Unreadable/ambiguous cells (smudged digits, missing date, `0`/`O`, 12h vs 24h) become **flagged rows that cannot be saved until corrected** — same rule as undated UTN sessions [Fact]. Dates are printed dates, never inferred from week arithmetic [Fact principle] |
| Review | Reuse the review UI patterns (`ImportTimetablePage`): per-row include/exclude, edit, clash list against existing events |
| Save | Dated one-off `work` events through the existing events path + provenance; weekly repeating shifts only when the user explicitly requests a series |
| Privacy | Images are not stored; only the SHA-256 and the user's confirmed rows. **Rules that must be settled before any server-side or third-party processing is built:** (1) local-only extraction is the default and must be offered first; (2) an image or text containing other employees' names or hours leaves the device only after an explicit per-upload opt-in that says so; (3) data minimisation: the user crops or masks everyone else's rows **on the device before upload**, and only that region is sent; (4) the processing provider must be contractually no-retention / no-training and its location known; (5) no logging of image or extracted content; (6) other people's rows are never saved, never used to build any alias or roster, and never shown back except in the on-screen review; (7) a privacy/legal review (the owner and coworkers are in Germany, so GDPR applies to third-party personal data) is a gate, not a detail. These rules are requirements for the later phase, not decisions made now |

Dependency from 4B: none beyond the shared review pattern; shifts stay in `events`.

## 3. AI onboarding and preferences (data only)

A future `user_preferences` record (versioned JSON, validated, user-editable, deletable) capturing: sleep window, preferred study windows, commute durations (per place), break length/frequency, daily and weekly workload caps, goals (hours per course), priorities, flexibility ("never schedule before 09:00", "keep Sundays free"). Collected by a plain form first; an AI chat may *fill the same form* but the form is the source of truth. Nothing is inferred silently; all fields optional.

## 4. Automatic routine generation

Two strictly separated layers:

1. **Deterministic planner (no AI, testable, offline):** inputs = fixed commitments (events/series occurrences, confirmed exams), tasks (due, estimate, priority, status), preferences. Computes **free intervals**, applies hard constraints (sleep, commute, no overlap with fixed commitments, daily caps) and produces *proposed* `PlannedBlock`s by a documented heuristic (e.g. earliest-deadline-first with priority weights and buffers). Output includes *why* each block is placed and which constraint blocked others. Same input ⇒ same output (unit-testable, golden tests).
2. **AI assistant (optional, advisory):** receives a **minimised, user-approved summary** (not raw data) and may suggest *changes to preferences, task splitting, or ordering*, and explain trade-offs. Its output is **validated against the deterministic constraints** and is treated as untrusted text: it cannot create or modify events directly.

Guarantees
* Proposals are shown as a diff; **nothing is written until the user accepts**. The planner and the AI **may only propose new `PlannedBlock`s** (and suggestions the user may act on by hand); they can never create, modify, move or delete confirmed user commitments — events, series occurrences, confirmed exams, tasks, or blocks the user pinned. Changing a commitment is always the user's own edit through the normal pessimistic path.
* A `PlannedBlock` is **not** a task due date: the due date is a deadline marker on the task; the block is separate, optional, deletable time reserved to work on it (DOMAIN §2.4).
* `PlannedBlock.created_by` records whether a block was user-made or an accepted suggestion; suggestion blocks can be bulk-cleared by the user without touching anything else.
* A re-plan never moves a block the user pinned/edited.
* AI calls go through a server function holding the provider key, with: authenticated user, per-user daily request/token budget, input size cap, no logging of content, a kill-switch flag, and a documented data-retention statement. No key in frontend, tests or Git [Fact rules].
* Cost control: planner runs locally for free; AI only on explicit user action.

## 5. Privacy, cost and security boundaries

| Concern | Boundary |
| --- | --- |
| Credentials (Canvas token, AI key) | Server-side only, per-user isolated, never returned to the client; separate approval before any implementation |
| Personal data to third parties | Explicit opt-in per feature; send the minimum; document what is sent |
| Third-party people's data (rosters) | Never persisted; only the user's own rows saved |
| Cost | Hard per-user budgets and a global kill-switch before enabling any paid extractor/model |
| Integrity | All imports idempotent, provenance-tracked, never auto-overwrite, never auto-delete |
| Verification | Every new table gets the hosted two-account RLS check before its UI is enabled [Fact process] |

## 6. Dependencies and recommended order

1. 4B.1–4B.4 (courses, tasks, exams, agenda projection, external-id columns).
2. **Canvas ICS import** (needs 4B tasks + external ids + review pattern).
3. Planned blocks + Study Planner on real data (needs tasks/exams; no AI).
4. Reminders/PWA (needs due dates; Phase 5 in the roadmap [Fact]).
5. Work-roster import (independent; needs only events + review pattern; extractor decision O-8).
6. Preference profile → deterministic scheduler → AI advisory layer.
7. Canvas API (needs a server component and token storage design).

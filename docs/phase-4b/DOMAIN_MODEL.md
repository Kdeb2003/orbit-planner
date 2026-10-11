# Phase 4B — Domain model

Labels: **[Fact]** verified in repo · **[Rec]** recommendation · **[Open]** needs decision ([OPEN_DECISIONS.md](OPEN_DECISIONS.md)). Persistence detail lives in [DATABASE_PROPOSAL.md](DATABASE_PROPOSAL.md); scope in [PRODUCT_SCOPE.md](PRODUCT_SCOPE.md).

## 1. Existing model (facts the design must respect)

* **[Fact]** `CalendarEvent`: UTC `start`/`end` + IANA `timeZone`; categories `university, work, study, german, research, personal, deadline`; optional `courseCode`, `sessionType`, `groupLabel`.
* **[Fact]** `RecurringSeries`: ONE record with local wall-clock times + zone, embedded `exceptions`; occurrences are generated, never stored; identity `"<seriesId>:<originalDate>"`.
* **[Fact]** Days are `DateKey` strings bucketed in Europe/Berlin (`src/utils/time.ts`).
* **[Fact]** Imported events are linked to import provenance (`event_import_links`); an event that differs from its `imported_snapshot` must never be overwritten by a re-import. The snapshot (`orbit_event_snapshot`) covers only the listed event columns.
* **[Fact]** Deadlines never take part in conflicts (`conflicts.ts`).

## 2. Entities

```
Course 1 ──< Task            (task.course_id, optional)
Course 1 ──< Exam            (exam.course_id, required)
Exam   1 ──< Task            (task.exam_id, optional, added in 4B.3; "study for this exam"; same course)
Course  ~~~ CalendarEvent / RecurringSeries   (DERIVED by course code, no stored FK in the MVP)
Task   1 ──< PlannedBlock    (future; time reserved to work on the task)
```

### 2.1 Course
A subject the user studies or works on in one **term** at one **institution**. Fields: name, optional code, optional institution, optional term label (free text, e.g. "WS 2026/27"), optional description, colour key, archive state.

* Course code is **optional**; the course is identified by its `id`, never by its code. [Rec]
* The same code may legitimately exist in two terms or at two institutions. Uniqueness (database) is on the **normalised** `(code, institution, term_label)` and applies only when a code is present (rule N, §6.1). [Rec]
* **Term fields.** `term_label` is display text only and is **never** used for matching. `term_start`/`term_end` (both set or both empty, `term_end >= term_start`) are the only fields used to tell semesters apart when matching sessions. A course without term dates still works, but cannot be told apart from another course with the same code (§6.2). [Rec]
* **Institution** is descriptive and used for uniqueness only; calendar events carry no institution, so it cannot take part in matching (§6.2). [Rec]
* "Project" for non-students is a later presentation alias of Course ([Open] O-12).

### 2.2 Task
One unit of work with at most one due date. **Assignments are tasks** with `kind = 'assignment'`; there is no second engine. Fields in [DATABASE_PROPOSAL.md §3.2](DATABASE_PROPOSAL.md).

Kinds (closed set, [Rec]): `assignment`, `study`, `reading`, `project`, `admin`, `personal`, `other`.
Priority: `low | normal | high`.

### 2.3 Exam
A specialised, scheduled assessment. It is **not** a task because it has a date state (unknown / tentative / confirmed), optional times, a location and delivery, and a preparation state that a task lacks, and because it can be placed on the calendar as a block or an all-day marker. Its preparation work is expressed as **tasks linked by `exam_id`** (kind `study`).

### 2.4 Planned study session (future, designed now)
A `PlannedBlock` reserves a time range for working on one task (or exam). It is the *only* thing that occupies calendar time on behalf of a task. A due date never occupies time.

| Concept | Meaning | Occupies time? | Participates in conflicts? |
| --- | --- | --- | --- |
| Class / shift / personal event | Fixed commitment | yes | yes |
| Task due date | Deadline for the work | no (a point/all-day marker) | no |
| Exam (confirmed, with times) | Fixed commitment | yes | yes, non-blocking warning |
| Exam (confirmed date-only, tentative, unknown) | Known or possible day, no time range | no (marker or nothing) | no |
| PlannedBlock (future) | Intended work time | yes | yes, but "soft" (can be moved by the scheduler, never auto-overwrites a fixed commitment) |

## 3. Ownership and isolation

Every row has `user_id` (server default `auth.uid()`, immutable). Cross-entity references are **composite foreign keys that include `user_id`** (`task.course_id`, `exam.course_id`, and from 4B.3 `task.exam_id`, which also carries the course), so a row cannot reference another user's row even for a role that bypasses RLS (same technique as `event_import_links` [Fact]). See DATABASE_PROPOSAL §3 and §5.

**Task / exam / course rule (single rule, enforced by the database):** a task linked to an exam must have a course, and that course is the exam's course. An exam's course cannot be changed while tasks are linked to it (the user unlinks them first). `tasks.exam_id` does not exist until the exams migration (4B.3).

## 4. Lifecycle and status rules

### Course
`active → archived → active` (reversible). Archive sets `archived_at`; it deletes nothing.
* Archived courses are hidden from pickers and the default course list, but their tasks/exams remain visible in "All tasks" with the course name and an "archived" tag.
* **Archived courses still take part in session matching** (so a finished term keeps its history) under the rules in §6.2: an archived course matches only when it is the sole remaining compatible candidate, and the result is flagged *archived* (muted colour, "(archived)"). [Rec]
* **Delete** is allowed only when the course has no tasks and no exams (database `RESTRICT`); otherwise the UI says how many items block it and offers "Archive instead". No cascade, no auto-detach. [Rec]

### Task
```
planned ──► in_progress ──► completed
   ▲            │               │
   └────────────┴──── reopen ◄──┘
planned/in_progress ──► cancelled ──► planned (restore)
```
* `completed_at` is set by the **database** when status becomes `completed` and cleared when it leaves it, so it is consistent across devices and never depends on a client clock. [Rec]
* `cancelled` = "no longer needed" (kept for history, hidden by default). Delete is a separate, explicit action.
* **Overdue is derived, never stored:** status ∈ {planned, in_progress} and the due moment is before *now* (rules in §5). Completed or cancelled tasks are never overdue.
* A task without a due date is never overdue.
* Editing `due_*` of a completed task is allowed and does not reopen it.

### Exam
Three independent axes:
* **Date state** `date_status`. The four user-visible cases need three stored values plus whether times are present:

| User-visible state | `date_status` | `exam_date` | `start_time` / `end_time` |
| --- | --- | --- | --- |
| 1. No date known | `unknown` | NULL | NULL |
| 2. Tentative date | `tentative` | set | NULL |
| 3. Confirmed date, time not yet announced | `confirmed` | set | NULL |
| 4. Confirmed date and time | `confirmed` | set | both set, `end_time > start_time` |

  No fake times are ever stored: "time not announced" is the *absence* of times, not `00:00`/`23:59`. A tentative exam never has times. Exams are same-day (`end_time > start_time`); an exam crossing midnight is a stated limitation. [Rec]
* **Preparation** `prep_status`: `not_started | in_progress | ready`.
* **Outcome** `status`: `active | taken | cancelled`. `taken`/`cancelled` exams leave the "upcoming" views; `taken` stays on the calendar as a past item, `cancelled` is removed from it.
* **Format is two fields, not one:** `exam_type` (what is assessed: `written, oral, practical, presentation, other`) and `delivery` (how: `in_person | online`, NULL when unknown). A written exam can be online; an oral exam can be in person. `location` is free text (a room, or e.g. "Zoom").
* Changing date/time never touches linked tasks; their due dates are independent. The exam page shows a hint if a linked study task is due after the exam date. [Rec]
* Where each state appears (this table is authoritative; USER_WORKFLOWS §5 and ACCEPTANCE E-* must agree with it):

| State | Exams list | Today "Next exam" | Calendar | Conflicts |
| --- | --- | --- | --- | --- |
| 1 No date | "Date to be announced" | not counted; hint "N exams without a date" | not shown | none |
| 2 Tentative | date + "tentative" | shown, labelled tentative | all-day marker, dashed, "tbc" | none |
| 3 Confirmed, time tbc | date + "time to be announced" | shown with the date | all-day marker, solid (**not** a timed block) | none (nothing to compare); an informational "same-day commitments" note is optional |
| 4 Confirmed, timed | date + time range | shown with countdown | timed block with "Exam" badge | non-blocking warnings against events and other timed exams ("Save anyway") |

## 5. Dates, times and time zones

Two kinds of "due", both stored as plain columns (never as one ambiguous timestamp):

| Case | Stored | Meaning |
| --- | --- | --- |
| **Date-only** | `due_date`, `due_time = NULL` | Due **on that calendar day**, any time until 23:59:59 in `time_zone`. Overdue from the start of the *next* local day |
| **Date + time** | `due_date`, `due_time`, `time_zone` | Due at that local wall-clock moment in `time_zone`. Overdue after that instant |

Rules:
* `time_zone` is an IANA name validated by the same trigger used for events [Fact: `orbit_validate_zone`]. Default `Europe/Berlin` (the app's display zone [Fact]).
* The instant is derived at read time with the existing `resolveLocalTime` helper [Fact] (for tasks with a due time and for timed exams). A nonexistent local time (DST gap, e.g. 02:30 on spring-forward) shifts forward and is flagged; an ambiguous time (fall-back) resolves to the first occurrence — identical to the series policy [Fact].
* Never convert a date-only deadline to a UTC midnight instant: that moves it to the wrong day for users east/west of UTC. [Rec]
* "Today" and "overdue" use the user's current Europe/Berlin day via `src/utils/time.ts` and the injectable clock (`useNow`) so tests can fix time [Fact].
* **Exams** store a local `exam_date` plus optional local `start_time`/`end_time` and a `time_zone` (like series [Fact]); instants are derived only for timed exams (state 4). Date-only exams (states 2 and 3) are never converted to instants.

## 6. Calendar representation (single source of truth)

**Nothing is copied into `events`.** A pure projection builds the display list at read time:

```
AgendaItem =
  | { kind:'event',      item: ScheduledItem }            // one-off event or series occurrence  [existing]
  | { kind:'task-due',   task, when: 'date' | instant }   // marker, no duration
  | { kind:'exam',       exam, shape:'block' | 'marker' } // block only for confirmed + timed; marker for tentative and date-only
  | { kind:'block',      block }                          // future PlannedBlock
```

Consequences (all testable, see ACCEPTANCE_CRITERIA §5):
* Completing a task changes the one `tasks` row; every view derives from it, so there is no second record to update or forget.
* Moving an exam updates one `exams` row; the calendar block moves, the Today "next exam" updates, the course page updates.
* Deleting a task removes its due marker and any future PlannedBlocks (FK `ON DELETE CASCADE` for blocks only, since a block has no meaning without its task; this cascade is on a derived planning object, not user content such as notes) [Rec].
* Existing `deadline`-category events stay as they are. They are manual one-off events and remain valid; a later, explicit, per-item "convert to task" action may be offered. ORBIT never converts them automatically. [Rec] [Open] O-7

### 6.1 Course ↔ imported events: derived, never stored (no modification of events)
* **[Fact]** Imported events have `course_code` (free text, ≤30) and no institution or term; they sit under provenance snapshots.
* **[Rec]** The MVP stores **no foreign key on `events`/`recurring_series`**. Association is computed by the pure function `matchCourse(session, courses)`.

**Normalisation rule N** (one rule, used by the client, the database and the tests):
1. Replace every run of whitespace (`[ \t\r\n\f\v]` and U+00A0) with one ASCII space, then trim both ends.
2. Convert the ASCII letters `a–z` to `A–Z`. All other characters are left unchanged (no Unicode case folding, which differs between JavaScript and PostgreSQL).
3. The result is the **key**. An empty key means "no code".

Client: `normaliseKey(s)` in TypeScript. Database: `code_key`, `institution_key` and `term_key` as `GENERATED ALWAYS AS (…) STORED` columns built only from immutable `regexp_replace`/`translate`, plus a CHECK that a present code has a non-empty key. A **golden vector file** (`"inf 101"`, `" INF  101 "`, `"INF\u00a0101"`, `"Ünï 1"`, tabs, empty, whitespace-only) is run through both implementations in CI (Vitest and PGlite), so they cannot drift. Matching and uniqueness therefore use the same key.

### 6.2 Matching rules
Input: a session (`courseCode`, local date in its zone) and all of the user's courses (active **and** archived).

1. **No code** (empty key) → `none`. No association is attempted.
2. Candidates = courses whose `code_key` equals the session key. None → `none`.
3. Classify each candidate by date: **in** (term dates set and contain the session date), **out** (term dates set and exclude it), **unknown** (no term dates).
4. Drop **out** candidates; the rest form the *remaining set* R.
5. R empty and at least one *out* candidate existed → `outside-term`. Nothing is associated; the UI may suggest creating a course for that term (USER_WORKFLOWS §1).
6. |R| = 1 → `matched` (flagged *archived* if that course is archived). Confidence **`dated`** if the course is *in*, **`by-code`** if *unknown*.
7. |R| > 1 → `matched` **only if exactly one candidate in R is *in* and none in R is *unknown***; otherwise `ambiguous`. (An undated candidate cannot be ruled out, so it prevents certainty; overlapping term dates are ambiguous too.)
8. `ambiguous`, `outside-term` and `none` sessions look exactly like today's unassigned sessions. ORBIT never guesses and never presents an authoritative course for them.

Consequences
* **One code, one compatible course:** matched (`dated` or `by-code`).
* **Same code, different semesters:** resolved by term dates; without dates → `ambiguous`.
* **Same code, different institutions:** events carry no institution, so institution cannot disambiguate; different term dates can; same, overlapping or missing dates → `ambiguous`.
* **Missing term dates:** allowed. A single undated course matches `by-code` and is presented as "matched by code", not as confirmed. Creating a second course with the same code can turn earlier `by-code` sessions into `ambiguous`; the Courses page shows a notice.
* **Archived courses:** classified like any other candidate (rules 3–7).
* The Courses page shows per course how many sessions match `dated` and `by-code`, and how many sessions with its code are `ambiguous`/`outside-term`, so the user can see and fix the cause by adding term dates.
* If real use shows ambiguity is common, the smallest addition is a separate `course_event_links` table (explicit user choice per series/event), **never** a column on `events`. [Open] O-4

### 6.3 Course colour
`color` stores a **token key** (`c1`…`c8`), mapped in the theme CSS, not a hex value (CLAUDE.md forbids hardcoded hex in components [Fact]). Category colours stay for categories; course colour is an additional accent on rows.

## 7. Search, filter and sorting

Handled client-side over the loaded set in the MVP (a student has hundreds, not millions, of tasks). Filters: status, course, kind, priority, due range, overdue only, "has exam". Sorts: due date (nulls last), priority, created, title. Text search: case-insensitive substring over title and description. Server-side search is deferred ([Open] O-9).

## 8. Idempotency and concurrency

* Creates accept a client-generated UUID and use `ON CONFLICT DO NOTHING` (same contract as `CloudApi.insert*` [Fact]), so a retried create cannot duplicate.
* Updates/deletes are conditional on the raw `updated_at` (optimistic concurrency) [Fact]; a stale write is rejected, not merged.
* External imports (future) use `(user_id, external_source, external_instance, external_id)` uniqueness.

### 8.1 Stale writes and status changes (one predictable rule)
* Every update/delete is conditional on the `updated_at` the client last read [Fact pattern]. A stale request changes **nothing** and returns `conflict` ("This changed on another device, so your edit was not saved. The latest version has been loaded." — the existing message [Fact]); the planner then re-reads that row.
* **Status transitions are intent-based.** After a stale rejection of "mark completed" (or reopen / cancel), the client compares the freshly read row with the intent:
  * the row **already has the intended status** → the UI shows the fresh row and a neutral note ("Already completed on another device"); this is *reconciliation after refresh*, not a silent overwrite, and no second write is made;
  * the row has a **different status or other changed fields** → the conflict message is shown with the latest data; nothing is re-applied automatically. The user may repeat the action, which then uses the fresh `updated_at`.
* **Field edits** (title, due date, …) are never reconciled automatically: always a conflict.
* Never a silent last-writer-wins and never a merge. Saves stay pessimistic: `{ok:true}` only after server confirmation; the dialog stays open on `{ok:false}`.

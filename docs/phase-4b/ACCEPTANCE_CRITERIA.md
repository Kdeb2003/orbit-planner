# Phase 4B — Acceptance criteria and test strategy

Each criterion is written to be directly testable. IDs (e.g. `C-3`) are for traceability in test names. Related: [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [DATABASE_PROPOSAL.md](DATABASE_PROPOSAL.md), [USER_WORKFLOWS.md](USER_WORKFLOWS.md), [OPEN_DECISIONS.md](OPEN_DECISIONS.md).

## 1. Courses (4B.1)

* C-1 Create a course with only a name succeeds; code, institution, term label, term dates, description are optional.
* C-2 Name is required and ≤120 chars; code ≤30; description ≤2000; invalid values are rejected client-side **and** by the database.
* C-3 Uniqueness uses the normalised key: `"inf 101"` and `" INF  101 "` with the same institution and term label are rejected as duplicates (client and database); the same code with a different term label or institution is accepted.
* C-4 Archiving sets `archived_at`, deletes nothing, hides the course from pickers, keeps its tasks/exams visible with an "archived" tag; restore reverses it.
* C-5 Deleting a course that has tasks or exams is refused with the counts shown; deleting an empty course succeeds.
* C-6 **Term dates:** both or neither; `term_end >= term_start`; span ≤ 400 days; each violation is rejected by the form and by the database CHECK. `term_label` has no effect on matching (test: changing only the label never changes a match).
* C-7 **Matching (`matchCourse`), table-driven over DOMAIN §6.2:**
  * no code / whitespace-only code → `none`;
  * one course, no dates → `matched`, confidence `by-code`;
  * one course with dates containing the session → `matched`, `dated`; session outside the dates → `outside-term` (not matched);
  * **cross-semester:** course A (code X, 2026-10-01…2027-02-28) and course B (code X, 2027-04-01…2027-09-30): a session on 2026-11-10 → A; on 2027-05-01 → B; on 2027-03-15 → `outside-term`;
  * **cross-semester, undated:** two courses with code X and no dates → `ambiguous`;
  * **one dated + one undated** with the same code → `ambiguous` (undated cannot be ruled out);
  * **cross-institution:** same code, institutions P and Q, overlapping dates → `ambiguous`; identical code but non-overlapping term dates → resolved by date; institution alone never decides;
  * **archived:** the only compatible candidate archived → `matched` flagged archived; archived + active both in the remaining set → `ambiguous`; an archived course whose term excludes the date is dropped;
  * ambiguous results never carry a course id.
* C-8 Matching never modifies an event, series or exception: stored rows and `event_import_links.imported_snapshot` are byte-identical before and after creating, editing, archiving and deleting courses.
* C-9 "Suggest courses from calendar": lists each distinct unmatched code once with suggested term dates (first/last session), lists *outside-term* and *ambiguous* codes separately, creates nothing until confirmed, is idempotent when run twice, and never offers a code that is already resolved.
* C-10 **One normalisation, two implementations:** a shared golden-vector file (`"inf 101"`, `" INF  101 "`, `"INF\u00a0101"`, tabs/newlines, `"Ünï 1"` (non-ASCII unchanged), empty, whitespace-only) yields identical keys from `normaliseKey` (Vitest) and from the database generated columns (PGlite and the local Docker stack).
* C-11 Colour is one of `c1…c8`; arbitrary strings are rejected; no hex values appear in component code (grep test).
* C-12 Creating a second course with a code already used by an undated course shows the "sessions may stay unassigned" warning and the Courses page lists the affected session count.

## 2. Tasks (4B.2)

* T-1 Create with only a title succeeds (kind default `other`, status `planned`, priority `normal`).
* T-2 `due_time` without `due_date` is rejected (client and DB).
* T-3 Date-only task due 2026-03-28 is **not** overdue at 2026-03-28 23:59:59 Berlin and **is** overdue at 2026-03-29 00:00:00 Berlin (also across the DST change of 2026-03-29).
* T-4 Timed task is overdue exactly after its instant; the spring-forward gap time (02:30 on 2026-03-29) is shifted forward and flagged; the fall-back ambiguous time resolves to the first occurrence.
* T-5 Completing sets `completed_at` (server time); reopening clears it; the DB CHECK rejects `status='completed'` with null `completed_at` and the reverse; a client-sent `completed_at` is ignored.
* T-6 Completed and cancelled tasks are never overdue; tasks with no due date are never overdue.
* T-7 Filters (status, course, kind, priority, overdue, no-due-date), sorts (due nulls last, priority, created) and case-insensitive search over title+description return exactly the expected ids on a fixed fixture.
* T-8 `external_url` accepts `http(s)://` and rejects `javascript:`, `data:`, relative and 2001-char values; rendered links carry `rel="noopener noreferrer"`.
* T-9 `estimated_minutes`/`tracked_minutes` bounds enforced.
* T-10 Assignment = task: no second table/store exists for assignments (static test on schema and module list).
* T-11 Retrying a create with the same client UUID produces exactly one row; a stale field edit (old `updated_at`) is rejected with the standard message, the latest row is loaded, and the dialog stays open.
* T-12 **Stale status change:** device 1 and device 2 both hold version v1. Device 1 completes the task (v2). Device 2's complete request is rejected as stale; after its re-read the row already has `completed` → the UI shows completed with "Already completed on another device", **no second write is sent**, and `completed_at` is unchanged. If instead device 1 had *cancelled* or renamed the task, device 2 shows the conflict message with the latest data and applies nothing. In no case is a newer value overwritten.
* T-13 The 4B.2 schema has no `exam_id` column and no reference to exams (catalog test); the task dialog has no exam field.

## 3. Exams (4B.3)

* E-1 **Date states** (database CHECK and client validator agree; every other combination is rejected):
  * `unknown` → date, start, end all NULL;
  * `tentative` → date set, times NULL;
  * `confirmed` → date set and either both times NULL (**date-only**) or both set with `end_time > start_time`;
  * a start without an end (or vice versa) is rejected; a `tentative` exam with times is rejected; no stored value is `00:00`/`23:59` as a stand-in for "unknown time".
* E-2 An exam requires a course; another user's course cannot be referenced (see S-4).
* E-3 **Same-course rule (database, no UI help):** inserting or updating a task with `exam_id` and a different `course_id` than the exam's fails; `exam_id` with NULL `course_id` fails; changing a linked task's course fails; changing an exam's `course_id` while tasks are linked fails; changing it with no linked tasks succeeds.
* E-4 Promoting tentative → confirmed (date-only) moves the item from a dashed to a solid all-day marker; adding times turns it into a timed block; removing times reverts to a marker. Nothing in between stores a fake time.
* E-5 `taken`/`cancelled` exams leave "Upcoming"; cancelled exams leave the calendar; taken remain as past items.
* E-6 Changing an exam's date does not modify linked tasks.
* E-7 **Conflicts:** a confirmed **timed** exam overlapping a class or another timed exam is reported as a non-blocking conflict ("Save anyway"); unknown, tentative and **date-only** exams never conflict; touching ends do not conflict.
* E-8 Nonexistent local start time (DST gap) is rejected like one-off events.
* E-9 `exam_type` and `delivery` are independent: `written + online`, `oral + in_person`, `practical + NULL` are all valid; `online` is not an `exam_type` value.
* E-10 **Display matrix** (DOMAIN §4 table) is tested per state for the Exams list, Today "Next exam", and Calendar: unknown → list only; tentative → dashed all-day marker; confirmed date-only → solid all-day marker, never a timed block; confirmed timed → timed block.
* E-11 **Delete rules:** deleting an exam that has linked tasks fails at the database (RESTRICT); the "unlink and delete" flow unlinks each task then deletes; if it fails after k of N tasks (injected failure), the k tasks stay unlinked, the exam and the other tasks are unchanged, nothing is deleted, and re-running completes the job; a task linked concurrently makes the final delete fail with a clear message.
* E-12 Adding `tasks.exam_id` in 4B.3 does not alter existing task rows (row count and column values identical before/after the migration test); the rollback refuses while any `exam_id` is set unless explicitly confirmed.

## 4. Calendar and dashboard consistency

* K-1 `buildAgenda` is pure and deterministic: same inputs ⇒ same output; it never mutates its inputs.
* K-2 One task ⇒ at most one due marker per day; no `events` row is created for a task or exam (test counts `events` rows before/after).
* K-3 Completing a task removes it from the due lane, Today "Due soon/Overdue", the course page counts and the open-task count **in the same render after the server confirms**, and from none of them before (pessimistic).
* K-4 Deleting a task removes it everywhere; deleting an exam removes its block/marker and "next exam" falls back to the next exam; linked tasks are never silently detached (see E-11).
* K-5 Moving an exam updates calendar, Today countdown and course page.
* K-6 Due items never appear in conflict results; only confirmed **timed** exams do (E-7).
* K-7 Existing calendar behaviour is unchanged: the full existing Vitest and Playwright suites pass **unmodified** with the planner flags off and on.
* K-8 Cross-tab/device: a second session sees changes after the existing focus/poll refresh; the test asserts that the same trigger also reloads planner data (see L-5).

## 4b. Local mode and session lifecycle (cloud-only planner)

* L-1 In local mode (Supabase unconfigured) and when signed out, no planner request is ever made and planner routes show the sign-in message; nav entries are hidden.
* L-2 The existing calendar suites (local mode and cloud mode) pass **unmodified**; local-mode storage keys and behaviour are unchanged (K-7).
* L-3 `PlannerSource.dispose()` (sign-out) clears courses, tasks and exams from memory; the snapshot of the next session starts empty and `userId` matches the new account.
* L-4 **Account switch race:** user A's planner read is in flight; the user signs out and B signs in; A's late response is discarded and never appears in B's snapshot or UI (fake API with controllable latency, as in the calendar's "disposed source ignores late responses" test). A write started by A that resolves after disposal returns `{ok:false, kind:'auth'}` and changes nothing in B's state.
* L-5 One refresh lifecycle: a single set of focus/visibility/online listeners and a single poll timer exists after sign-in (counted in the test); a trigger refreshes calendar and planner exactly once each, honouring the ≥ 2 s gap and skipping while the tab is hidden; sign-out removes all listeners and timers.
* L-6 In-flight refresh calls are de-duplicated; a refresh that started before a write completes is discarded and repeated (no stale overwrite).
* L-7 Static test: planner code references no `orbit.*` storage keys, no `eventStore`/`seriesStore`, and no Supabase client other than through `plannerApi`.
* L-8 Flags: with all planner flags off, no planner module is loaded (lazy chunk absent from the main bundle) and the app behaves as today; `EXAMS` on with `COURSES` off disables exams; the deploy workflow pins each flag to `'false'` until its PR enables it (guard test).

## 5. Security and isolation (multi-account)

Run in PGlite (simulation), against the local Docker stack, and — before enabling a flag in production — against the hosted project with **two normal accounts and synthetic rows only** (marker `ORBIT_RLS_CHECK_<run>`, cleaned up, no service-role key) [process from 4A.3].

* S-1 Account B cannot `select` any of A's courses/tasks/exams (0 rows), by id or by filter.
* S-2 B cannot `update` or `delete` A's rows (0 affected rows).
* S-3 B cannot insert a row with `user_id = A` (RLS violation).
* S-4 B cannot create a task whose `course_id` is A's course, nor an exam for A's course, nor (4B.3) a task whose `exam_id` is A's exam, **even with RLS bypassed** (composite FK tests in PGlite as table owner).
* S-5 Changing `user_id` or `id` on one's own row is rejected (new generic protect trigger; test per table, guarding against the `orbit_protect_row` table-name pitfall).
* S-6 Anonymous (logged-out) requests: select/insert denied on every new table.
* S-7 No new object grants anything to `anon` or `public`; no `SECURITY DEFINER` function exists in the new migrations (static test like existing ones).
* S-8 Account deletion cascades the user's planner rows (`ON DELETE CASCADE` from `auth.users`).
* S-9 Existing tables' policies, grants and triggers are unchanged (migration-safety test compares catalog snapshots).
* S-10 Applied migrations are not edited (existing guard); rollback files live in `supabase/recovery/` only.
* S-11 Planner code never imports `eventStore`/`seriesStore`, reads `orbit.*` keys, uses `console.*`, or references service-role strings (static isolation test).
* S-12 Hosted two-account script is extended with the new tables; result recorded as "N passed, 0 failed, 0 skipped".

## 6. Test strategy by layer

| Layer | Tool | What |
| --- | --- | --- |
| Pure logic | Vitest | overdue/due-moment, DST, filters/sorts/search, `buildAgenda`, `courseForSession`, course suggestion, validators/mappers (property-style tests for DST/date edges) |
| Data layer | Vitest + `FakePlannerApi` | concurrency, idempotent create, error mapping, pessimistic results |
| SQL | Vitest + PGlite (`supabase/tests/`) | constraints, triggers, RLS policies via role switching, composite FKs, grants, migration safety, rollback |
| Local Docker | manual + script | real PostgreSQL 17 behaviour of the same SQL |
| UI integration | Vitest + Testing Library | dialogs, validation messages, stale-edit message, empty states |
| Browser | Playwright with mock PostgREST (`e2e/plannerMock.ts`) at 1440/768/390/320, fixed clock | workflows in USER_WORKFLOWS, calendar lane rendering, Today sections, overflow checks |
| Hosted | scripted two-account check (manual approval) | S-1…S-12 for the tables of that increment |

Mocks (`FakePlannerApi`, mock PostgREST) are **mocks**; docs must not claim hosted behaviour is verified until the hosted script has run [Fact wording rule].

The intermittent 5 s timeout seen in a PGlite provenance test (observed during the 4A.3 release) should be fixed (explicit per-test timeout) before adding more PGlite suites, otherwise CI flakiness will grow with the new tables.

## 7. Accessibility

* A-1 All controls reachable and operable by keyboard; dialogs use `showModal()`, trap focus, focus the `data-autofocus` element, restore focus on close, close with Esc.
* A-2 Status, overdue and exam-tentative are conveyed by text/icon, not colour alone; contrast of text on course colours meets WCAG AA (checked per token).
* A-3 Lists have headings and landmarks; task rows expose status via accessible names ("Assignment 3, due Fri 14 Nov, overdue by 2 days, in progress").
* A-4 Form errors are associated with fields (`aria-describedby`) and announced (`role="alert"` for save failures).
* A-5 Progress/priority indicators have text equivalents; the calendar due lane is a list, not an image.
* A-6 Respects `prefers-reduced-motion`; touch targets ≥ 44 px; no horizontal scroll at 320 px.

## 8. MVP completion criteria (whole of Phase 4B)

1. All criteria C-*, T-*, E-*, K-*, S-*, A-* pass in CI (`npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`).
2. Every new table passed the hosted two-account check and the result is recorded in docs.
3. Planner flags are on in production only after (2); Study Planner no longer shows invented numbers for what is tracked (otherwise the Demo badge stays).
4. No change to existing event/series/provenance data or schema; an upgrade test imports a fixture dataset before and after and compares.
5. CLAUDE.md and the docs are updated (Phase 4B section, folder list); unfinished sections are visibly labelled.
6. Known limits stated plainly (cloud-only, client-side search, no reminders/time tracking).

## 9. Recommended implementation sequence

| Step | Content | Gate |
| --- | --- | --- |
| 4B.0 | This design reviewed; O-1…O-6 approved by the owner | Owner approval |
| 4B.1a | Pure code: types, `normaliseKey`, `matchCourse`, `suggestCourses` + golden vectors + table-driven tests (no DB) | C-6…C-10 unit |
| 4B.1b | Migration `courses` (+ generic protect trigger, generated key columns) + PGlite tests + rollback; `plannerApi`/fake; `PlannerSource` skeleton with lifecycle tests (L-3…L-6); Courses page behind `VITE_ENABLE_PLANNER_COURSES` | Local Docker check |
| 4B.1c | Hosted apply (approval) + two-account check for `courses`; enable the flag in a reviewed PR | S-* for courses |
| 4B.2 | Tasks migration (**no `exam_id`**), API, list/dialog, overdue, status reconciliation (T-12), agenda projection (due lane, Today), e2e | Same gates (T-13) |
| 4B.3 | Exams migration **including** `tasks.exam_id` + 3-column composite FK; API, UI, four date states, conflicts, unlink-and-delete flow | Same gates (E-1…E-12) |
| 4B.4 | Dashboard integration, course page, Study Planner on real task/exam data, docs | MVP criteria §8 |

Each step is its own branch and PR; the user commits and merges (project rule [Fact]).

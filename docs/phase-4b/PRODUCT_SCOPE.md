# Phase 4B — Product scope

Status: **design proposal for review.** Nothing here is implemented. Labels used in all Phase 4B documents:

* **[Fact]** verified in the repository on `origin/main` (`dd6eaa9`).
* **[Rec]** a recommendation made by this design.
* **[Open]** needs a product-owner decision; see [OPEN_DECISIONS.md](OPEN_DECISIONS.md).

Related: [DOMAIN_MODEL.md](DOMAIN_MODEL.md) · [DATABASE_PROPOSAL.md](DATABASE_PROPOSAL.md) · [USER_WORKFLOWS.md](USER_WORKFLOWS.md) · [FUTURE_INTEGRATIONS.md](FUTURE_INTEGRATIONS.md) · [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md)

## 1. Why Phase 4B

The calendar answers "where do I have to be, and when". It cannot answer "what is due, for which course, and have I prepared". Today:

* **[Fact]** Study Planner and Insights render demonstration data (`src/mock/demo.ts`, badge "Demo data"); nothing is tracked.
* **[Fact]** A deadline can only be a calendar event with category `deadline`. It has no status, course, effort or completion, and `conflicts.ts` ignores deadlines.
* **[Fact]** Imported university sessions carry a free-text `course_code` (≤30 chars) on `events` / `recurring_series`; there is no Course entity.

Phase 4B adds the **academic planning core**: courses, tasks (including assignments), exams, and their presentation in Calendar/Today. It is the foundation that Canvas import, work-roster import and the AI routine planner will later build on.

## 2. Target users

| User | Needs |
| --- | --- |
| Primary (the owner): master's student, part-time worker, learning German | Courses from one institution now, possibly several; assignments and exams; personal tasks; one place to see it all |
| Other students | Courses without a university code; several institutions or exchange semesters; deadlines without a time |
| Working professionals (later) | Projects instead of courses; shift work; tasks without academic vocabulary |

**[Rec]** Use neutral vocabulary in code and schema (`course` is the only academic noun; "project" is a later alias, see O-12). Everything is private to the signed-in user; there is no sharing.

**[Open] O-1:** The app is deployed with public sign-up disabled (`VITE_ENABLE_SIGNUP=false`, Supabase "Allow new users to sign up" off). "Multi-user" in 4B therefore means *the schema and tests are multi-tenant-safe*, not that registration opens. Opening registration is a separate product/ops decision.

## 3. Phase 4B MVP

The MVP is deliberately split into four small, independently shippable increments (details in [ACCEPTANCE_CRITERIA.md §9](ACCEPTANCE_CRITERIA.md)).

| Increment | Content | Calendar impact |
| --- | --- | --- |
| **4B.1 Courses** | Create/edit/archive courses; colour; derived link to imported sessions by course code; "suggest courses from my calendar" | Events/occurrences show their course colour/name when a course matches. No event is modified |
| **4B.2 Tasks** | Task CRUD with optional course, due date/time, priority, status, estimate; list with filter/sort/search; overdue; complete/reopen | Due dates appear as a lightweight "due" lane/marker in Calendar day view and in Today |
| **4B.3 Exams** | Exam CRUD with four date states (no date, tentative, confirmed without time, confirmed with time), type and delivery, preparation status, link study tasks (adds `tasks.exam_id` in the same migration) | Timed exams show as blocks; tentative and date-only exams as all-day markers |
| **4B.4 Dashboard integration** | Today "Due soon / Overdue / Next exam", per-course page, replace demo data in Study Planner with real task/exam progress (no time tracking yet) | Consistency tests across Calendar, Today, course page |

Each increment ends with a PR, tests, and (for 4B.1–4B.3) a migration that is applied to hosted **only after** the same two-account verification used for Phase 4A.3 ([docs/proposals/hosted-two-user-rls-verification.md](../proposals/hosted-two-user-rls-verification.md)).

### MVP user stories (priority: M = must, S = should, C = could)

Courses
* M — As a student I can create a course with a name, optional code, institution, semester label, colour and description.
* M — I can archive a course (and restore it) without losing its tasks or exams.
* M — My imported timetable sessions show under the matching course when the match is unambiguous (course code, plus term dates when the same code is reused); sessions that cannot be matched safely stay unassigned. Nothing is changed.
* S — ORBIT suggests courses (with suggested term dates) from the course codes already in my calendar, and flags codes that are ambiguous or outside a course's term; I confirm each one.
* C — I can delete an empty course.

Tasks
* M — I can add a task with title, optional course, optional due date, and priority.
* M — I can add a due *time* when a deadline has one, and leave it out when it does not (date-only).
* M — I can mark a task in progress, completed, and reopen it.
* M — I see overdue tasks clearly and can filter by status, course, type, and priority, sort, and search by text.
* S — I can record an estimate in minutes and a manually entered tracked-minutes total.
* S — I can attach an external link (e.g. the assignment page).
* C — Quick-add from Today.

Exams
* M — I can add an exam for a course with a type and delivery, and record it as: no date yet, tentative date, confirmed date (time not yet announced), or confirmed date and time.
* M — I can set preparation status and an optional target grade and topic notes.
* S — I can create study tasks attached to an exam.
* C — Convert "tentative" to "confirmed" with a single action.

Calendar / dashboard
* M — Calendar day/week views show classes, work, exams (blocks or markers by state), and task due markers, visually distinct.
* M — Completing/deleting a task, or moving an exam, is reflected immediately in every view.
* S — Today shows "Overdue", "Due in the next 7 days", "Next exam".

## 4. Explicit exclusions (not in Phase 4B)

* Canvas ICS/API import, any credential handling ([FUTURE_INTEGRATIONS.md](FUTURE_INTEGRATIONS.md)).
* OCR / screenshot / roster import; any image upload or storage.
* AI provider calls, AI-generated schedules, preference onboarding.
* Planned study blocks stored in the calendar (designed in [DOMAIN_MODEL.md §6](DOMAIN_MODEL.md), built later).
* Time tracking (timers); only a manually entered `tracked_minutes`.
* Reminders / push / email notifications, PWA/offline write queue.
* Subtasks, recurring tasks, task dependencies, tags, attachments.
* Sharing, collaboration, teams, multiple calendars.
* Grade tracking, GPA, credit points.
* Changes to existing `events` / `recurring_series` rows or to the import provenance tables.
* Opening public registration.

## 5. Feature priorities beyond the MVP (indicative)

1. Planned study blocks (task ↔ time) and Study Planner real data.
2. Canvas **ICS** import (read-only, review before save).
3. Reminders / PWA.
4. Work-roster import.
5. Preference profile and deterministic scheduler; then AI suggestions.

Reasoning: each later item depends on the stable task/exam identity and the external-reference columns introduced in 4B, not on any UI of 4B.

## 6. Future integration boundaries (summary)

The MVP exposes four seams, all documented in [FUTURE_INTEGRATIONS.md](FUTURE_INTEGRATIONS.md):

1. `external_source` / `external_id` on tasks and exams (stable external identity; nullable, unused by the MVP).
2. A pure **agenda projection** (`events + series + tasks + exams → AgendaItem[]`) so new item kinds do not touch the calendar stores.
3. The import-review pattern already proven by the UTN importer (preview → confirm → idempotent write → provenance).
4. A server-side boundary for anything needing secrets (AI, Canvas tokens): never the browser.

# Phase 4B — User workflows

Behavioural description of the MVP screens. Data rules: [DOMAIN_MODEL.md](DOMAIN_MODEL.md); testable criteria: [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md). Wireframes are intentionally text-only; visual design is decided during implementation using the existing tokens (`bg-surface`, `text-muted`, `accent`).

General rules (all workflows)
* **[Fact]** Saves are pessimistic: dialogs stay open until the server confirms and show the reason on failure; nothing is shown as saved that is not.
* **[Fact]** Times display in Europe/Berlin via `src/utils/time.ts`.
* Destructive actions need an explicit confirmation naming what will be affected. Nothing is deleted or detached automatically.
* Pages are hidden behind their feature flag (`VITE_ENABLE_PLANNER_COURSES/TASKS/EXAMS`) until the matching hosted migration is verified (DATABASE_PROPOSAL §7). The task dialog has **no exam field** before 4B.3.

## 1. First-time course setup (4B.1)

1. User opens **Courses** (empty state: "No courses yet" + two actions).
2. **"Suggest from my calendar"** groups the user's events/series by normalised course code (rule N, [DOMAIN_MODEL.md §6.1](DOMAIN_MODEL.md)) and shows three lists:
   * **No course yet** — codes with no matching course: sessions count, first and last session date, a sample title. Each row has a checkbox, an editable **name** (prefilled from the most common session title; a suggestion), a colour, and **term start/end prefilled from the first and last session date and clearly marked "suggested — please check"**. Nothing is created until **Create selected**.
   * **Needs attention — outside term**: sessions of a code whose existing course has term dates that exclude them (e.g. the next semester). Offer: "Create a course for this term" (prefilled as above) or ignore.
   * **Needs attention — ambiguous**: several courses share the code and cannot be told apart; offer "Add term dates to course X / Y".
   Suggestions are idempotent: running it again lists only what is still unresolved.
3. **"Add course manually"**: dialog with
   * name (required, ≤ 120), code (optional, ≤ 30), institution (optional), description;
   * **term label** (optional text, display only);
   * **term start** and **term end** (optional **as a pair**; helper text: "Term dates let ORBIT tell semesters apart when the same course code is reused. Without them, a course whose code is shared with another course cannot be matched to sessions."). Validation: both or neither; end on or after start; at most 400 days; inline errors;
   * colour (8 tokens).
   Warnings (non-blocking): "Another course uses this code and has overlapping or missing term dates — sessions may stay unassigned." Errors (blocking): a course with the same normalised code, institution and term label already exists (link to it).
4. After creation, sessions matched by the rules of DOMAIN §6.2 show the course colour and name in Calendar/Today. The course page states how sessions were matched: "N matched by code and term dates", "M matched by code only", "K not assigned (ambiguous/outside term)". Sessions never assigned look exactly as today. No event is edited.
5. Matching outcomes users will see
   * one compatible course → shown (by-code matches are labelled "matched by code");
   * same code in two semesters with term dates → each session goes to the course whose term contains it;
   * same code at two institutions, overlapping or no dates → unassigned with "ambiguous" explanation;
   * no code → unassigned (the page explains that courses can only be matched through the code);
   * archived course → still matched if it is the only compatible one, shown muted with "(archived)".
6. **Archive**: confirm dialog "Hide this course? Its N tasks and M exams are kept, and sessions with its code stay matched." Restore is one click.
7. **Delete** is offered only on a course with no tasks/exams; otherwise "N tasks and M exams use this course — archive instead".

## 2. Create and complete an assignment (4B.2)

1. From **Tasks → Add task** (or Today quick-add): title; kind = assignment; course (picker of non-archived courses, optional); due date; "Add a time" toggle revealing time; priority; estimate (minutes or h:mm); link; notes.
2. **Date only**: label "Due Fri 14 Nov (any time that day)". **With time**: "Due Fri 14 Nov, 23:59".
3. Saving shows a spinner on the button; on success the dialog closes and the task appears in the list; on failure the dialog stays open with the message.
4. In the list: status control (Planned → In progress → Done). **Done** sets `completed_at` on the server. The row moves to the completed group (collapsed by default) and disappears from "Overdue/Due soon" and from the calendar due lane after the next confirmed response.
5. **Reopen** from the completed group returns it to Planned.
6. **Overdue** rows show a red "Overdue by 2 days" label (text, not colour alone) and sort first when the "Due" sort is chosen.
7. Filters (chips): status, course, kind, priority, "Overdue", "No due date"; sort: due date / priority / newest; search box (title+description, case-insensitive). State may be remembered in `localStorage` only as a per-viewer convenience (wrapped in try/catch) [Fact guidance for artifacts; same idea].
8. Conflict handling
   * **Stale edit** (task changed on another device): the save is rejected with the existing message ("This changed on another device, so your edit was not saved. The latest version has been loaded.") and the dialog shows the latest values. No silent merge or overwrite [Fact policy for events].
   * **Stale status change** (e.g. Complete tapped on two devices): the second device's request is rejected as stale; after the automatic re-read, if the task **already has the intended status** the row simply shows as completed with the note "Already completed on another device" (no second write, no error); if anything else changed (different status, edited fields) the conflict message is shown instead and the user may tap again. Rule: DOMAIN §8.1.
   * **Course archived/deleted elsewhere** while the dialog is open: the save is rejected by the FK; the dialog explains and offers "Save without course".
   * **Offline**: save fails with the offline message; no queue (offline queue is Phase 5 [Fact]).

## 3. Add and update an exam (4B.3)

1. **Exams → Add exam** (or from a course page): course (required), title, **type** (written, oral, practical, presentation, other) and, separately, **delivery** (in person / online / not known), location.
2. **Date** — one selector with four outcomes:
   * **No date yet** → no date fields;
   * **Tentative date** → date only (labelled tentative; no time field);
   * **Confirmed date, time not announced** → date only, labelled "time to be announced";
   * **Confirmed date and time** → date, start, end (end after start), time zone.
   Switching between them keeps what is valid and clears what is not; no fake times are ever stored.
3. Optional: target grade, topics/notes, preparation status.
4. **Updating**: *Confirm date* promotes tentative → confirmed; *Add time* turns state 3 into state 4 and moves the calendar item from an all-day marker to a timed block; changing the date moves the item. Linked study tasks are *not* changed; if any is due after the exam date the exam page shows "2 study tasks are due after this exam".
5. **Link study tasks**: "Add study task" on the exam page creates a task with the exam's course and `exam_id`. From the task dialog the exam picker lists only exams of the task's course; a task without a course must first get one. If the user changes a linked task's course the UI asks to unlink the exam first (the database would refuse the mismatch anyway). Changing an **exam's course** is refused while tasks are linked ("2 tasks are linked — unlink them first").
6. **Mark taken / cancel**: confirmation; the exam leaves "Upcoming"; nothing else changes.
7. **Delete an exam with linked tasks**: refused by the database; the UI offers **"Unlink N tasks and delete"** with the list of tasks. It runs the tasks one by one then deletes the exam. If it stops part-way (network, stale task) the dialog reports which tasks are still linked, nothing is lost, and the same action can be run again; if a task was linked meanwhile from another device, the final delete is refused and the user is told (DATABASE_PROPOSAL §3.3).
8. **Conflicts**: only a confirmed exam **with times** is compared with classes, shifts and other timed exams (non-blocking, "Save anyway") using the existing engine on real UTC instants [Fact]. Tentative, unknown and date-only exams never conflict. A date-only exam may show an informational "same-day commitments" list (not a conflict).
9. DST: a nonexistent local start time is rejected as for one-off events [Fact].

## 4. Manage personal tasks (4B.2)

Personal tasks are tasks with `kind = personal` (or `admin`/`other`) and no course. They use the same dialog, list and filters; the course field is simply empty. No separate screen.

## 5. Calendar and Today display

**Calendar day/week**
* Classes/shifts/events: existing rows (course colour dot added when matched).
* **Due lane** at the top of a day (all-day style): "Due: Assignment 3 — Data Mining". Timed due items show a flag icon with the time, but occupy no vertical span.
* **Exams** (authoritative table in DOMAIN §4): *confirmed with times* → timed block with an "Exam" badge; *confirmed, time not announced* → solid all-day marker "Exam — time tbc" (never a timed block); *tentative* → dashed all-day marker "date tbc"; *no date* → not on the calendar (listed on the Exams and course pages).
* Completed tasks: hidden by default; a "Show completed" toggle shows them struck through.
* Colour is never the only carrier of meaning (icons + text labels).
* The existing "add event" action is unchanged; due items are opened/edited with the task dialog, not the event dialog.

**Today**
* New sections (flagged): *Overdue*, *Due today*, *Due in 7 days*, *Next exam* (countdown in days; tentative and date-only exams are labelled as such; exams without a date are not counted, with a hint). Existing "Up next" is unchanged [Fact].

**Course page**: sessions matched, tasks (grouped by status), exams, counts.

## 6. Errors, conflicts, empty states

| Situation | Behaviour |
| --- | --- |
| Load failure | Existing banner pattern with Retry; stale data remains visible and is marked as possibly outdated |
| Invalid rows from server (fail local validation) | Skipped and counted ("N items could not be shown") like `skippedInvalid` for events [Fact] |
| Same task completed on two devices | Second device is rejected as stale, re-reads, finds the intended status and reconciles to "already completed" (DOMAIN §8.1); never a silent overwrite |
| Task due date in the past on creation | Allowed; shown overdue immediately |
| Time-zone differences | All displays in Berlin; the dialog shows the stored zone if different |
| Not signed in / local mode | Planner pages show "Sign in to use Courses and Tasks" and nav entries are hidden; the local calendar works exactly as before (cloud-only MVP, recommended for approval, O-6) |

## 7. Responsive behaviour

* Breakpoints validated by e2e at 1440 / 768 / 390 / 320 px like existing suites [Fact].
* ≥ 1024 px: Tasks list + detail side panel. < 768 px: list only, dialogs become full-height sheets; filters collapse into a "Filters" button.
* Touch targets ≥ 44 px; no horizontal page scroll at 320 px; dialogs use `showModal()` with `data-autofocus` [Fact convention].
* Bottom nav has limited room: **Courses/Tasks/Exams** live under one **Plan** entry (or Settings sub-navigation) rather than three new tabs [Open] O-11.

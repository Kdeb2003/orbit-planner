# Phase 4B — Open decisions

Decisions that need the product owner. **Every answer below is a recommendation awaiting final owner approval; none is approved yet.** Each has a recommended default so work can proceed if the owner simply approves. Context: [PRODUCT_SCOPE.md](PRODUCT_SCOPE.md), [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [DATABASE_PROPOSAL.md](DATABASE_PROPOSAL.md).

## A. Decide before any implementation (blocking)

| # | Question | Recommended default | Alternatives / trade-off |
| --- | --- | --- | --- |
| **O-1** | Is "multi-user" only a schema/test property in 4B, or should public registration open? | **Schema/test property only.** Registration stays disabled (Supabase setting + `VITE_ENABLE_SIGNUP=false`). Opening it needs its own review (abuse, cost, support, privacy notice) | Open registration: more users but needs rate limits, email deliverability, terms/privacy text |
| **O-2** | Increment order: courses → tasks → exams → dashboard (4B.1–4B.4)? | **Yes**, one migration + hosted verification per increment | Single big migration: fewer hosted applies, much larger review and rollback risk |
| **O-3** | Task kinds and exam fields: are the closed lists right (task kinds `assignment, study, reading, project, admin, personal, other`; exam `exam_type` = `written, oral, practical, presentation, other` and a **separate** `delivery` = `in_person, online`, optional)? | **Accept**; adding a value later is a small new migration | User-defined kinds: flexible but breaks filters/analytics and validation |
| **O-4** | Course↔session link: derived or stored? | **Derived** by normalised code + term dates (DOMAIN §6), ambiguous/outside-term sessions stay unassigned; no change to `events`. Add a separate `course_event_links` table only if ambiguity proves common in real use | Column `events.course_id`: simplest queries but alters a provenance-protected table and needs backfill |
| **O-5** | Deleting a course/exam that has dependants | **Refuse (`RESTRICT`); courses: offer Archive.** Exams with tasks: an explicit, resumable, non-transactional "unlink N tasks and delete" flow (every intermediate state is valid; DATABASE_PROPOSAL §3.3); an atomic `SECURITY INVOKER` function is a later option | `SET NULL` (PG ≥15): easier deletes but silently orphans tasks |
| **O-6** | Local (signed-out) mode for tasks/courses/exams? | **Cloud-only planner**; the existing local calendar is untouched; planner routes show a sign-in message; the session is disposed on sign-out/account switch (DATABASE_PROPOSAL §8.3) | Also local storage: ~2× persistence code and a second import path for no current user |

## B. Decide during implementation (non-blocking, default applies)

| # | Question | Default | Alternatives |
| --- | --- | --- | --- |
| O-7 | Existing `deadline`-category events | Leave untouched; maybe later an explicit per-item "convert to task" | Auto-convert (rejected: destructive/ambiguous); hide them (rejected: data loss feel) |
| O-8 | Extractor for roster images (future) | Decide in the roster phase; start with CSV/PDF-text; evaluate on-device OCR vs. server vision with explicit opt-in | Third-party vision API by default (privacy/cost risk) |
| O-9 | Task search | Client-side substring over loaded tasks | Postgres full-text/trigram (extension, indexes) when volume demands |
| O-10 | One vs. three migrations | **Three, in dependency order:** 4B.1 courses; 4B.2 tasks **without** `exam_id`; 4B.3 exams **plus** `tasks.exam_id` and its 3-column composite FK in the same file | One file: single hosted apply but no independent verification/rollback |
| O-11 | Navigation | One **Plan** entry (tabs: Tasks, Exams, Courses) to keep the 5-item bottom nav | Three new top-level items (crowded on mobile) |
| O-12 | Non-student vocabulary ("Project" instead of "Course") | Keep "Course" in code; user-facing label configurable later | Rename now (premature) |
| O-13 | Reserve `external_source`/`external_instance`/`external_id` columns now | **Yes**, nullable, all-or-none CHECK, partial unique index scoped by instance | Add at Canvas time via a new migration (also fine, but touches tables with real data) |
| O-14 | Course colour set | 8 theme tokens `c1…c8` | Free hex picker (violates "no hardcoded hex" rule; accessibility risk) |
| O-15 | Show completed tasks in calendar | Hidden by default, optional toggle | Always show struck-through |
| O-16 | Overdue boundary for date-only tasks | Overdue from the start of the *next* local day | Overdue at end of due day 17:00, or user preference |
| O-17 | Default time zone for tasks/exams | Europe/Berlin (the app's display zone); stored per row | Per-user setting (needs a user-settings table; relevant to AI preferences later) |
| O-18 | Calendar position of due items | "Due" lane above timed events + dot in month cells | Inline timed markers only |
| O-19 | Overlapping term dates for one code | Allowed by the database; client warns; matching treats overlap as ambiguous | Exclusion constraint with `btree_gist` (stricter, extra extension) |
| O-20 | Exams crossing midnight | Not supported (`end_time > start_time`) | Add an end-day offset like series |
| O-21 | `delivery` values | `in_person`, `online` (NULL = unknown) | add `hybrid` |

## C. High-risk architectural issues

1. **Protect-trigger pitfall.** `orbit_protect_row()` only protects three named tables; reusing it for new tables gives no `id`/`user_id` immutability. Mitigated by a new generic function and tests (DATABASE_PROPOSAL §2, S-5). *Risk if missed: silent ownership reassignment inside one account's rows.*
2. **Hosted migrations are irreversible-in-practice** once real data exists. Mitigation: local Docker + PGlite validation, rollback in `supabase/recovery/`, apply one increment at a time, hosted two-account check before enabling the flag.
3. **Pessimistic, no-offline model.** Task completion needs a network round-trip; on a phone with poor signal this feels slow. Accepted for MVP (consistent with the event model); an offline queue is Phase 5. The UI must show pending state clearly to avoid double taps.
4. **Free-text course code matching** can mislink (typos in a manual code, two terms with one code). Mitigated by normalisation, term dates, an explicit "ambiguous — choose" state, and showing why a session matched.
5. **Last-writer-wins gaps already documented** (exceptions) do not extend to planner tables: they use conditional updates on `updated_at` like events/series.
6. **Cost of agenda recomputation** if the projection runs on every render: memoise by snapshot identity and visible range; test with a 5,000-item fixture.
7. **Scope creep** into reminders, time tracking, AI. Section 4 of PRODUCT_SCOPE lists exclusions; each new item needs an explicit decision.

## D. Questions to resolve before implementation

1. Approve O-1…O-6 (or choose alternatives).
2. Is the hosted PostgreSQL version known to be ≥15? (The applied provenance migration requires it, so yes in practice; confirm once in the dashboard.)
3. Which semester/institution data should the first real courses use? (Owner enters them manually; no real timetable data is bundled or committed [Fact rule].)
4. Planner features are flag-gated (`VITE_ENABLE_PLANNER_COURSES/TASKS/EXAMS`, default off, pinned `'false'` in the deploy workflow until each hosted verification passes). Confirm.
5. Grade format for `target_grade`: free text (recommended) or a numeric scale per course?
6. Priority labels: 3 levels (`low/normal/high`) enough?
7. Should the exam "taken" state prompt for the achieved grade later (grade tracking is excluded now)?

# Phase 4B — Database and frontend module proposal

**This is a design proposal, not an executable migration.** No SQL here has been run anywhere. Labels: **[Fact]** verified in repo · **[Rec]** recommendation · **[Open]** needs decision ([OPEN_DECISIONS.md](OPEN_DECISIONS.md)). Entities and rules: [DOMAIN_MODEL.md](DOMAIN_MODEL.md).

## 1. Existing conventions this proposal follows

* **[Fact]** Three applied, immutable migrations in `supabase/migrations/` (core schema, RLS, event imports). Schema changes only via **new** timestamped migrations; rollbacks live in `supabase/recovery/` (never under `migrations/`; a guard test enforces it).
* **[Fact]** Fail-closed pattern: a table is created with RLS enabled and all client privileges revoked in the *same* migration, then granted minimally to `authenticated` only. No `anon` access, no policy for `anon`.
* **[Fact]** `user_id uuid not null default auth.uid() references auth.users(id) on delete cascade`; policies `using/with check (user_id = (select auth.uid()))`.
* **[Fact]** Helpers live in schema `orbit_private` (not exposed over PostgREST). No `SECURITY DEFINER` anywhere.
* **[Fact]** Composite FKs `(id, user_id)` for ownership independent of RLS (used by `event_import_links`); column-level grants; triggers that re-check state.
* **[Fact]** Tests: PGlite simulation (`supabase/tests/*.test.ts`), plus hosted two-account script `scripts/hosted-two-user-rls-check.mjs` (79 checks passed on hosted).
* **[Fact]** Client: `CloudApi` (only code building PostgREST requests), pure mappers/validators, `FakeCloudApi` for tests, idempotent inserts, `updated_at` optimistic concurrency, pagination (1000/page).

## 2. Findings that affect this design

1. **[Fact] `orbit_protect_row()` hard-codes table names** (`events`, `recurring_series`, `series_exceptions`). A new table that reuses it would silently get **no** `id`/`user_id` immutability check (it only refreshes timestamps). The new migration must add its own function (e.g. `orbit_protect_owned_row`) that enforces `id`, `user_id` and `created_at` immutability generically, and a test that proves it for every new table. Do **not** edit the applied function.
2. **[Fact]** `events.course_code` is free text (≤30), un-normalised; `''` means "clear" in overrides. Matching must normalise (§6).
3. **[Fact]** `orbit_validate_zone` is a trigger on specific tables; reuse the function, add triggers for new tables.
4. **[Fact]** There is no per-user settings table; the app hard-codes Europe/Berlin. Needed later for AI preferences ([FUTURE_INTEGRATIONS.md §4](FUTURE_INTEGRATIONS.md)) but **not** in 4B.
5. **[Fact]** The provenance snapshot covers a fixed event column list, so *adding unrelated tables* is safe; *adding columns to `events`* would still be a change to a protected table and is avoided.

## 3. Proposed tables

All tables: `id uuid primary key default gen_random_uuid()` (client may supply for idempotent create), `user_id` as above, `created_at`/`updated_at timestamptz not null default now()`, `unique (id, user_id)` (target of composite FKs). `updated_at` is server-maintained by trigger; never sent by the client [Fact convention].

### 3.1 `courses` (migration 4B.1)
| Column | Type / rule |
| --- | --- |
| `name` | text, `length(btrim(name)) between 1 and 120` |
| `code` | text null, `length ≤ 30` (same bound as events); when present its key must be non-empty |
| `code_key` | text, `GENERATED ALWAYS AS (normalisation rule N of `code`) STORED`; NULL when `code` is NULL |
| `institution` / `institution_key` | text null ≤ 120 / generated key (rule N; `''` when NULL) |
| `term_label` / `term_key` | text null ≤ 40, **display only** / generated key (rule N; `''` when NULL) |
| `term_start`, `term_end` | date null; **CHECK both NULL or both set, and `term_end >= term_start`, and `term_end - term_start <= 400`**. These are the only term fields used for matching |
| `description` | text null, ≤ 2000 |
| `color` | text, check in `('c1'…'c8')` (theme token key, not hex) |
| `archived_at` | timestamptz null |

**Normalisation rule N** is defined once, in [DOMAIN_MODEL.md §6.1](DOMAIN_MODEL.md): collapse whitespace runs (`[ \t\r\n\f\v]` and U+00A0) to one space, trim, upper-case ASCII `a–z` only. SQL (locale-independent): `translate(btrim(regexp_replace(x, '[ \t\r\n\f\v\u00a0]+', ' ', 'g')), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`. (`upper()` is deliberately **not** used because it is locale dependent and would diverge from JavaScript.) The TypeScript twin is `normaliseKey`; a shared golden-vector test runs both (ACCEPTANCE C-10).

Indexes: `(user_id, archived_at)`; `(user_id, code_key) where code_key is not null` (matching lookups); **unique `(user_id, code_key, institution_key, term_key) where code_key is not null`**, so the *same normalised* code cannot be duplicated for the same institution and term label. Because uniqueness uses the same key as matching, `"inf 101"` and `"INF  101"` can never coexist as two courses. Two courses with the same code and **different** term labels/institutions are allowed; whether they can be told apart for *matching* depends only on term dates (DOMAIN §6.2). Overlapping term dates for one code are allowed by the database (an exclusion constraint would need `btree_gist`); the client warns and matching treats overlap as ambiguous. [Open] O-19

### 3.2 `tasks` (migration 4B.2) — **no `exam_id` yet**
| Column | Type / rule |
| --- | --- |
| `title` | text, 1–200 after trim |
| `description` | text null, ≤ 4000 |
| `kind` | text, check in `assignment, study, reading, project, admin, personal, other` |
| `course_id` | uuid null; **FK `(course_id, user_id) → courses(id, user_id)` `ON DELETE RESTRICT`** |
| `status` | text, check in `planned, in_progress, completed, cancelled`, default `planned` |
| `priority` | text, check in `low, normal, high`, default `normal` |
| `due_date` | date null |
| `due_time` | time null; **check `due_time is null or due_date is not null`** |
| `time_zone` | text not null default `'Europe/Berlin'` (validated by trigger) |
| `estimated_minutes` | integer null, `between 1 and 100000` |
| `tracked_minutes` | integer not null default 0, `between 0 and 1000000` |
| `completed_at` | timestamptz null; set/cleared by trigger; **check `(status = 'completed') = (completed_at is not null)`** |
| `external_url` | text null, ≤ 2000, **check `external_url ~* '^https?://'`** |
| `external_source`, `external_instance`, `external_id` | text null (≤ 40 / ≤ 200 / ≤ 200); **check all three NULL or all three set**; reserved for later import ([Rec] include now, O-13) |

The 4B.2 migration contains **no reference to exams**: no `exam_id` column, no FK, no exam type. The UI in 4B.2 has no exam field, so no unconstrained exam reference can exist.

Indexes: `(user_id, status, due_date)`; `(user_id, course_id)`; unique `(user_id, external_source, external_instance, external_id) where external_id is not null`. Also `unique (id, user_id)` (kept for uniformity; no table references tasks in the MVP).

### 3.3 `exams` and the task↔exam link (migration 4B.3, one approved migration)
**`exams`**
| Column | Type / rule |
| --- | --- |
| `course_id` | uuid **not null**; FK `(course_id, user_id) → courses(id, user_id)` `ON DELETE RESTRICT` |
| `title` | text 1–200 |
| `exam_type` | check in `written, oral, practical, presentation, other` (**what** is assessed) |
| `delivery` | text null, check in `in_person, online` (**how** it is held; independent of type) |
| `date_status` | check in `unknown, tentative, confirmed`, default `unknown` |
| `exam_date` | date null |
| `start_time`, `end_time` | time null |
| `time_zone` | text not null default `'Europe/Berlin'` (validated by trigger) |
| `location` | text null, ≤ 120 |
| `prep_status` | check in `not_started, in_progress, ready`, default `not_started` |
| `status` | check in `active, taken, cancelled`, default `active` |
| `target_grade` | text null, ≤ 10 (free text; grading scales differ) |
| `topics` | text null, ≤ 4000 |
| `external_source`, `external_instance`, `external_id` | as in tasks |

Date CHECKs (the four user-visible states of DOMAIN §4; no fake times):
```
unknown   → exam_date IS NULL     AND start_time IS NULL AND end_time IS NULL
tentative → exam_date IS NOT NULL AND start_time IS NULL AND end_time IS NULL
confirmed → exam_date IS NOT NULL AND ((start_time IS NULL AND end_time IS NULL)
                                    OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
```
Keys: `unique (id, user_id)` and **`unique (id, course_id, user_id)`** (target of the task link). Indexes: `(user_id, course_id)`, `(user_id, exam_date)`.

**Task link, added to `tasks` in the same migration**
```
alter table tasks add column exam_id uuid null;
-- a linked task must have a course (MATCH SIMPLE would otherwise skip the FK when course_id is NULL)
alter table tasks add constraint tasks_exam_needs_course check (exam_id is null or course_id is not null);
-- one composite FK carries owner AND course: same user, same course as the exam
alter table tasks add constraint tasks_exam_fk
  foreign key (exam_id, course_id, user_id) references exams (id, course_id, user_id) on delete restrict;
index (user_id, exam_id) where exam_id is not null
```
Why one FK: no trigger on `tasks` is needed for the same-course rule; the database refuses a mismatch on insert, on changing the task's `course_id`, and on changing the exam's `course_id` (the update would break existing links, so it is rejected with `restrict`/`no action` until the user unlinks the tasks). This is the smallest safe implementation. Trade-off: the UI must clear `exam_id` (or refuse) when a task's course changes, and show a clear message when an exam's course change is refused; a trigger-based design would give friendlier errors but adds code to review and test.

Deletion with `RESTRICT` (both FKs): deleting an exam that has linked tasks, or a course that has tasks/exams, is refused by the database; no user data is removed or detached implicitly.

**Explicit "unlink and delete exam" flow** (not transactional by design, no new SQL objects):
1. UI lists the N linked tasks and asks for confirmation.
2. For each task: conditional update `exam_id = NULL` on its `updated_at` (existing optimistic concurrency).
3. Conditional delete of the exam on its `updated_at`.
Partial-failure behaviour: every intermediate state is valid (a task without exam; an exam with fewer tasks), nothing is lost, and the flow is **resumable and idempotent** — rerunning it skips tasks already unlinked. If a task fails (stale/offline) the flow stops, reports which tasks remain, and leaves the exam in place. If another device links a new task between steps 2 and 3, step 3 is refused by `RESTRICT` and the UI reports it and offers to repeat. An atomic alternative (a `SECURITY INVOKER` function doing the same in one transaction) is possible later if partial failures prove annoying; it is not needed for the MVP. [Open] O-5

### 3.4 Future (not in the 4B migrations; shown so the design leaves room)
* `planned_blocks(task_id, user_id, starts_at, ends_at, time_zone, status, created_by)` with composite FK to `tasks`, `ON DELETE CASCADE`; `created_by in ('user','suggestion-accepted')`.
* `course_event_links(course_id, user_id, event_id|series_id)` only if per-session overrides are needed.
* `user_preferences(user_id pk, jsonb…)` for the routine planner.
* `external_imports` / links for Canvas, modelled on `event_imports` / `event_import_links` [Fact].

## 4. Validation and integrity rules (summary)

| Rule | Mechanism |
| --- | --- |
| Code/institution/term matching key | generated `*_key` columns (rule N) + golden vectors shared with the TypeScript `normaliseKey` |
| Term dates | CHECK both-or-none, ordered, ≤ 400 days |
| Exam date/time states | CHECK per `date_status` (§3.3) |
| Length/enumeration/format of every column | `CHECK` (server) **and** the same limits in `src/cloud/mappers.ts`-style validators (client), so the UI rejects before the network; the client list is mirrored from SQL like today [Fact] |
| `completed_at` consistency | trigger sets `now()` / `NULL` from `status`; CHECK ties them |
| Time zone is a real IANA zone | reuse `orbit_validate_zone()` trigger |
| `id`, `user_id`, `created_at` immutable; `updated_at` server-set | new generic `orbit_protect_owned_row` trigger (see Finding 1) |
| course/exam/task same-owner and same-course | composite FKs only: `tasks(course_id,user_id)→courses`, `exams(course_id,user_id)→courses`, and from 4B.3 `tasks(exam_id,course_id,user_id)→exams(id,course_id,user_id)` plus `exam_id is null or course_id is not null` (no trigger) |
| Date-only vs timed due | `due_time` requires `due_date`; interpretation in domain layer |
| External URL scheme | `^https?://` CHECK; the UI additionally renders links with `rel="noopener noreferrer"` and never as `javascript:` |
| No destructive cascades from user content | `RESTRICT` on course/exam FKs; the UI never auto-detaches |

## 5. RLS and authorization

Per table, identical to `events` [Fact]:
* `alter table … enable row level security; revoke all … from public, anon, authenticated;` in the creating migration (fail closed).
* `grant select, insert, update, delete … to authenticated;` (full-row grants are acceptable here because there is no provenance state to protect, unlike `event_import_links`; a column-level `grant update` that excludes `id, user_id, created_at, updated_at, completed_at` is still **recommended**).
* Four policies per table with `user_id = (select auth.uid())`; `with check` on insert/update.
* Cross-user linking is prevented twice: by RLS on the referenced table (a foreign user's course is invisible) and, independent of RLS, by the composite FKs.
* No views, no `SECURITY DEFINER`, nothing for `anon`, no service-role use in the frontend or tests [Fact rule].
* PostgreSQL ≥ 15 is already required by the applied provenance migration, so `ON DELETE SET NULL (col)` is available if a later decision prefers SET NULL over RESTRICT [Open] O-5.

## 6. Backward compatibility and protection of existing data

* No change to `events`, `recurring_series`, `series_exceptions`, `event_imports`, `event_import_links`, their policies, grants, triggers or functions.
* Course ↔ session relation is derived in the client from `courseCode` (DOMAIN_MODEL §6). Imported events keep byte-identical content, so `imported_snapshot` comparisons, "verified" checks and re-import duplicate prevention are unaffected.
* `orbit_forget_import_history` and the import RPCs do not reference the new tables.
* Normalisation function for matching (client, pure, unit-tested): `trim → collapse internal whitespace → uppercase`; the DB unique index uses `lower(btrim())` only for de-duplicating *courses*, not for matching events.

## 7. Migration strategy

1. **Three migrations, in dependency order** [Rec] (O-10):
   * **4B.1** `…_courses.sql`: `courses` (+ the generic protect trigger and normalisation helpers).
   * **4B.2** `…_tasks.sql`: `tasks` **without** `exam_id`; depends only on `courses`.
   * **4B.3** `…_exams.sql`: `exams` **and**, in the same file, `alter table tasks add column exam_id`, the `exam_id` check, the composite FK and its index. The migration depends on 4B.2 being applied. Because it alters `tasks` (which may then hold real rows), the added column is nullable with no default (a cheap, metadata-only change that rewrites no rows); its rollback drops the FK, constraint and column and **refuses to run if any task has a non-NULL `exam_id` without explicit confirmation** (same stance as the provenance rollback [Fact]).
   * No migration exposes a reference to a table that does not exist yet. 4B.2 never contains an unconstrained exam reference.
2. Each migration: forward SQL in `migrations/`, rollback in `supabase/recovery/`, validated in PGlite and on the local Docker stack, **then** applied to hosted only after approval, followed by the two-account hosted check extended to the new tables (synthetic rows, normal accounts, no service-role key) [Fact process from 4A.3].
3. **Feature flags** `VITE_ENABLE_PLANNER_COURSES`, `VITE_ENABLE_PLANNER_TASKS`, `VITE_ENABLE_PLANNER_EXAMS`, each default **off** in source and pinned `'false'` in the deploy workflow (with a guard test, as for `VITE_ENABLE_TIMETABLE_SAVE` [Fact]) until that increment's hosted migration is applied and the two-account check has passed; each is then enabled by its own reviewed PR. Dependencies: **tasks** work without courses (the course field is hidden if the courses flag is off); **exams require courses** (an exam needs a course), so `EXAMS` without `COURSES` is treated as off. Flags only hide UI: they are never a security control (RLS is). [Rec]
4. Never edit an applied migration. Rollback after real data must refuse without explicit confirmation (as for provenance [Fact]).

## 8. Frontend architecture

### 8.1 Options for where tasks/exams/courses live

| | A. Extend `CalendarSource` | B. One new `PlannerSource` (courses + tasks + exams), beside `CalendarSource` | C. Three independent services |
| --- | --- | --- | --- |
| Fit with current code | Interface is event/series specific, has `mode: local \| cloud`, local wrapper over localStorage [Fact] | Same pattern (per-user session, snapshot, pessimistic ops) with its own snapshot | Same pattern ×3 |
| Re-render cost | Every task edit re-renders every calendar consumer | Calendar re-renders only through the agenda projection | Finest-grained |
| Cross-entity validation (course exists, exam's course matches) | Mixed into an event-centric file (~330 lines already [Fact]) | One place sees courses, tasks and exams | Needs cross-service lookups |
| Local-mode (unsigned) support | Forced to implement local stores for tasks | Cloud-only; local mode shows a clear "sign in to use" state | same |
| Risk to existing, heavily tested calendar | **High** | Low | Low |
| Complexity | Low initially, grows poorly | Medium | Highest (3 sessions, 3 refresh loops) |

**[Rec] Option B.** Keep `CalendarSource` unchanged. Add a `PlannerSource` created by the same per-user lifecycle (generalise `calendarManager`'s `CloudSession` to carry both sources, or add a sibling manager; the session is disposed on sign-out/account switch exactly as today [Fact]). Views join the two via a pure, tested `buildAgenda(calendarSnapshot, plannerSnapshot, range)`.

Planner mutations follow the proven contract: asynchronous, **pessimistic** (`{ok:true}` only after the server confirmed; `{ok:false}` = not saved), idempotent create by client UUID, optimistic concurrency on raw `updated_at`, `FakeCloud`-style fake for unit tests, mock PostgREST for Playwright. No optimistic UI updates (rule in CLAUDE.md [Fact]).

Cloud-only decision: **[Open] O-6** (alternative: also implement local-storage stores; costs a second storage format and import story for no current user).

### 8.2 Proposed modules
```
src/planner/            PlannerSource, PlannerContext/Provider, usePlanner(), refresh hookup (reuse startAutoRefresh)
src/planner/agenda.ts   pure projection (events+series+tasks+exams → AgendaItem[])
src/planner/courses.ts  courseForSession(), normaliseCourseCode(), suggestCoursesFromEvents()
src/planner/tasks.ts    overdue(), due moment (uses utils/time.ts), filter/sort/search
src/planner/exams.ts    schedule rules, prep helpers
src/cloud/plannerApi.ts the ONLY code building requests for the 3 tables (like importApi.ts [Fact])
src/cloud/plannerMappers.ts  row ↔ model + validation (mirrors SQL limits)
src/cloud/fakePlannerApi.ts  in-memory fake
src/pages/CoursesPage.tsx, TasksPage.tsx, ExamsPage.tsx (lazy-loaded), components/planner/*
src/types/planner.ts
```
Routes inside `RequireAuth`; nav gets Courses/Tasks entries behind their flags (unfinished features must be hidden or visibly "Coming soon" [Fact rule]). Existing Study Planner keeps its "Demo data" badge until 4B.4.

### 8.3 Session lifecycle, local mode and refresh
* **Cloud-only MVP.** Courses, tasks and exams exist only for a signed-in cloud session. In local mode (Supabase unconfigured) or when signed out the planner routes show "Sign in to use Courses and Tasks" and the nav entries are hidden or disabled. The unsigned/local **calendar is unchanged** (`localSource` and the stores are not modified; `buildAgenda` simply receives no planner data and returns today's items). [Rec, final approval O-6]
* **One session per user, disposed on sign-out and account switch.** `PlannerSource` is created next to `createCloudSource(api, {userId})` by the same manager (`setUser`), and `dispose()` drops every private record from memory. [Fact pattern: `calendarManager` + `cloudSource` already "dispose on sign-out/account switch" and ignore late responses from a disposed instance (`disposed`/`loadSeq` guards, test "a disposed (signed-out) source ignores late responses and refuses writes")].
* **No cross-account leakage.** Every request closure belongs to one source instance; responses are applied only if `!disposed` and the read sequence is current; reads and writes use the session's JWT, and RLS is the final barrier. A response that arrives after an account switch is discarded, never merged into the new user's snapshot. The `userId` is kept on the snapshot like the calendar's.
* **Refresh without new loops.** Reuse the existing `startAutoRefresh` triggers (focus, visibility, online, 60 s poll while visible, ≥ 2 s gap [Fact]) by passing **one combined target** `{ refresh: () => Promise.all([calendar.refresh(), planner.refresh()]) }` — no second timer or listener set. Each source de-duplicates in-flight refreshes (as the calendar does [Fact]). Planner refresh is also triggered once after any planner write, like the calendar's. Realtime stays off [Fact].
* **Stale reads** never overwrite newer data: a refresh that started before a write is discarded and repeated [Fact pattern].
* Tests: ACCEPTANCE L-1…L-8.

### 8.4 Static isolation tests (follow existing pattern [Fact: `provenance-isolation`, `preview-isolation`])
Planner code never touches `orbit.events.v1` / `orbit.series.v1`, never imports `eventStore`/`seriesStore`, never uses `console.*`, and never references service-role keys.

## 9. Security risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cross-user reference (task → another user's course/exam) | RLS on referenced table **and** composite FKs including `user_id`; PGlite test as table owner (RLS bypassed) and two-account hosted test per table |
| Task linked to an exam of a different course | single 3-column composite FK `(exam_id, course_id, user_id)` + `exam_id is null or course_id is not null` |
| Mislinking sessions to a course by an ambiguous code | rule N + matching rules (DOMAIN §6.2); ambiguous/outside-term sessions are never assigned |
| Table reused trigger gives false protection (Finding 1) | New generic protect function + per-table test |
| Stored XSS via description/URL | React escapes text; URL scheme CHECK + `rel` attributes; never `dangerouslySetInnerHTML` |
| Client-supplied `user_id`/`completed_at`/`updated_at` | Not sent by client; column grants exclude them; triggers overwrite |
| Silent data loss on delete | `RESTRICT`; explicit UI; no automatic cascade of user content |
| Over-posting extra columns via PostgREST | Column-level `grant update` lists |
| Large text DoS | length CHECKs; list pagination 1000/page |
| Accidental real data in tests | Synthetic marker `ORBIT_RLS_CHECK_<run>` for hosted checks; no real data in fixtures [Fact rules] |

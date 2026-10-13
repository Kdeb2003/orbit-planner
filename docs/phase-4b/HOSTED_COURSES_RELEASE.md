# Hosted release of Courses (Phase 4B.1c): runbook

**Status: Gates A, B and C DONE; Gate D PR PREPARED, NOT YET MERGED OR DEPLOYED.** The live site does not run Courses until the Gate D PR is merged and deployed, and the live-site smoke test is still pending. Every gate needed the owner's explicit approval; Claude/automation never runs a hosted gate on its own. The sections below keep the original runbook text (written before execution) for reference.

### Execution record (hosted project `wlxdfrkppuhjtubntduc`)

| Gate | Outcome |
|---|---|
| A | Done. Preflight passed (blob and SHA-256 matched; history = three applied + only `20261020120000` pending; dry run listed only that file; PostgreSQL 17.11). The Supabase Free plan has no confirmed usable backup (`backups: []`, no point-in-time recovery); **the owner deliberately waived the backup for this release.** Future backup work: GitHub issue #18. |
| B | Done. `20261020120000_courses.sql` applied to `wlxdfrkppuhjtubntduc`. All 12 read-only hosted schema checks passed (RLS on, exactly four owner-only policies, nothing for `anon`/PUBLIC, column-limited `authenticated` grants, both helper functions, indexes and the `courses_protect` trigger, zero rows, migration history intact). |
| C | Done. `scripts/hosted-courses-check.mjs` run with two existing normal accounts: **59 passed, 0 failed, exit code 0**. Synthetic course cleanup succeeded with zero rows remaining. The two accounts were retained, not deleted. |
| D | Activation PR prepared (`release/courses-gate-d-enable`: flag `'true'` in `deploy.yml`, guard test, docs). **Not yet merged or deployed; live-site smoke test pending.** |

Why gates: once real course rows exist, undoing the migration destroys them. So the release is split into four steps, each with a clear stop condition, and nothing is enabled for users until the hosted security check passes.

| Gate | What happens | Who decides |
|---|---|---|
| A | Preflight: confirm what will be applied, to which project, with which backup | Owner approves |
| B | Apply the one reviewed SQL file | Owner approves, owner (or Claude on request) runs |
| C | Two-account security check on hosted (synthetic rows only) | Owner approves and prepares accounts |
| D | Turn the feature on for users (separate PR) | Owner approves |

## What exactly will be applied

| Item | Value |
|---|---|
| File | `supabase/migrations/20261020120000_courses.sql` (159 lines, **never edit it**) |
| Git blob id (the authoritative identity) | `85826de87b5d3c2046b39da4b55a2fcca59d444e`, the object committed in Git (`git rev-parse HEAD:supabase/migrations/20261020120000_courses.sql`) |
| SHA-256 of the committed bytes (8566 bytes, LF) | `ebfb6a287078a99b84568c8fa1f7c3fafdb614c5fa07426d2fce1008aab4765b`. A Windows working copy converted to CRLF (8725 bytes) hashes differently (`1335ac32...`); that is NOT the committed file and must not be compared with this value. |
| Adds only | table `public.courses`, functions `orbit_private.orbit_normalise_key(text)` and `orbit_private.orbit_protect_owned_row()`, 3 indexes, 1 trigger, 4 owner-only policies, minimal grants for `authenticated` |
| Changes nothing of | `events`, `recurring_series`, `series_exceptions`, `event_imports`, `event_import_links`, their policies, grants, functions or triggers (proved by `supabase/tests/courses.test.ts`) |
| Needs | schema `orbit_private` (created by `20261009120000_core_schema.sql`), `auth.users`, `auth.uid()`; PostgreSQL 12+ (generated columns), hosted is already 15+ |
| Rollback (manual, **not** part of the release) | `supabase/recovery/20261020120000_courses.rollback.sql` (SHA-256 in the audit notes at the end) |

### Verifying the file identity (PowerShell-compatible)

The committed Git object is the identity of the file, not whatever is in the working folder: with `core.autocrlf=true` (the Windows default here) a checkout converts LF to CRLF, so the working copy has other bytes and another SHA-256. `git hash-object <file>` is not a safe check either, because its result depends on the configured line-ending conversion. Check the committed object and hash its exact bytes (no PowerShell pipe, which would re-encode them):

```powershell
git rev-parse HEAD:supabase/migrations/20261020120000_courses.sql      # must print 85826de87b5d3c2046b39da4b55a2fcca59d444e
node -e "const c=require('crypto'),{execFileSync:x}=require('child_process');for(const f of ['supabase/migrations/20261020120000_courses.sql','supabase/recovery/20261020120000_courses.rollback.sql']){console.log(f,c.createHash('sha256').update(x('git',['cat-file','blob','HEAD:'+f])).digest('hex'))}"
# migration: ebfb6a28...765b   rollback: 435b2b2a...a39a   (full values in this document)
git status --short supabase                                           # must print nothing: the files are unmodified
```

If the blob id differs, the commit is not the reviewed one: stop. SQL does not care about CRLF versus LF, but apply from a clean checkout of the verified commit so that what runs is what was reviewed.

## Gate A: before any hosted change

Do all of this on the owner's machine; the checks marked *read-only* look at the hosted project and therefore also need the owner's approval, because "no hosted contact" has been the rule until now.

1. **Code state.** `main` contains all Courses work (PRs #11 to #16) and the working tree is clean. `npm test`, `npm run lint`, `npm run build` and `npm run test:e2e` pass (sequentially).
2. **Local evidence is current.** `supabase/tests/courses.test.ts`, `supabase/tests/courses-api.test.ts` and `supabase/tests/courses-hosted-check.test.ts` pass (PGlite). On the local Docker stack, the migration applies cleanly and `node scripts/hosted-courses-check.mjs` passes against it (see "Local rehearsal" below); this was done once on PostgreSQL 17.11 and a real PostgREST 14.
3. **Project identity.** Confirm that the project the CLI is linked to is the ORBIT project: the project reference in the dashboard URL matches `VITE_SUPABASE_URL` in the repository variables (the Pages deployment), and `npx supabase projects list` marks it as linked. *(read-only)* A wrong project is a stop condition.
4. **Migration history matches.** `npx supabase migration list` must show the first three migrations applied remotely and **only** `20261020120000` pending. *(read-only)* If the remote history is missing an earlier migration (for example because it was applied by hand), `db push` would try to re-run it and fail: STOP and fix the history first, do not push.
5. **Database version.** Dashboard -> Database shows PostgreSQL 15 or newer (already implied by the applied provenance migration, see OPEN_DECISIONS).
6. **API exposure.** Dashboard -> Settings -> API: "Exposed schemas" must NOT include `orbit_private` (the helper functions must not be callable as RPC). `public` and `graphql_public` are the defaults.
7. **Backup.** The project has no real course data yet, so the table is new and the migration only *adds* objects; still, take the standard precaution: dashboard -> Database -> Backups shows a recent backup (or take a manual one if the plan allows), and write down the time. The calendar and import-history tables are untouched by this migration, but they are real data.
8. **Single transaction.** The SQL must be applied as ONE transaction, so that a failure can never leave a half-created table (for example a table that exists but whose RLS/revokes have not run yet). The Supabase CLI applies a migration file as one batch; if you use the SQL editor or `psql` instead, wrap the file in `begin; ... commit;` (or `psql -1`) and never run it statement by statement.
9. **Flag stays off (until Gate D).** `grep VITE_ENABLE_PLANNER_COURSES .github/workflows/deploy.yml` shows `'false'`.
10. **Owner approval.** The owner writes "approved: apply 20261020120000_courses.sql to project <ref>" in the conversation. Without it, stop here.

## Gate B: apply the migration

Method (the one used for the earlier migrations): from the repository root, on a clean `main` checkout:

```powershell
npx supabase db push --dry-run     # read-only: must list ONLY 20261020120000_courses.sql
npx supabase db push               # applies it
```

Do not use `--include-all`, `db reset`, or any command that touches other files.

**Expected success indicators (all read-only, SQL editor or `psql` as a read-only role):**

```sql
select to_regclass('public.courses');                                              -- courses
select relrowsecurity from pg_class where oid = 'public.courses'::regclass;       -- t
select polname from pg_policy where polrelid = 'public.courses'::regclass order by 1;
  -- courses_delete_own, courses_insert_own, courses_select_own, courses_update_own  (exactly four)
select grantee, privilege_type from information_schema.role_table_grants
  where table_schema='public' and table_name='courses' and grantee in ('anon','authenticated','PUBLIC') order by 1,2;
  -- authenticated: DELETE, SELECT only (INSERT/UPDATE are column grants); NOTHING for anon or PUBLIC
select count(*) from public.courses;                                                -- 0
select version from supabase_migrations.schema_migrations order by 1 desc limit 1;  -- 20261020120000
```

**Stop conditions (do not continue to Gate C; report and decide):** any error from `db push`; a table that exists without RLS, with a policy count other than four, or with any privilege for `anon`/`PUBLIC`; a different object touched; a non-zero row count. A failed partial apply is handled by the owner and Claude together: do NOT run the rollback script reflexively (see below), first read what exists.

## Gate C: two-account verification on hosted

Script: `scripts/hosted-courses-check.mjs` (core: `scripts/hostedCoursesCore.mjs`). It is separate from `scripts/hosted-two-user-rls-check.mjs` (calendar and provenance), which stays unchanged and is not needed for this gate.

1. **Accounts (manual, dashboard; the owner does this).** Authentication -> Users -> Add user -> "Create new user", **Auto Confirm User** ticked, two *disposable* addresses and long random passwords from a password manager. Do not turn sign-ups on. Claude does not create or delete authentication users.
2. **Environment (in the owner's shell only; never in a file, never in chat, never in CI).**

```powershell
$env:ORBIT_COURSES_CHECK_CONFIRM = 'I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-COURSES-TO-THE-HOSTED-PROJECT'
$env:ORBIT_SUPABASE_URL = '<https project url>'
$env:ORBIT_SUPABASE_PUBLISHABLE_KEY = '<publishable key>'     # never the secret / service-role key (the script refuses it)
$env:ORBIT_USER_A_EMAIL = '...'; $env:ORBIT_USER_A_PASSWORD = '...'
$env:ORBIT_USER_B_EMAIL = '...'; $env:ORBIT_USER_B_PASSWORD = '...'
node scripts/hosted-courses-check.mjs --dry-run              # validates the configuration; no client, no request
node scripts/hosted-courses-check.mjs                        # the real check (writes synthetic courses, then removes them)
```

3. **What it proves** (59 checks, each recorded by id; the full list is `REQUIRED` in `hostedCoursesCore.mjs`): owner create/read/update/archive/restore/delete with optimistic-concurrency shapes; B cannot read, list, update, archive, delete, re-own, insert-as-A or take A's id (each negative paired with a positive control for the same operation by its owner, and with an "A's row is unchanged" read); anonymous cannot read/insert/update/delete; `id`, `user_id`, `created_at`, `updated_at` and the generated keys cannot be written; 12 kinds of invalid data are rejected with an *error* (not merely zero rows) and the exact boundaries (400-day term, 30-character code) are accepted; normalised uniqueness (case and whitespace variants, per user, null codes); generated keys and server timestamps.
4. **Expected report.** Every line `PASS`, last lines `59 passed, 0 failed`, exit code `0`. **Anything else is a FAIL:** a failed check, a crash, a missing table, a required check that did not run (there is no skip mode), a cleanup error or a leftover record all give exit code `1`; refusals (missing confirmation, bad configuration, failed sign-in) give `2` before any write.
5. **Cleanup verification.** The run deletes exactly the ids it created plus rows whose name carries its own marker `ORBIT_RLS_CHECK_<run>` (escaped `LIKE`), in each account's own space, also after a failure or crash. It then verifies twice: a per-account read after the deletes, and an independent read of both spaces at the very end. Check yourself afterwards (SQL editor, read-only): `select count(*) from public.courses where name like 'ORBIT\_RLS\_CHECK\_%';` must be `0`.
6. **If records are left behind.** The script says how many and for which account. Do not retry blindly. Delete them as the owning test account (sign in as that user, or delete the disposable test user in the dashboard: courses cascade with their user). Never delete anything else, never use a service-role key.
7. **If any line FAILS.** Stop. Do not "fix" with elevated rights. Report the check id and the error code printed. A failed isolation check means the hosted schema differs from the reviewed SQL: the feature stays off, and the migration question goes back to the owner.
8. **Afterwards.** Close the shell or `Remove-Item Env:ORBIT_*`. Delete the two disposable users. Record the result (date, `59 passed, 0 failed`) in `docs/phase-4b/DATABASE_PROPOSAL.md` and `CLAUDE.md` only after it really ran.

## Gate D: production activation

Only after Gate C passed and the owner approves again.

1. A **separate, small PR** changes only `VITE_ENABLE_PLANNER_COURSES: 'false'` to `'true'` in `.github/workflows/deploy.yml` and updates the guard test `tests/planner/planner-guards.test.ts` and the docs that say "pinned false". The PR reviews itself: no other change.
2. Final security and build checks on that PR: `npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`; the disabled-bundle test must be updated deliberately (it asserts the flag-off bundle, so it keeps testing the default).
3. Merge deploys (the existing workflow). Smoke test on the live site with the owner's account: Plan appears in the navigation, Courses opens, create a course, edit it, archive and restore it, delete it, and check the calendar still works.
4. **If something is wrong:** the fastest safe response is a PR that sets the flag back to `'false'` (hides the UI; RLS stays the real protection). Do not drop the table. The rollback script is a last resort for the *database*, see below.

## About the rollback script (read before ever touching it)

`supabase/recovery/20261020120000_courses.rollback.sql` removes the whole Courses table. It is **not** part of this release and must not be run casually:

* It destroys every course (names, codes, term dates, archive state). It cannot be undone by the script.
* It refuses (error 55000) while any course row exists unless the transaction explicitly confirms (`orbit.confirm_drop_courses = yes`); it refuses roles that would not see all rows (error 42501); it never uses CASCADE, so tables that later reference courses (tasks/exams) must be rolled back first.
* Running it on hosted is a **separate decision** that needs the owner's approval, a fresh backup, and a reason; hiding the feature with the flag is almost always enough. A rollback is only reasonable while the table is empty (for example straight after a failed Gate C and before real use).

## Local rehearsal (done once, local Docker stack only)

On the local Supabase stack (PostgreSQL 17.11, PostgREST 14.18; the hosted project was not contacted): the migration applied cleanly in one `psql` run, `node scripts/hosted-courses-check.mjs` (two disposable local users, throw-away local key) gave **59 passed, 0 failed**, the table was empty afterwards, the two users were deleted, and the rollback script ran on the empty table, returning the local database to its previous state. This is evidence about the SQL and the script on real PostgREST. **It is not evidence about the hosted project.**

## Audit notes (migration readiness, no edits made)

* Fail-closed order is in the file: `enable row level security` and `revoke all` directly follow `create table`; grants and the four policies come last. Only a *non-transactional* apply could expose the short window in between on Supabase's default privileges: hence Gate A item 8.
* `anon` and `PUBLIC` get nothing; `authenticated` gets `select, delete` and column-level `insert`/`update` lists that exclude `user_id`, timestamps and the generated keys. The helper functions are in `orbit_private`; `orbit_normalise_key` is executable by `authenticated` only because generated columns run with the caller's privileges.
* `service_role` keeps its usual Supabase privileges and bypasses RLS; the frontend never has that key.
* No SECURITY DEFINER anywhere; no change to existing tables.
* Known, accepted properties: the generated key function must never be edited after rows exist (stored keys would not be recomputed); the unique index error text names the index (the client relies on it); a plain insert with an id that belongs to another user returns a unique-violation error (the id exists; ids are random UUIDs).
* Rollback files: `20261020120000_courses.rollback.sql`, SHA-256 of the committed bytes (blob `a9bd1e11770d071ae27fbd7a042fd3d56a661851`): `435b2b2aa17138fc1629ed9ebed2d839a07caf49d984de3713b540968bdea39a`.

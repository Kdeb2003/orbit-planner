# Hosted two-account RLS and provenance-integrity verification (procedure, NOT YET RUN)

Purpose: prove on the **hosted** project that (a) one signed-in user cannot read, change, delete or link another user's data, for the existing tables (`events`, `recurring_series`, `series_exceptions` are still unverified live) and, after checkpoint 2, for `event_imports`, `event_import_links`, `orbit_import_sessions` and `orbit_forget_import_history`; and (b) the same user cannot corrupt their own import provenance through the table API.

Rules
* Only **normal user sessions** (publishable key + email/password). **No service-role or secret key**, not even to "make it easier". RLS and the integrity triggers must apply to every request.
* Only **disposable synthetic rows** marked `ORBIT_RLS_CHECK_<run id>` (source slug `rls-check-<run id>`), created in each account's own space and deleted at the end. Never touch or delete real data.
* Public sign-up stays **disabled**. Nothing in this procedure enables it.
* Do not run it before checkpoint 2 is approved **unless you only want the existing-table part** (the provenance part is then skipped automatically).
* Stop and wait for approval at every "STOP".

## A. Second test account (manual, dashboard; STOP for approval first)

1. Supabase dashboard → **Authentication → Users → Add user → Create new user**.
2. Use a disposable address you control and a long random password stored in your password manager. Tick *Auto Confirm User*.
3. Do **not** change *Authentication → Sign In / Providers → Allow new users to sign up*; it stays off.
4. Accounts: **A** = a normal account, **B** = the new test account. Using a *third* disposable account as A is safest, so your real calendar is not involved at all (the script only ever touches rows carrying the run marker either way).

STOP: tell Claude the accounts exist and that the run is approved. Claude does not create or delete authentication users.

## B. Run the script (from your machine, never in CI)

```powershell
$env:ORBIT_RLS_CHECK_CONFIRM = 'I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-ROWS-TO-THE-HOSTED-PROJECT'
$env:ORBIT_SUPABASE_URL = '<https project url>'
$env:ORBIT_SUPABASE_PUBLISHABLE_KEY = '<publishable key>'      # never the secret / service-role key
$env:ORBIT_USER_A_EMAIL = '...'; $env:ORBIT_USER_A_PASSWORD = '...'
$env:ORBIT_USER_B_EMAIL = '...'; $env:ORBIT_USER_B_PASSWORD = '...'
node scripts/hosted-two-user-rls-check.mjs --dry-run   # validates the configuration, makes no request

# BEFORE the provenance migration (existing tables only; provenance checks are reported as SKIP):
node scripts/hosted-two-user-rls-check.mjs

# AFTER the provenance migration (the post-migration verification): provenance tables and both RPCs are REQUIRED.
# If any is missing the run FAILS; a skipped provenance check can never produce a passing run.
node scripts/hosted-two-user-rls-check.mjs --require-provenance
```

**Exit codes:** `0` = every check passed and cleanup verified that no run-created record remains. `1` = a failed check, a crash, a cleanup problem, a leftover record or (with `--require-provenance`) a skipped check. `2` = refused to start (configuration / confirmation). A run without `--require-provenance` that skipped the provenance part ends with a NOTE saying it did not verify them; it is only valid before the migration.

Close the shell (or `Remove-Item Env:ORBIT_*`) afterwards. Nothing is written to files.

## C. What it checks (expected: every line PASS)

**Existing tables (can run today)**
1. A creates a synthetic event, series and exception as themselves.
2. B cannot read, update or delete A's event, series or exception (0 rows or an error), cannot create an event attributed to A, cannot attach an exception to A's series. The exception update is a **valid** edit (`cancelled: true` plus an `override` title, aimed at the exact `series_id` + `original_date`), so a denial cannot be explained by an invalid payload; a **control** applies the identical edit as the owner on a second exception and must succeed.
3. A's data is unchanged afterwards (A's exception still `cancelled = true` with no override).
4. Anonymous visitors cannot read `events`, `recurring_series`, `series_exceptions`, nor create events or series.

**Provenance tables (reported as SKIP until the approved migration is applied)**
4b. *Event-id collisions (same user and across users):* an item whose event id is already used by A's own manual event, or by A's event when B imports, comes back `event-id-taken`; A's event is unchanged; no link is written.
4c. *Malformed RPC payloads:* empty list, non-array, item without `source`, item without `event`, non-UUID event id, duplicate keys in one request are all rejected and write nothing.
5. *Happy path (same user):* A creates a batch (starts `in_progress`), imports a synthetic session through the RPC (`created`), repeats it (`already-linked`), labels an incomplete batch `written_partial`, dismisses a session, completes a second batch (`written` then `verified`).
6. *Integrity (same user, must be rejected):* direct link insert; rewriting a link's `source_key`, `imported_snapshot`, `source_snapshot`, `batch_id`, `event_id` (re-point and forged tombstone); direct link delete; rewriting a batch's `planned_count`, `written_at`, `source_sha256`; declaring an incomplete batch `written` or `verified`; reopening a verified batch; importing into a finished batch; importing more than planned; deleting a written batch directly.
7. *Two users:* B cannot read, update or delete A's batches or links, cannot run the RPC on A's batch, cannot link B's import to A's event; B's `orbit_forget_import_history` affects only B (A's links survive).
8. *Anonymous:* cannot read batches or links, cannot call either RPC.
9. *Supported deletion:* A's `orbit_forget_import_history` removes only the run's provenance; A's calendar events are kept.

**Cleanup** (also after a failure or crash; each account independently, one failing never skips the other): history is forgotten with the run's own slug; every event/series id the run created or might have created is deleted by its owner; any row still carrying this run's marker (escaped `LIKE`) is deleted. Cleanup then **verifies**: the marker, the tracked ids and (when provenance exists) the run's batches and links must all be gone. Each account's cleanup is reported as a check, **so it FAILS the run (exit 1)** if a delete or sweep errors, a verification read errors, anything created by the run remains, or the cleanup throws. Output carries error codes only, never exception text, URLs or credentials. Then both users are signed out.

## D. After the run

* Record the result in `docs/cloud-sync.md` ("Verification status") only if it actually ran, with the date and the PASS/FAIL list. Until then cross-user isolation stays listed as **not verified live**.
* Delete account B in the dashboard (**Authentication → Users → … → Delete user**); its rows cascade. Do not delete any other user.
* If any line FAILS: stop, do not retry blindly, do not "fix" with a service-role key; report the line and the error code. A FAIL in section 6 means a trigger or grant did not behave as in the offline tests.

## E. Review of `scripts/hosted-two-user-rls-check.mjs` (revision 2)

| Area | Finding | Status |
|---|---|---|
| Authentication | Two independent `signInWithPassword` sessions, a third unauthenticated client for the anonymous checks. `persistSession` off, `autoRefreshToken` off, signed out at the end. | ok |
| Credentials | Environment variables only; never printed or written; emails masked; refuses a secret/service-role-looking key (`sb_secret_…`, JWT with `role: service_role`), a non-https URL (plain http only for `localhost`/`127.0.0.1`, **host anchored**: `http://localhost.evil.example` is refused; fixed in the final self-review), and identical accounts. A refusal exits with code 2 before any request. | ok; guards **are executed by `tests/utn/hosted-script-guards.test.ts`** (13 tests, mutation-checked) |
| Confirmation | Needs a long explicit phrase; cannot run by accident. | ok |
| Row targeting | Every created row carries the run marker (title `ORBIT_RLS_CHECK_<run>`, slug `rls-check-<run>`); no query selects or modifies unmarked rows; deletes are by tracked id or by marker. **Fixed:** rows a failing check might create by mistake (e.g. a forged event attributed to A) are now tracked and also swept by marker; **the marker `LIKE` now escapes `_` and `%`** (they are wildcards), so the sweep cannot match anything but this run's own titles. Note the sweep runs inside each account's own RLS space only. | ok |
| Cleanup | Runs in `finally`, so also after an exception. **Fixed:** provenance can no longer be deleted directly, so cleanup uses `orbit_forget_import_history` with the run slug (it cannot touch another slug or user); leftover count printed per account. | ok (never executed against a server) |
| Table probe | **Fixed:** the existence probe was a HEAD request, whose error has no body and therefore no code, so a missing table could have been taken for present and the whole provenance section would have FAILed instead of SKIPping. It is now a plain GET: 404 / `PGRST205` / `42P01` = missing. | ok (logic never run against a server) |
| Error handling | Each check records PASS/FAIL; an unexpected exception is reported as `run crashed` (message only, no stack) and still triggers cleanup; exit code 1 on any failure or crash. A "denied" is accepted as an error **or** zero affected rows (PostgREST returns empty results for RLS-filtered statements). | ok |
| Coverage | **Added:** series and exceptions; anonymous access to all five tables and both RPCs; same-account integrity rejections; lifecycle (`written`, `verified`); **event-id collisions (own and another user's event) and six malformed payloads (final self-review)**. A "denied" read/update/delete is accepted as an error or zero rows, so a check on a misspelled table could pass vacuously; each negative check is paired with a positive check on the same table by the owner. | ok |
| What was **not** verified | The script has never made a network call: request shapes (PostgREST filters, RPC argument names), error codes returned by the hosted API and timing are untested. Its offline equivalents are the PGlite suites. Expect to adjust a check if a line FAILS for a reason that is a script bug rather than a security finding. | **PENDING** |

## E2. Final hosted-verification hardening (this checkpoint)

| Gap | Correction | Tested offline |
|---|---|---|
| Cleanup problems and leftovers were only logged; the exit code ignored them | Cleanup is verified and reported as a check; failures, leftovers, errors and exceptions all set exit code 1; both accounts are always attempted | `cleanupUser` with fake clients: delete error, silently-stuck row, unreadable verification, throwing client (still continues), leftover batches/links, forget error |
| Missing provenance was always a SKIP | `--require-provenance` makes missing tables or RPCs a FAIL; tables without RPCs (or the reverse) fail in every mode; the RPC probe uses inputs rejected before any read or write | `provenanceDecision`, `rpcMissing`, `exitCode`, `--dry-run` mode output |
| The foreign-user exception update (`cancelled: false`, no override) could be rejected as invalid even for the owner | Valid edit, exact occurrence, owner control, unchanged-owner check | static assertion on the script |
| Thrown exception text could reach the output | only the exception name is printed | fake client that throws a message containing a secret-looking string |

Still true: the network logic has never run against a real server.

## F. Status

| Item | Status |
|---|---|
| Script syntax, refusal guards, `--dry-run` | checked offline |
| Script network logic against the real API | **never run** |
| Equivalent isolation and integrity checks in SQL (PGlite) | passing (`supabase/tests/migrations.test.ts`, `supabase/tests/import-provenance.test.ts`) |
| Hosted cross-user isolation, existing tables | **PENDING** |
| Hosted cross-user isolation and integrity, provenance tables | **PENDING** (needs checkpoint 2) |

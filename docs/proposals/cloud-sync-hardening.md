# Proposal: cloud-sync hardening (NOT APPLIED, needs approval)

Status: **proposal only.** Nothing here is in `supabase/migrations/`, nothing was run against the hosted project, and applied migrations are untouched.

## What the review found (code reading, mock tests and the hosted QA run)

| # | Behaviour | Can data be lost? | Severity |
|---|---|---|---|
| 1 | Saving a series is **two requests**: (1) conditional `UPDATE` of the schedule, (2) one `DELETE` per exception the user agreed to drop. | **No.** If (2) fails, the series is already saved, the exceptions stay (they become harmless orphans), and the dialog stays open with “The series was saved, but N outdated exception(s) could not be removed. Try saving again.” A retry recomputes the same removal and is safe. Exceptions are only removed from the set the user explicitly confirmed; exceptions another device added after the last refresh are not in that set and survive. | Low |
| 2 | Exceptions are **last-writer-wins**: two devices editing the same occurrence → the later write replaces the earlier one without a warning. | One of two near-simultaneous changes to the **same occurrence** is replaced. Nothing else is affected. | Low (single-user app, rare) |
| 3 | After a failed request whose outcome is unknown (timeout), the app re-reads the server instead of assuming. | No | n/a |
| 4 | A 401/“JWT” error shows “Your session has expired” but does not itself sign out; supabase-js signs out when it cannot refresh the token (then all private state is cleared). A token the server rejects while the local one still looks valid keeps showing the last data plus the error. | No | Low |

Neither #1 nor #2 blocks merging Phase 3B: they are documented limits and no confirmed data can disappear silently.

## Option A: client-only fix for #2 (no migration, recommended first)

`series_exceptions` already has a server-maintained `updated_at` (trigger). The client can use it like it does for events:

* remember each exception's `updated_at` from the read;
* **edit** an existing exception with `UPDATE … WHERE series_id = ? AND original_date = ? AND updated_at = ?` (0 rows → “changed on another device”);
* **create** with `INSERT … ON CONFLICT DO NOTHING` (0 rows → someone created it first);
* **delete** conditionally the same way.

This needs changes in `cloudApi.ts`, `cloudSource.ts`, `FakeCloud` and `e2e/cloudMock.ts`, plus tests, but **no schema change and no RLS change**.

## Option B: atomic series update for #1 (needs a new migration)

A function that updates the series and deletes the listed exceptions in one transaction. Sketch only (unreviewed, to be written and tested with PGlite before any proposal to apply):

```sql
-- NEW migration file, never an edit of an applied one.
create or replace function public.orbit_save_series(
  p_id uuid, p_expected_updated_at timestamptz, p_patch jsonb, p_drop_dates date[]
) returns public.recurring_series
language plpgsql
security invoker            -- RLS keeps applying: the caller can only touch their own rows
set search_path = ''
as $$
declare r public.recurring_series;
begin
  update public.recurring_series s set
    title = p_patch->>'title', /* … every patchable column … */
  where s.id = p_id and s.updated_at = p_expected_updated_at
  returning * into r;
  if not found then return null; end if;          -- stale or not yours: caller reports a conflict
  delete from public.series_exceptions where series_id = p_id and original_date = any (p_drop_dates);
  return r;
end $$;
revoke all on function public.orbit_save_series(uuid, timestamptz, jsonb, date[]) from public, anon;
grant execute on function public.orbit_save_series(uuid, timestamptz, jsonb, date[]) to authenticated;
```

Trade-offs: a `public` function becomes a PostgREST `/rpc` endpoint (acceptable with `security invoker` + RLS, but it enlarges the API surface that the Phase 3A audit kept deliberately small); the patch-by-jsonb mapping duplicates column knowledge in SQL. Because #1 loses no data, the benefit is mostly a nicer error story, so **B is optional and I would not do it before the live QA is finished.**

## Option C: nothing to change for #4 yet

If live use shows a rejected-token-but-not-signed-out situation, the fix is client-side: on an `auth`-kind error, call `supabase.auth.getUser()` (validates the token server-side) and sign out if it fails.

## Decision requested

1. The hosted QA run is complete (see the verification status in [../cloud-sync.md](../cloud-sync.md)); the two-account isolation test is still outstanding.
2. Choose: A (client-only exception versioning), B (migration), both, or neither for now.

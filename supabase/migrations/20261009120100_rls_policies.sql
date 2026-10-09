-- ORBIT Row Level Security (Phase 3A) — NOT yet applied to any hosted project.
-- Requires 20261009120000_core_schema.sql (which already enabled RLS and revoked all client
-- privileges, so the tables are closed until this file runs).
--
-- Security model
--   * Every table has RLS enabled. With RLS on and no matching policy, access is denied.
--   * Only the `authenticated` role gets any table privileges; `anon` (logged-out
--     visitors) gets none, and no policy targets `anon`.
--   * Ownership is `user_id = auth.uid()`. `(select auth.uid())` is used so Postgres
--     evaluates it once per statement instead of once per row.
--   * series_exceptions has no user_id: access is allowed only if the parent series is
--     owned by the caller (checked with EXISTS on recurring_series, which is itself RLS-protected).
--   * Ownership/identity cannot be reassigned (policy WITH CHECK + orbit_protect_row trigger).
--   * No views, no SECURITY DEFINER functions: nothing can bypass these policies. Helper
--     functions live in the non-exposed schema orbit_private (no RPC access, no anon EXECUTE).
--   * The `service_role` key bypasses RLS by design. It must NEVER be used in the frontend.

-- RLS is already enabled (and client privileges revoked) by the core schema migration so the
-- tables were never exposed. Re-asserting it here is idempotent and keeps this file self-contained.
alter table public.events            enable row level security;
alter table public.recurring_series  enable row level security;
alter table public.series_exceptions enable row level security;

-- Explicit privileges: start from nothing, then grant the minimum to signed-in users only.
-- (Supabase's default privileges may have granted more to anon/authenticated; reset them.)
revoke all on public.events, public.recurring_series, public.series_exceptions from public, anon;
revoke all on public.events, public.recurring_series, public.series_exceptions from authenticated;
grant select, insert, update, delete on public.events, public.recurring_series, public.series_exceptions to authenticated;

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create policy events_select_own on public.events
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy events_insert_own on public.events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy events_update_own on public.events
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy events_delete_own on public.events
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- recurring_series
-- ---------------------------------------------------------------------------
create policy series_select_own on public.recurring_series
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy series_insert_own on public.recurring_series
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy series_update_own on public.recurring_series
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy series_delete_own on public.recurring_series
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- series_exceptions (ownership via the parent series)
-- ---------------------------------------------------------------------------
create policy exceptions_select_own on public.series_exceptions
  for select to authenticated
  using (exists (
    select 1 from public.recurring_series s
    where s.id = series_exceptions.series_id and s.user_id = (select auth.uid())
  ));

create policy exceptions_insert_own on public.series_exceptions
  for insert to authenticated
  with check (exists (
    select 1 from public.recurring_series s
    where s.id = series_exceptions.series_id and s.user_id = (select auth.uid())
  ));

create policy exceptions_update_own on public.series_exceptions
  for update to authenticated
  using (exists (
    select 1 from public.recurring_series s
    where s.id = series_exceptions.series_id and s.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.recurring_series s
    where s.id = series_exceptions.series_id and s.user_id = (select auth.uid())
  ));

create policy exceptions_delete_own on public.series_exceptions
  for delete to authenticated
  using (exists (
    select 1 from public.recurring_series s
    where s.id = series_exceptions.series_id and s.user_id = (select auth.uid())
  ));

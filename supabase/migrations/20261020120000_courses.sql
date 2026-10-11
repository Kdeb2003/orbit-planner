-- ORBIT planner, increment 4B.1: courses — NOT yet applied to any hosted project.
-- Design: docs/phase-4b/DATABASE_PROPOSAL.md §3.1 and DOMAIN_MODEL.md §6.1 (normalisation rule N).
-- Rollback (manual, refuses while course rows exist): supabase/recovery/20261020120000_courses.rollback.sql
--
-- Adds ONLY: public.courses, orbit_private.orbit_normalise_key(), orbit_private.orbit_protect_owned_row().
-- No existing table, policy, grant, function or trigger is touched; courses are NOT linked to events
-- (sessions are matched to courses in the client by normalised code and term dates).
--
-- FAIL-CLOSED: RLS is enabled and every client privilege revoked in this file, right after create table.
-- Only the grants and the four owner-only policies at the end of the file open the table, and only to
-- `authenticated`. `anon` never receives privileges or policies. No SECURITY DEFINER function.
-- Helpers live in `orbit_private` (never exposed as RPC).

-- ---------------------------------------------------------------------------
-- Normalisation rule N (the SQL twin of normaliseKey in src/planner/normalise.ts):
--   1. every run of [ \t\r\n\f\v] or U+00A0 becomes ONE ASCII space; then trim spaces at both ends;
--   2. ASCII a-z become A-Z; every other character is unchanged (no upper(): it is locale dependent
--      and would diverge from JavaScript).
-- The regular expression uses ARE escapes (\t \r \n \f \v \u00a0), which are interpreted by the regex
-- engine, not the string literal (standard_conforming_strings keeps the backslashes). The shared golden
-- vectors (src/planner/__fixtures__/normalisation-vectors.json) are run through this function in
-- supabase/tests/courses.test.ts. NULL in, NULL out; '' means "no code".
-- IMMUTABLE is required for generated columns. Do not change the body after rows exist: stored keys would
-- not be recomputed (a later change needs a migration that rebuilds them).
-- ---------------------------------------------------------------------------

create or replace function orbit_private.orbit_normalise_key(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.translate(
    pg_catalog.btrim(pg_catalog.regexp_replace(t, '[ \t\r\n\f\v\u00a0]+', ' ', 'g'), ' '),
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
$$;

-- Generic immutability/timestamp protection for owned rows (does NOT reuse orbit_protect_row(), which only
-- knows the three calendar tables by name). Works for any table with id, user_id, created_at, updated_at.
--   INSERT: created_at / updated_at are set by the server (client values are ignored).
--   UPDATE: id, user_id and created_at cannot change (error 42501, even for the table owner);
--           updated_at is always set by the server.
create or replace function orbit_private.orbit_protect_owned_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'id is immutable' using errcode = '42501';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable (ownership cannot be reassigned)' using errcode = '42501';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is immutable' using errcode = '42501';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function orbit_private.orbit_normalise_key(text)  from public, anon, authenticated;
revoke all on function orbit_private.orbit_protect_owned_row()  from public, anon, authenticated;
-- Generated columns are evaluated with the caller's privileges, so signed-in users need EXECUTE on the key function.
grant execute on function orbit_private.orbit_normalise_key(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function orbit_private.orbit_normalise_key(text) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------

create table public.courses (
  id           uuid        primary key default gen_random_uuid(),   -- client may supply it (idempotent create)
  user_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,

  -- Not blank: at least one character outside the whitespace set of JavaScript's trim() (the client rule).
  name         text        not null check (length(btrim(name)) <= 120 and name ~ '[^ \t\r\n\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'),
  code         text        check (length(code) <= 30),
  -- Matching/uniqueness keys (rule N). code_key is NULL without a code; the others are '' when absent.
  code_key        text generated always as (case when code is null then null else orbit_private.orbit_normalise_key(code) end) stored,
  institution     text check (length(institution) <= 120),
  institution_key text generated always as (coalesce(orbit_private.orbit_normalise_key(institution), '')) stored,
  term_label      text check (length(term_label) <= 40),            -- display only, never used for matching
  term_key        text generated always as (coalesce(orbit_private.orbit_normalise_key(term_label), '')) stored,
  term_start   date,
  term_end     date,
  description  text        check (length(description) <= 2000),
  color        text        not null default 'c1' check (color in ('c1','c2','c3','c4','c5','c6','c7','c8')),
  archived_at  timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Target of the same-owner composite foreign keys of tasks and exams (later increments).
  constraint courses_id_user_key unique (id, user_id),
  constraint courses_code_not_blank check (code is null or code_key <> ''),
  constraint courses_term_paired   check ((term_start is null) = (term_end is null)),
  constraint courses_term_ordered  check (term_end >= term_start),
  constraint courses_term_max_span check (term_end - term_start <= 400)
);

alter table public.courses enable row level security;
revoke all on public.courses from public, anon, authenticated;

comment on table public.courses is 'A subject studied in one term at one institution. Sessions are matched to courses in the client by normalised code and term dates; nothing is stored on events.';
comment on column public.courses.code_key is 'Normalisation rule N of code (NULL when there is no code). Used for matching and uniqueness.';
comment on column public.courses.term_label is 'Display text only; never used for matching.';

create index courses_user_archived_idx on public.courses (user_id, archived_at);
create index courses_user_code_idx     on public.courses (user_id, code_key) where code_key is not null;
create unique index courses_user_code_institution_term_key
  on public.courses (user_id, code_key, institution_key, term_key) where code_key is not null;

create trigger courses_protect
  before insert or update on public.courses
  for each row execute function orbit_private.orbit_protect_owned_row();

-- ---------------------------------------------------------------------------
-- Privileges and policies: minimum for signed-in owners only.
-- user_id is never client-supplied (server default auth.uid()); id may be (idempotent create).
-- ---------------------------------------------------------------------------

grant select, delete on public.courses to authenticated;
grant insert (id, name, code, institution, term_label, term_start, term_end, description, color, archived_at)
  on public.courses to authenticated;
grant update (name, code, institution, term_label, term_start, term_end, description, color, archived_at)
  on public.courses to authenticated;

create policy courses_select_own on public.courses
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy courses_insert_own on public.courses
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy courses_update_own on public.courses
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy courses_delete_own on public.courses
  for delete to authenticated
  using (user_id = (select auth.uid()));

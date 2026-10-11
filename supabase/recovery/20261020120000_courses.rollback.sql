-- Rollback for migrations/20261020120000_courses.sql. MANUAL RECOVERY SCRIPT: lives in supabase/recovery/ so Supabase never runs it automatically.
--
-- Removes ONLY what that migration added: public.courses (with its policies, indexes, trigger and constraints),
-- orbit_private.orbit_protect_owned_row() and orbit_private.orbit_normalise_key(). It never touches events,
-- recurring_series, series_exceptions, event_imports, event_import_links or any function/policy of theirs.
--
-- TWO SITUATIONS
--   1. The table is empty (or missing): lossless; run as is.
--   2. Course rows exist: dropping the table DESTROYS the user's courses (names, codes, term dates, archive state). It cannot be
--      reversed by this script. The script REFUSES (error 55000) unless you confirm AND have taken a copy (OPTIONAL BACKUP).
--
-- FUTURE TABLES: tasks/exams (later increments) reference courses with RESTRICT foreign keys. This script does not CASCADE:
-- roll those back first, otherwise the DROP TABLE fails (and the whole transaction rolls back).
--
-- THE GUARD
--   * It must run as the owner of public.courses, or a role that bypasses row level security. Under RLS a normal user would see
--     zero rows and the check would wrongly pass, so any other role is refused (error 42501).
--
-- THE CONFIRMATION (only when rows exist, only after reading the above)
--   The file is ONE transaction. Put the next line right after `begin;`, uncommented:
--       select set_config('orbit.confirm_drop_courses', 'yes', true);
--   `true` makes it LOCAL to this transaction. Never use `false` (session-wide).
--
-- OPTIONAL BACKUP (restoring needs a new, reviewed migration):
--   create schema orbit_courses_backup;
--   create table orbit_courses_backup.courses as select * from public.courses;

begin;

-- select set_config('orbit.confirm_drop_courses', 'yes', true);  -- uncomment ONLY after reading the above

do $$
declare
  v_rows    boolean;
  v_ok_role boolean;
begin
  if to_regclass('public.courses') is not null then
    select (c.relowner = (select oid from pg_roles where rolname = current_user))
           or coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false)
      into v_ok_role
      from pg_class c where c.oid = to_regclass('public.courses');
    if not v_ok_role then
      raise exception 'run this rollback as the owner of public.courses (or a role that bypasses RLS): under RLS the emptiness check cannot be trusted'
        using errcode = '42501';
    end if;
    execute 'select exists (select 1 from public.courses)' into v_rows;
    if v_rows and coalesce(current_setting('orbit.confirm_drop_courses', true), '') <> 'yes' then
      raise exception 'refusing to drop public.courses: it contains rows. Read the header of this file; confirm with orbit.confirm_drop_courses = yes (transaction-local) after taking a backup.'
        using errcode = '55000';
    end if;
  end if;
end
$$;

drop table if exists public.courses;   -- no CASCADE on purpose

drop function if exists orbit_private.orbit_protect_owned_row();
drop function if exists orbit_private.orbit_normalise_key(text);

commit;

-- Rollback for migrations/20261015120000_event_imports.sql. MANUAL RECOVERY SCRIPT: lives in supabase/recovery/ so Supabase never runs it automatically.
--
-- Removes ONLY what the proposal added. `events` rows, series, exceptions, policies and grants of the existing
-- tables are untouched: no calendar event is deleted, imported events stay in the calendar as ordinary events.
--
-- TWO SITUATIONS
--   1. BEFORE any import was written (every provenance table that exists is empty): the rollback is lossless.
--      Run it as is.
--   2. AFTER real imports exist: dropping the tables DESTROYS the provenance (which session each event came from,
--      the imported snapshots, the tombstones of events the user deleted, the batch history). That cannot be
--      reversed by this script. After the rollback, a later import would not know what was imported before and
--      could create duplicates of events that are still in the calendar. The script therefore REFUSES to run while
--      provenance rows exist, unless you confirm (see below) and first keep a copy ("OPTIONAL BACKUP").
--
-- THE GUARD (each provenance table is checked on its own, so a half-installed state cannot bypass it)
--   * event_import_links and event_imports are each tested for existence and then for rows. A missing table counts as
--     empty ONLY for that table; rows in the other one still block the rollback.
--   * It must run as the owner of those tables (or a role that bypasses row level security). Under RLS a normal user
--     would see zero rows and the guard would wrongly pass, so the script refuses to run as any other role.
--
-- THE CONFIRMATION (only when rows exist, only after reading the above)
--   The whole file is ONE transaction (begin ... commit below). Put the next line right after `begin;`, uncommented:
--       select set_config('orbit.confirm_drop_provenance', 'yes', true);
--   `true` makes the setting LOCAL to this transaction: it disappears at commit/rollback and cannot carry over to a later
--   run on the same connection. Never use `false` (session-wide).
--
-- OPTIONAL BACKUP (keeps the provenance in a separate schema; restoring needs a new, reviewed migration):
--   create schema orbit_import_backup;
--   create table orbit_import_backup.event_imports      as select * from public.event_imports;
--   create table orbit_import_backup.event_import_links as select * from public.event_import_links;

begin;

-- select set_config('orbit.confirm_drop_provenance', 'yes', true);  -- uncomment ONLY after reading the above

do $$
declare
  t         text;
  v_rows    boolean;
  v_has     boolean := false;
  v_found   text[] := '{}';
  v_ok_role boolean;
begin
  foreach t in array array['event_import_links', 'event_imports'] loop
    if to_regclass('public.' || t) is null then
      continue;                                       -- missing: nothing to lose in THIS table
    end if;
    select (c.relowner = (select oid from pg_roles where rolname = current_user))
           or coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false)
      into v_ok_role
      from pg_class c where c.oid = to_regclass('public.' || t);
    if not v_ok_role then
      raise exception 'run this rollback as the owner of public.% (or a role that bypasses RLS): under RLS the emptiness check cannot be trusted', t
        using errcode = '42501';
    end if;
    execute format('select exists (select 1 from public.%I)', t) into v_rows;
    if v_rows then
      v_has := true;
      v_found := v_found || t;
    end if;
  end loop;

  if v_has and coalesce(current_setting('orbit.confirm_drop_provenance', true), '') <> 'yes' then
    raise exception 'refusing to drop import provenance: rows exist in %. Read the header of this file; confirm with orbit.confirm_drop_provenance = yes (transaction-local).', array_to_string(v_found, ', ')
      using errcode = '55000';
  end if;
end
$$;

drop function if exists public.orbit_forget_import_history(text);
drop function if exists public.orbit_import_sessions(uuid, jsonb);

drop table if exists public.event_import_links;
drop table if exists public.event_imports;

drop function if exists orbit_private.orbit_guard_link_delete();
drop function if exists orbit_private.orbit_guard_link_update();
drop function if exists orbit_private.orbit_guard_link_insert();
drop function if exists orbit_private.orbit_guard_batch_delete();
drop function if exists orbit_private.orbit_guard_batch_write();
drop function if exists orbit_private.orbit_import_lock(uuid, text);
drop function if exists orbit_private.orbit_import_source_valid(jsonb);
drop function if exists orbit_private.orbit_import_snapshot_valid(jsonb);
drop function if exists orbit_private.orbit_event_snapshot(public.events);
drop function if exists orbit_private.orbit_import_op();

alter table public.events drop constraint if exists events_id_user_key;

commit;

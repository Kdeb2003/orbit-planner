-- ORBIT timetable-import provenance (Phase 4A.3).
-- STATUS: tracked migration. Validated on LOCAL Supabase (PostgreSQL 17.11) and in PGlite. NOT YET APPLIED to the hosted
-- project. Its rollback is in supabase/recovery/ (deliberately NOT in migrations/, so it can never run automatically).
-- Revision 2 (security and integrity corrections after independent review), amended by the final self-review:
-- an item without a `source` key is now rejected up front (22023) instead of by a later NOT NULL violation.
--
-- Never edit this file once it has been applied anywhere (change the schema with a NEW migration).
--
-- Requires: 20261009120000_core_schema.sql and 20261009120100_rls_policies.sql (applied).
-- Requires PostgreSQL 15 or later (`ON DELETE SET NULL (column_list)` in the events foreign key). Everything else
-- used here exists in PostgreSQL 13-15. Check the hosted version FIRST (see docs/proposals/timetable-import-provenance.md).
--
-- WHAT IT ADDS
--   event_imports        one row per import ATTEMPT (batch) of a source PDF.
--   event_import_links   one row per imported source session: stable identity, link to the calendar event, and two
--                        snapshots (what was written / what the PDF said). A link whose event was deleted stays as a
--                        tombstone (event_id NULL) so a re-import does not resurrect the event.
--   orbit_import_sessions(batch, items)   atomic, idempotent, insert-only chunk write.   (SECURITY INVOKER)
--   orbit_forget_import_history(slug)     the one supported way to delete provenance.    (SECURITY INVOKER)
--   events (id, user_id) unique key       additive; the only change to an existing table.
--
-- WHAT IT DOES NOT DO
--   * No PDF bytes are stored (only the SHA-256). No existing column, policy, grant or trigger is changed.
--   * It never updates or deletes calendar events.
--   * No SECURITY DEFINER anywhere, no service_role usage, nothing for `anon`.
--
-- INTEGRITY MODEL (three layers; RLS alone only separates users, it does not protect provenance inside one account)
--   1. OWNERSHIP, by the database: composite foreign keys carry user_id (and source_slug), so a link can only join a
--      batch and an event of the SAME user, and a batch of the SAME source lineage, even for a role that bypasses RLS.
--   2. PRIVILEGES, by column: `authenticated` may read both tables, create a batch (identity columns only), change a
--      batch's `status`, and change a link's `retired_*`. Nothing else is granted on a column level.
--   3. TRIGGERS re-check the real table state, so a direct API call cannot claim more than the data supports:
--        * a batch may become `written` only if exactly planned_count links exist, `verified` only if every one of
--          its events still exists and still equals the imported snapshot;
--        * a link can be inserted only (a) by orbit_import_sessions, (b) into an `in_progress` batch of the same
--          lineage, (c) for an event that exists, was created after the batch started, and equals the snapshot,
--          (d) without exceeding planned_count;
--        * link identity, snapshots and event_id are immutable; event_id becomes NULL only through the foreign key's
--          ON DELETE action (the event really is gone);
--        * links and written/verified batches are deleted only through orbit_forget_import_history (or by the
--          account's own cascade).
--   The "(a)" gate is a transaction-local setting (orbit.import_op) that only the two functions below set. API
--   clients cannot set it: PostgREST exposes no set_config(), and the setting is reset when the function returns.
--   This defends against accidental or scripted misuse through the table API (bugs, injected script), not against
--   someone who can run arbitrary SQL as the user's own role, which the Supabase API does not allow.
--
-- FAIL CLOSED: RLS is enabled and every privilege revoked in the same block as each CREATE TABLE.

-- ---------------------------------------------------------------------------
-- 0. Additive key on events (target of the composite ownership FK)
-- ---------------------------------------------------------------------------
alter table public.events add constraint events_id_user_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- 1. Helpers (schema orbit_private; never exposed through the API)
-- ---------------------------------------------------------------------------

-- Which supported operation is running in this transaction ('' = none). Set only by the two functions below.
create or replace function orbit_private.orbit_import_op()
returns text
language sql
stable
set search_path = ''
as $$ select coalesce(pg_catalog.current_setting('orbit.import_op', true), '') $$;

-- The ten content fields of an event in the canonical JSON form (JavaScript Date.toISOString timestamps).
create or replace function orbit_private.orbit_event_snapshot(e public.events)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'title', e.title, 'category', e.category,
    'starts_at', pg_catalog.to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ends_at',   pg_catalog.to_char(e.ends_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'time_zone', e.time_zone, 'location', e.location, 'description', e.description,
    'course_code', e.course_code, 'session_type', e.session_type, 'group_label', e.group_label)
$$;

-- A snapshot is exactly these keys, strings or null, with real UTC instants for the two times.
create or replace function orbit_private.orbit_import_snapshot_valid(j jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  k text;
  v jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'object' then
    return false;
  end if;
  for k, v in select key, value from jsonb_each(j) loop
    if k not in ('title','category','starts_at','ends_at','time_zone','location','description','course_code','session_type','group_label') then
      return false;
    end if;
    if jsonb_typeof(v) not in ('string', 'null') then
      return false;
    end if;
  end loop;
  if not (j ? 'title' and j ? 'category' and j ? 'starts_at' and j ? 'ends_at' and j ? 'time_zone') then
    return false;
  end if;
  if jsonb_typeof(j -> 'title') <> 'string' or jsonb_typeof(j -> 'starts_at') <> 'string' or jsonb_typeof(j -> 'ends_at') <> 'string' then
    return false;
  end if;
  if orbit_private.orbit_utc_ts(j ->> 'starts_at') is null or orbit_private.orbit_utc_ts(j ->> 'ends_at') is null then
    return false;
  end if;
  if length(j::text) > 6000 then
    return false;
  end if;
  return true;
end;
$$;

-- The PDF-side facts of a session: bounded, compared by the client, never interpreted by the database.
create or replace function orbit_private.orbit_import_source_valid(j jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(j is not null and jsonb_typeof(j) = 'object' and length(j::text) <= 4000, false)
$$;

-- One advisory lock per user + source lineage serialises chunk writes, status changes and history deletion.
create or replace function orbit_private.orbit_import_lock(p_user uuid, p_slug text)
returns void
language sql
set search_path = ''
as $$ select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text || ':' || p_slug, 0)) $$;

revoke all on function orbit_private.orbit_import_op()                          from public, anon, authenticated;
revoke all on function orbit_private.orbit_event_snapshot(public.events)        from public, anon, authenticated;
revoke all on function orbit_private.orbit_import_snapshot_valid(jsonb)         from public, anon, authenticated;
revoke all on function orbit_private.orbit_import_source_valid(jsonb)           from public, anon, authenticated;
revoke all on function orbit_private.orbit_import_lock(uuid, text)              from public, anon, authenticated;
grant execute on function orbit_private.orbit_import_op()                       to authenticated;
grant execute on function orbit_private.orbit_event_snapshot(public.events)     to authenticated;
grant execute on function orbit_private.orbit_import_snapshot_valid(jsonb)      to authenticated;
grant execute on function orbit_private.orbit_import_source_valid(jsonb)        to authenticated;
grant execute on function orbit_private.orbit_import_lock(uuid, text)           to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function orbit_private.orbit_import_snapshot_valid(jsonb) to service_role;
    grant execute on function orbit_private.orbit_import_source_valid(jsonb)   to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. event_imports: one row per import attempt
-- ---------------------------------------------------------------------------
-- Status machine (enforced by trigger, with the real data re-checked):
--   in_progress -> failed | abandoned | written | written_partial
--   failed      -> in_progress (resume) | abandoned | written | written_partial
--   written     -> verified
--   written_partial, verified, abandoned: terminal
--   written          = exactly planned_count links exist for this batch
--   written_partial  = fewer exist (the rest was already linked by another batch/device, or blocked); labelled, never "complete"
--   verified         = additionally every linked event still exists and still equals what was imported
-- written_count is deliberately NOT a column: it is count(links of the batch), so it cannot drift or be falsified.
create table public.event_imports (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null default auth.uid() references auth.users (id) on delete cascade,

  -- All revisions of one timetable share a slug (the prefix of every sourceKey, e.g. 'utn-wise2627').
  source_slug      text        not null check (source_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_label     text        not null check (length(btrim(source_label)) between 1 and 120),
  source_sha256    text        not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_published_on date     check (source_published_on between date '2000-01-01' and date '2100-01-01'),
  parser_version   smallint    not null default 1 check (parser_version > 0),
  -- Which courses/groups were chosen, e.g. {'W26M-AINBA:B'}. Provenance only, NOT a durable preference.
  selection        text[]      not null default '{}' check (cardinality(selection) <= 100 and length(array_to_string(selection, ',')) <= 2000),
  -- Number of sessions this batch is going to write. Fixed at creation.
  planned_count    integer     not null check (planned_count between 0 and 5000),

  status           text        not null default 'in_progress'
                     check (status in ('in_progress', 'failed', 'abandoned', 'written', 'written_partial', 'verified')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  written_at       timestamptz,
  verified_at      timestamptz,

  constraint event_imports_lineage_key unique (id, user_id, source_slug),
  constraint event_imports_written_at check ((status in ('written', 'written_partial', 'verified')) = (written_at is not null)),
  constraint event_imports_verified_at check ((status = 'verified') = (verified_at is not null))
);

alter table public.event_imports enable row level security;
revoke all on public.event_imports from public, anon, authenticated;

comment on table public.event_imports is 'One row per import attempt of a source PDF. Stores the SHA-256 of the file, never the file itself. Counts are derived from the links.';

create index event_imports_user_source_idx on public.event_imports (user_id, source_slug, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. event_import_links: imported session <-> calendar event
-- ---------------------------------------------------------------------------
create table public.event_import_links (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  batch_id          uuid        not null,
  source_slug       text        not null check (source_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Stable identity of the source session (content based: date, time, course, type). NOT a page or coordinate.
  source_key        text        not null check (length(source_key) between 1 and 300),
  -- NULL only when the event was deleted (tombstone): the link then prevents the importer from recreating it.
  event_id          uuid,
  imported_snapshot jsonb       not null check (orbit_private.orbit_import_snapshot_valid(imported_snapshot)),
  source_snapshot   jsonb       not null check (orbit_private.orbit_import_source_valid(source_snapshot)),
  -- Dismissed / no longer in the source. Kept for history; never deletes the event.
  retired_at        timestamptz,
  retired_reason    text        check (retired_reason in ('removed-from-source', 'superseded', 'dismissed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint event_import_links_identity unique (user_id, source_slug, source_key),
  constraint event_import_links_one_event unique (event_id),
  constraint event_import_links_retired check ((retired_at is null) = (retired_reason is null)),
  -- Ownership AND lineage by foreign key: same user, same source slug as the batch.
  constraint event_import_links_batch_fk foreign key (batch_id, user_id, source_slug) references public.event_imports (id, user_id, source_slug),
  -- Same user as the event; ON DELETE SET NULL (event_id) keeps user_id (needs PostgreSQL 15+).
  constraint event_import_links_event_fk foreign key (event_id, user_id) references public.events (id, user_id) on delete set null (event_id)
);

alter table public.event_import_links enable row level security;
revoke all on public.event_import_links from public, anon, authenticated;

comment on table public.event_import_links is 'Provenance of imported calendar events. Written only by orbit_import_sessions; event_id becomes NULL (tombstone) when the event is deleted.';

create index event_import_links_batch_idx on public.event_import_links (batch_id);
create index event_import_links_user_source_idx on public.event_import_links (user_id, source_slug);

-- ---------------------------------------------------------------------------
-- 4. Triggers: the integrity rules
-- ---------------------------------------------------------------------------

-- 4a. batches
create or replace function orbit_private.orbit_guard_batch_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n integer;
  intact integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'in_progress' or new.written_at is not null or new.verified_at is not null then
      raise exception 'a new import starts in_progress' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.source_slug is distinct from old.source_slug
     or new.source_label is distinct from old.source_label or new.source_sha256 is distinct from old.source_sha256
     or new.source_published_on is distinct from old.source_published_on or new.parser_version is distinct from old.parser_version
     or new.selection is distinct from old.selection or new.planned_count is distinct from old.planned_count
     or new.created_at is distinct from old.created_at then
    raise exception 'an import batch is immutable except for its status' using errcode = '42501';
  end if;

  new.written_at := old.written_at;
  new.verified_at := old.verified_at;

  if new.status is distinct from old.status then
    if not ((old.status = 'in_progress' and new.status in ('failed', 'abandoned', 'written', 'written_partial'))
         or (old.status = 'failed'      and new.status in ('in_progress', 'abandoned', 'written', 'written_partial'))
         or (old.status = 'written'     and new.status = 'verified')) then
      raise exception 'illegal import status change % -> %', old.status, new.status using errcode = '55000';
    end if;

    if new.status in ('written', 'written_partial', 'verified') then
      perform orbit_private.orbit_import_lock(old.user_id, old.source_slug);
      select count(*) into n from public.event_import_links where batch_id = old.id;

      if new.status = 'written' and n <> old.planned_count then
        raise exception 'import is incomplete: % of % planned sessions are written', n, old.planned_count using errcode = '55000';
      elsif new.status = 'written_partial' and n >= old.planned_count then
        raise exception 'all % planned sessions are written; use status written', old.planned_count using errcode = '55000';
      elsif new.status = 'verified' then
        select count(*) into intact
          from public.event_import_links l
          join public.events e on e.id = l.event_id and e.user_id = l.user_id
          where l.batch_id = old.id and orbit_private.orbit_event_snapshot(e) = l.imported_snapshot;
        if n <> old.planned_count or intact <> n then
          raise exception 'verification failed: % of % planned sessions are present and unchanged', intact, old.planned_count using errcode = '55000';
        end if;
        new.verified_at := now();
      end if;
      if new.status <> 'verified' then
        new.written_at := now();
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function orbit_private.orbit_guard_batch_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- allowed: an attempt that never produced history, the supported "forget" operation, or the account's own cascade
  if old.status in ('in_progress', 'failed', 'abandoned') or orbit_private.orbit_import_op() = 'forget' or pg_catalog.pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'written imports are history; use orbit_forget_import_history()' using errcode = '42501';
end;
$$;

-- 4b. links
create or replace function orbit_private.orbit_guard_link_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  b public.event_imports;
  ev public.events;
  n integer;
begin
  if orbit_private.orbit_import_op() <> 'import' then
    raise exception 'import links are written only by orbit_import_sessions()' using errcode = '42501';
  end if;
  if new.event_id is null or new.retired_at is not null or new.retired_reason is not null then
    raise exception 'a new link must point at an event and must not be retired' using errcode = '23514';
  end if;

  select * into b from public.event_imports where id = new.batch_id;
  if not found then
    raise exception 'unknown import batch' using errcode = '23503';
  end if;
  if b.status <> 'in_progress' then
    raise exception 'import batch is %; links can only be added while it is in_progress', b.status using errcode = '55000';
  end if;

  select * into ev from public.events where id = new.event_id;
  if not found then
    raise exception 'unknown event' using errcode = '23503';
  end if;
  if ev.created_at < b.created_at then
    raise exception 'an event that existed before the import started cannot be linked to it' using errcode = '23514';
  end if;
  if orbit_private.orbit_event_snapshot(ev) <> new.imported_snapshot then
    raise exception 'imported_snapshot does not match the stored event' using errcode = '23514';
  end if;

  select count(*) into n from public.event_import_links where batch_id = b.id;
  if n >= b.planned_count then
    raise exception 'import batch would exceed its planned count (%)', b.planned_count using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function orbit_private.orbit_guard_link_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.batch_id is distinct from old.batch_id
     or new.source_slug is distinct from old.source_slug or new.source_key is distinct from old.source_key
     or new.imported_snapshot is distinct from old.imported_snapshot or new.source_snapshot is distinct from old.source_snapshot
     or new.created_at is distinct from old.created_at then
    raise exception 'link identity and snapshots are immutable' using errcode = '42501';
  end if;
  if new.event_id is distinct from old.event_id then
    -- only the foreign key's ON DELETE action (a nested trigger, and the event really is gone) may clear it
    if not (old.event_id is not null and new.event_id is null and pg_catalog.pg_trigger_depth() > 1
            and not exists (select 1 from public.events where id = old.event_id)) then
      raise exception 'event_id cannot be changed' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function orbit_private.orbit_guard_link_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if orbit_private.orbit_import_op() = 'forget' or pg_catalog.pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'import history is removed only through orbit_forget_import_history()' using errcode = '42501';
end;
$$;

revoke all on function orbit_private.orbit_guard_batch_write()  from public, anon, authenticated;
revoke all on function orbit_private.orbit_guard_batch_delete() from public, anon, authenticated;
revoke all on function orbit_private.orbit_guard_link_insert()  from public, anon, authenticated;
revoke all on function orbit_private.orbit_guard_link_update()  from public, anon, authenticated;
revoke all on function orbit_private.orbit_guard_link_delete()  from public, anon, authenticated;

create trigger event_imports_guard_write  before insert or update on public.event_imports
  for each row execute function orbit_private.orbit_guard_batch_write();
create trigger event_imports_guard_delete before delete on public.event_imports
  for each row execute function orbit_private.orbit_guard_batch_delete();
create trigger event_import_links_guard_insert before insert on public.event_import_links
  for each row execute function orbit_private.orbit_guard_link_insert();
create trigger event_import_links_guard_update before update on public.event_import_links
  for each row execute function orbit_private.orbit_guard_link_update();
create trigger event_import_links_guard_delete before delete on public.event_import_links
  for each row execute function orbit_private.orbit_guard_link_delete();

-- ---------------------------------------------------------------------------
-- 5. Privileges (column level) and RLS policies
-- ---------------------------------------------------------------------------
-- What a signed-in user may do DIRECTLY through the table API:
--   event_imports       select; insert the identity columns (status/timestamps/user_id come from defaults);
--                       update `status` only (the trigger verifies the claim); delete (trigger: only attempts that
--                       produced no history)
--   event_import_links  select; update retired_at/retired_reason ("dismiss"); insert and delete are granted only
--                       because the two SECURITY INVOKER functions run with the caller's privileges - the triggers
--                       reject both unless the supported function is the one running.
grant select on public.event_imports, public.event_import_links to authenticated;
grant insert (id, source_slug, source_label, source_sha256, source_published_on, parser_version, selection, planned_count)
  on public.event_imports to authenticated;
grant update (status) on public.event_imports to authenticated;
grant delete on public.event_imports to authenticated;
grant insert (batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot) on public.event_import_links to authenticated;
grant update (retired_at, retired_reason) on public.event_import_links to authenticated;
grant delete on public.event_import_links to authenticated;

create policy event_imports_select_own on public.event_imports
  for select to authenticated using (user_id = (select auth.uid()));
create policy event_imports_insert_own on public.event_imports
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy event_imports_update_own on public.event_imports
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy event_imports_delete_own on public.event_imports
  for delete to authenticated using (user_id = (select auth.uid()));

create policy event_import_links_select_own on public.event_import_links
  for select to authenticated using (user_id = (select auth.uid()));
create policy event_import_links_insert_own on public.event_import_links
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy event_import_links_update_own on public.event_import_links
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy event_import_links_delete_own on public.event_import_links
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 6. orbit_import_sessions: atomic, idempotent chunk write (events + links in ONE transaction)
-- ---------------------------------------------------------------------------
-- p_items: JSON array (1..100) of
--   { "source_key": text, "event_id": uuid, "event": {10 event content fields}, "source": {...PDF facts} }
-- Preconditions: the caller owns p_batch and it is `in_progress`; source_key and event_id are unique inside the payload.
-- Per item, in order:
--   1. a link for (user, source_slug, source_key) already exists -> 'already-linked' (nothing written; this also covers
--      tombstones: a deleted event is NOT recreated)
--   2. else insert the event with the client's deterministic id, ON CONFLICT DO NOTHING; if that id is used by any other
--      event -> 'event-id-taken' (nothing written; the existing event is NEVER adopted or changed)
--   3. else insert the link -> 'created'
-- The function only INSERTS. It never updates or deletes an event. A constraint violation in ANY item (including the
-- batch's planned_count being exceeded) aborts the whole chunk: nothing is half-written and no counter is "clamped".
-- SECURITY INVOKER: every statement runs under the caller's RLS and column privileges.
create or replace function public.orbit_import_sessions(p_batch uuid, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  b        public.event_imports;
  it       jsonb;
  ev       jsonb;
  v_key    text;
  v_id     uuid;
  v_link   public.event_import_links;
  v_row    public.events;
  v_out    jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'p_items must be a JSON array of 1 to 100 items' using errcode = '22023';
  end if;
  if (select count(distinct x ->> 'source_key') from jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items)
     or (select count(distinct x ->> 'event_id') from jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) then
    raise exception 'source_key and event_id must be present and unique within one request' using errcode = '22023';
  end if;

  -- RLS: only the caller's own batch is visible. Lock BEFORE reading its status so that a concurrent status change or
  -- chunk of the same user + lineage is ordered with this call.
  select * into b from public.event_imports where id = p_batch;
  if not found then
    raise exception 'unknown import batch' using errcode = 'P0002';
  end if;
  perform orbit_private.orbit_import_lock(b.user_id, b.source_slug);
  select * into b from public.event_imports where id = p_batch;
  if b.status <> 'in_progress' then
    raise exception 'import batch is %; only an in_progress batch accepts sessions', b.status using errcode = '55000';
  end if;

  perform set_config('orbit.import_op', 'import', true);

  for it in select value from jsonb_array_elements(p_items) loop
    v_key := it ->> 'source_key';
    ev    := it -> 'event';
    -- coalesce: jsonb_typeof(NULL) is NULL, and `NULL <> 'object'` would let a MISSING key slip through this test
    if length(coalesce(v_key, '')) = 0 or ev is null or coalesce(jsonb_typeof(ev), '') <> 'object' or coalesce(jsonb_typeof(it -> 'source'), '') <> 'object' then
      raise exception 'each item needs source_key, event_id, event and source' using errcode = '22023';
    end if;
    v_id := (it ->> 'event_id')::uuid;

    select * into v_link from public.event_import_links
      where user_id = b.user_id and source_slug = b.source_slug and source_key = v_key;
    if found then
      v_out := v_out || jsonb_build_object('source_key', v_key, 'event_id', v_link.event_id, 'outcome', 'already-linked');
      continue;
    end if;

    if not orbit_private.orbit_import_snapshot_valid(ev) then
      raise exception 'invalid event content for %', v_key using errcode = '23514';
    end if;

    v_row := null;
    insert into public.events (id, user_id, title, category, starts_at, ends_at, time_zone, location, description, course_code, session_type, group_label)
    values (v_id, b.user_id, ev ->> 'title', ev ->> 'category',
            (ev ->> 'starts_at')::timestamptz, (ev ->> 'ends_at')::timestamptz, ev ->> 'time_zone',
            ev ->> 'location', ev ->> 'description', ev ->> 'course_code', ev ->> 'session_type', ev ->> 'group_label')
    on conflict (id) do nothing
    returning * into v_row;

    if v_row.id is null then
      v_out := v_out || jsonb_build_object('source_key', v_key, 'event_id', v_id, 'outcome', 'event-id-taken');
      continue;
    end if;

    -- the snapshot is built from the row the database actually stored; the link trigger re-checks it
    insert into public.event_import_links (batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot)
    values (b.id, b.source_slug, v_key, v_row.id, orbit_private.orbit_event_snapshot(v_row), it -> 'source');

    v_out := v_out || jsonb_build_object('source_key', v_key, 'event_id', v_row.id, 'outcome', 'created');
  end loop;

  perform set_config('orbit.import_op', '', true);
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. orbit_forget_import_history: the one supported way to delete provenance
-- ---------------------------------------------------------------------------
-- Deletes the caller's links and batches of ONE source lineage. Calendar events are never touched.
create or replace function public.orbit_forget_import_history(p_slug text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_links   integer;
  v_batches integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'invalid source slug' using errcode = '22023';
  end if;
  perform orbit_private.orbit_import_lock(auth.uid(), p_slug);
  perform set_config('orbit.import_op', 'forget', true);
  -- RLS limits both statements to the caller's own rows
  with d as (delete from public.event_import_links where source_slug = p_slug returning 1) select count(*) into v_links from d;
  with d as (delete from public.event_imports where source_slug = p_slug returning 1) select count(*) into v_batches from d;
  perform set_config('orbit.import_op', '', true);
  return jsonb_build_object('links_deleted', v_links, 'batches_deleted', v_batches);
end;
$$;

revoke all on function public.orbit_import_sessions(uuid, jsonb)   from public, anon;
revoke all on function public.orbit_forget_import_history(text)    from public, anon;
grant execute on function public.orbit_import_sessions(uuid, jsonb) to authenticated;
grant execute on function public.orbit_forget_import_history(text)  to authenticated;

comment on function public.orbit_import_sessions(uuid, jsonb) is 'Atomic, idempotent insert of imported events and their provenance links. Insert-only; SECURITY INVOKER.';
comment on function public.orbit_forget_import_history(text) is 'Deletes the caller''s import links and batches of one source lineage. Never touches calendar events; SECURITY INVOKER.';

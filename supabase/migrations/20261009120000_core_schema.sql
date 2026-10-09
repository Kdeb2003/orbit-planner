-- ORBIT core schema (Phase 3A) — NOT yet applied to any hosted project.
--
-- Mirrors the frontend TypeScript model (src/types/index.ts):
--   events           <- CalendarEvent      (one-off events)
--   recurring_series <- RecurringSeries    (ONE row per weekly schedule)
--   series_exceptions<- SeriesException    (cancelled / edited / moved occurrences)
--
-- Time model (unchanged from the app):
--   * one-off events: absolute UTC instants (timestamptz)
--   * series: LOCAL wall-clock times (time) + an IANA zone, so 09:00 Europe/Berlin
--     stays 09:00 across daylight saving; occurrences are generated on demand
--   * exceptions: keyed by the occurrence's ORIGINAL date, so they stay attached
--     when an occurrence is moved to another day
--
-- FAIL-CLOSED DEPLOYMENT
--   Row Level Security is enabled on each table in THIS file, immediately after it is
--   created, and all client privileges are revoked at the same time. If only this
--   migration is ever applied, `anon` and `authenticated` can neither read nor write
--   anything (no privileges, and RLS with zero policies denies even if privileges were
--   re-granted). The next migration (…_rls_policies.sql) grants the minimum privileges
--   and installs the ownership policies.
--
-- HELPER FUNCTIONS live in the schema `orbit_private`, NOT in `public`.
--   PostgREST exposes public-schema functions as /rpc endpoints; `orbit_private` must
--   NEVER be added to the project's "Exposed schemas". EXECUTE is revoked from PUBLIC and
--   `anon`; only `authenticated` (and `service_role`, if the role exists) may call them,
--   because CHECK constraints are evaluated with the caller's privileges.

create schema if not exists orbit_private;
revoke all on schema orbit_private from public;
grant usage on schema orbit_private to authenticated;

-- ---------------------------------------------------------------------------
-- Validation helpers (immutable, no table access, never raise on bad input)
-- ---------------------------------------------------------------------------

create or replace function orbit_private.orbit_weekdays_valid(w smallint[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    cardinality(w) between 1 and 7
    and not exists (select 1 from unnest(w) as d where d is null or d not between 0 and 6)
    and (select count(distinct d) from unnest(w) as d) = cardinality(w),
    false)
$$;

-- Parses a UTC instant written exactly like JavaScript's Date.toISOString()
-- ('2026-10-22T07:00:00.000Z'). Returns the instant (as a timestamp in UTC), or NULL
-- when the text does not match OR names an impossible date/time (30 February, month 13,
-- hour 24, minute 60, second 60, year 0, …). The pattern alone is NOT trusted: the
-- components are validated by make_timestamp(), whose errors are caught.
create or replace function orbit_private.orbit_utc_ts(t text)
returns timestamp
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  m text[];
  ts timestamp;
begin
  if t is null then
    return null;
  end if;
  m := regexp_match(t, '^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$');
  if m is null then
    return null;
  end if;
  -- Explicit ranges: make_timestamp() would silently accept 24:00:00 (rolling to the next day).
  if m[1]::int < 1 or m[4]::int > 23 or m[5]::int > 59 or m[6]::int > 59 then
    return null;
  end if;
  ts := make_timestamp(m[1]::int, m[2]::int, m[3]::int, m[4]::int, m[5]::int, (m[6] || '.' || m[7])::double precision);
  -- Round trip: the parsed instant must print back as exactly the same text (no normalisation).
  if to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z' <> t then
    return null;
  end if;
  return ts;
exception when others then
  return null;
end;
$$;

-- An exception override is a JSON object with a fixed set of string fields.
-- start/end are real UTC instants (see orbit_utc_ts) that come as a pair with end > start.
-- Mirrors OccurrenceOverride in the app. Sequential early returns (no reliance on
-- boolean short-circuiting), so any malformed value yields false rather than an error.
create or replace function orbit_private.orbit_override_valid(o jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  s timestamp;
  e timestamp;
begin
  if o is null then
    return true;                       -- SQL NULL = "no override"
  end if;
  if jsonb_typeof(o) <> 'object' then  -- arrays, scalars and JSON null
    return false;
  end if;
  for k, v in select key, value from jsonb_each(o) loop
    if k not in ('title','category','start','end','location','description','courseCode','sessionType','groupLabel') then
      return false;
    end if;
    if jsonb_typeof(v) <> 'string' then
      return false;
    end if;
  end loop;

  if (o ? 'start') <> (o ? 'end') then
    return false;
  end if;
  if o ? 'start' then
    s := orbit_private.orbit_utc_ts(o ->> 'start');
    e := orbit_private.orbit_utc_ts(o ->> 'end');
    if s is null or e is null or e <= s then
      return false;
    end if;
  end if;

  if o ? 'title' and not (length(btrim(o ->> 'title')) between 1 and 120) then return false; end if;
  if o ? 'category' and (o ->> 'category') not in ('university','work','study','german','research','personal','deadline') then return false; end if;
  if o ? 'location' and length(o ->> 'location') > 120 then return false; end if;
  if o ? 'description' and length(o ->> 'description') > 2000 then return false; end if;
  if o ? 'courseCode' and length(o ->> 'courseCode') > 30 then return false; end if;
  if o ? 'sessionType' and (o ->> 'sessionType') not in ('','main','tutorial','seminar','practical','other') then return false; end if;
  if o ? 'groupLabel' and length(o ->> 'groupLabel') > 40 then return false; end if;
  return true;
end;
$$;

-- Triggers (not callable as functions, but lock them down anyway).
create or replace function orbit_private.orbit_protect_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name in ('events', 'recurring_series') then
    if new.id is distinct from old.id then
      raise exception 'id is immutable' using errcode = '42501';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'user_id is immutable (ownership cannot be reassigned)' using errcode = '42501';
    end if;
  elsif tg_table_name = 'series_exceptions' then
    if new.series_id is distinct from old.series_id or new.original_date is distinct from old.original_date then
      raise exception 'series_id and original_date are immutable (occurrence identity)' using errcode = '42501';
    end if;
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

-- Time zones must be real IANA names (the app derives wall-clock times from them).
create or replace function orbit_private.orbit_validate_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.time_zone) then
    raise exception 'unknown time zone: %', new.time_zone using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Function privileges: nothing for PUBLIC/anon. CHECK constraints run as the caller,
-- so `authenticated` (and `service_role` when present) need EXECUTE on the validators.
revoke all on function orbit_private.orbit_weekdays_valid(smallint[]) from public, anon, authenticated;
revoke all on function orbit_private.orbit_utc_ts(text)               from public, anon, authenticated;
revoke all on function orbit_private.orbit_override_valid(jsonb)      from public, anon, authenticated;
revoke all on function orbit_private.orbit_protect_row()              from public, anon, authenticated;
revoke all on function orbit_private.orbit_validate_zone()            from public, anon, authenticated;

grant execute on function orbit_private.orbit_weekdays_valid(smallint[]) to authenticated;
grant execute on function orbit_private.orbit_utc_ts(text)               to authenticated;
grant execute on function orbit_private.orbit_override_valid(jsonb)      to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema orbit_private to service_role;
    grant execute on function orbit_private.orbit_weekdays_valid(smallint[]) to service_role;
    grant execute on function orbit_private.orbit_utc_ts(text)               to service_role;
    grant execute on function orbit_private.orbit_override_valid(jsonb)      to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- events: one-off calendar events
-- ---------------------------------------------------------------------------

create table public.events (
  -- Client-generated UUIDs are accepted so Phase 3B can import local events
  -- idempotently (same id => same row, no duplicates).
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,

  title        text        not null check (length(btrim(title)) between 1 and 120),
  category     text        not null check (category in
                 ('university','work','study','german','research','personal','deadline')),

  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  time_zone    text        not null default 'Europe/Berlin' check (length(time_zone) between 1 and 64),

  location     text        check (length(location) <= 120),
  description  text        check (length(description) <= 2000),

  -- Optional university metadata
  course_code  text        check (length(course_code) <= 30),
  session_type text        check (session_type in ('main','tutorial','seminar','practical','other')),
  group_label  text        check (length(group_label) <= 40),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint events_end_not_before_start check (ends_at >= starts_at)
);

-- Fail closed immediately: RLS on, no client privileges until the policies migration.
alter table public.events enable row level security;
revoke all on public.events from public, anon, authenticated;

comment on table public.events is 'One-off calendar events. starts_at/ends_at are absolute instants; time_zone is the zone they were entered in.';

-- Range queries: WHERE user_id = $1 AND starts_at < $to AND ends_at > $from
create index events_user_starts_idx on public.events (user_id, starts_at);

-- ---------------------------------------------------------------------------
-- recurring_series: ONE row per weekly schedule (occurrences are never stored)
-- ---------------------------------------------------------------------------

create table public.recurring_series (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null default auth.uid() references auth.users (id) on delete cascade,

  title          text        not null check (length(btrim(title)) between 1 and 120),
  category       text        not null check (category in
                   ('university','work','study','german','research','personal','deadline')),
  time_zone      text        not null default 'Europe/Berlin' check (length(time_zone) between 1 and 64),

  location       text        check (length(location) <= 120),
  description    text        check (length(description) <= 2000),
  course_code    text        check (length(course_code) <= 30),
  session_type   text        check (session_type in ('main','tutorial','seminar','practical','other')),
  group_label    text        check (length(group_label) <= 40),

  -- recurrence (TypeScript: series.recurrence)
  frequency      text        not null default 'weekly' check (frequency = 'weekly'),
  weekdays       smallint[]  not null check (orbit_private.orbit_weekdays_valid(weekdays)), -- Monday = 0 … Sunday = 6
  start_date     date        not null,   -- first active date (inclusive)
  until_date     date        not null,   -- last active date (inclusive)

  -- Local wall-clock times in time_zone (TypeScript: startTime / endTime 'HH:mm')
  start_time     time        not null,
  end_time       time        not null,
  -- 0 = same day, 1 = ends the next day (overnight), … 6 (TypeScript: endDayOffset)
  end_day_offset smallint    not null default 0 check (end_day_offset between 0 and 6),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint series_dates_ordered check (until_date >= start_date),
  constraint series_max_span      check (until_date - start_date <= 1100),
  -- A same-day occurrence must end strictly after it starts. Overnight / multi-day
  -- occurrences (end_day_offset >= 1) may use any end time (e.g. 22:00 -> 02:00, or a 24 h
  -- event 10:00 -> 10:00 next day).
  constraint series_positive_duration check (end_day_offset > 0 or end_time > start_time)
);

alter table public.recurring_series enable row level security;
revoke all on public.recurring_series from public, anon, authenticated;

comment on table public.recurring_series is 'Weekly repeating schedule. Occurrences are generated by the app from these fields; Europe/Berlin wall-clock time is preserved by storing local times + zone.';

create index series_user_idx       on public.recurring_series (user_id);
create index series_user_range_idx on public.recurring_series (user_id, start_date, until_date);

-- ---------------------------------------------------------------------------
-- series_exceptions: per-occurrence changes, identified by the ORIGINAL date
-- ---------------------------------------------------------------------------

create table public.series_exceptions (
  series_id     uuid        not null references public.recurring_series (id) on delete cascade,
  original_date date        not null,   -- the date the schedule would have used (stable identity)

  cancelled     boolean     not null default false,
  override      jsonb       check (orbit_private.orbit_override_valid(override)),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (series_id, original_date),
  -- An exception must DO something: cancel the occurrence, or carry a non-empty override.
  -- (cancelled = false with no override, or with an empty {} override, is a no-op; the app
  -- deletes the row to "restore" an occurrence.)
  constraint exception_has_effect check (
    cancelled or (override is not null and override <> '{}'::jsonb)
  )
);

alter table public.series_exceptions enable row level security;
revoke all on public.series_exceptions from public, anon, authenticated;

comment on table public.series_exceptions is 'Cancelled / edited / moved occurrences of a series. Ownership is derived from the parent series (no user_id column).';
comment on column public.series_exceptions.override is 'Only the fields that differ from the series (title, category, start, end [both, real UTC instants, end > start], location, description, courseCode, sessionType, groupLabel). Empty string clears an inherited value.';

-- ---------------------------------------------------------------------------
-- Triggers: server-side timestamps, immutable identity/ownership, real time zones
-- ---------------------------------------------------------------------------

create trigger events_protect            before update on public.events
  for each row execute function orbit_private.orbit_protect_row();
create trigger recurring_series_protect  before update on public.recurring_series
  for each row execute function orbit_private.orbit_protect_row();
create trigger series_exceptions_protect before update on public.series_exceptions
  for each row execute function orbit_private.orbit_protect_row();

create trigger events_zone            before insert or update of time_zone on public.events
  for each row execute function orbit_private.orbit_validate_zone();
create trigger recurring_series_zone  before insert or update of time_zone on public.recurring_series
  for each row execute function orbit_private.orbit_validate_zone();

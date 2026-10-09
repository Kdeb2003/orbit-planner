// Executes the REAL migration files against an in-memory PostgreSQL (PGlite) with a
// minimal simulation of Supabase's `auth` schema and roles. This demonstrates the
// schema constraints and cross-user isolation WITHOUT touching any hosted project.
//
// Limitation: it is a simulation (PGlite + our own `auth.uid()` shim), not Supabase itself.
// Run the equivalent checks against a local Supabase stack (`supabase start`) before
// trusting production; see supabase/README.md.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const dir = join(__dirname, '..', 'migrations')

let db: PGlite

async function as(user: string | null, fn: () => Promise<unknown>, d: PGlite = db) {
  await d.exec(`set role ${user === null ? 'anon' : 'authenticated'}`)
  await d.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ''])
  try {
    return await fn()
  } finally {
    await d.exec('reset role')
    await d.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

/** Resolves to the error code (e.g. '42501') or null if the statement succeeded. */
async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown'
  }
}

/** Builds an INSERT for events; `over` replaces default column values (values are raw SQL literals). */
const event = (user: string, over: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    user_id: `'${user}'`,
    title: `'QA event'`,
    category: `'university'`,
    starts_at: `'2026-10-12T07:00:00Z'`,
    ends_at: `'2026-10-12T08:30:00Z'`,
    ...over,
  }
  return `insert into public.events (${Object.keys(cols).join(', ')}) values (${Object.values(cols).join(', ')})`
}

const series = (user: string, id: string, extra = '') =>
  `insert into public.recurring_series (id, user_id, title, category, weekdays, start_date, until_date, start_time, end_time ${extra})
   values ('${id}', '${user}', 'QA series', 'university', '{0,2}', '2026-10-12', '2026-12-14', '09:00', '10:30')`

const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const migrationFiles = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()

/** A fresh in-memory database with simulated Supabase roles/auth, with the first `count` migrations applied. */
async function newDb(count: number): Promise<PGlite> {
  const d = new PGlite()
  await d.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Supabase grants broad default privileges on new public objects (this is also what
    -- PostgREST exposes); simulate that so the migrations' explicit REVOKE/GRANT is what is under test.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    insert into auth.users values ('${ALICE}'), ('${BOB}');
  `)
  for (const f of migrationFiles.slice(0, count)) await d.exec(readFileSync(join(dir, f), 'utf8'))
  return d
}

beforeAll(async () => {
  db = await newDb(migrationFiles.length)
})

afterAll(async () => {
  await db.close()
})

describe('migrations', () => {
  it('apply cleanly and enable RLS on every application table', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by relname`,
    )
    expect(rows.map((r) => r.relname)).toEqual(['events', 'recurring_series', 'series_exceptions'])
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
  })

  it('every table has policies for all four operations, only for the authenticated role', async () => {
    const { rows } = await db.query<{ tablename: string; cmd: string; roles: string }>(
      `select tablename, cmd, roles::text as roles from pg_policies where schemaname = 'public'`,
    )
    for (const t of ['events', 'recurring_series', 'series_exceptions']) {
      expect(rows.filter((r) => r.tablename === t).map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    }
    expect(rows.every((r) => r.roles === '{authenticated}')).toBe(true)
  })

  it('anon has no table privileges', async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`,
    )
    expect(rows[0].n).toBe(0)
  })
})

describe('row level security: cross-user isolation', () => {
  it('a user sees only their own events and cannot read, change or delete another user\'s', async () => {
    await as(ALICE, () => db.exec(event(ALICE)))
    const alice = await as(ALICE, () => db.query('select id from public.events')) as { rows: unknown[] }
    const bob = await as(BOB, () => db.query('select id from public.events')) as { rows: unknown[] }
    expect(alice.rows).toHaveLength(1)
    expect(bob.rows).toHaveLength(0)

    const upd = await as(BOB, () => db.query(`update public.events set title = 'hacked' returning id`)) as { rows: unknown[] }
    expect(upd.rows).toHaveLength(0)
    const del = await as(BOB, () => db.query(`delete from public.events returning id`)) as { rows: unknown[] }
    expect(del.rows).toHaveLength(0)
    const after = await db.query<{ title: string }>('select title from public.events')
    expect(after.rows).toEqual([{ title: 'QA event' }])
  })

  it('a user cannot insert a row owned by someone else', async () => {
    expect(await as(BOB, () => errorOf(db.exec(event(ALICE))))).toBe('42501')
  })

  it('user_id defaults to the caller', async () => {
    await as(BOB, () =>
      db.exec(`insert into public.events (title, category, starts_at, ends_at) values ('mine','work','2026-10-13T07:00:00Z','2026-10-13T08:00:00Z')`),
    )
    const { rows } = await db.query<{ user_id: string }>(`select user_id from public.events where title = 'mine'`)
    expect(rows[0].user_id).toBe(BOB)
  })

  it('ownership cannot be reassigned, even by the owner', async () => {
    expect(await as(ALICE, () => errorOf(db.exec(`update public.events set user_id = '${BOB}' where title = 'QA event'`)))).toBe('42501')
  })

  it('logged-out (anon) visitors cannot read or write anything', async () => {
    expect(await as(null, () => errorOf(db.query('select * from public.events')))).toBe('42501')
    expect(await as(null, () => errorOf(db.exec(event(ALICE))))).toBe('42501')
    expect(await as(null, () => errorOf(db.query('select * from public.recurring_series')))).toBe('42501')
    expect(await as(null, () => errorOf(db.query('select * from public.series_exceptions')))).toBe('42501')
  })

  it('an authenticated role without a user id (no sub claim) sees and creates nothing', async () => {
    await db.exec('set role authenticated')
    expect((await db.query('select * from public.events')).rows).toHaveLength(0)
    expect(await errorOf(db.exec(event(ALICE)))).toBe('42501')
    await db.exec('reset role')
  })

  it('series and exceptions are isolated; exceptions are reachable only through an owned series', async () => {
    await as(ALICE, () => db.exec(series(ALICE, S1)))
    await as(BOB, () => db.exec(series(BOB, S2)))
    await as(ALICE, () =>
      db.exec(`insert into public.series_exceptions (series_id, original_date, cancelled) values ('${S1}', '2026-10-19', true)`),
    )

    expect(((await as(BOB, () => db.query('select * from public.recurring_series'))) as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual([S2])
    expect(((await as(BOB, () => db.query('select * from public.series_exceptions'))) as { rows: unknown[] }).rows).toHaveLength(0)
    expect(((await as(ALICE, () => db.query('select * from public.series_exceptions'))) as { rows: unknown[] }).rows).toHaveLength(1)

    // Bob cannot attach an exception to Alice's series, nor modify/delete hers
    expect(
      await as(BOB, () => errorOf(db.exec(`insert into public.series_exceptions (series_id, original_date, cancelled) values ('${S1}', '2026-10-26', true)`))),
    ).toBe('42501')
    expect(((await as(BOB, () => db.query(`update public.series_exceptions set cancelled = false returning *`))) as { rows: unknown[] }).rows).toHaveLength(0)
    expect(((await as(BOB, () => db.query(`delete from public.series_exceptions returning *`))) as { rows: unknown[] }).rows).toHaveLength(0)
    expect((await db.query('select * from public.series_exceptions')).rows).toHaveLength(1)

    // Series can't be changed or deleted by Bob either
    expect(((await as(BOB, () => db.query(`update public.recurring_series set title = 'x' where id = '${S1}' returning id`))) as { rows: unknown[] }).rows).toHaveLength(0)
    expect(((await as(BOB, () => db.query(`delete from public.recurring_series where id = '${S1}' returning id`))) as { rows: unknown[] }).rows).toHaveLength(0)
  })

  it('exception identity is immutable (cannot be moved to another series or date)', async () => {
    await as(ALICE, () => db.exec(series(ALICE, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')))
    expect(
      await as(ALICE, () => errorOf(db.exec(`update public.series_exceptions set series_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' where series_id = '${S1}'`))),
    ).toBe('42501')
    expect(await as(ALICE, () => errorOf(db.exec(`update public.series_exceptions set original_date = '2026-10-20' where series_id = '${S1}'`)))).toBe('42501')
  })

  it('deleting a series cascades to its exceptions; deleting a user removes all their data', async () => {
    await as(ALICE, () => db.exec(`delete from public.recurring_series where id = '${S1}'`))
    expect((await db.query('select * from public.series_exceptions')).rows).toHaveLength(0)
    await db.exec(`delete from auth.users where id = '${BOB}'`)
    expect((await db.query(`select * from public.events where user_id = '${BOB}'`)).rows).toHaveLength(0)
    expect((await db.query(`select * from public.recurring_series where user_id = '${BOB}'`)).rows).toHaveLength(0)
    await db.exec(`insert into auth.users values ('${BOB}')`)
  })
})

describe('constraints (as table owner, independent of RLS)', () => {
  const bad = async (sql: string) => expect(await errorOf(db.exec(sql)), sql).toBe('23514')

  it('rejects invalid events', async () => {
    await bad(event(ALICE, { category: `'lecture'` }))
    await bad(event(ALICE, { title: `''` }))
    await bad(
      `insert into public.events (user_id, title, category, starts_at, ends_at) values ('${ALICE}','x','work','2026-10-12T09:00:00Z','2026-10-12T08:00:00Z')`,
    )
    await bad(event(ALICE, { session_type: `'bogus'` }))
    await bad(event(ALICE, { course_code: `'${'x'.repeat(31)}'` }))
  })

  it('accepts zero-length and university-metadata events', async () => {
    expect(
      await errorOf(db.exec(`insert into public.events (user_id, title, category, starts_at, ends_at, course_code, session_type, group_label)
        values ('${ALICE}','Deadline','deadline','2026-10-12T09:00:00Z','2026-10-12T09:00:00Z','CS201','tutorial','Group B')`)),
    ).toBeNull()
  })

  it('rejects invalid series', async () => {
    const S = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const ins = (cols: string, vals: string) =>
      `insert into public.recurring_series (id, user_id, title, category, start_time, end_time, ${cols}) values ('${S}','${ALICE}','x','work','09:00','10:00', ${vals})`
    await bad(ins('weekdays, start_date, until_date', `'{}', '2026-10-12', '2026-10-20'`))
    await bad(ins('weekdays, start_date, until_date', `'{7}', '2026-10-12', '2026-10-20'`))
    await bad(ins('weekdays, start_date, until_date', `'{1,1}', '2026-10-12', '2026-10-20'`))
    await bad(ins('weekdays, start_date, until_date', `'{1}', '2026-10-12', '2026-10-01'`))
    await bad(ins('weekdays, start_date, until_date', `'{1}', '2026-10-12', '2030-10-01'`))
    await bad(ins('weekdays, start_date, until_date, end_day_offset', `'{1}', '2026-10-12', '2026-10-20', 7`))
    await bad(ins('weekdays, start_date, until_date, frequency', `'{1}', '2026-10-12', '2026-10-20', 'daily'`))
  })

  it('stores the app\'s series and exception shapes faithfully (overnight, Berlin wall-clock)', async () => {
    const S = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await db.exec(`insert into public.recurring_series (id, user_id, title, category, time_zone, weekdays, start_date, until_date, start_time, end_time, end_day_offset)
      values ('${S}','${ALICE}','Night shift','work','Europe/Berlin','{4}','2026-03-20','2026-04-10','22:00','02:30',1)`)
    const moved = JSON.stringify({
      start: '2026-10-22T07:00:00.000Z',
      end: '2026-10-22T08:30:00.000Z',
      location: 'Room 204',
      sessionType: '',
      groupLabel: 'Group C',
    })
    expect(
      await errorOf(db.query(`insert into public.series_exceptions (series_id, original_date, override) values ('${S}','2026-03-27',$1)`, [moved])),
    ).toBeNull()
    const { rows } = await db.query<{ start_time: string; end_time: string; end_day_offset: number }>(
      `select start_time::text, end_time::text, end_day_offset from public.recurring_series where id = '${S}'`,
    )
    expect(rows[0]).toEqual({ start_time: '22:00:00', end_time: '02:30:00', end_day_offset: 1 })
  })

  it('rejects invalid exceptions', async () => {
    const S = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const ex = (cancelled: string, override: string) =>
      `insert into public.series_exceptions (series_id, original_date, cancelled, override) values ('${S}','2026-04-03',${cancelled},${override})`
    await bad(ex('false', 'null')) // no effect
    await bad(ex('false', `'{"unknown":"x"}'::jsonb`))
    await bad(ex('false', `'{"start":"2026-10-22T07:00:00.000Z"}'::jsonb`)) // start without end
    await bad(ex('false', `'{"start":"2026-10-22T08:00:00.000Z","end":"2026-10-22T07:00:00.000Z"}'::jsonb`)) // end before start
    await bad(ex('false', `'{"category":"nope"}'::jsonb`))
    await bad(ex('false', `'{"sessionType":"lecture"}'::jsonb`))
    await bad(ex('false', `'{"title":5}'::jsonb`))
    await bad(ex('false', `'["a"]'::jsonb`))
    expect(await errorOf(db.exec(ex('true', 'null')))).toBeNull()
  })

  it('maintains timestamps server-side', async () => {
    await db.exec(`update public.events set title = 'renamed', created_at = '2000-01-01', updated_at = '2000-01-01' where title = 'Deadline'`)
    const { rows } = await db.query<{ created_at: string; updated_at: string }>(`select created_at, updated_at from public.events where title = 'Deadline' or title = 'renamed'`)
    expect(new Date(rows[0].created_at).getFullYear()).toBeGreaterThan(2000) // created_at preserved
    expect(new Date(rows[0].updated_at).getFullYear()).toBeGreaterThan(2000) // updated_at set by trigger, not client
  })
})

// ===========================================================================
// Final SQL security audit corrections
// ===========================================================================

const TABLES = ['events', 'recurring_series', 'series_exceptions'] as const

describe('fail-closed deployment: state after the FIRST migration only', () => {
  let pre: PGlite
  const SP = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'

  beforeAll(async () => {
    pre = await newDb(1)
    // Seed one private row of each kind as the table owner (the only role that can write).
    await pre.exec(event(ALICE))
    await pre.exec(series(ALICE, SP))
    await pre.exec(`insert into public.series_exceptions (series_id, original_date, cancelled) values ('${SP}', '2026-10-19', true)`)
  })
  afterAll(async () => {
    await pre.close()
  })

  it('RLS is already enabled on every table, with no policies yet', async () => {
    const { rows } = await pre.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by relname`,
    )
    expect(rows.map((r) => r.relname)).toEqual([...TABLES].sort())
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
    expect((await pre.query(`select 1 from pg_policies where schemaname = 'public'`)).rows).toHaveLength(0)
  })

  it('anon and authenticated hold no privileges on any table (even though default privileges grant them)', async () => {
    const { rows } = await pre.query<{ n: number }>(
      `select count(*)::int as n from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')`,
    )
    expect(rows[0].n).toBe(0)
  })

  for (const role of [null, ALICE]) {
    const who = role === null ? 'anon' : 'authenticated'
    it(`${who} cannot read or modify private records`, async () => {
      for (const t of TABLES) {
        expect(await as(role, () => errorOf(pre.query(`select * from public.${t}`)), pre), `${who} select ${t}`).toBe('42501')
        expect(await as(role, () => errorOf(pre.exec(`delete from public.${t}`)), pre), `${who} delete ${t}`).toBe('42501')
      }
      expect(await as(role, () => errorOf(pre.exec(event(ALICE))), pre)).toBe('42501')
      expect(await as(role, () => errorOf(pre.exec(`update public.events set title = 'x'`)), pre)).toBe('42501')
    })
  }

  it('defence in depth: even if privileges were wrongly granted, RLS with no policies still denies everything', async () => {
    await pre.exec('grant select, insert, update, delete on public.events, public.recurring_series, public.series_exceptions to anon, authenticated')
    try {
      for (const role of [null, ALICE, BOB]) {
        for (const t of TABLES) {
          expect(((await as(role, () => pre.query(`select * from public.${t}`), pre)) as { rows: unknown[] }).rows, `select ${t}`).toHaveLength(0)
          expect(((await as(role, () => pre.query(`delete from public.${t} returning 1`), pre)) as { rows: unknown[] }).rows).toHaveLength(0)
        }
        expect(((await as(role, () => pre.query(`update public.events set title = 'hacked' returning 1`), pre)) as { rows: unknown[] }).rows).toHaveLength(0)
        expect(await as(role, () => errorOf(pre.exec(event(role ?? ALICE))), pre)).toBe('42501') // RLS: no INSERT policy
      }
      expect((await pre.query<{ title: string }>('select title from public.events')).rows).toEqual([{ title: 'QA event' }]) // untouched
    } finally {
      await pre.exec('revoke all on public.events, public.recurring_series, public.series_exceptions from anon, authenticated')
    }
  })

  it('helper functions are unreachable for anon before the second migration too', async () => {
    expect(await as(null, () => errorOf(pre.query(`select orbit_private.orbit_override_valid('{}'::jsonb)`)), pre)).toBe('42501')
  })

  it('applying the second migration then opens exactly the intended access', async () => {
    await pre.exec(readFileSync(join(dir, migrationFiles[1]), 'utf8'))
    expect(((await as(ALICE, () => pre.query('select * from public.events'), pre)) as { rows: unknown[] }).rows).toHaveLength(1)
    expect(((await as(BOB, () => pre.query('select * from public.events'), pre)) as { rows: unknown[] }).rows).toHaveLength(0)
    expect(await as(null, () => errorOf(pre.query('select * from public.events')), pre)).toBe('42501')
    expect(await as(null, () => errorOf(pre.query('select * from public.series_exceptions')), pre)).toBe('42501')
  })
})

describe('helper function exposure', () => {
  const fns = [
    'orbit_private.orbit_weekdays_valid(smallint[])',
    'orbit_private.orbit_utc_ts(text)',
    'orbit_private.orbit_override_valid(jsonb)',
  ]
  const trigs = ['orbit_private.orbit_protect_row()', 'orbit_private.orbit_validate_zone()']

  it('no ORBIT functions exist in the public schema (nothing is exposed as an RPC endpoint)', async () => {
    const { rows } = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'orbit%'`)
    expect(rows).toEqual([])
  })

  it('PUBLIC and anon cannot execute any helper; triggers are not executable by clients at all', async () => {
    for (const f of [...fns, ...trigs]) {
      for (const role of ['public', 'anon']) {
        const { rows } = await db.query<{ ok: boolean }>(`select has_function_privilege('${role}', '${f}', 'execute') as ok`)
        expect(rows[0].ok, `${role} execute ${f}`).toBe(false)
      }
    }
    for (const f of trigs) {
      const { rows } = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', '${f}', 'execute') as ok`)
      expect(rows[0].ok, `authenticated execute ${f}`).toBe(false)
    }
    expect(await as(null, () => errorOf(db.query(`select orbit_private.orbit_utc_ts('2026-10-22T07:00:00.000Z')`)))).toBe('42501')
    expect(await as(null, () => errorOf(db.query(`select * from orbit_private.orbit_protect_row()`)))).toBeTruthy()
  })

  it('authenticated can still use the validators (needed by CHECK constraints) and the schema is not otherwise open', async () => {
    for (const f of fns) {
      const { rows } = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', '${f}', 'execute') as ok`)
      expect(rows[0].ok, f).toBe(true)
    }
    expect((await db.query<{ ok: boolean }>(`select has_schema_privilege('anon', 'orbit_private', 'usage') as ok`)).rows[0].ok).toBe(false)
  })

  it('an authenticated user can insert/update rows that exercise every constraint and trigger function', async () => {
    const SX = '99999999-9999-4999-8999-999999999999'
    await as(ALICE, () => db.exec(series(ALICE, SX)))
    await as(ALICE, () =>
      db.query(`insert into public.series_exceptions (series_id, original_date, override) values ('${SX}', '2026-10-19', $1)`, [
        JSON.stringify({ start: '2026-10-19T08:00:00.000Z', end: '2026-10-19T09:30:00.000Z', title: 'Moved' }),
      ]),
    )
    await as(ALICE, () => db.exec(`update public.recurring_series set title = 'renamed', time_zone = 'Europe/Berlin' where id = '${SX}'`))
    await as(ALICE, () => db.exec(`update public.series_exceptions set cancelled = true where series_id = '${SX}'`))
    await as(ALICE, () => db.exec(`delete from public.recurring_series where id = '${SX}'`))
  })
})

describe('recurring_series duration', () => {
  let n = 0
  const insert = (offset: number, start: string, end: string) =>
    `insert into public.recurring_series (id, user_id, title, category, weekdays, start_date, until_date, start_time, end_time, end_day_offset)
     values ('d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}', '${ALICE}', 'x', 'work', '{1}', '2026-10-12', '2026-10-20', '${start}', '${end}', ${offset})`

  it('rejects a same-day series that ends before or exactly when it starts', async () => {
    expect(await errorOf(db.exec(insert(0, '15:00', '10:00')))).toBe('23514')
    expect(await errorOf(db.exec(insert(0, '10:00', '10:00')))).toBe('23514')
  })

  it('accepts a same-day series that ends later', async () => {
    expect(await errorOf(db.exec(insert(0, '10:00', '15:00')))).toBeNull()
    expect(await errorOf(db.exec(insert(0, '23:00', '23:59')))).toBeNull()
  })

  it('preserves legitimate overnight and multi-day series', async () => {
    expect(await errorOf(db.exec(insert(1, '22:00', '02:00')))).toBeNull() // overnight
    expect(await errorOf(db.exec(insert(1, '15:00', '10:00')))).toBeNull() // the exact values from the audit, but overnight
    expect(await errorOf(db.exec(insert(1, '10:00', '10:00')))).toBeNull() // exactly 24 h
    expect(await errorOf(db.exec(insert(3, '09:00', '08:00')))).toBeNull() // multi-day
  })

  it('also applies on UPDATE', async () => {
    const id = 'd0000000-0000-4000-8000-0000000000aa'
    await db.exec(`insert into public.recurring_series (id, user_id, title, category, weekdays, start_date, until_date, start_time, end_time) values ('${id}', '${ALICE}', 'x', 'work', '{1}', '2026-10-12', '2026-10-20', '10:00', '15:00')`)
    expect(await errorOf(db.exec(`update public.recurring_series set start_time = '16:00' where id = '${id}'`))).toBe('23514')
    expect(await errorOf(db.exec(`update public.recurring_series set start_time = '09:00' where id = '${id}'`))).toBeNull()
  })
})

describe('override timestamps are validated as real UTC instants', () => {
  const SO = 'c0000000-0000-4000-8000-000000000001'
  const valid = async (o: unknown) =>
    (await db.query<{ v: boolean }>('select orbit_private.orbit_override_valid($1::jsonb) as v', [JSON.stringify(o)])).rows[0].v
  const T = (s: string, e: string) => ({ start: s, end: e })
  const OK_S = '2026-10-22T07:00:00.000Z'
  const OK_E = '2026-10-22T08:30:00.000Z'

  beforeAll(async () => {
    await db.exec(series(ALICE, SO))
  })

  it('accepts real instants in order, including a leap day', async () => {
    expect(await valid(T(OK_S, OK_E))).toBe(true)
    expect(await valid(T('2028-02-29T23:59:59.000Z', '2028-03-01T00:00:00.000Z'))).toBe(true)
    expect(await valid({ ...T(OK_S, OK_E), location: '', sessionType: '' })).toBe(true)
  })

  it('rejects impossible dates that still match the text pattern', async () => {
    for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '0000-10-10']) {
      expect(await valid(T(`${bad}T07:00:00.000Z`, '2030-01-01T00:00:00.000Z')), `start ${bad}`).toBe(false)
      expect(await valid(T('2020-01-01T00:00:00.000Z', `${bad}T07:00:00.000Z`)), `end ${bad}`).toBe(false)
    }
  })

  it('rejects impossible times that still match the text pattern', async () => {
    for (const bad of ['24:00:00.000', '25:00:00.000', '10:60:00.000', '10:00:60.000', '99:99:99.999']) {
      expect(await valid(T(`2026-10-22T${bad}Z`, '2030-01-01T00:00:00.000Z')), `start ${bad}`).toBe(false)
      expect(await valid(T('2020-01-01T00:00:00.000Z', `2026-10-22T${bad}Z`)), `end ${bad}`).toBe(false)
    }
  })

  it('rejects text that is not exactly Date.toISOString() output (offsets, no millis, no Z, lowercase, spaces)', async () => {
    for (const bad of ['2026-10-22T07:00:00Z', '2026-10-22T07:00:00.000+01:00', '2026-10-22T07:00:00.000', '2026-10-22t07:00:00.000z', '2026-10-22 07:00:00.000Z', '22/10/2026', '', 'garbage']) {
      expect(await valid(T(bad, OK_E)), `start ${bad}`).toBe(false)
      expect(await valid(T(OK_S, bad)), `end ${bad}`).toBe(false)
    }
  })

  it('requires start and end together', async () => {
    expect(await valid({ start: OK_S })).toBe(false)
    expect(await valid({ end: OK_E })).toBe(false)
    expect(await valid({ title: 'only a title' })).toBe(true)
  })

  it('rejects reversed and zero-length intervals, comparing real instants (not strings)', async () => {
    expect(await valid(T(OK_E, OK_S))).toBe(false)
    expect(await valid(T(OK_S, OK_S))).toBe(false)
    expect(await valid(T('2026-10-22T07:00:00.001Z', '2026-10-22T07:00:00.000Z'))).toBe(false)
    expect(await valid(T('2026-10-22T07:00:00.000Z', '2026-10-22T07:00:00.001Z'))).toBe(true)
    expect(await valid(T('2025-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z'))).toBe(true)
  })

  it('fails safely (false, never an error) for non-string values and non-objects', async () => {
    expect(await valid({ start: 5, end: 6 })).toBe(false)
    expect(await valid({ start: null, end: null })).toBe(false)
    expect(await valid({ start: { a: 1 }, end: [] })).toBe(false)
    expect(await valid([OK_S])).toBe(false)
    expect(await valid('text')).toBe(false)
    expect(await valid(42)).toBe(false)
    expect(await valid(null)).toBe(false) // JSON null (distinct from SQL NULL)
    expect((await db.query<{ v: boolean }>('select orbit_private.orbit_override_valid(null) as v')).rows[0].v).toBe(true) // SQL NULL = no override
  })

  it('the table constraint enforces the same rules end to end', async () => {
    const ins = (o: unknown, d: string) =>
      db.query(`insert into public.series_exceptions (series_id, original_date, override) values ('${SO}', '${d}', $1::jsonb)`, [JSON.stringify(o)])
    expect(await errorOf(ins(T('2026-02-30T07:00:00.000Z', OK_E), '2026-10-26'))).toBe('23514')
    expect(await errorOf(ins(T('2026-10-22T25:00:00.000Z', '2026-10-23T00:00:00.000Z'), '2026-10-26'))).toBe('23514')
    expect(await errorOf(ins({ start: OK_S }, '2026-10-26'))).toBe('23514')
    expect(await errorOf(ins(T(OK_E, OK_S), '2026-10-26'))).toBe('23514')
    expect(await errorOf(ins(T(OK_S, OK_E), '2026-10-26'))).toBeNull()
  })
})

describe('no-op exceptions', () => {
  const SE = 'c0000000-0000-4000-8000-000000000002'
  const ins = (cancelled: boolean, override: string | null, d: string) =>
    db.query(`insert into public.series_exceptions (series_id, original_date, cancelled, override) values ('${SE}', '${d}', ${cancelled}, $1::jsonb)`, [override])

  beforeAll(async () => {
    await db.exec(series(ALICE, SE))
  })

  it('rejects not-cancelled exceptions with a NULL or empty override', async () => {
    expect(await errorOf(ins(false, null, '2026-10-12'))).toBe('23514')
    expect(await errorOf(ins(false, '{}', '2026-10-12'))).toBe('23514')
  })

  it('still allows cancellations (with or without an empty override) and real modifications', async () => {
    expect(await errorOf(ins(true, null, '2026-10-12'))).toBeNull()
    expect(await errorOf(ins(true, '{}', '2026-10-14'))).toBeNull()
    expect(await errorOf(ins(false, '{"location":"Room 204"}', '2026-10-19'))).toBeNull()
    expect(await errorOf(ins(false, '{"location":""}', '2026-10-21'))).toBeNull() // '' = clear the location: meaningful
    expect(await errorOf(ins(true, '{"title":"X"}', '2026-10-26'))).toBeNull()
  })

  it('cannot be turned into a no-op by an UPDATE either', async () => {
    expect(await errorOf(db.exec(`update public.series_exceptions set override = '{}' where series_id = '${SE}' and original_date = '2026-10-19'`))).toBe('23514')
    expect(await errorOf(db.exec(`update public.series_exceptions set cancelled = false where series_id = '${SE}' and original_date = '2026-10-12'`))).toBe('23514')
  })
})

describe('time zone validation', () => {
  it('accepts real IANA zones and rejects unknown names, abbreviations-as-offsets and POSIX strings', async () => {
    expect(await errorOf(db.exec(event(ALICE, { time_zone: `'Europe/Berlin'` })))).toBeNull()
    expect(await errorOf(db.exec(event(ALICE, { time_zone: `'America/New_York'` })))).toBeNull()
    for (const bad of ['Nope/Zone', 'UTC+9', 'Europe/Berlin ', '']) {
      expect(await errorOf(db.exec(event(ALICE, { time_zone: `'${bad}'` }))), bad).toBe('23514')
    }
    expect(await errorOf(db.exec(`update public.events set time_zone = 'Mars/Olympus' where title = 'QA event'`))).toBe('23514')
  })
})

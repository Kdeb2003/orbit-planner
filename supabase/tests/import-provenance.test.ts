// Offline verification of the import-provenance migration (supabase/migrations/20261015120000_event_imports.sql), revision 2.
// Runs the real SQL in an in-memory PostgreSQL (PGlite) with a simulated Supabase `auth` schema and roles, together
// with the real TypeScript item builder and diff. NOTHING here touches a hosted project.
//
// Limitations (also in docs/proposals/timetable-import-provenance.md):
//  * PGlite is ONE connection, so truly parallel transactions are not exercised. The guarantees rest on the unique
//    constraints, the per-lineage advisory lock and the status/link triggers, verified by sequential, interleaved
//    and constraint-level tests below. PENDING on the hosted project.
//  * `auth.uid()` is our shim; PostgREST / JWT handling is not simulated. PGlite 0.5.8 is PostgreSQL 18, so
//    PostgreSQL 15 compatibility is checked statically (see the last describe), not by execution.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EventRow } from '../../src/cloud/types'
import raw from '../../src/timetable/utn/__fixtures__/utn-wise2627-layouts.json?raw'
import { extractFromLayouts } from '../../src/timetable/utn/index.ts'
import { buildReview, initialState } from '../../src/timetable/utn/review.ts'
import type { PageLayout } from '../../src/timetable/utn/types.ts'
import { diffRevision } from '../../src/timetable/provenance/diff.ts'
import type { LinkRecord } from '../../src/timetable/provenance/diff.ts'
import { buildImportItems, chunk, toRpcItems } from '../../src/timetable/provenance/importItems.ts'
import type { ImportItem } from '../../src/timetable/provenance/importItems.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const SHA = 'a'.repeat(64)
const SLUG = 'utn-wise2627'
const migrationsDir = join(__dirname, '..', 'migrations')
const recoveryDir = join(__dirname, '..', 'recovery')
const PROPOSAL = readFileSync(join(migrationsDir, '20261015120000_event_imports.sql'), 'utf8')
const ROLLBACK = readFileSync(join(recoveryDir, '20261015120000_event_imports.rollback.sql'), 'utf8')
// The base schema = every migration before the provenance one (later migrations, e.g. courses, have their own tests), which these tests apply (and roll back) explicitly.
const migrationFiles = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql') && n < '20261015120000_event_imports.sql').sort()

type Q = { rows: Record<string, unknown>[] }

async function newDb(withProposal = true): Promise<PGlite> {
  const d = new PGlite()
  await d.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    insert into auth.users values ('${ALICE}'), ('${BOB}');
  `)
  for (const f of migrationFiles) await d.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  if (withProposal) await d.exec(PROPOSAL)
  return d
}

let db: PGlite

/** Runs `fn` as the `authenticated` role with the given user (like a PostgREST request), or as `anon`. */
async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${user === null ? 'anon' : 'authenticated'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown'
  }
}

const pages = (JSON.parse(raw) as { pages: PageLayout[] }).pages
let items: ImportItem[]
let bobItems: ImportItem[]

beforeAll(async () => {
  db = await newDb()
  const sessions = extractFromLayouts(structuredClone(pages)).sessions
  const reviewed = buildReview(sessions, initialState(sessions)).items
  items = (await buildImportItems(ALICE, reviewed)).items
  bobItems = (await buildImportItems(BOB, reviewed)).items
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('truncate public.event_import_links, public.event_imports, public.events, public.recurring_series cascade')
  await db.exec(`insert into auth.users values ('${ALICE}'), ('${BOB}') on conflict do nothing`)
  await db.query(`select set_config('orbit.import_op', '', false)`)
})

async function newBatch(user: string, over: { planned?: number; slug?: string; sha?: string } = {}): Promise<string> {
  const r = await as(user, () =>
    db.query<{ id: string }>(
      `insert into public.event_imports (source_slug, source_label, source_sha256, planned_count) values ($1, 'UTN WiSe 2026/27 (test)', $2, $3) returning id`,
      [over.slug ?? SLUG, over.sha ?? SHA, over.planned ?? items.length],
    ),
  )
  return r.rows[0].id
}

type Outcome = { source_key: string; event_id: string | null; outcome: string }
async function importChunk(user: string, batch: string, list: readonly ImportItem[]): Promise<Outcome[]> {
  const r = await as(user, () => db.query<{ r: Outcome[] }>(`select public.orbit_import_sessions($1::uuid, $2::jsonb) as r`, [batch, JSON.stringify(toRpcItems(list))]))
  return r.rows[0].r
}
async function importAll(user: string, batch: string, list: readonly ImportItem[]): Promise<Outcome[]> {
  const out: Outcome[] = []
  for (const c of chunk(list)) out.push(...(await importChunk(user, batch, c)))
  return out
}
const rpcError = (user: string, batch: string, payload: unknown) =>
  as(user, () => errorOf(db.query(`select public.orbit_import_sessions($1::uuid, $2::jsonb)`, [batch, JSON.stringify(payload)])))
const setStatus = (user: string, batch: string, status: string) =>
  as(user, () => errorOf(db.exec(`update public.event_imports set status = '${status}' where id = '${batch}'`)))

const count = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n)
const linksOf = async (batch: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.event_import_links where batch_id = '${batch}'`)).rows[0].n)
const eventRows = async (user: string) =>
  (await as(user, () => db.query<{ r: EventRow }>(`select row_to_json(e) as r from public.events e`))).rows.map((x) => x.r)
const linkRows = async (user: string) =>
  (await as(user, () => db.query<LinkRecord>(`select id, source_key, event_id, imported_snapshot, source_snapshot, retired_at from public.event_import_links`))).rows
const statusOf = async (batch: string) => (await db.query<{ status: string }>(`select status from public.event_imports where id = '${batch}'`)).rows[0].status
const eventInsert = (user: string, id: string, title = 'Mine') =>
  `insert into public.events (id, user_id, title, category, starts_at, ends_at) values ('${id}', '${user}', '${title}', 'personal', '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z')`

/**
 * Inserts a link as the TABLE OWNER (RLS bypassed, like a service role) with the supported-operation gate opened, so
 * that only the foreign keys and the content checks decide. The snapshot is taken from the event row unless given.
 */
async function ownerLink(o: { user: string; batch: string; event: string; slug?: string; key?: string; snapshot?: string }): Promise<string | null> {
  try {
    await db.exec(`select set_config('orbit.import_op', 'import', false)`)
    return await errorOf(
      db.exec(`insert into public.event_import_links (user_id, batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot)
        select '${o.user}', '${o.batch}', '${o.slug ?? SLUG}', '${o.key ?? `k-${Math.random()}`}', e.id, ${o.snapshot ?? 'orbit_private.orbit_event_snapshot(e)'}, '{}'::jsonb
        from public.events e where e.id = '${o.event}'`),
    )
  } finally {
    await db.exec(`select set_config('orbit.import_op', '', false)`)
  }
}

describe('structure, grants and exposure', () => {
  it('enables RLS on both new tables, with four own-row policies each for authenticated only', async () => {
    const t = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname`,
    )
    expect(t.rows.map((r) => r.relname)).toEqual(['event_import_links', 'event_imports', 'events', 'recurring_series', 'series_exceptions'])
    expect(t.rows.every((r) => r.relrowsecurity)).toBe(true)
    const p = await db.query<{ tablename: string; cmd: string; roles: string; qual: string | null }>(
      `select tablename, cmd, roles::text as roles, coalesce(qual, with_check) as qual from pg_policies where schemaname = 'public' and tablename like 'event_import%'`,
    )
    for (const tbl of ['event_imports', 'event_import_links']) {
      expect(p.rows.filter((r) => r.tablename === tbl).map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    }
    expect(p.rows.every((r) => r.roles === '{authenticated}' && /user_id = /.test(r.qual ?? ''))).toBe(true)
  })

  it('column privileges: users can create a batch (identity columns only), change a batch status, and retire a link - nothing else', async () => {
    const cols = async (table: string, priv: string) =>
      (await db.query<{ c: string }>(`select column_name as c from information_schema.column_privileges where grantee = 'authenticated' and table_schema = 'public' and table_name = '${table}' and privilege_type = '${priv}' order by column_name`)).rows.map((r) => r.c)
    expect(await cols('event_imports', 'INSERT')).toEqual(['id', 'parser_version', 'planned_count', 'selection', 'source_label', 'source_published_on', 'source_sha256', 'source_slug'])
    expect(await cols('event_imports', 'UPDATE')).toEqual(['status'])
    expect(await cols('event_import_links', 'INSERT')).toEqual(['batch_id', 'event_id', 'imported_snapshot', 'source_key', 'source_slug', 'source_snapshot'])
    expect(await cols('event_import_links', 'UPDATE')).toEqual(['retired_at', 'retired_reason'])
    const t = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_name in ('event_imports','event_import_links') order by 1, 2`,
    )
    expect(t.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual(['event_import_links:DELETE', 'event_import_links:SELECT', 'event_imports:DELETE', 'event_imports:SELECT'])
  })

  it('anon has no privilege on the new tables or functions; the only new public functions are the two invoker RPCs', async () => {
    const g = await db.query<{ n: number }>(`select count(*)::int as n from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`)
    expect(g.rows[0].n).toBe(0)
    const fns = await db.query<{ proname: string; prosecdef: boolean }>(
      `select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'orbit%' order by 1`,
    )
    expect(fns.rows).toEqual([{ proname: 'orbit_forget_import_history', prosecdef: false }, { proname: 'orbit_import_sessions', prosecdef: false }])
    const b = await newBatch(ALICE)
    expect(await as(null, () => errorOf(db.query(`select public.orbit_import_sessions('${b}', '[]')`)))).toBe('42501')
    expect(await as(null, () => errorOf(db.query(`select public.orbit_forget_import_history('x')`)))).toBe('42501')
    expect(await as(null, () => errorOf(db.query('select * from public.event_imports')))).toBe('42501')
    expect(await as(null, () => errorOf(db.query('select * from public.event_import_links')))).toBe('42501')
  })

  it('no SECURITY DEFINER function exists in public or orbit_private; helpers are not callable by anon', async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','orbit_private') and p.prosecdef`)
    expect(r.rows[0].n).toBe(0)
    expect(await as(null, () => errorOf(db.query(`select orbit_private.orbit_import_op()`)))).toBe('42501')
  })

  it('the transaction-local gate is closed again after the RPC returns', async () => {
    await importChunk(ALICE, await newBatch(ALICE), items.slice(0, 2))
    expect((await db.query<{ v: string }>(`select orbit_private.orbit_import_op() as v`)).rows[0].v).toBe('')
  })
})

describe('compatibility with existing data and behaviour', () => {
  it('applying the proposal to a database that already holds events changes none of them', async () => {
    const d = new PGlite()
    await d.exec(`
      create role anon nologin; create role authenticated nologin; create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
      insert into auth.users values ('${ALICE}');`)
    for (const f of migrationFiles) await d.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    await d.exec(`insert into public.events (id, user_id, title, category, starts_at, ends_at, location) values
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '${ALICE}', 'Old event', 'work', '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z', 'Home')`)
    const before = (await d.query(`select * from public.events order by id`)).rows
    await d.exec(PROPOSAL)
    expect((await d.query(`select * from public.events order by id`)).rows).toEqual(before)
    const cols = await d.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'events' order by ordinal_position`)
    expect(cols.rows.map((c) => c.column_name)).toEqual(['id', 'user_id', 'title', 'category', 'starts_at', 'ends_at', 'time_zone', 'location', 'description', 'course_code', 'session_type', 'group_label', 'created_at', 'updated_at'])
    await d.close()
  })

  it('manual events keep working: create, edit (updated_at moves), delete, with no link needed', async () => {
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002')))
    await as(ALICE, () => db.exec(`update public.events set title = 'Edited' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'`))
    expect((await eventRows(ALICE))[0]).toMatchObject({ title: 'Edited' })
    await as(ALICE, () => db.exec(`delete from public.events where id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'`))
    expect(await count('events')).toBe(0)
  })
})

describe('import RPC: first import, identity, duplicates', () => {
  it('writes every session as one dated event plus one link; the batch counts are derived, not stored', async () => {
    const batch = await newBatch(ALICE)
    const out = await importAll(ALICE, batch, items)
    expect(out.every((o) => o.outcome === 'created')).toBe(true)
    expect(await count('events')).toBe(items.length)
    expect(await linksOf(batch)).toBe(items.length)
    const cols = await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'event_imports'`)
    expect(cols.rows.map((c) => c.column_name)).not.toContain('written_count')
    expect(new Set((await eventRows(ALICE)).map((e) => e.id))).toEqual(new Set(items.map((i) => i.eventId)))
  })

  it('the stored snapshot equals the item the client built, and the diff then finds nothing to do', async () => {
    await importAll(ALICE, await newBatch(ALICE), items)
    const links = await linkRows(ALICE)
    const byKey = new Map(items.map((i) => [i.sourceKey, i]))
    for (const l of links) {
      expect(l.imported_snapshot).toEqual(byKey.get(l.source_key)!.event)
      expect(l.source_snapshot).toEqual(byKey.get(l.source_key)!.source)
    }
    const d = diffRevision({ incoming: items, links, events: await eventRows(ALICE) })
    expect(d.summary).toMatchObject({ new: 0, unchanged: items.length, sourceChanged: 0, removed: 0, possibleMoves: 0, ambiguous: 0, blocked: 0, userEdited: 0 })
  })

  it('repeating the import creates nothing (duplicate prevention), in the same batch or a new one', async () => {
    const b1 = await newBatch(ALICE)
    await importAll(ALICE, b1, items)
    // a completed batch refuses more; use a second batch for the repeat
    const b2 = await newBatch(ALICE)
    expect((await importAll(ALICE, b2, items)).every((o) => o.outcome === 'already-linked')).toBe(true)
    expect(await count('events')).toBe(items.length)
    expect(await count('event_import_links')).toBe(items.length)
    expect(await linksOf(b2)).toBe(0)
    // the same batch may be re-sent while it is in_progress (a retried request)
    expect((await importAll(ALICE, b1, items)).every((o) => o.outcome === 'already-linked')).toBe(true)
    expect(await linksOf(b1)).toBe(items.length)
  })

  it('two devices importing the same file end with exactly one copy; the constraints are the guard', async () => {
    const dev1 = await newBatch(ALICE)
    const dev2 = await newBatch(ALICE)
    const half = Math.floor(items.length / 2)
    const o1 = await importChunk(ALICE, dev1, items.slice(0, half + 5))
    const o2 = await importChunk(ALICE, dev2, items.slice(half - 5))
    await importChunk(ALICE, dev1, items.slice(half + 5))
    expect(o1.every((o) => o.outcome === 'created')).toBe(true)
    expect(o2.filter((o) => o.outcome === 'already-linked')).toHaveLength(10)
    expect(await count('events')).toBe(items.length)
    expect(await count('event_import_links')).toBe(items.length)
    // the loser cannot claim success: it wrote fewer than planned, so only the labelled partial state is possible
    expect(await setStatus(ALICE, dev2, 'written')).toBe('55000')
    expect(await setStatus(ALICE, dev2, 'written_partial')).toBeNull()
    // and the database refuses duplicates whatever a client does
    const l = (await linkRows(ALICE))[0]
    await db.exec(`select set_config('orbit.import_op', 'import', false)`)
    const dup = (id: string, key: string) =>
      `insert into public.event_import_links (user_id, batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot)
       select user_id, batch_id, source_slug, ${key}, ${id}, imported_snapshot, source_snapshot from public.event_import_links where id = '${l.id}'`
    expect(await errorOf(db.exec(dup('null', 'source_key')))).toBe('23514') // trigger: must point at an event
    expect(await errorOf(db.exec(`alter table public.event_import_links disable trigger event_import_links_guard_insert`))).toBeNull()
    expect(await errorOf(db.exec(dup('null', 'source_key')))).toBe('23505') // constraint, with the trigger out of the way: same identity
    expect(await errorOf(db.exec(dup(`'${l.event_id}'`, `'other-key'`)))).toBe('23505') // same event
    await db.exec(`alter table public.event_import_links enable trigger event_import_links_guard_insert`)
    await db.exec(`select set_config('orbit.import_op', '', false)`)
  })

  it('interrupted on device 1, finished by device 2 in a NEW batch for only the missing sessions; the original batch stays honestly partial', async () => {
    const cut = 40
    const dev1 = await newBatch(ALICE)
    await importAll(ALICE, dev1, items.slice(0, cut)) // device 1 is interrupted here (its batch is still in_progress)
    expect(await linksOf(dev1)).toBe(cut)

    // device 2 recomputes the diff from the server and plans ONLY what is missing
    const d = diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) })
    expect(d.new).toHaveLength(items.length - cut)
    expect(d.summary.unchanged).toBe(cut)
    const dev2 = await newBatch(ALICE, { planned: d.new.length })
    const out = await importAll(ALICE, dev2, d.new)
    expect(out.every((o) => o.outcome === 'created')).toBe(true)
    expect(await setStatus(ALICE, dev2, 'written')).toBeNull()
    expect(await setStatus(ALICE, dev2, 'verified')).toBeNull()

    // no duplicates anywhere, and nothing left to do
    expect(await count('events')).toBe(items.length)
    expect(await count('event_import_links')).toBe(items.length)
    expect(diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) }).summary.new).toBe(0)

    // device 1 wakes up: its batch wrote ${cut} of ${items.length} planned sessions, so the only honest label is partial; success cannot be claimed
    expect(await setStatus(ALICE, dev1, 'written')).toBe('55000')
    expect(await setStatus(ALICE, dev1, 'verified')).toBe('55000')
    expect(await setStatus(ALICE, dev1, 'written_partial')).toBeNull()
    expect(await statusOf(dev1)).toBe('written_partial')
    expect(await setStatus(ALICE, dev1, 'written')).toBe('55000') // terminal
    // and re-sending device 1's whole list creates nothing and cannot reopen the batch
    expect(await rpcError(ALICE, dev1, toRpcItems(items.slice(0, 2)))).toBe('55000')
    expect(await count('events')).toBe(items.length)
  })

  it('the same interrupted batch can also be resumed with its ORIGINAL batch id (failed -> in_progress) and then earns written', async () => {
    const batch = await newBatch(ALICE)
    await importAll(ALICE, batch, items.slice(0, 30))
    expect(await setStatus(ALICE, batch, 'failed')).toBeNull()
    expect(await rpcError(ALICE, batch, toRpcItems(items.slice(30, 31)))).toBe('55000') // a failed batch must be resumed first
    expect(await setStatus(ALICE, batch, 'written')).toBe('55000') // incomplete: no success claim from "failed" either
    expect(await setStatus(ALICE, batch, 'in_progress')).toBeNull()
    const d = diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) })
    expect(d.new).toHaveLength(items.length - 30)
    await importAll(ALICE, batch, d.new)
    expect(await linksOf(batch)).toBe(items.length)
    expect(await setStatus(ALICE, batch, 'written')).toBeNull()
    expect(await setStatus(ALICE, batch, 'verified')).toBeNull()
    expect(await count('events')).toBe(items.length)
  })

  it('an event id already used by an unrelated event is never adopted or changed, and the batch can only end partial', async () => {
    await as(ALICE, () => db.exec(eventInsert(ALICE, items[0].eventId, 'My own event')))
    const batch = await newBatch(ALICE, { planned: 3 })
    const out = await importChunk(ALICE, batch, items.slice(0, 3))
    expect(out.map((o) => o.outcome)).toEqual(['event-id-taken', 'created', 'created'])
    expect((await eventRows(ALICE)).find((e) => e.id === items[0].eventId)).toMatchObject({ title: 'My own event', category: 'personal' })
    expect((await linkRows(ALICE)).some((l) => l.source_key === items[0].sourceKey)).toBe(false)
    expect(await setStatus(ALICE, batch, 'written')).toBe('55000')
    expect(await setStatus(ALICE, batch, 'written_partial')).toBeNull()
    const d = diffRevision({ incoming: items.slice(0, 3), links: await linkRows(ALICE), events: await eventRows(ALICE) })
    expect(d.blocked).toHaveLength(1)
  })

  it("an event id that belongs to ANOTHER user is not touched either (the id probe reveals nothing but 'taken')", async () => {
    await as(BOB, () => db.exec(eventInsert(BOB, items[0].eventId, 'Bob private')))
    const out = await importChunk(ALICE, await newBatch(ALICE, { planned: 2 }), items.slice(0, 2))
    expect(out.map((o) => o.outcome)).toEqual(['event-id-taken', 'created'])
    expect((await eventRows(BOB))[0]).toMatchObject({ title: 'Bob private' })
    expect((await eventRows(ALICE)).map((e) => e.id)).toEqual([items[1].eventId])
  })
})

describe('user edits and deletions', () => {
  it('a user-edited event is never overwritten by a repeated import, and the diff reports the edit', async () => {
    await importAll(ALICE, await newBatch(ALICE), items)
    await as(ALICE, () => db.exec(`update public.events set title = 'Renamed by me', location = 'My room' where id = '${items[4].eventId}'`))
    await importAll(ALICE, await newBatch(ALICE), items)
    expect((await eventRows(ALICE)).find((e) => e.id === items[4].eventId)).toMatchObject({ title: 'Renamed by me', location: 'My room' })
    const d = diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) })
    expect(d.unchanged.find((u) => u.incoming.sourceKey === items[4].sourceKey)!.userEdited.sort()).toEqual(['location', 'title'])
    expect(d.summary.userEdited).toBe(1)
  })

  it('a deleted event leaves a tombstone link and is not recreated by a later import', async () => {
    await importAll(ALICE, await newBatch(ALICE), items)
    await as(ALICE, () => db.exec(`delete from public.events where id = '${items[2].eventId}'`))
    expect(await count('events')).toBe(items.length - 1)
    const tomb = (await linkRows(ALICE)).find((l) => l.source_key === items[2].sourceKey)!
    expect(tomb.event_id).toBeNull()
    expect((await db.query(`select user_id from public.event_import_links where id = '${tomb.id}'`)).rows[0].user_id).toBe(ALICE)
    expect((await importChunk(ALICE, await newBatch(ALICE), [items[2]]))[0].outcome).toBe('already-linked')
    expect(await count('events')).toBe(items.length - 1)
    const d = diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) })
    expect(d.deletedByUser).toHaveLength(1)
    expect(d.new).toHaveLength(0)
  })

  it('a tombstone cannot be forged and a link cannot be re-pointed (direct calls, and even as the table owner)', async () => {
    await importAll(ALICE, await newBatch(ALICE), items.slice(0, 3))
    const key = items[0].sourceKey
    await as(BOB, () => db.exec(eventInsert(BOB, 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001')))
    for (const set of [`event_id = null`, `event_id = '${items[1].eventId}'`, `event_id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'`]) {
      expect(await as(ALICE, () => errorOf(db.exec(`update public.event_import_links set ${set} where source_key = '${key}'`)))).toBe('42501') // no column privilege
      expect(await errorOf(db.exec(`update public.event_import_links set ${set} where source_key = '${key}'`))).not.toBeNull() // owner: trigger / FK
    }
    expect(await errorOf(db.exec(`update public.event_import_links set event_id = null where source_key = '${key}'`))).toBe('42501') // event still exists
    expect((await linkRows(ALICE)).find((l) => l.source_key === key)!.event_id).toBe(items[0].eventId)
  })
})

describe('integrity inside one account (provenance cannot be rewritten through the table API)', () => {
  it('a link cannot be inserted directly, even with valid-looking content for a real event', async () => {
    const batch = await newBatch(ALICE)
    await importChunk(ALICE, batch, items.slice(0, 1))
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000031')))
    const direct = (extra = '') =>
      as(ALICE, () => errorOf(db.exec(
        `insert into public.event_import_links (batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot)
         select '${batch}', '${SLUG}', 'forged-${Math.random()}', e.id, orbit_private.orbit_event_snapshot(e), '{}' from public.events e where e.id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000031' ${extra}`,
      )))
    expect(await direct()).toBe('42501')
    expect(await count('event_import_links')).toBe(1)
  })

  it('identity, snapshots, batch and lineage columns cannot be updated; retiring a session is allowed and keeps the event', async () => {
    const batch = await newBatch(ALICE)
    await importAll(ALICE, batch, items.slice(0, 3))
    const k = items[0].sourceKey
    const other = await newBatch(ALICE)
    for (const set of [
      `source_key = 'rewritten'`, `source_slug = 'other'`, `batch_id = '${other}'`, `user_id = '${BOB}'`, `id = gen_random_uuid()`,
      `imported_snapshot = '${JSON.stringify(items[1].event)}'`, `source_snapshot = '{}'`, `created_at = now()`, `updated_at = now()`,
    ]) {
      expect(await as(ALICE, () => errorOf(db.exec(`update public.event_import_links set ${set} where source_key = '${k}'`))), set).toBe('42501')
      // the trigger refuses even the table owner (updated_at is simply re-stamped by the server, so it is not a rewrite)
      if (!set.startsWith('updated_at')) expect(await errorOf(db.exec(`update public.event_import_links set ${set} where source_key = '${k}'`)), `owner: ${set}`).not.toBeNull()
    }
    expect(await as(ALICE, () => errorOf(db.exec(`update public.event_import_links set retired_at = now(), retired_reason = 'dismissed' where source_key = '${k}'`)))).toBeNull()
    expect(await count('events')).toBe(3)
    expect(await as(ALICE, () => errorOf(db.exec(`update public.event_import_links set retired_reason = null where source_key = '${k}'`)))).toBe('23514')
  })

  it('links cannot be deleted directly; written batches cannot be deleted directly; attempts that produced no history can', async () => {
    const batch = await newBatch(ALICE, { planned: 3 })
    await importAll(ALICE, batch, items.slice(0, 3))
    expect(await as(ALICE, () => errorOf(db.exec(`delete from public.event_import_links where batch_id = '${batch}'`)))).toBe('42501')
    expect(await errorOf(db.exec(`delete from public.event_import_links where batch_id = '${batch}'`))).toBe('42501') // even as owner
    expect(await setStatus(ALICE, batch, 'written')).toBeNull()
    expect(await as(ALICE, () => errorOf(db.exec(`delete from public.event_imports where id = '${batch}'`)))).toBe('42501')
    const empty = await newBatch(ALICE)
    expect(await as(ALICE, () => errorOf(db.exec(`delete from public.event_imports where id = '${empty}'`)))).toBeNull()
    expect(await count('event_import_links')).toBe(3)
  })

  it('a batch row is immutable except for its status; timestamps cannot be set by a client', async () => {
    const batch = await newBatch(ALICE)
    for (const set of [`planned_count = 1`, `source_sha256 = '${'b'.repeat(64)}'`, `source_slug = 'other'`, `source_label = 'x'`, `written_at = now()`, `verified_at = now()`, `user_id = '${BOB}'`]) {
      expect(await as(ALICE, () => errorOf(db.exec(`update public.event_imports set ${set} where id = '${batch}'`))), set).toBe('42501')
      // even the table owner cannot rewrite the row; the two timestamps are simply kept by the trigger
      if (/written_at|verified_at/.test(set)) {
        expect(await errorOf(db.exec(`update public.event_imports set ${set} where id = '${batch}'`))).toBeNull()
        expect((await db.query(`select written_at, verified_at from public.event_imports where id = '${batch}'`)).rows[0]).toEqual({ written_at: null, verified_at: null })
      } else {
        expect(await errorOf(db.exec(`update public.event_imports set ${set} where id = '${batch}'`)), `owner: ${set}`).not.toBeNull()
      }
    }
  })

  it('a link must join a batch of the same user AND the same source slug (foreign key); the matching case works', async () => {
    const aliceBatch = await newBatch(ALICE, { slug: 'utn-wise2627' })
    const bobBatch = await newBatch(BOB)
    const lineageB = await newBatch(ALICE, { slug: 'other-lineage' })
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000020')))
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000021')))
    expect(await ownerLink({ user: ALICE, batch: aliceBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000020', slug: 'other-lineage' })).toBe('23503') // wrong slug
    expect(await ownerLink({ user: BOB, batch: aliceBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000020' })).toBe('23503') // wrong user
    expect(await ownerLink({ user: ALICE, batch: bobBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000020' })).toBe('23503')
    expect(await ownerLink({ user: ALICE, batch: aliceBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000020' })).toBeNull() // same user and slug
    // and the slug of a link cannot differ from its batch even when the batch slug is a different valid lineage
    expect(await ownerLink({ user: ALICE, batch: lineageB, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000021', slug: SLUG })).toBe('23503')
    expect(await ownerLink({ user: ALICE, batch: lineageB, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000021', slug: 'other-lineage' })).toBeNull()
  })

  it('a link must reference an event that was created after the batch started and equals its snapshot; tombstones cannot be created directly', async () => {
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000030', 'Existed before')))
    const batch = await newBatch(ALICE)
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000032', 'After')))
    await db.exec(`update public.events set created_at = now() - interval '1 day' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000030'`)
    expect(await ownerLink({ user: ALICE, batch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000030' })).toBe('23514') // pre-existing event
    expect(await ownerLink({ user: ALICE, batch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000032', snapshot: `'${JSON.stringify(items[0].event)}'::jsonb` })).toBe('23514') // snapshot differs from the event
    expect(await ownerLink({ user: ALICE, batch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000032' })).toBeNull()
    await db.exec(`select set_config('orbit.import_op', 'import', false)`)
    const tomb = await errorOf(db.exec(`insert into public.event_import_links (user_id, batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot) values ('${ALICE}', '${batch}', '${SLUG}', 'tomb', null, '${JSON.stringify(items[0].event)}', '{}')`))
    await db.exec(`select set_config('orbit.import_op', '', false)`)
    expect(tomb).toBe('23514')
  })

  it('invalid snapshots are rejected when links are written (constraint level)', async () => {
    const batch = await newBatch(ALICE)
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000040')))
    const link = (snap: unknown) => ownerLink({ user: ALICE, batch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000040', snapshot: `'${JSON.stringify(snap)}'::jsonb` })
    for (const bad of [{ ...items[0].event, extra: 1 }, { ...items[0].event, starts_at: 'tomorrow' }, { title: 'only a title' }, [], { ...items[0].event, title: 5 }]) {
      expect(await link(bad)).toBe('23514')
    }
  })
})

describe('batch lifecycle: success must be earned', () => {
  it('written needs exactly the planned number of links; a client cannot claim success early, or claim partial when complete', async () => {
    const batch = await newBatch(ALICE, { planned: 5 })
    expect(await setStatus(ALICE, batch, 'written')).toBe('55000') // nothing written yet
    await importChunk(ALICE, batch, items.slice(0, 3))
    expect(await setStatus(ALICE, batch, 'written')).toBe('55000') // 3 of 5
    expect(await setStatus(ALICE, batch, 'verified')).toBe('55000') // not even written
    await importChunk(ALICE, batch, items.slice(3, 5))
    expect(await setStatus(ALICE, batch, 'written_partial')).toBe('55000') // complete: must be `written`
    expect(await setStatus(ALICE, batch, 'written')).toBeNull()
    const b = (await db.query<{ status: string; written_at: string | null; verified_at: string | null }>(`select status, written_at, verified_at from public.event_imports where id = '${batch}'`)).rows[0]
    expect(b.status).toBe('written')
    expect(b.written_at).not.toBeNull()
    expect(b.verified_at).toBeNull()
  })

  it('verified needs every linked event to exist and still equal what was imported', async () => {
    const batch = await newBatch(ALICE, { planned: 4 })
    await importAll(ALICE, batch, items.slice(0, 4))
    expect(await setStatus(ALICE, batch, 'written')).toBeNull()
    await as(ALICE, () => db.exec(`update public.events set location = 'edited after the import' where id = '${items[1].eventId}'`))
    expect(await setStatus(ALICE, batch, 'verified')).toBe('55000') // an edited event no longer matches
    await as(ALICE, () => db.exec(`update public.events set location = ${items[1].event.location === null ? 'null' : `'${items[1].event.location}'`} where id = '${items[1].eventId}'`))
    expect(await setStatus(ALICE, batch, 'verified')).toBeNull() // restored by hand: matches again
    const b = (await db.query<{ verified_at: string | null }>(`select verified_at from public.event_imports where id = '${batch}'`)).rows[0]
    expect(b.verified_at).not.toBeNull()

    const b2 = await newBatch(ALICE, { planned: 2 })
    await importChunk(ALICE, b2, items.slice(4, 6))
    expect(await setStatus(ALICE, b2, 'written')).toBeNull()
    await as(ALICE, () => db.exec(`delete from public.events where id = '${items[4].eventId}'`))
    expect(await setStatus(ALICE, b2, 'verified')).toBe('55000') // a deleted event is not "verified"
  })

  it('only legal transitions exist; terminal states stay terminal', async () => {
    const batch = await newBatch(ALICE, { planned: 2 })
    expect(await setStatus(ALICE, batch, 'failed')).toBeNull()
    expect(await setStatus(ALICE, batch, 'in_progress')).toBeNull() // resume
    expect(await setStatus(ALICE, batch, 'abandoned')).toBeNull()
    for (const s of ['in_progress', 'failed', 'written', 'verified', 'nonsense']) expect(await setStatus(ALICE, batch, s)).not.toBeNull()
    const done = await newBatch(ALICE, { planned: 2 })
    await importChunk(ALICE, done, items.slice(0, 2))
    expect(await setStatus(ALICE, done, 'written')).toBeNull()
    expect(await setStatus(ALICE, done, 'verified')).toBeNull()
    for (const s of ['in_progress', 'failed', 'written', 'written_partial', 'abandoned']) expect(await setStatus(ALICE, done, s), s).toBe('55000')
    const partial = await newBatch(ALICE, { planned: 5 })
    await importChunk(ALICE, partial, items.slice(2, 3))
    expect(await setStatus(ALICE, partial, 'written_partial')).toBeNull()
    for (const s of ['verified', 'written', 'in_progress']) expect(await setStatus(ALICE, partial, s), s).toBe('55000')
  })

  it('a finished batch accepts no more sessions; a failed batch must be resumed first', async () => {
    const batch = await newBatch(ALICE, { planned: 3 })
    await importChunk(ALICE, batch, items.slice(0, 2))
    expect(await setStatus(ALICE, batch, 'failed')).toBeNull()
    expect(await rpcError(ALICE, batch, toRpcItems(items.slice(2, 3)))).toBe('55000')
    expect(await setStatus(ALICE, batch, 'in_progress')).toBeNull()
    await importChunk(ALICE, batch, items.slice(2, 3))
    expect(await setStatus(ALICE, batch, 'written')).toBeNull()
    expect(await rpcError(ALICE, batch, toRpcItems(items.slice(3, 4)))).toBe('55000')
    expect(await count('events')).toBe(3)
  })

  it('a batch can never receive more links than planned: the chunk is rejected whole, nothing is clamped', async () => {
    const batch = await newBatch(ALICE, { planned: 3 })
    expect(await rpcError(ALICE, batch, toRpcItems(items.slice(0, 4)))).toBe('23514')
    expect(await count('events')).toBe(0)
    expect(await count('event_import_links')).toBe(0)
    await importChunk(ALICE, batch, items.slice(0, 3))
    expect(await rpcError(ALICE, batch, toRpcItems(items.slice(3, 4)))).toBe('23514')
    expect(await linksOf(batch)).toBe(3)
    expect(await count('events')).toBe(3)
  })

  it('status changes and chunk writes of one user+lineage are serialised by the same advisory lock', async () => {
    for (const fn of ['orbit_guard_batch_write', 'orbit_import_sessions', 'orbit_forget_import_history']) {
      const src = (await db.query<{ s: string }>(`select prosrc as s from pg_proc where proname = '${fn}'`)).rows[0].s
      expect(src, fn).toContain('orbit_import_lock')
    }
  })

  it('validates batch rows: slug, hash, label, counts, publication date', async () => {
    const ins = (cols: string, vals: string) => as(ALICE, () => errorOf(db.exec(`insert into public.event_imports (${cols}) values (${vals})`)))
    const cols = 'source_slug, source_label, source_sha256, planned_count'
    expect(await ins(cols, `'${SLUG}', 'x', '${SHA}', 5`)).toBeNull()
    expect(await ins(cols, `'UTN', 'x', '${SHA}', 5`)).toBe('23514')
    expect(await ins(cols, `'utn', 'x', 'nothex', 5`)).toBe('23514')
    expect(await ins(cols, `'utn', '  ', '${SHA}', 5`)).toBe('23514')
    expect(await ins(cols, `'utn', 'x', '${SHA}', 5001`)).toBe('23514')
    expect(await ins(`${cols}, source_published_on`, `'utn', 'x', '${SHA}', 5, '1999-01-01'`)).toBe('23514')
    expect(await ins(`${cols}, status`, `'utn', 'x', '${SHA}', 5, 'verified'`)).toBe('42501') // no privilege on status at creation
    expect(await ins(`${cols}, user_id`, `'utn', 'x', '${SHA}', 5, '${BOB}'`)).toBe('42501') // nor on user_id
  })
})

describe('forgetting import history (the one supported delete)', () => {
  it('deletes the links and batches of one lineage for the caller only; calendar events stay; ids stay occupied', async () => {
    const a1 = await newBatch(ALICE, { planned: 3 })
    await importAll(ALICE, a1, items.slice(0, 3))
    await setStatus(ALICE, a1, 'written')
    const other = await newBatch(ALICE, { slug: 'other-lineage', planned: 0 })
    await setStatus(ALICE, other, 'written')
    const bb = await newBatch(BOB, { planned: 2 })
    await importAll(BOB, bb, bobItems.slice(0, 2))

    const r = await as(ALICE, () => db.query<{ r: { links_deleted: number; batches_deleted: number } }>(`select public.orbit_forget_import_history('${SLUG}') as r`))
    expect(r.rows[0].r).toEqual({ links_deleted: 3, batches_deleted: 1 })
    expect(await count('events')).toBe(5) // 3 of Alice + 2 of Bob: nothing in the calendar was touched
    expect((await db.query(`select source_slug from public.event_imports order by 1`)).rows.map((x) => x.source_slug)).toEqual(['other-lineage', SLUG]) // Alice's other lineage + Bob's batch
    expect((await db.query<{ n: number }>(`select count(*)::int as n from public.event_import_links where user_id = '${BOB}'`)).rows[0].n).toBe(2)

    // history is gone but the events remain: a new import finds the ids occupied and adds nothing
    const again = await newBatch(ALICE, { planned: 3 })
    const out = await importChunk(ALICE, again, items.slice(0, 3))
    expect(out.every((o) => o.outcome === 'event-id-taken')).toBe(true)
    expect(await count('events')).toBe(5)
  })

  it('rejects bad input and needs a signed-in user', async () => {
    expect(await as(ALICE, () => errorOf(db.query(`select public.orbit_forget_import_history('Bad Slug')`)))).toBe('22023')
    expect(await as(ALICE, () => errorOf(db.query(`select public.orbit_forget_import_history(null)`)))).toBe('22023')
    expect(await as(null, () => errorOf(db.query(`select public.orbit_forget_import_history('x')`)))).toBe('42501')
    await db.exec('set role authenticated')
    expect(await errorOf(db.query(`select public.orbit_forget_import_history('x')`))).toBe('28000')
    await db.exec('reset role')
  })
})

describe('partial failure and recovery', () => {
  it('a chunk with one bad item writes nothing from that chunk; earlier chunks stay; resuming imports only the rest', async () => {
    const batch = await newBatch(ALICE)
    await importChunk(ALICE, batch, items.slice(0, 20))
    const poisoned = items.slice(20, 40).map((i, n) => (n === 7 ? { ...i, event: { ...i.event, category: 'not-a-category' } } : i))
    expect(await rpcError(ALICE, batch, toRpcItems(poisoned))).toBe('23514')
    expect(await count('events')).toBe(20)
    expect(await count('event_import_links')).toBe(20)

    expect(await setStatus(ALICE, batch, 'failed')).toBeNull()
    const d = diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) })
    expect(d.new.map((i) => i.sourceKey)).toEqual(items.slice(20).map((i) => i.sourceKey))
    expect(await setStatus(ALICE, batch, 'in_progress')).toBeNull() // resume
    const out = await importAll(ALICE, batch, d.new)
    expect(out.every((o) => o.outcome === 'created')).toBe(true)
    expect(await count('events')).toBe(items.length)
    expect(await setStatus(ALICE, batch, 'written')).toBeNull()
    expect(await setStatus(ALICE, batch, 'verified')).toBeNull()
    expect(diffRevision({ incoming: items, links: await linkRows(ALICE), events: await eventRows(ALICE) }).summary.new).toBe(0)
  })

  it('rejects malformed requests without writing anything', async () => {
    const batch = await newBatch(ALICE)
    const good = toRpcItems([items[0]])[0]
    expect(await rpcError(ALICE, batch, { not: 'an array' })).toBe('22023')
    expect(await rpcError(ALICE, batch, [])).toBe('22023')
    expect(await rpcError(ALICE, batch, Array.from({ length: 101 }, () => ({})))).toBe('22023')
    expect(await rpcError(ALICE, batch, [{ source_key: 'x' }])).toBe('22023')
    expect(await rpcError(ALICE, batch, [good, good])).toBe('22023') // duplicate key and id in one payload
    expect(await rpcError(ALICE, batch, [good, { ...good, source_key: 'another' }])).toBe('22023') // duplicate event_id
    expect(await rpcError(ALICE, batch, [{ ...good, source: 'text' }])).toBe('22023')
    const { source: _omitSource, ...noSource } = good // a MISSING key, not a wrong type (NULL <> 'object' must not slip through)
    void _omitSource
    expect(await rpcError(ALICE, batch, [noSource])).toBe('22023')
    const { event: _omitEvent, ...noEvent } = good
    void _omitEvent
    expect(await rpcError(ALICE, batch, [noEvent])).toBe('22023')
    expect(await rpcError(ALICE, batch, ['a string', 42, null])).toBe('22023')
    expect(await rpcError(ALICE, batch, [{ ...good, event_id: 'not-a-uuid' }])).toBe('22P02')
    expect(await rpcError(ALICE, batch, [{ ...good, event: { ...good.event, extra: 'field' } }])).toBe('23514')
    expect(await rpcError(ALICE, batch, [{ ...good, event: { ...good.event, starts_at: '2026-02-30T07:00:00.000Z' } }])).toBe('23514')
    expect(await rpcError(ALICE, batch, [{ ...good, event: { ...good.event, ends_at: '2000-01-01T00:00:00.000Z' } }])).toBe('23514')
    expect(await rpcError(ALICE, batch, [{ ...good, event: { ...good.event, time_zone: 'Mars/Base' } }])).not.toBeNull()
    expect(await count('events')).toBe(0)
    expect(await count('event_import_links')).toBe(0)
  })
})

describe('ownership and isolation between users', () => {
  it('a user sees only their own batches and links; others cannot read, change or delete them', async () => {
    const batch = await newBatch(ALICE, { planned: 5 })
    await importAll(ALICE, batch, items.slice(0, 5))
    expect((await as(BOB, () => db.query('select * from public.event_imports'))).rows).toHaveLength(0)
    expect((await as(BOB, () => db.query('select * from public.event_import_links'))).rows).toHaveLength(0)
    expect((await as(BOB, () => db.query(`update public.event_import_links set retired_at = now(), retired_reason = 'dismissed' returning id`))).rows).toHaveLength(0)
    expect((await as(BOB, () => db.query(`update public.event_imports set status = 'abandoned' returning id`))).rows).toHaveLength(0)
    expect((await as(BOB, () => db.query(`delete from public.event_imports returning id`))).rows).toHaveLength(0)
    expect(await as(BOB, () => errorOf(db.exec(`delete from public.event_import_links`)))).toBeNull() // RLS shows Bob no rows: nothing to delete
    expect(await count('event_import_links')).toBe(5)
    expect(await statusOf(batch)).toBe('in_progress')
  })

  it("a link can never join one user's batch or event with another user's link, even for a role that bypasses RLS", async () => {
    const aliceBatch = await newBatch(ALICE)
    const bobBatch = await newBatch(BOB)
    await as(ALICE, () => db.exec(eventInsert(ALICE, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010')))
    await as(BOB, () => db.exec(eventInsert(BOB, 'bbbbbbbb-bbbb-4bbb-8bbb-000000000010')))
    expect(await ownerLink({ user: BOB, batch: aliceBatch, event: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000010' })).toBe('23503')
    expect(await ownerLink({ user: ALICE, batch: bobBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010' })).toBe('23503')
    expect(await ownerLink({ user: BOB, batch: bobBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010' })).toBe('23503')
    expect(await ownerLink({ user: ALICE, batch: aliceBatch, event: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000010' })).toBe('23503')
    expect(await ownerLink({ user: ALICE, batch: aliceBatch, event: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010' })).toBeNull()
  })

  it("the import RPC cannot be pointed at another user's batch, and the same sessions imported by two users stay separate", async () => {
    const aliceBatch = await newBatch(ALICE, { planned: 5 })
    expect(await rpcError(BOB, aliceBatch, toRpcItems(items.slice(0, 2)))).toBe('P0002')
    expect(await rpcError(BOB, '00000000-0000-4000-8000-000000000000', toRpcItems(items.slice(0, 1)))).toBe('P0002')
    expect(await count('events')).toBe(0)
    await importAll(ALICE, aliceBatch, items.slice(0, 5))
    const bobBatch = await newBatch(BOB, { planned: 5 })
    expect((await importAll(BOB, bobBatch, bobItems.slice(0, 5))).every((o) => o.outcome === 'created')).toBe(true)
    expect(new Set((await eventRows(ALICE)).map((e) => e.id))).toEqual(new Set(items.slice(0, 5).map((i) => i.eventId)))
    expect((await eventRows(BOB)).some((e) => items.some((i) => i.eventId === e.id))).toBe(false)
    expect(await count('event_import_links')).toBe(10)
  })

  it('a user cannot create records attributed to someone else', async () => {
    expect(await as(BOB, () => errorOf(db.exec(`insert into public.event_imports (user_id, source_slug, source_label, source_sha256, planned_count) values ('${ALICE}', 's', 'x', '${SHA}', 1)`)))).toBe('42501')
    // with the privileges they do have, user_id is the caller
    const id = await newBatch(BOB)
    expect((await db.query(`select user_id from public.event_imports where id = '${id}'`)).rows[0].user_id).toBe(BOB)
  })
})

describe('account deletion', () => {
  it("removes the user's events, batches and links, including a written batch and tombstones", async () => {
    const batch = await newBatch(ALICE, { planned: 4 })
    await importAll(ALICE, batch, items.slice(0, 4))
    await setStatus(ALICE, batch, 'written')
    await as(ALICE, () => db.exec(`delete from public.events where id = '${items[0].eventId}'`)) // tombstone
    await db.exec(`delete from auth.users where id = '${ALICE}'`)
    expect([await count('events'), await count('event_imports'), await count('event_import_links')]).toEqual([0, 0, 0])
  })
})

describe('rollback', () => {
  it('before any import: lossless, runs without confirmation, leaves events and policies alone', async () => {
    const d = await newDb()
    await d.exec(`insert into public.events (id, user_id, title, category, starts_at, ends_at) values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000099', '${ALICE}', 'Keep me', 'work', '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z')`)
    await d.exec(ROLLBACK)
    const t = await d.query<{ relname: string }>(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname`)
    expect(t.rows.map((r) => r.relname)).toEqual(['events', 'recurring_series', 'series_exceptions'])
    expect((await d.query(`select proname from pg_proc where proname like 'orbit_import%' or proname like 'orbit_forget%' or proname like 'orbit_guard%' or proname = 'orbit_event_snapshot'`)).rows).toEqual([])
    expect((await d.query(`select conname from pg_constraint where conname = 'events_id_user_key'`)).rows).toEqual([])
    expect((await d.query(`select title from public.events`)).rows).toEqual([{ title: 'Keep me' }])
    expect((await d.query(`select count(*)::int as n from pg_policies where schemaname = 'public'`)).rows[0]).toEqual({ n: 12 })
    await d.exec(PROPOSAL) // and it can be re-applied
    await d.close()
  })

  it('after real imports exist: refuses without explicit confirmation and drops nothing; with confirmation it drops only provenance', async () => {
    const batch = await newBatch(ALICE, { planned: 3 })
    await importAll(ALICE, batch, items.slice(0, 3))
    expect(await errorOf(db.exec(ROLLBACK))).toBe('55000')
    await db.exec('rollback') // the file opened its own transaction; leave the aborted one
    expect(await count('event_import_links')).toBe(3) // nothing dropped
    expect(await count('events')).toBe(3)
    expect((await db.query(`select to_regclass('public.event_imports') as t`)).rows[0].t).not.toBeNull()

    // a SESSION-wide "yes" left over from earlier is not how the confirmation is meant to be given, but the guard reads the
    // setting wherever it is; the documented, transaction-local form is what the file's header prescribes:
    expect(ROLLBACK).toMatch(/set_config\('orbit\.confirm_drop_provenance', 'yes', true\)/)
    expect(ROLLBACK).not.toMatch(/set_config\('orbit\.confirm_drop_provenance', 'yes', false\)/)
    expect(await errorOf(db.exec(`begin; select set_config('orbit.confirm_drop_provenance', 'yes', true);\n${ROLLBACK}`))).toBeNull()
    expect((await db.query(`select to_regclass('public.event_imports') as t`)).rows[0].t).toBeNull()
    expect(await count('events')).toBe(3) // the imported events remain, now without provenance
    // the confirmation did NOT outlive the transaction
    expect((await db.query<{ v: string | null }>(`select nullif(current_setting('orbit.confirm_drop_provenance', true), '') as v`)).rows[0].v).toBeNull()
    await db.exec(PROPOSAL) // the same database can take the proposal again (tables are empty now: provenance was lost)
    expect(await count('event_import_links')).toBe(0)
  })

  it('a half-installed state cannot bypass the guard: rows in EITHER provenance table block the rollback', async () => {
    // links table missing, batches with rows (the old guard looked only at the links table when it existed)
    const d1 = await newDb()
    await d1.exec(`insert into public.event_imports (id, user_id, source_slug, source_label, source_sha256, planned_count) values (gen_random_uuid(), '${ALICE}', 'x', 'x', '${SHA}', 1)`)
    await d1.exec('drop table public.event_import_links')
    expect((await d1.query(`select to_regclass('public.event_import_links') as t`)).rows[0].t).toBeNull()
    await expect(d1.exec(ROLLBACK)).rejects.toMatchObject({ code: '55000' })
    await d1.exec('rollback')
    expect(Number((await d1.query<{ n: number }>('select count(*)::int as n from public.event_imports')).rows[0].n)).toBe(1) // nothing dropped
    // batches table dropped (constraint removed), links with rows
    const d2 = await newDb()
    await d2.exec(`insert into public.event_imports (id, user_id, source_slug, source_label, source_sha256, planned_count) values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', '${ALICE}', 'x', 'x', '${SHA}', 1)`)
    await d2.exec(`insert into public.events (id, user_id, title, category, starts_at, ends_at) values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '${ALICE}', 'E', 'work', '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z')`)
    await d2.exec(`select set_config('orbit.import_op', 'import', false)`)
    await d2.exec(`insert into public.event_import_links (user_id, batch_id, source_slug, source_key, event_id, imported_snapshot, source_snapshot) select '${ALICE}', 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 'x', 'k', e.id, orbit_private.orbit_event_snapshot(e), '{}'::jsonb from public.events e`)
    await d2.exec('drop table public.event_imports cascade')
    await expect(d2.exec(ROLLBACK)).rejects.toMatchObject({ code: '55000' })
    await d2.exec('rollback')
    expect(Number((await d2.query<{ n: number }>('select count(*)::int as n from public.event_import_links')).rows[0].n)).toBe(1)
    // neither table exists: nothing to lose, the rollback is a no-op that still removes helpers
    const d3 = await newDb(false)
    await expect(d3.exec(ROLLBACK)).resolves.toBeDefined()
    await d1.close()
    await d2.close()
    await d3.close()
  }, 30_000) // three fresh PGlite databases with every migration applied: ~6 s on a busy machine, over the 5 s default

  it('refuses to run as a role that cannot see all rows (under RLS an empty-looking table proves nothing)', async () => {
    const d = await newDb()
    await d.exec(`select set_config('request.jwt.claim.sub', '${ALICE}', false)`)
    await d.exec('set role authenticated')
    await expect(d.exec(ROLLBACK)).rejects.toMatchObject({ code: '42501' })
    await d.exec('rollback')
    await d.exec('reset role')
    expect((await d.query(`select to_regclass('public.event_imports') as t`)).rows[0].t).not.toBeNull() // nothing dropped
    await d.close()
  })

  it('the rollback never deletes calendar events, series or exceptions (before or after import)', async () => {
    const src = ROLLBACK.replace(/^\s*--.*$/gm, '')
    expect(src).not.toMatch(/delete\s+from|truncate|drop\s+table\s+(if exists\s+)?public\.(events|recurring_series|series_exceptions)\b/i)
    expect(src).not.toMatch(/\bcascade\b/i)
  })
})

describe('PostgreSQL 15 compatibility (static; PGlite is PostgreSQL 18 and cannot run an older server)', () => {
  const sql = PROPOSAL.replace(/--.*$/gm, '')

  it('the only feature newer than PostgreSQL 14 is ON DELETE SET NULL (column list), which needs 15', () => {
    expect(sql).toMatch(/on delete set null \(event_id\)/i)
  })

  it('uses nothing introduced in PostgreSQL 16, 17 or 18', () => {
    const newer: [RegExp, string][] = [
      [/\bjson_(object|array|objectagg|arrayagg|table|exists|query|value|scalar|serialize)\b/i, 'SQL/JSON constructors and JSON_TABLE (16/17)'],
      [/\bis\s+(not\s+)?json\b/i, 'IS JSON predicates (16)'],
      [/pg_input_is_valid|pg_input_error_info/i, 'pg_input_* (16)'],
      [/\bany_value\s*\(|\barray_sort\b|\barray_shuffle\b|\barray_sample\b|\brandom_normal\b/i, 'new functions (16/17/18)'],
      [/\buuidv[47]\s*\(/i, 'uuidv4/uuidv7 (18)'],
      [/returning\s+(old|new)\b/i, 'RETURNING OLD/NEW (18)'],
      [/\bnot\s+enforced\b|\bwithout\s+overlaps\b|\bvirtual\b/i, 'NOT ENFORCED / temporal keys / virtual generated columns (17/18)'],
      [/\bmerge\b[\s\S]*\breturning\b/i, 'MERGE ... RETURNING (17)'],
      [/\bunique\s+nulls\s+not\s+distinct\b/i, 'NULLS NOT DISTINCT (15, not needed)'],
    ]
    for (const [re, what] of newer) expect(sql, what).not.toMatch(re)
  })

  it('relies on no relaxed-search-path or version-specific behaviour: every function pins search_path', () => {
    const defs = sql.split(/create or replace function/i).slice(1)
    expect(defs.length).toBeGreaterThanOrEqual(12)
    for (const d of defs) expect(d, d.slice(0, 80)).toMatch(/set search_path = ''/)
  })
})

describe('TypeScript and SQL agree', () => {
  it('limits used by the client builders match the table constraints', async () => {
    const q: Q = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.event_imports'::regclass and contype = 'c'`)
    const defs = q.rows.map((r) => String(r.def)).join('\n')
    expect(defs).toContain('^[a-z0-9][a-z0-9-]{0,63}$')
    expect(defs).toContain('^[0-9a-f]{64}$')
    expect(defs).toContain('5000')
  })
})

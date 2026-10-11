// Confirm & Save, end to end against the REAL proposed SQL (PGlite = in-memory PostgreSQL with a simulated Supabase
// `auth` schema and roles). The production service code (src/timetable/save/saveImport.ts) runs unchanged on top of
// an ImportApi that executes the same statements the PostgREST API would, as the `authenticated` role (RLS, column
// privileges and integrity triggers apply). NOTHING here touches a hosted project.
//
// Not covered here (see docs): PostgREST/JWT behaviour, truly parallel transactions, real PostgreSQL 15.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ImportError, mapImportError } from '../../src/cloud/importApi.ts'
import type { BatchRow, BatchStatus, ImportApi, LinkRow, RpcOutcome } from '../../src/cloud/importApi.ts'
import type { EventRow } from '../../src/cloud/types'
import raw from '../../src/timetable/utn/__fixtures__/utn-wise2627-layouts.json?raw'
import { extractFromLayouts } from '../../src/timetable/utn/index.ts'
import { buildReview, initialState, toggleExcluded } from '../../src/timetable/utn/review.ts'
import type { ReviewItem } from '../../src/timetable/utn/review.ts'
import type { PageLayout } from '../../src/timetable/utn/types.ts'
import { buildImportItems } from '../../src/timetable/provenance/importItems.ts'
import { checkAvailability, executeSave, planSave } from '../../src/timetable/save/saveImport.ts'
import type { SaveContext, SaveInput } from '../../src/timetable/save/saveImport.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const SHA = 'a'.repeat(64)
const migrationsDir = join(__dirname, '..', 'migrations')
const PROPOSAL = readFileSync(join(__dirname, '..', 'migrations', '20261015120000_event_imports.sql'), 'utf8')
// The base schema = every migration except the provenance one, which these tests apply (and roll back) explicitly.
const migrationFiles = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql') && !/event_imports/.test(n)).sort()

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

async function as<T>(user: string, fn: () => Promise<T>, target: PGlite = db): Promise<T> {
  await target.exec('set role authenticated')
  await target.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user])
  try {
    return await fn()
  } finally {
    await target.exec('reset role')
    await target.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

/** The ImportApi over SQL: the same statements PostgREST would run for these calls, as the signed-in user. */
function pgImportApi(user: string, target: PGlite = db): ImportApi {
  const q = <T>(sql: string, params: unknown[] = []) =>
    as(user, async () => {
      try {
        return (await target.query<T>(sql, params)).rows
      } catch (e) {
        throw mapImportError({ code: (e as { code?: string }).code, message: (e as Error).message }, 400)
      }
    }, target)
  return {
    async probe() {
      const t = await target.query<{ ok: boolean }>(`select to_regclass('public.event_imports') is not null and to_regclass('public.event_import_links') is not null and exists (select 1 from pg_proc where proname = 'orbit_import_sessions') as ok`)
      return t.rows[0].ok ? { available: true as const } : { available: false as const, reason: 'Saving a timetable is not available on this server yet (the import feature is not installed).' }
    },
    async loadLinks(slug) {
      return (await q<{ r: LinkRow }>(`select row_to_json(l) as r from public.event_import_links l where source_slug = $1 order by created_at, id`, [slug])).map((x) => x.r)
    },
    async loadBatches(slug) {
      return (await q<{ r: BatchRow }>(`select row_to_json(b) as r from public.event_imports b where source_slug = $1 order by created_at, id`, [slug])).map((x) => x.r)
    },
    async createBatch(row) {
      await q(`insert into public.event_imports (id, source_slug, source_label, source_sha256, source_published_on, parser_version, selection, planned_count) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, row.source_slug, row.source_label, row.source_sha256, row.source_published_on, row.parser_version, row.selection, row.planned_count])
    },
    async importSessions(batch, items) {
      return (await q<{ r: RpcOutcome[] }>(`select public.orbit_import_sessions($1::uuid, $2::jsonb) as r`, [batch, JSON.stringify(items)]))[0].r
    },
    async setStatus(batch, status: BatchStatus) {
      const rows = await q<{ r: BatchRow }>(`update public.event_imports set status = $2 where id = $1 returning row_to_json(event_imports) as r`, [batch, status])
      if (!rows[0]) throw new ImportError('state', 'The import batch could not be found. Retry.', 'not-found')
      return rows[0].r
    },
  }
}

const cloudFor = (user: string, target: PGlite = db): SaveContext['cloud'] => ({
  async loadEvents() {
    return (await as(user, () => target.query<{ r: EventRow }>(`select row_to_json(e) as r from public.events e order by starts_at, id`), target)).rows.map((x) => x.r)
  },
})
const ctxFor = (user: string, imports = pgImportApi(user)): SaveContext => ({ cloud: cloudFor(user), imports })

const pages = (JSON.parse(raw) as { pages: PageLayout[] }).pages
let sessions: ReturnType<typeof extractFromLayouts>['sessions']
let reviewed: ReviewItem[]
let importable: number

const inputFor = (user: string, items: readonly ReviewItem[] = reviewed, over: Partial<SaveInput> = {}): SaveInput => ({
  userId: user, reviewItems: items, sha256: SHA, label: 'UTN timetable - test', publishedOn: null, selection: ['TEST:'], clashes: 0, ...over,
})

beforeAll(async () => {
  db = await newDb()
  sessions = extractFromLayouts(structuredClone(pages)).sessions
  reviewed = buildReview(sessions, initialState(sessions)).items
  importable = (await buildImportItems(ALICE, reviewed)).items.length
}, 60_000)
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await db.exec('truncate public.event_import_links, public.event_imports, public.events, public.recurring_series cascade')
  await db.query(`select set_config('orbit.import_op', '', false)`)
})

const count = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n)
const batchStatuses = async () => (await db.query<{ status: string }>(`select status from public.event_imports order by created_at, id`)).rows.map((r) => r.status)
const manualEvent = (id: string, title: string) =>
  as(ALICE, () => db.exec(`insert into public.events (id, user_id, title, category, starts_at, ends_at) values ('${id}', '${ALICE}', '${title}', 'personal', '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z')`))

describe('first save', () => {
  it('there is something to import and the plan says exactly what a save will do (nothing is written by planning)', async () => {
    expect(importable).toBeGreaterThan(50) // more than one RPC chunk
    const plan = await planSave(ctxFor(ALICE), inputFor(ALICE))
    expect(plan.counts).toMatchObject({ toCreate: importable, alreadyImported: 0, notRecreated: 0, differences: 0 })
    expect(plan.counts.skipped).toBe(reviewed.length - importable)
    expect(await count('events')).toBe(0)
    expect(await count('event_imports')).toBe(0)
  })

  it('saves every selected session through the RPC, reads it back, and only then reports "verified"; planned_count = the new events', async () => {
    const stages: string[] = []
    const res = await executeSave(ctxFor(ALICE), inputFor(ALICE), (p) => stages.push(p.stage))
    expect(res).toMatchObject({ kind: 'verified', created: importable })
    expect(stages[0]).toBe('planning')
    expect(stages.at(-1)).toBe('verifying')
    expect(await count('events')).toBe(importable)
    expect(await count('event_import_links')).toBe(importable)
    expect(await batchStatuses()).toEqual(['verified'])
    const b = (await db.query<{ planned_count: number; source_sha256: string }>(`select planned_count, source_sha256 from public.event_imports`)).rows[0]
    expect(b).toEqual({ planned_count: importable, source_sha256: SHA })
  })

  it('imports only the sessions the user selected: excluded and needs-review sessions are never written', async () => {
    const ready = reviewed.filter((r) => r.state === 'ready')
    let st = initialState(sessions)
    for (const r of ready.slice(0, 7)) st = toggleExcluded(st, r.id, true)
    const items = buildReview(sessions, st).items
    const res = await executeSave(ctxFor(ALICE), inputFor(ALICE, items))
    expect(res).toMatchObject({ kind: 'verified', created: importable - 7 })
    const titles = (await db.query<{ source_key: string }>(`select source_key from public.event_import_links`)).rows.map((r) => r.source_key)
    for (const r of ready.slice(0, 7)) expect(titles).not.toContain(r.session.sourceKey)
    for (const r of reviewed.filter((x) => x.state !== 'ready')) expect(titles).not.toContain(r.session.sourceKey)
  })
})

describe('duplicate-free re-import and preservation of the user\'s events', () => {
  it('re-importing the identical PDF creates nothing and no new batch', async () => {
    await executeSave(ctxFor(ALICE), inputFor(ALICE))
    const events = await count('events')
    const again = await executeSave(ctxFor(ALICE), inputFor(ALICE))
    expect(again).toMatchObject({ kind: 'nothing-to-do', alreadyImported: importable })
    expect(await count('events')).toBe(events)
    expect(await batchStatuses()).toEqual(['verified']) // no empty history row
    const plan = await planSave(ctxFor(ALICE), inputFor(ALICE))
    expect(plan.counts).toMatchObject({ toCreate: 0, alreadyImported: importable })
  })

  it('manual events survive, an event id that is already taken is never adopted, and edited imported events are kept', async () => {
    const items = (await buildImportItems(ALICE, reviewed)).items
    await manualEvent('aaaaaaaa-aaaa-4aaa-8aaa-0000000000aa', 'My manual event') // unrelated
    await manualEvent(items[0].eventId, 'Occupies the id of the first session') // collision
    // the plan sees the collision up front: that session is reported, not planned, and the batch covers only what it can write
    expect((await planSave(ctxFor(ALICE), inputFor(ALICE))).counts).toMatchObject({ toCreate: importable - 1, notRecreated: 1 })
    const first = await executeSave(ctxFor(ALICE), inputFor(ALICE))
    expect(first).toMatchObject({ kind: 'verified', created: importable - 1 })
    expect(await batchStatuses()).toEqual(['verified'])
    const blocked = (await db.query<{ title: string }>(`select title from public.events where id = '${items[0].eventId}'`)).rows[0]
    expect(blocked.title).toBe('Occupies the id of the first session') // not adopted, not changed
    expect((await db.query(`select 1 from public.events where title = 'My manual event'`)).rows).toHaveLength(1)

    // the user edits an imported event; a repeat save keeps it
    const link = (await db.query<{ event_id: string }>(`select event_id from public.event_import_links limit 1`)).rows[0]
    await as(ALICE, () => db.exec(`update public.events set title = 'Edited by me' where id = '${link.event_id}'`))
    const again = await executeSave(ctxFor(ALICE), inputFor(ALICE))
    expect(again.kind).toBe('nothing-to-do') // the blocked one is reported, not retried or forced
    expect((await db.query<{ title: string }>(`select title from public.events where id = '${link.event_id}'`)).rows[0].title).toBe('Edited by me')
    expect(await count('events')).toBe(importable + 1) // all but the blocked one, plus the manual ones (blocked id = 1 manual)
  })

  it('a collision that appears AFTER planning (another device wrote the id meanwhile) ends honestly as partial, never "complete"', async () => {
    const items = (await buildImportItems(ALICE, reviewed)).items
    const api = pgImportApi(ALICE)
    let raced = false
    const racing: ImportApi = { ...api, importSessions: async (b, i) => { if (!raced) { raced = true; await manualEvent(items[5].eventId, 'Appeared meanwhile') } return api.importSessions(b, i) } }
    const res = await executeSave(ctxFor(ALICE, racing), inputFor(ALICE))
    expect(res).toMatchObject({ kind: 'partial', created: importable - 1, planned: importable })
    expect(await batchStatuses()).toEqual(['written_partial'])
    expect((await db.query<{ title: string }>(`select title from public.events where id = '${items[5].eventId}'`)).rows[0].title).toBe('Appeared meanwhile')
  })

  it('an event the user deleted after importing is not recreated', async () => {
    await executeSave(ctxFor(ALICE), inputFor(ALICE))
    const gone = (await db.query<{ event_id: string }>(`select event_id from public.event_import_links limit 1`)).rows[0]
    await as(ALICE, () => db.exec(`delete from public.events where id = '${gone.event_id}'`))
    const again = await executeSave(ctxFor(ALICE), inputFor(ALICE))
    expect(again.kind).toBe('nothing-to-do')
    expect(await count('events')).toBe(importable - 1)
    const plan = await planSave(ctxFor(ALICE), inputFor(ALICE))
    expect(plan.counts.notRecreated).toBe(1)
  })

  it('another user\'s data is never involved: Bob saves the same PDF independently', async () => {
    await executeSave(ctxFor(ALICE), inputFor(ALICE))
    const bobItems = (await buildImportItems(BOB, reviewed)).items.length
    const res = await executeSave(ctxFor(BOB), inputFor(BOB))
    expect(res).toMatchObject({ kind: 'verified', created: bobItems })
    expect(await count('events')).toBe(importable + bobItems)
    expect((await cloudFor(ALICE).loadEvents()).length).toBe(importable)
  })
})

describe('partial failure and safe retry', () => {
  const failing = (api: ImportApi, at: number): ImportApi => {
    let n = 0
    return {
      ...api,
      importSessions: async (b, items) => {
        if (++n === at) throw new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network')
        return api.importSessions(b, items)
      },
    }
  }

  it('a failure midway reports what was saved, marks the batch failed, and the retry resumes the SAME batch with only the missing sessions', async () => {
    const res = await executeSave(ctxFor(ALICE, failing(pgImportApi(ALICE), 2)), inputFor(ALICE))
    expect(res).toMatchObject({ kind: 'failed', errorKind: 'network', created: 50 })
    expect(await count('events')).toBe(50)
    expect(await batchStatuses()).toEqual(['failed'])
    const batchId = (await db.query<{ id: string }>(`select id from public.event_imports`)).rows[0].id

    const sent: number[] = []
    const api = pgImportApi(ALICE)
    const spy: ImportApi = { ...api, importSessions: (b, items) => (sent.push(items.length), api.importSessions(b, items)) }
    const retry = await executeSave(ctxFor(ALICE, spy), inputFor(ALICE))
    expect(retry).toMatchObject({ kind: 'verified', created: importable, batchId })
    expect(sent.reduce((a, b) => a + b, 0)).toBe(importable - 50) // only the missing ones
    expect(await count('events')).toBe(importable) // no duplicates
    expect(await batchStatuses()).toEqual(['verified']) // one batch, resumed
  })

  it('a failure while finishing leaves the batch resumable; the retry completes it without writing anything again', async () => {
    const api = pgImportApi(ALICE)
    const noWritten: ImportApi = { ...api, setStatus: async (b, s) => { if (s === 'written') throw new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network'); return api.setStatus(b, s) } }
    const res = await executeSave(ctxFor(ALICE, noWritten), inputFor(ALICE))
    expect(res).toMatchObject({ kind: 'failed', created: importable })
    expect(await batchStatuses()).toEqual(['failed'])
    const sent: number[] = []
    const spy: ImportApi = { ...api, importSessions: (b, items) => (sent.push(items.length), api.importSessions(b, items)) }
    expect(await executeSave(ctxFor(ALICE, spy), inputFor(ALICE))).toMatchObject({ kind: 'verified', created: importable })
    expect(sent).toEqual([]) // nothing re-sent
    expect(await count('events')).toBe(importable)
  })

  it('an unknown outcome on batch creation (timeout) does not create a second batch', async () => {
    const api = pgImportApi(ALICE)
    let first = true
    const lostAck: ImportApi = { ...api, createBatch: async (row) => { await api.createBatch(row); if (first) { first = false; throw new ImportError('network', 'timeout', 'network') } } }
    const res = await executeSave(ctxFor(ALICE, lostAck), inputFor(ALICE))
    expect(res.kind).toBe('verified')
    expect(await batchStatuses()).toEqual(['verified'])
  })

  it('when the selection changed since the interrupted attempt, the old batch is closed as partial and a new batch saves only the missing sessions', async () => {
    await executeSave(ctxFor(ALICE, failing(pgImportApi(ALICE), 2)), inputFor(ALICE)) // 50 saved, batch failed, planned = importable
    const ready = reviewed.filter((r) => r.state === 'ready')
    let st = initialState(sessions)
    for (const r of ready.slice(-5)) st = toggleExcluded(st, r.id, true) // the user now deselects 5 sessions
    const res = await executeSave(ctxFor(ALICE), inputFor(ALICE, buildReview(sessions, st).items))
    expect(res).toMatchObject({ kind: 'verified', created: importable - 5 - 50 })
    expect(await batchStatuses()).toEqual(['written_partial', 'verified'])
    expect(await count('events')).toBe(importable - 5)
  })

  it('a fresh import that another tab/device is running is not raced', async () => {
    const api = pgImportApi(ALICE)
    await api.createBatch({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', source_slug: 'utn-wise2627', source_label: 'x', source_sha256: 'b'.repeat(64), source_published_on: null, parser_version: 1, selection: [], planned_count: 3 })
    const res = await executeSave(ctxFor(ALICE), inputFor(ALICE))
    expect(res.kind).toBe('blocked')
    expect(await count('events')).toBe(0)
  })
})

describe('read-back verification', () => {
  it('data that does not read back as reviewed is NOT reported as verified (the batch stays "written")', async () => {
    let reads = 0
    const tamper: SaveContext['cloud'] = {
      loadEvents: async () => {
        const rows = await cloudFor(ALICE).loadEvents()
        return ++reads >= 2 ? rows.map((r, i) => (i === 3 ? { ...r, title: 'changed behind our back' } : r)) : rows // 1st read = planning
      },
    }
    const res = await executeSave({ cloud: tamper, imports: pgImportApi(ALICE) }, inputFor(ALICE))
    expect(res.kind).toBe('unverified')
    expect(res.kind === 'unverified' && res.problems.join()).toMatch(/differs from what was reviewed/)
    expect(await batchStatuses()).toEqual(['written'])
  })

  it('the server refuses to verify when an event was edited before verification', async () => {
    const api = pgImportApi(ALICE)
    const editBeforeVerified: ImportApi = {
      ...api,
      setStatus: async (b, s) => {
        if (s === 'verified') await as(ALICE, () => db.exec(`update public.events set title = 'edited meanwhile' where id = (select event_id from public.event_import_links limit 1)`))
        return api.setStatus(b, s)
      },
    }
    const res = await executeSave(ctxFor(ALICE, editBeforeVerified), inputFor(ALICE))
    expect(res.kind).toBe('failed') // the database rejected the false "verified" claim
    expect(await batchStatuses()).not.toContain('verified')
  })
})

describe('backend not installed / not allowed', () => {
  it('a database without the provenance feature is reported as unavailable and nothing is written', async () => {
    const bare = await newDb(false)
    const api = pgImportApi(ALICE, bare)
    expect(await checkAvailability(api)).toMatchObject({ ok: false })
    const res = await executeSave({ cloud: cloudFor(ALICE, bare), imports: api }, inputFor(ALICE))
    expect(res).toMatchObject({ kind: 'failed', errorKind: 'unavailable', created: 0 })
    expect((await bare.query<{ n: number }>(`select count(*)::int as n from public.events`)).rows[0].n).toBe(0)
    await bare.close()
  })

  it('with the feature installed the probe says available', async () => {
    expect(await checkAvailability(pgImportApi(ALICE))).toEqual({ ok: true })
  })
})

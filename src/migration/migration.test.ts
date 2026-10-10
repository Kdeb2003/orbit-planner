import { describe, expect, it } from 'vitest'
import type { CloudApi } from '../cloud/cloudApi'
import { FakeCloud } from '../cloud/fakeCloudApi'
import { isUuid } from '../cloud/ids'
import { rowToEvent, rowToSeries } from '../cloud/mappers'
import { CloudError } from '../cloud/types'
import type { StorageLike } from '../storage/collection'
import type { CalendarEvent, RecurringSeries } from '../types'
import { buildImportPlan } from './importPlan'
import { IMPORT_RECORD_KEY, readImportRecord } from './importRecord'
import { backupFilename, buildBackup, countRaw, readLocalRaw } from './localData'
import { runImport, verifyImport } from './runImport'

const USER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const TS = '2026-01-01T00:00:00.000Z'
const UUID_EVENT = '11111111-1111-4111-8111-111111111111'

const ev = (id: string, title = 'Lecture', over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title,
  category: 'university',
  start: '2026-10-12T07:00:00.000Z',
  end: '2026-10-12T08:30:00.000Z',
  timeZone: 'Europe/Berlin',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-02T10:00:00.000Z',
  ...over,
})
const ser = (id: string, over: Partial<RecurringSeries> = {}): RecurringSeries => ({
  id,
  title: 'Maths',
  category: 'university',
  timeZone: 'Europe/Berlin',
  courseCode: 'MA1',
  recurrence: { frequency: 'weekly', weekdays: [0, 2], startDate: '2026-10-12', untilDate: '2026-12-14' },
  startTime: '09:00',
  endTime: '10:30',
  endDayOffset: 0,
  exceptions: [
    { originalDate: '2026-10-19', cancelled: true },
    { originalDate: '2026-10-21', override: { start: '2026-10-22T07:00:00.000Z', end: '2026-10-22T08:30:00.000Z', location: 'Room 204' } },
    { originalDate: '2026-10-20', cancelled: true }, // a Tuesday: no longer on the schedule (orphaned)
  ],
  createdAt: TS,
  updatedAt: TS,
  ...over,
})

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string>; writes: string[] } {
  const data = { ...initial }
  const writes: string[] = []
  return {
    data,
    writes,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      writes.push(k)
      data[k] = v
    },
  }
}

const local = { events: [ev('legacy-1', 'Old event'), ev(UUID_EVENT, 'Has a real UUID')], series: [ser('legacy-series')] }

async function plan(cloud: FakeCloud, input = local, user = USER) {
  const api = cloud.apiFor(user)
  const [e, s, x] = await Promise.all([api.loadEvents(), api.loadSeries(), api.loadExceptions()])
  return buildImportPlan({ userId: user, ...input, cloudEvents: e.map(rowToEvent), cloudSeries: s.map((r) => rowToSeries(r, x)) })
}

describe('backup', () => {
  const raw = { events: '[{"id":"a"}, not valid json', series: JSON.stringify([ser('s1')]) }

  it('contains the byte-exact raw values, even for unreadable data, plus counts', () => {
    const b = JSON.parse(buildBackup(raw, new Date('2026-10-09T10:00:00Z')))
    expect(b.format).toBe('orbit-local-backup')
    expect(b.storage['orbit.events.v1']).toBe(raw.events)
    expect(b.storage['orbit.series.v1']).toBe(raw.series)
    expect(b.counts).toMatchObject({ series: 1, exceptions: 3, unreadable: true })
    expect(b.series[0].id).toBe('s1')
    expect(b.events).toBeNull()
    expect(backupFilename(new Date('2026-10-09T10:20:30Z'))).toBe('orbit-local-backup-2026-10-09-10-20-30.json')
  })

  it('counts every entry, valid or not', () => {
    expect(countRaw({ events: JSON.stringify([{}, 5, null]), series: null })).toEqual({ events: 3, series: 0, exceptions: 0, unreadable: false })
    expect(countRaw({ events: '{"not":"array"}', series: null }).unreadable).toBe(true)
    expect(countRaw({ events: null, series: null })).toEqual({ events: 0, series: 0, exceptions: 0, unreadable: false })
  })

  it('reading local data is read-only', () => {
    const readOnly = { getItem: (k: string) => (k === 'orbit.events.v1' ? '[]' : null) }
    expect(readLocalRaw(readOnly)).toEqual({ events: '[]', series: null })
    expect(readLocalRaw({ getItem: () => { throw new Error('blocked') } })).toEqual({ events: null, series: null })
    expect(readLocalRaw(null)).toEqual({ events: null, series: null })
  })
})

describe('migration preview (plan)', () => {
  it('classifies everything as new in an empty cloud and maps legacy ids deterministically', async () => {
    const p = await plan(new FakeCloud())
    expect(p.counts.events.new).toBe(2)
    expect(p.counts.series.new).toBe(1)
    expect(p.counts.exceptions.new).toBe(3)
    expect(p.toUpload).toBe(6)
    expect(p.hasSkips).toBe(false)
    expect(p.idMap[UUID_EVENT]).toBe(UUID_EVENT) // real UUIDs are kept
    expect(isUuid(p.idMap['legacy-1'])).toBe(true)
    expect(p.idMap['legacy-1']).not.toBe('legacy-1')
    const again = await plan(new FakeCloud())
    expect(again.idMap).toEqual(p.idMap) // same mapping every run
    expect((await plan(new FakeCloud(), local, OTHER)).idMap['legacy-1']).not.toBe(p.idMap['legacy-1']) // per user
  })

  it('flags orphaned exceptions but keeps them (never silently dropped)', async () => {
    const p = await plan(new FakeCloud())
    expect(p.counts.exceptions.orphaned).toBe(1)
    expect(p.series[0].exceptions.find((x) => x.orphaned)?.exception.originalDate).toBe('2026-10-20')
    expect(p.series[0].exceptions.find((x) => x.orphaned)?.status).toBe('new')
  })

  it('reports invalid records with reasons and does not plan to upload them', async () => {
    const bad = {
      events: [ev('e-bad', 'x'.repeat(121)), ev('e-tz', 'Zone', { timeZone: 'UTC+9' }), ev('e-ok')],
      series: [ser('s-long', { recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2024-01-01', untilDate: '2028-01-01' } }), ser('s-ok')],
    }
    const p = await plan(new FakeCloud(), bad)
    expect(p.counts.events).toMatchObject({ invalid: 2, new: 1 })
    expect(p.events.find((e) => e.legacyId === 'e-bad')!.problems[0]).toMatch(/title/)
    expect(p.events.find((e) => e.legacyId === 'e-tz')!.problems[0]).toMatch(/time zone/)
    expect(p.series.find((s) => s.legacyId === 's-long')!.problems[0]).toMatch(/1100/)
    expect(p.series.find((s) => s.legacyId === 's-long')!.exceptions.every((x) => x.status === 'skipped')).toBe(true)
    expect(p.hasSkips).toBe(true)
  })

  it('detects "already imported" and "different version in the cloud" (never overwritten)', async () => {
    const cloud = new FakeCloud()
    const first = await plan(cloud)
    await runImport(first, cloud.apiFor(USER))
    const again = await plan(cloud)
    expect(again.counts.events['exists-same']).toBe(2)
    expect(again.counts.series['exists-same']).toBe(1)
    expect(again.counts.exceptions['exists-same']).toBe(3)
    expect(again.toUpload).toBe(0)

    cloud.touchEvent(USER, first.idMap['legacy-1'], { title: 'Edited in the cloud' })
    const changed = await plan(cloud)
    expect(changed.counts.events.conflict).toBe(1)
    expect(changed.hasSkips).toBe(true)
  })

  it('detects duplicate ids inside the local data', async () => {
    const p = await plan(new FakeCloud(), { events: [ev(UUID_EVENT), ev(UUID_EVENT.toUpperCase(), 'Same id, other case')], series: [] })
    expect(p.counts.events).toMatchObject({ new: 1, invalid: 1 })
  })
})

describe('running the import', () => {
  it('uploads, verifies by reading back, then records "verified"; local storage is never touched', async () => {
    const cloud = new FakeCloud()
    const storage = memoryStorage({ 'orbit.events.v1': JSON.stringify(local.events), 'orbit.series.v1': JSON.stringify(local.series) })
    const before = { ...storage.data }
    const p = await plan(cloud)
    const progress: string[] = []
    const out = await runImport(p, cloud.apiFor(USER), { recordStorage: storage, onProgress: (x) => progress.push(x.phase) })

    expect(out).toEqual({ ok: true, status: 'verified', uploaded: { events: 2, series: 1, exceptions: 3 } })
    expect(progress).toContain('verifying')
    expect(cloud.events.get(USER)).toHaveLength(2)
    expect(cloud.series.get(USER)).toHaveLength(1)
    expect(cloud.exceptions.get(USER)).toHaveLength(3)
    // the original data is untouched, byte for byte; only the progress marker was written
    expect(storage.data['orbit.events.v1']).toBe(before['orbit.events.v1'])
    expect(storage.data['orbit.series.v1']).toBe(before['orbit.series.v1'])
    expect(new Set(storage.writes)).toEqual(new Set([IMPORT_RECORD_KEY]))
    const rec = readImportRecord(storage, USER)!
    expect(rec).toMatchObject({ status: 'verified', uploaded: { events: 2, series: 1, exceptions: 3 } })
    expect(rec.idMap['legacy-1']).toBe(p.idMap['legacy-1']) // durable id mapping
    expect(readImportRecord(storage, OTHER)).toBeNull()
  })

  it('preserves original creation times and the exact content (including university metadata and moved occurrences)', async () => {
    const cloud = new FakeCloud()
    await runImport(await plan(cloud), cloud.apiFor(USER))
    const row = cloud.events.get(USER)!.find((r) => r.id === UUID_EVENT)!
    expect(new Date(row.created_at).toISOString()).toBe('2026-09-01T10:00:00.000Z')
    const s = cloud.series.get(USER)![0]
    expect(s).toMatchObject({ course_code: 'MA1', start_time: '09:00', end_time: '10:30', weekdays: [0, 2] })
    const moved = cloud.exceptions.get(USER)!.find((x) => x.original_date === '2026-10-21')!
    expect(moved.override).toMatchObject({ start: '2026-10-22T07:00:00.000Z', location: 'Room 204' })
  })

  it('is idempotent: repeating the import creates no duplicates and uploads nothing', async () => {
    const cloud = new FakeCloud()
    const storage = memoryStorage()
    await runImport(await plan(cloud), cloud.apiFor(USER), { recordStorage: storage })
    const second = await runImport(await plan(cloud), cloud.apiFor(USER), { recordStorage: storage })
    expect(second).toMatchObject({ ok: true, status: 'verified', uploaded: { events: 0, series: 0, exceptions: 0 } })
    // even re-running the OLD plan (stale preview, double click) cannot duplicate: inserts ignore existing ids
    const stalePlan = await plan(new FakeCloud())
    await runImport(stalePlan, cloud.apiFor(USER))
    expect(cloud.events.get(USER)).toHaveLength(2)
    expect(cloud.series.get(USER)).toHaveLength(1)
    expect(cloud.exceptions.get(USER)).toHaveLength(3)
  })

  it('recovers from a failure between series and exceptions: resumes without duplicates; not "verified" meanwhile', async () => {
    const cloud = new FakeCloud()
    const storage = memoryStorage()
    const real = cloud.apiFor(USER)
    const flaky: CloudApi = {
      ...real,
      insertExceptionsIgnoreDuplicates: async () => {
        throw new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network')
      },
    }
    const first = await runImport(await plan(cloud), flaky, { recordStorage: storage })
    expect(first).toMatchObject({ ok: false, stage: 'upload', uploaded: { events: 2, series: 1, exceptions: 0 } })
    expect(readImportRecord(storage, USER)!.status).toBe('failed') // never marked complete
    expect(cloud.series.get(USER)).toHaveLength(1) // series made it
    expect(cloud.exceptions.get(USER) ?? []).toHaveLength(0) // exceptions did not

    const resumePlan = await plan(cloud)
    expect(resumePlan.counts.series['exists-same']).toBe(1)
    expect(resumePlan.counts.exceptions.new).toBe(3) // exactly the missing part
    const second = await runImport(resumePlan, real, { recordStorage: storage })
    expect(second).toMatchObject({ ok: true, status: 'verified', uploaded: { events: 0, series: 0, exceptions: 3 } })
    expect(cloud.events.get(USER)).toHaveLength(2)
    expect(cloud.series.get(USER)).toHaveLength(1)
    expect(cloud.exceptions.get(USER)).toHaveLength(3)
    expect(readImportRecord(storage, USER)!.status).toBe('verified')
  })

  it('does not report success when verification finds a problem', async () => {
    const cloud = new FakeCloud()
    const storage = memoryStorage()
    const real = cloud.apiFor(USER)
    const lying: CloudApi = { ...real, loadEvents: async () => (await real.loadEvents()).slice(1) } // one event "missing" on read-back
    const out = await runImport(await plan(cloud), lying, { recordStorage: storage })
    expect(out).toMatchObject({ ok: false, stage: 'verify' })
    expect(out.ok === false && out.mismatches?.[0]).toMatch(/missing in the cloud/)
    expect(readImportRecord(storage, USER)!.status).toBe('verification-failed')
  })

  it('never overwrites a different cloud version and finishes as "verified with skips"', async () => {
    const cloud = new FakeCloud()
    const first = await plan(cloud)
    await runImport(first, cloud.apiFor(USER))
    cloud.touchEvent(USER, first.idMap['legacy-1'], { title: 'Edited in the cloud' })
    const storage = memoryStorage()
    const out = await runImport(await plan(cloud), cloud.apiFor(USER), { recordStorage: storage })
    expect(out).toMatchObject({ ok: true, status: 'verified-with-skips' })
    expect(cloud.events.get(USER)!.find((r) => r.id === first.idMap['legacy-1'])!.title).toBe('Edited in the cloud')
    expect(readImportRecord(storage, USER)!.status).toBe('verified-with-skips')
  })

  it('skips invalid records but still imports the valid ones', async () => {
    const cloud = new FakeCloud()
    const out = await runImport(await plan(cloud, { events: [ev('bad', 'x'.repeat(200)), ev('good')], series: [] }), cloud.apiFor(USER))
    expect(out).toMatchObject({ ok: true, status: 'verified-with-skips', uploaded: { events: 1 } })
    expect(cloud.events.get(USER)).toHaveLength(1)
  })

  it('only ever writes into the signed-in user\'s own rows', async () => {
    const cloud = new FakeCloud()
    await runImport(await plan(cloud), cloud.apiFor(USER))
    expect(cloud.events.get(OTHER) ?? []).toHaveLength(0)
    expect((await verifyImport(await plan(cloud), cloud.apiFor(USER))).length).toBe(0)
    expect((await verifyImport(await plan(cloud), cloud.apiFor(OTHER))).length).toBeGreaterThan(0) // another account does not have this data
  })
})

import { describe, expect, it } from 'vitest'
import { FakePlanner } from '../cloud/fakePlannerApi'
import type { PlannerApi } from '../cloud/plannerApi'
import type { CourseRow } from '../cloud/plannerTypes'
import { CloudError } from '../cloud/types'
import type { CourseInput } from '../types/planner'
import { createPlannerSource } from './plannerSource'

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const C1 = 'c0c0c0c0-0000-4000-8000-000000000001'
const C2 = 'c0c0c0c0-0000-4000-8000-000000000002'
const C3 = 'c0c0c0c0-0000-4000-8000-000000000003'

const algebra: CourseInput = {
  name: 'Linear Algebra',
  code: 'MATH 101',
  institution: 'Example University',
  termLabel: 'WS 26/27',
  termStart: '2026-10-12',
  termEnd: '2027-02-12',
  color: 'c2',
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick()
}
async function open(cloud: FakePlanner, user = ALICE, extra: Partial<Parameters<typeof createPlannerSource>[1]> = {}) {
  const source = createPlannerSource(cloud.apiFor(user), { userId: user, ...extra })
  await source.refresh()
  return source
}
const names = (s: { getSnapshot(): { courses: readonly { name: string }[] } }) => s.getSnapshot().courses.map((c) => c.name)
const ids = (s: { getSnapshot(): { courses: readonly { id: string }[] } }) => s.getSnapshot().courses.map((c) => c.id).sort()

describe('loading', () => {
  it('starts in loading, then shows only this user\'s courses', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'Mine' })
    cloud.seedCourse(BOB, { id: C2, name: 'Bobs secret' })
    const source = createPlannerSource(cloud.apiFor(ALICE), { userId: ALICE })
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', userId: ALICE, courses: [] })
    await source.refresh()
    const snap = source.getSnapshot()
    expect(snap.status).toBe('ready')
    expect(snap.courses.map((c) => c.name)).toEqual(['Mine'])
    expect(snap.lastSyncedAt).not.toBeNull()
    expect(JSON.stringify(snap)).not.toContain('Bobs secret')
  })

  it('an empty account is a successful, empty result', async () => {
    const s = await open(new FakePlanner())
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', courses: [], error: null })
  })

  it('sorts by name and skips (and counts) rows that fail validation', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'zoology' })
    cloud.seedCourse(ALICE, { id: C2, name: 'Algebra' })
    cloud.seedCourse(ALICE, { id: C3, name: '   ' }) // violates the course rules
    const s = await open(cloud)
    expect(names(s)).toEqual(['Algebra', 'zoology'])
    expect(s.getSnapshot().skippedInvalid).toBe(1)
  })

  it('never shows a row that belongs to another owner, even if the API returned one', async () => {
    const cloud = new FakePlanner()
    const foreign: CourseRow = cloud.seedCourse(BOB, { id: C2, name: 'Bobs secret' })
    const api: PlannerApi = { ...cloud.apiFor(ALICE), loadCourses: async () => [foreign] }
    const s = createPlannerSource(api, { userId: ALICE })
    await s.refresh()
    expect(s.getSnapshot().courses).toEqual([])
    expect(s.getSnapshot().skippedInvalid).toBe(1)
  })

  it('a failed first load is an error state; a later failure keeps the last good data', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'Mine' })
    cloud.offline = true
    const s = createPlannerSource(cloud.apiFor(ALICE), { userId: ALICE })
    await s.refresh()
    expect(s.getSnapshot()).toMatchObject({ status: 'error', offline: true, courses: [] })

    cloud.offline = false
    await s.refresh()
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', offline: false, error: null })
    expect(names(s)).toEqual(['Mine'])

    cloud.offline = true
    await s.refresh()
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', offline: true })
    expect(names(s)).toEqual(['Mine'])
  })

  it('a server error that is not a network problem is reported with its own message', async () => {
    const cloud = new FakePlanner()
    cloud.failReads = { error: new CloudError('unknown', 'Courses are not available on this server yet.', 'planner_unavailable'), remaining: 1 }
    const s = await open(cloud)
    expect(s.getSnapshot()).toMatchObject({ status: 'error', offline: false, error: 'Courses are not available on this server yet.' })
  })
})

describe('creating, editing, archiving, deleting', () => {
  it('create is pessimistic: nothing is shown until the server confirmed, then the confirmed row is', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.holdResponses()
    const p = s.createCourse(algebra, C1)
    await settle()
    expect(s.getSnapshot().courses).toEqual([])
    expect(s.getSnapshot().pendingWrites).toBe(1)
    cloud.releaseResponses()
    const r = await p
    expect(r).toMatchObject({ ok: true, value: { id: C1, name: 'Linear Algebra', userId: ALICE } })
    expect(names(s)).toEqual(['Linear Algebra'])
    expect(s.getSnapshot().pendingWrites).toBe(0)
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
  })

  it('invalid input is rejected before any request', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    const before = cloud.calls.length
    const r = await s.createCourse({ ...algebra, name: '  ' })
    expect(r).toMatchObject({ ok: false, kind: 'validation' })
    expect((r as { error: string }).error).toMatch(/name/i)
    expect((await s.updateCourse(C1, { ...algebra, termEnd: undefined })).ok).toBe(false)
    expect(cloud.calls.length).toBe(before)
  })

  it('stores blank optionals as NULL on the server and reads them back as absent', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse({ name: 'Bare', code: '', institution: '  ', color: 'c1' }, C1)
    expect(cloud.courses.get(ALICE)![0]).toMatchObject({ code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null })
    expect(s.getSnapshot().courses[0]).not.toHaveProperty('code')
  })

  it('update changes the course and never touches its archive state', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    await s.archiveCourse(C1)
    const archivedAt = s.getSnapshot().courses[0].archivedAt
    expect(archivedAt).toBeDefined()
    const r = await s.updateCourse(C1, { ...algebra, name: 'Linear Algebra II' })
    expect(r).toMatchObject({ ok: true, value: { name: 'Linear Algebra II', archivedAt } })
  })

  it('archive and restore are confirmed by the server; archiving twice keeps the first archive time', async () => {
    let t = Date.parse('2026-10-11T10:00:00Z')
    const cloud = new FakePlanner()
    const s = await open(cloud, ALICE, { now: () => t })
    await s.createCourse(algebra, C1)
    const a = await s.archiveCourse(C1)
    expect(a).toMatchObject({ ok: true })
    const first = (a as { value: { archivedAt?: string } }).value.archivedAt
    expect(first).toBe('2026-10-11T10:00:00.000Z')
    t += 3_600_000
    const again = await s.archiveCourse(C1)
    expect((again as { value: { archivedAt?: string } }).value.archivedAt).toBe(first)
    const r = await s.restoreCourse(C1)
    expect(r).toMatchObject({ ok: true })
    expect(s.getSnapshot().courses[0].archivedAt).toBeUndefined()
    expect(cloud.courses.get(ALICE)![0].archived_at).toBeNull()
  })

  it('delete removes the course after the server confirmed', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    expect(await s.deleteCourse(C1)).toMatchObject({ ok: true })
    expect(s.getSnapshot().courses).toEqual([])
    expect(cloud.courses.get(ALICE)).toEqual([])
  })

  it('a successful write converges with the server (picks up another device\'s course)', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.seedCourse(ALICE, { id: C2, name: 'From my phone' })
    await s.createCourse(algebra, C1)
    await settle()
    expect(ids(s)).toEqual([C1, C2])
  })
})

describe('idempotent create', () => {
  it('a retry after a lost response (the first attempt was saved) yields exactly one course', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.loseResponses = { mode: 'error', remaining: 1 }
    const first = await s.createCourse(algebra, C1)
    expect(first).toMatchObject({ ok: false, kind: 'network' })
    expect(cloud.courses.get(ALICE)).toHaveLength(1) // it did reach the server
    const retry = await s.createCourse(algebra, C1)
    expect(retry).toMatchObject({ ok: true, value: { id: C1 } })
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
    expect(ids(s)).toEqual([C1])
  })

  it('an existing id with DIFFERENT content is not treated as success', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'Something else entirely' })
    const s = await open(cloud)
    const r = await s.createCourse(algebra, C1)
    expect(r).toMatchObject({ ok: false, kind: 'conflict' })
    expect(cloud.courses.get(ALICE)![0].name).toBe('Something else entirely')
  })

  it('an id that belongs to ANOTHER user is not success, and nothing of theirs becomes visible', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(BOB, { id: C1, name: 'Bobs secret', code: 'X 1' })
    const s = await open(cloud)
    const r = await s.createCourse({ ...algebra, name: 'Bobs secret', code: 'X 1' }, C1)
    expect(r.ok).toBe(false)
    expect(s.getSnapshot().courses).toEqual([])
    expect(cloud.courses.get(BOB)).toHaveLength(1)
    expect(JSON.stringify(s.getSnapshot())).not.toContain('Bobs secret')
  })

  it('two creates with different generated ids make two courses', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse({ name: 'One', color: 'c1' })
    await s.createCourse({ name: 'Two', color: 'c1' })
    expect(s.getSnapshot().courses).toHaveLength(2)
  })
})

describe('duplicate course codes', () => {
  it('rejects a second course with the same normalised code, institution and term as "duplicate" (not stale)', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    const r = await s.createCourse({ ...algebra, name: 'Same again', code: '  math   101 ' }, C2)
    expect(r).toMatchObject({ ok: false, kind: 'duplicate' })
    expect(s.getSnapshot().courses).toHaveLength(1)
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
  })

  it('allows the same code in a different term or institution, and courses without a code', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    expect((await s.createCourse({ ...algebra, termLabel: 'WS 27/28' }, C2)).ok).toBe(true)
    expect((await s.createCourse({ ...algebra, institution: 'Other University' }, C3)).ok).toBe(true)
    expect((await s.createCourse({ name: 'No code A', color: 'c1' })).ok).toBe(true)
    expect((await s.createCourse({ name: 'No code B', color: 'c1' })).ok).toBe(true)
  })

  it('two different users may use the same code', async () => {
    const cloud = new FakePlanner()
    const a = await open(cloud, ALICE)
    const b = await open(cloud, BOB)
    expect((await a.createCourse(algebra, C1)).ok).toBe(true)
    expect((await b.createCourse(algebra, C2)).ok).toBe(true)
  })

  it('an edit that would collide is a duplicate; the original is untouched', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    await s.createCourse({ ...algebra, code: 'MATH 102' }, C2)
    const r = await s.updateCourse(C2, { ...algebra, code: 'math 101' })
    expect(r).toMatchObject({ ok: false, kind: 'duplicate' })
    expect(cloud.courses.get(ALICE)!.find((c) => c.id === C2)!.code).toBe('MATH 102')
  })

  it('a duplicate does not look like a stale write, and a stale write does not look like a duplicate', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.touchCourse(ALICE, C1, { description: 'edited elsewhere' })
    const stale = await s.updateCourse(C1, { ...algebra, name: 'Mine' })
    expect(stale).toMatchObject({ ok: false, kind: 'stale' })
    const dup = await s.createCourse({ ...algebra, name: 'Dup' }, C2)
    expect(dup).toMatchObject({ ok: false, kind: 'duplicate' })
  })
})

describe('optimistic concurrency', () => {
  it('a stale update is rejected, the other device\'s data survives, and the latest version is loaded', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.touchCourse(ALICE, C1, { name: 'Renamed on my phone' })
    const r = await s.updateCourse(C1, { ...algebra, name: 'Renamed on my laptop' })
    expect(r).toMatchObject({ ok: false, kind: 'stale' })
    expect(cloud.courses.get(ALICE)![0].name).toBe('Renamed on my phone')
    await settle()
    expect(names(s)).toEqual(['Renamed on my phone'])
    // with the fresh version the edit now goes through
    expect((await s.updateCourse(C1, { ...algebra, name: 'Renamed on my laptop' })).ok).toBe(true)
    expect(cloud.courses.get(ALICE)![0].name).toBe('Renamed on my laptop')
  })

  it('stale archive, restore and delete change nothing on the server', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.touchCourse(ALICE, C1, { description: 'phone' })
    expect(await s.archiveCourse(C1)).toMatchObject({ ok: false, kind: 'stale' })
    await settle()
    cloud.touchCourse(ALICE, C1, { archived_at: '2026-10-01T00:00:00+00:00' })
    expect(await s.restoreCourse(C1)).toMatchObject({ ok: false, kind: 'stale' })
    await settle()
    cloud.touchCourse(ALICE, C1, { description: 'phone again' })
    expect(await s.deleteCourse(C1)).toMatchObject({ ok: false, kind: 'stale' })
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
    expect(cloud.courses.get(ALICE)![0]).toMatchObject({ description: 'phone again', archived_at: '2026-10-01T00:00:00+00:00' })
  })

  it('editing or deleting a course that is gone (deleted elsewhere) fails as stale and removes it from view', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.courses.set(ALICE, [])
    expect(await s.updateCourse(C1, algebra)).toMatchObject({ ok: false, kind: 'stale' })
    await settle()
    expect(s.getSnapshot().courses).toEqual([])
    expect(await s.deleteCourse(C1)).toMatchObject({ ok: false, kind: 'stale' })
  })

  it('a course unknown to this source cannot be changed', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(BOB, { id: C2, name: 'Bobs' })
    const s = await open(cloud)
    expect(await s.deleteCourse(C2)).toMatchObject({ ok: false, kind: 'stale' })
    expect(await s.archiveCourse(C2)).toMatchObject({ ok: false, kind: 'stale' })
    expect(cloud.calls.filter((c) => c.method !== 'loadCourses')).toEqual([]) // no write request was ever sent
    expect(cloud.courses.get(BOB)).toHaveLength(1)
  })

  it('even a forged conditional request for another user\'s row changes nothing (per-user scoping)', async () => {
    const cloud = new FakePlanner()
    const bobs = cloud.seedCourse(BOB, { id: C2, name: 'Bobs' })
    const api = cloud.apiFor(ALICE)
    expect(await api.updateCourse(C2, { name: 'Hacked', code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c1' }, bobs.updated_at)).toBeNull()
    expect(await api.archiveCourse(C2, '2026-10-01T00:00:00Z', bobs.updated_at)).toBeNull()
    expect(await api.deleteCourse(C2, bobs.updated_at)).toBe(false)
    expect(await api.getCourse(C2)).toBeNull()
    expect(cloud.courses.get(BOB)![0].name).toBe('Bobs')
  })

  it('writes are applied in order, one at a time', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    const a = s.updateCourse(C1, { ...algebra, name: 'Step 1' })
    const b = s.updateCourse(C1, { ...algebra, name: 'Step 2' }) // runs after a, with a's confirmed version
    expect(await a).toMatchObject({ ok: true })
    expect(await b).toMatchObject({ ok: true })
    expect(cloud.courses.get(ALICE)![0].name).toBe('Step 2')
  })
})

describe('reviewed-version precondition', () => {
  const writes = (c: FakePlanner) => c.calls.filter((x) => x.method !== 'loadCourses' && x.method !== 'getCourse')

  /** v1 reviewed by the caller; another device then saves v2 and this source refreshes (the caller still holds v1). */
  async function setup() {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    const v1 = s.getSnapshot().courses[0].updatedAt
    cloud.touchCourse(ALICE, C1, { name: 'Phone edit' })
    await s.refresh()
    expect(s.getSnapshot().courses[0].name).toBe('Phone edit')
    return { cloud, s, v1, v2: s.getSnapshot().courses[0].updatedAt }
  }

  it('an update based on an older version is rejected as stale WITHOUT any write request, and the newer data survives', async () => {
    const { cloud, s, v1 } = await setup()
    const before = writes(cloud).length
    const r = await s.updateCourse(C1, { ...algebra, name: 'Laptop edit' }, v1)
    expect(r).toMatchObject({ ok: false, kind: 'stale' })
    expect(writes(cloud).length).toBe(before) // nothing was sent
    expect(cloud.courses.get(ALICE)![0].name).toBe('Phone edit')
  })

  it('archive, restore and delete bound to an older version are rejected the same way', async () => {
    const { cloud, s, v1 } = await setup()
    const before = writes(cloud).length
    expect(await s.archiveCourse(C1, v1)).toMatchObject({ ok: false, kind: 'stale' })
    expect(await s.restoreCourse(C1, v1)).toMatchObject({ ok: false, kind: 'stale' })
    expect(await s.deleteCourse(C1, v1)).toMatchObject({ ok: false, kind: 'stale' })
    expect(writes(cloud).length).toBe(before)
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
    expect(cloud.courses.get(ALICE)![0].archived_at).toBeNull()
  })

  it('with the version that was actually reviewed the operations go through, and the server check is still conditional', async () => {
    const { cloud, s, v2 } = await setup()
    cloud.touchCourse(ALICE, C1, { description: 'changed while the source still held v2' }) // not yet refreshed here
    const r = await s.updateCourse(C1, { ...algebra, name: 'Mine' }, v2)
    expect(r).toMatchObject({ ok: false, kind: 'stale' }) // the server's conditional update rejected it
    expect(cloud.courses.get(ALICE)![0].name).toBe('Phone edit')
    await settle()
    const v3 = s.getSnapshot().courses[0].updatedAt
    expect((await s.updateCourse(C1, { ...algebra, name: 'Mine' }, v3)).ok).toBe(true)
    expect(cloud.courses.get(ALICE)![0].name).toBe('Mine')
  })

  it('callers that name no version keep the old behaviour (whatever the source holds now)', async () => {
    const { cloud, s } = await setup()
    expect((await s.updateCourse(C1, { ...algebra, name: 'No form' })).ok).toBe(true)
    expect(cloud.courses.get(ALICE)![0].name).toBe('No form')
  })
})

describe('failures never report success', () => {
  it('offline: not saved, nothing changes, the offline flag is set', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.offline = true
    const r = await s.createCourse(algebra, C1)
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    expect(s.getSnapshot()).toMatchObject({ courses: [], offline: true, pendingWrites: 0 })
    expect(s.getSnapshot().error).toBeTruthy()
    cloud.offline = false
    expect(cloud.courses.get(ALICE) ?? []).toHaveLength(0)
  })

  it('a rejected write (permission) reports its reason and changes nothing', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.failWrites = { error: new CloudError('permission', 'Not allowed. You may be signed out; please sign in again.', '42501'), remaining: 1 }
    const r = await s.updateCourse(C1, { ...algebra, name: 'Nope' })
    expect(r).toMatchObject({ ok: false, kind: 'permission' })
    expect(names(s)).toEqual(['Linear Algebra'])
    expect(cloud.courses.get(ALICE)![0].name).toBe('Linear Algebra')
  })

  it('the server\'s own validation (CHECK constraint) is reported as a validation failure', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.failWrites = { error: new CloudError('validation', 'The server rejected this data as invalid.', '23514'), remaining: 1 }
    expect(await s.createCourse(algebra, C1)).toMatchObject({ ok: false, kind: 'validation' })
    expect(s.getSnapshot().courses).toEqual([])
  })

  it('dismissError clears the message', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.offline = true
    await s.createCourse(algebra, C1)
    expect(s.getSnapshot().error).toBeTruthy()
    s.dismissError()
    expect(s.getSnapshot().error).toBeNull()
  })
})

describe('timeouts (outcome unknown)', () => {
  it('a request that never answers is reported as not saved, and the truth is re-read', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud, ALICE, { timeoutMs: 15 })
    cloud.loseResponses = { mode: 'hang', remaining: 1 } // committed on the server, but the answer never arrives
    const r = await s.createCourse(algebra, C1)
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    await settle()
    // the fresh read shows what the server really holds: the course WAS saved
    expect(ids(s)).toEqual([C1])
    expect(s.getSnapshot().pendingWrites).toBe(0)
  })

  it('a request that never answers and never committed leaves the list empty after the re-read', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud, ALICE, { timeoutMs: 15 })
    cloud.holdResponses()
    const p = s.createCourse(algebra, C1)
    const r = await p
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    const readsBefore = cloud.calls.filter((c) => c.method === 'loadCourses').length
    cloud.releaseResponses() // the held requests now run, late
    await settle()
    expect(cloud.calls.filter((c) => c.method === 'loadCourses').length).toBeGreaterThan(readsBefore - 1)
    // the late insert did commit on the server after the timeout; the next read shows that, and nothing was applied blindly
    await s.refresh()
    expect(ids(s)).toEqual(cloud.courses.get(ALICE)!.map((c) => c.id))
  })

  it('a late answer after the timeout is never applied by itself', async () => {
    const cloud = new FakePlanner()
    const real = cloud.apiFor(ALICE)
    let answer: (() => void) | undefined
    const api: PlannerApi = {
      ...real,
      insertCourse: async (row) => {
        const saved = await real.insertCourse(row)
        return new Promise((res) => (answer = () => res(saved)))
      },
      loadCourses: async () => [], // the re-read happens to show nothing (e.g. replica lag)
    }
    const s = createPlannerSource(api, { userId: ALICE, timeoutMs: 15 })
    await s.refresh()
    const r = await s.createCourse(algebra, C1)
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    answer?.()
    await settle()
    expect(s.getSnapshot().courses).toEqual([]) // only a server read (or a confirmed write) changes the list
  })

  it('after a timeout the same id can be retried safely', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud, ALICE, { timeoutMs: 15 })
    cloud.loseResponses = { mode: 'hang', remaining: 1 }
    expect((await s.createCourse(algebra, C1)).ok).toBe(false)
    const retry = await s.createCourse(algebra, C1)
    expect(retry.ok).toBe(true)
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
  })
})

describe('network errors with an uncertain outcome (the server may have committed)', () => {
  const reads = (c: FakePlanner) => c.calls.filter((x) => x.method === 'loadCourses').length

  it('a committed create whose response was lost is reported as not saved, then appears after the automatic re-read (no manual retry)', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.loseResponses = { mode: 'error', remaining: 1 }
    const r = await s.createCourse(algebra, C1)
    expect(r).toMatchObject({ ok: false, kind: 'network' }) // never claimed as saved
    await settle()
    expect(cloud.courses.get(ALICE)).toHaveLength(1) // it WAS committed
    expect(ids(s)).toEqual([C1]) // and the reconciliation read made it visible
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', pendingWrites: 0, offline: false })
  })

  it('a committed update, archive and delete with lost responses are each reconciled by a re-read', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)

    cloud.loseResponses = { mode: 'error', remaining: 1 }
    expect(await s.updateCourse(C1, { ...algebra, name: 'Renamed' })).toMatchObject({ ok: false, kind: 'network' })
    await settle()
    expect(names(s)).toEqual(['Renamed'])

    cloud.loseResponses = { mode: 'error', remaining: 1 }
    expect(await s.archiveCourse(C1)).toMatchObject({ ok: false, kind: 'network' })
    await settle()
    expect(s.getSnapshot().courses[0].archivedAt).toBeDefined()

    cloud.loseResponses = { mode: 'error', remaining: 1 }
    expect(await s.deleteCourse(C1)).toMatchObject({ ok: false, kind: 'network' })
    await settle()
    expect(s.getSnapshot().courses).toEqual([])
    expect(cloud.courses.get(ALICE)).toEqual([])
  })

  it('after the reconciliation the same save can be retried safely with its id (one row)', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.loseResponses = { mode: 'error', remaining: 1 }
    await s.createCourse(algebra, C1)
    await settle()
    expect((await s.createCourse(algebra, C1)).ok).toBe(true)
    expect(cloud.courses.get(ALICE)).toHaveLength(1)
  })

  it('a genuinely offline failure commits nothing, keeps the last known data, and makes exactly one failing re-read (no retry loop)', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    await settle()
    cloud.offline = true
    const before = reads(cloud)
    const r = await s.updateCourse(C1, { ...algebra, name: 'Offline edit' })
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    await settle()
    expect(reads(cloud)).toBe(before + 1) // one reconciliation attempt
    for (let i = 0; i < 10; i++) await tick()
    expect(reads(cloud)).toBe(before + 1) // ... and nothing keeps retrying in the background
    expect(names(s)).toEqual(['Linear Algebra']) // last known data preserved
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', offline: true })
    cloud.offline = false
    expect(cloud.courses.get(ALICE)![0].name).toBe('Linear Algebra') // nothing was committed
  })

  it('an offline create leaves nothing behind, before or after the reconciliation read', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.offline = true
    expect(await s.createCourse(algebra, C1)).toMatchObject({ ok: false, kind: 'network' })
    await settle()
    cloud.offline = false
    await s.refresh()
    expect(s.getSnapshot().courses).toEqual([])
    expect(cloud.courses.get(ALICE) ?? []).toHaveLength(0)
  })

  it('a lost response during a hold is not applied directly: only the server read decides what is shown', async () => {
    const cloud = new FakePlanner()
    const real = cloud.apiFor(ALICE)
    const api: PlannerApi = { ...real, loadCourses: async () => [] } // the re-read shows nothing (replica lag)
    cloud.loseResponses = { mode: 'error', remaining: 1 }
    const s = createPlannerSource(api, { userId: ALICE })
    await s.refresh()
    const r = await s.createCourse(algebra, C1)
    expect(r.ok).toBe(false)
    await settle()
    expect(s.getSnapshot().courses).toEqual([]) // committed on the server, but nothing is shown from the lost answer itself
  })

  it('sign-out between the lost response and the re-read leaves no data and makes no request', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.loseResponses = { mode: 'error', remaining: 1 }
    const done = s.createCourse(algebra, C1)
    await done
    s.dispose() // the reconciliation read is scheduled but the source is gone
    const before = reads(cloud)
    await settle()
    expect(s.getSnapshot().courses).toEqual([])
    expect(reads(cloud)).toBeLessThanOrEqual(before + 1)
  })

  it('a rejected write that is certain (permission, validation, duplicate) does not trigger a re-read', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    await settle()
    const before = reads(cloud)
    cloud.failWrites = { error: new CloudError('permission', 'Not allowed.', '42501'), remaining: 1 }
    await s.updateCourse(C1, { ...algebra, name: 'x' })
    expect((await s.createCourse({ ...algebra, name: 'dup' }, C2)).ok).toBe(false) // duplicate code
    await settle()
    expect(reads(cloud)).toBe(before)
  })
})

describe('stale edit message', () => {
  it('says the latest version is being refreshed (the refresh is asynchronous) and leaves the server data untouched', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.touchCourse(ALICE, C1, { name: 'Elsewhere' })
    const r = await s.updateCourse(C1, { ...algebra, name: 'Mine' })
    expect(r).toMatchObject({ ok: false, kind: 'stale' })
    expect((r as { error: string }).error).toMatch(/refreshing/i)
    expect((r as { error: string }).error).not.toMatch(/has been loaded/i)
    expect(cloud.courses.get(ALICE)![0].name).toBe('Elsewhere')
  })
})

describe('refresh ordering', () => {
  it('an older read that finishes after a newer successful write never overwrites it', async () => {
    const cloud = new FakePlanner()
    const real = cloud.apiFor(ALICE)
    let finishRead: (() => void) | undefined
    let slow = true
    const api: PlannerApi = {
      ...real,
      loadCourses: async () => {
        const rows = await real.loadCourses() // snapshot of the server at request time
        if (!slow) return rows
        return new Promise((res) => (finishRead = () => res(rows)))
      },
    }
    const s = createPlannerSource(api, { userId: ALICE })
    slow = false
    await s.refresh()
    slow = true
    const reading = s.refresh() // starts reading: sees zero courses
    await settle()
    slow = false
    const w = await s.createCourse(algebra, C1) // completes while the read is still outstanding
    expect(w.ok).toBe(true)
    expect(ids(s)).toEqual([C1])
    finishRead?.() // the stale answer arrives now
    await reading
    await settle()
    expect(ids(s)).toEqual([C1])
  })

  it('a read that overlaps a write is discarded and repeated, ending with the server\'s truth', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.holdResponses()
    const reading = s.refresh()
    const writing = s.createCourse(algebra, C1)
    await settle()
    cloud.releaseResponses()
    await Promise.all([reading, writing])
    await settle()
    expect(ids(s)).toEqual([C1])
    expect(s.getSnapshot().status).toBe('ready')
  })

  it('concurrent refreshes share one in-flight read plus at most one repeat', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'A' })
    const s = createPlannerSource(cloud.apiFor(ALICE), { userId: ALICE })
    const all = Promise.all([s.refresh(), s.refresh(), s.refresh(), s.refresh()])
    await all
    expect(cloud.calls.filter((c) => c.method === 'loadCourses').length).toBeLessThanOrEqual(2)
    expect(ids(s)).toEqual([C1])
    expect(s.getSnapshot().status).toBe('ready')
  })

  it('refresh never rejects, even when the server fails', async () => {
    const cloud = new FakePlanner()
    const s = createPlannerSource(cloud.apiFor(ALICE), { userId: ALICE })
    cloud.failReads = { error: new CloudError('unknown', 'boom'), remaining: 5 }
    await expect(s.refresh()).resolves.toBeUndefined()
  })

  it('picks up changes made on another device', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.seedCourse(ALICE, { id: C1, name: 'From my phone' })
    await s.refresh()
    expect(names(s)).toEqual(['From my phone'])
  })

  it('a stale-write rejection and a failed refresh leave the last good data visible', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    await s.createCourse(algebra, C1)
    cloud.offline = true
    await s.refresh()
    expect(names(s)).toEqual(['Linear Algebra'])
    expect(s.getSnapshot().offline).toBe(true)
  })
})

describe('disposal (sign-out)', () => {
  it('clears every private record, empties the snapshot and stops notifying', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'Private course' })
    const s = await open(cloud)
    let notified = 0
    s.subscribe(() => notified++)
    s.dispose()
    expect(s.getSnapshot()).toMatchObject({ courses: [], status: 'loading', error: null, userId: ALICE })
    expect(JSON.stringify(s.getSnapshot())).not.toContain('Private course')
    await s.refresh()
    expect(notified).toBe(0)
  })

  it('a disposed source ignores late read responses', async () => {
    const cloud = new FakePlanner()
    cloud.seedCourse(ALICE, { id: C1, name: 'Private course' })
    const s = createPlannerSource(cloud.apiFor(ALICE), { userId: ALICE })
    cloud.holdResponses()
    const reading = s.refresh()
    await settle()
    s.dispose()
    cloud.releaseResponses()
    await reading
    await settle()
    expect(s.getSnapshot().courses).toEqual([])
    expect(s.getSnapshot().status).toBe('loading')
  })

  it('a disposed source refuses writes, and a write in flight at disposal reports signed-out and applies nothing', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.holdResponses()
    const inFlight = s.createCourse(algebra, C1)
    await settle()
    s.dispose()
    cloud.releaseResponses()
    expect(await inFlight).toMatchObject({ ok: false, kind: 'auth' })
    expect(s.getSnapshot().courses).toEqual([])
    expect(await s.createCourse(algebra, C2)).toMatchObject({ ok: false, kind: 'auth' })
    expect(await s.deleteCourse(C1)).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('writes queued behind an in-flight write do not run after disposal', async () => {
    const cloud = new FakePlanner()
    const s = await open(cloud)
    cloud.holdResponses()
    const first = s.createCourse(algebra, C1)
    const second = s.createCourse({ ...algebra, code: 'X 2', name: 'Two' }, C2)
    await settle()
    s.dispose()
    cloud.releaseResponses()
    expect((await first).ok).toBe(false)
    expect((await second).ok).toBe(false)
    expect(cloud.calls.filter((c) => c.method === 'insertCourse')).toHaveLength(1) // the queued one never reached the server
  })
})

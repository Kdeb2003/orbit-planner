import { describe, expect, it, vi } from 'vitest'
import type { CloudApi } from '../cloud/cloudApi'
import { FakeCloud } from '../cloud/fakeCloudApi'
import { eventToWrite, seriesToWrite } from '../cloud/mappers'
import { CloudError } from '../cloud/types'
import type { EventInput, SeriesInput } from '../types'
import { resolveOccurrence } from '../utils/recurrence'
import { startAutoRefresh } from './autoRefresh'
import { createCalendarManager } from './calendarManager'
import { createCloudSource } from './cloudSource'
import { subscribeRealtime } from './realtime'

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const E1 = '11111111-1111-4111-8111-111111111111'
const E2 = '22222222-2222-4222-8222-222222222222'
const S1 = '33333333-3333-4333-8333-333333333333'

const eventInput: EventInput = {
  title: 'Lecture',
  category: 'university',
  start: '2026-10-12T07:00:00.000Z',
  end: '2026-10-12T08:30:00.000Z',
  timeZone: 'Europe/Berlin',
  location: 'Room 1',
}
const seriesInput: SeriesInput = {
  title: 'Maths',
  category: 'university',
  timeZone: 'Europe/Berlin',
  recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-12', untilDate: '2026-12-14' },
  startTime: '09:00',
  endTime: '10:30',
  endDayOffset: 0,
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick()
}
async function open(cloud: FakeCloud, user = ALICE, extra: Partial<Parameters<typeof createCloudSource>[1]> = {}) {
  const source = createCloudSource(cloud.apiFor(user), { userId: user, ...extra })
  await source.refresh()
  return source
}
const ids = (s: { getSnapshot(): { events: readonly { id: string }[] } }) => s.getSnapshot().events.map((e) => e.id).sort()

describe('loading', () => {
  it('starts in loading, then shows only this user\'s data, with exceptions attached to their series', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(ALICE, { ...eventToWrite(eventInput, E1), user_id: undefined } as never)
    cloud.seedEvent(BOB, { ...eventToWrite({ ...eventInput, title: 'Bobs secret' }, E2), user_id: undefined } as never)
    const seriesRow = cloud.seedSeries(ALICE, { ...seriesToWrite(seriesInput, S1) } as never)
    cloud.exceptions.set(ALICE, [{ series_id: seriesRow.id, original_date: '2026-10-19', cancelled: true, override: null, created_at: '', updated_at: '' }])

    const source = createCloudSource(cloud.apiFor(ALICE), { userId: ALICE })
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', mode: 'cloud', events: [] })
    await source.refresh()
    const snap = source.getSnapshot()
    expect(snap.status).toBe('ready')
    expect(snap.events.map((e) => e.title)).toEqual(['Lecture'])
    expect(snap.series[0].exceptions).toEqual([{ originalDate: '2026-10-19', cancelled: true }])
    expect(snap.lastSyncedAt).not.toBeNull()
    expect(JSON.stringify(snap)).not.toContain('Bobs secret')
  })

  it('an empty calendar is a successful, empty result', async () => {
    const s = await open(new FakeCloud())
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', events: [], series: [], error: null })
  })

  it('a failed first load is an error state, not an empty calendar; retry recovers', async () => {
    const cloud = new FakeCloud()
    cloud.offline = true
    const s = await open(cloud)
    expect(s.getSnapshot()).toMatchObject({ status: 'error', offline: true })
    cloud.offline = false
    await s.refresh()
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', offline: false, error: null })
  })

  it('a failed background refresh keeps the last good data and reports it', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(ALICE, eventToWrite(eventInput, E1) as never)
    const s = await open(cloud)
    cloud.offline = true
    await s.refresh()
    expect(s.getSnapshot()).toMatchObject({ status: 'ready', offline: true })
    expect(s.getSnapshot().events).toHaveLength(1)
    expect(s.getSnapshot().error).toMatch(/Offline/)
  })

  it('hides (and counts) rows that fail local validation instead of crashing', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(ALICE, { ...eventToWrite(eventInput, E1), category: 'bogus' } as never)
    const s = await open(cloud)
    expect(s.getSnapshot()).toMatchObject({ events: [], skippedInvalid: 1 })
  })

  it('reads every page of results is the API\'s job; the source de-duplicates concurrent refreshes', async () => {
    const cloud = new FakeCloud()
    const s = createCloudSource(cloud.apiFor(ALICE), { userId: ALICE })
    await Promise.all([s.refresh(), s.refresh(), s.refresh()])
    expect(cloud.calls.filter((c) => c.method === 'loadEvents').length).toBeLessThanOrEqual(2) // one read, plus at most one queued re-read
  })
})

describe('event writes', () => {
  it('create: pending while in flight, then saved from the server\'s row', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    cloud.holdResponses()
    const p = s.createEvent(eventInput, E1)
    await tick()
    expect(s.getSnapshot().pendingWrites).toBe(1)
    expect(s.getSnapshot().events).toHaveLength(0) // nothing shown as saved yet
    cloud.releaseResponses()
    expect(await p).toEqual({ ok: true })
    expect(s.getSnapshot().pendingWrites).toBe(0)
    expect(ids(s)).toEqual([E1])
    expect(s.getSnapshot().events[0].updatedAt).toMatch(/\+00:00$/) // server timestamp, not the client's
  })

  it('create is idempotent per id: a retried save never duplicates', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    expect(await s.createEvent(eventInput, E1)).toEqual({ ok: true })
    expect(await s.createEvent(eventInput, E1)).toEqual({ ok: true }) // e.g. the first response was lost
    await settle()
    expect(cloud.events.get(ALICE)).toHaveLength(1)
    expect(ids(s)).toEqual([E1])
  })

  it('a failed write is reported, shows nothing as saved, and can be retried', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    cloud.offline = true
    const r = await s.createEvent(eventInput, E1)
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    expect(s.getSnapshot()).toMatchObject({ events: [], pendingWrites: 0, offline: true })
    expect(s.getSnapshot().error).toMatch(/not saved/)
    cloud.offline = false
    expect(await s.createEvent(eventInput, E1)).toEqual({ ok: true })
    expect(ids(s)).toEqual([E1])
  })

  it('a rejected write (server error) is surfaced with its kind and leaves data unchanged', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    await s.createEvent(eventInput, E1)
    cloud.failWrites = { error: new CloudError('permission', 'Not allowed.', '42501'), remaining: 1 }
    const r = await s.updateEvent(E1, { ...eventInput, title: 'Changed' })
    expect(r).toMatchObject({ ok: false, kind: 'permission' })
    expect(s.getSnapshot().events[0].title).toBe('Lecture')
    expect(s.getSnapshot().error).toBe('Not allowed.')
  })

  it('invalid data is rejected before any network call', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    const before = cloud.calls.length
    expect(await s.createEvent({ ...eventInput, title: 'x'.repeat(121) }, E1)).toMatchObject({ ok: false, kind: 'validation' })
    expect(await s.createEvent({ ...eventInput, timeZone: 'Nope/Zone' }, E1)).toMatchObject({ ok: false, kind: 'validation' })
    expect(await s.createSeries({ ...seriesInput, startTime: '15:00', endTime: '10:00' }, S1)).toMatchObject({ ok: false, kind: 'validation' })
    expect(cloud.calls.length).toBe(before)
  })

  it('an invalid (non-UUID) id is rejected by the server and reported', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    expect(await s.createEvent(eventInput, 'not-a-uuid')).toMatchObject({ ok: false, kind: 'validation' })
    expect(s.getSnapshot().events).toHaveLength(0)
  })

  it('update and delete work and use the latest version', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    await s.createEvent(eventInput, E1)
    expect(await s.updateEvent(E1, { ...eventInput, title: 'Renamed', location: undefined })).toEqual({ ok: true })
    expect(s.getSnapshot().events[0]).toMatchObject({ title: 'Renamed' })
    expect(s.getSnapshot().events[0]).not.toHaveProperty('location')
    expect(await s.updateEvent(E1, { ...eventInput, title: 'Again' })).toEqual({ ok: true }) // second edit uses the new version
    expect(await s.removeEvent(E1)).toEqual({ ok: true })
    expect(s.getSnapshot().events).toEqual([])
    expect(cloud.events.get(ALICE)).toEqual([])
  })

  it('concurrent edits from two devices: the stale edit is rejected, nothing is overwritten', async () => {
    const cloud = new FakeCloud()
    const phone = await open(cloud)
    await phone.createEvent(eventInput, E1)
    const laptop = await open(cloud) // second device, same account
    // laptop edits first
    expect(await laptop.updateEvent(E1, { ...eventInput, title: 'From laptop' })).toEqual({ ok: true })
    // phone still holds the old version and tries to save
    const r = await phone.updateEvent(E1, { ...eventInput, title: 'From phone' })
    expect(r).toMatchObject({ ok: false, kind: 'conflict' })
    expect(r.ok === false && r.error).toMatch(/another device/)
    await settle()
    expect(cloud.events.get(ALICE)![0].title).toBe('From laptop') // laptop's edit survived
    expect(phone.getSnapshot().events[0].title).toBe('From laptop') // phone reloaded the latest
    // deleting a stale version is also refused
    cloud.touchEvent(ALICE, E1, { title: 'Edited elsewhere again' })
    expect(await phone.removeEvent(E1)).toMatchObject({ ok: false, kind: 'conflict' })
    expect(cloud.events.get(ALICE)).toHaveLength(1)
  })

  it('writes are applied in order', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    const order: string[] = []
    await Promise.all([
      s.createEvent(eventInput, E1).then(() => order.push('a')),
      s.createEvent({ ...eventInput, title: 'Second' }, E2).then(() => order.push('b')),
    ])
    expect(order).toEqual(['a', 'b'])
    expect(ids(s)).toEqual([E1, E2])
  })

  it('a hung request times out as "not confirmed" and the calendar is re-read', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud, ALICE, { timeoutMs: 20 })
    cloud.holdResponses()
    const r = await s.createEvent(eventInput, E1)
    expect(r).toMatchObject({ ok: false, kind: 'network' })
    expect(r.ok === false && r.error).toMatch(/may not have been saved/)
    cloud.releaseResponses()
  })
})

describe('series and exceptions', () => {
  async function withSeries() {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    await s.createSeries(seriesInput, S1)
    return { cloud, s }
  }

  it('series create / update / delete', async () => {
    const { cloud, s } = await withSeries()
    expect(s.getSnapshot().series[0]).toMatchObject({ id: S1, title: 'Maths', startTime: '09:00' })
    expect(await s.updateSeries(S1, { ...seriesInput, startTime: '10:00', endTime: '11:30' }, [])).toEqual({ ok: true })
    expect(s.getSnapshot().series[0]).toMatchObject({ startTime: '10:00', endTime: '11:30' })
    expect(await s.removeSeries(S1)).toEqual({ ok: true })
    expect(cloud.series.get(ALICE)).toEqual([])
  })

  it('cancel, move, edit, restore: exceptions keep their stable occurrence identity', async () => {
    const { s } = await withSeries()
    await s.setException(S1, { originalDate: '2026-10-19', cancelled: true })
    await s.setException(S1, { originalDate: '2026-10-26', override: { start: '2026-10-27T13:00:00.000Z', end: '2026-10-27T14:30:00.000Z', location: 'Hall' } })
    const series = s.getSnapshot().series[0]
    expect(series.exceptions.map((e) => e.originalDate)).toEqual(['2026-10-19', '2026-10-26'])
    const moved = resolveOccurrence(series, '2026-10-26')
    expect(moved).toMatchObject({ id: `${S1}:2026-10-26`, originalDate: '2026-10-26', start: '2026-10-27T13:00:00.000Z', location: 'Hall', modified: true })
    expect(resolveOccurrence(series, '2026-10-19').cancelled).toBe(true)

    // replacing an exception keeps one row per occurrence (no duplicates)
    await s.setException(S1, { originalDate: '2026-10-19', override: { title: 'Exam' } })
    expect(s.getSnapshot().series[0].exceptions.filter((e) => e.originalDate === '2026-10-19')).toHaveLength(1)

    // restore / reset
    expect(await s.clearException(S1, '2026-10-19')).toEqual({ ok: true })
    expect(await s.clearException(S1, '2026-10-26')).toEqual({ ok: true })
    expect(s.getSnapshot().series[0].exceptions).toEqual([])
  })

  it('refuses invalid exceptions locally and for unknown series', async () => {
    const { s } = await withSeries()
    expect(await s.setException(S1, { originalDate: '2026-10-19', override: {} })).toMatchObject({ ok: false, kind: 'validation' })
    expect(await s.setException('99999999-9999-4999-8999-999999999999', { originalDate: '2026-10-19', cancelled: true })).toMatchObject({ ok: false })
  })

  it('shrinking a series removes only the exceptions the user agreed to drop (orphans), after saving the series', async () => {
    const { cloud, s } = await withSeries()
    await s.setException(S1, { originalDate: '2026-10-19', cancelled: true })
    await s.setException(S1, { originalDate: '2026-12-07', cancelled: true })
    const shorter = { ...seriesInput, recurrence: { ...seriesInput.recurrence, untilDate: '2026-11-30' } }
    // user confirmed that the December exception may go
    expect(await s.updateSeries(S1, shorter, [{ originalDate: '2026-10-19', cancelled: true }])).toEqual({ ok: true })
    await settle()
    expect(cloud.exceptions.get(ALICE)!.map((x) => x.original_date)).toEqual(['2026-10-19'])
    // without confirmation (kept = everything) the orphan is retained, never silently deleted
    await s.setException(S1, { originalDate: '2026-12-14', cancelled: true })
    expect(await s.updateSeries(S1, shorter, s.getSnapshot().series[0].exceptions)).toEqual({ ok: true })
    expect(cloud.exceptions.get(ALICE)!.map((x) => x.original_date)).toContain('2026-12-14')
  })

  it('if removing exceptions fails after the series was saved, it says so (no false success)', async () => {
    const cloud = new FakeCloud()
    const real = cloud.apiFor(ALICE)
    const api: CloudApi = { ...real, deleteException: async () => { throw new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network') } }
    const s = createCloudSource(api, { userId: ALICE })
    await s.refresh()
    await s.createSeries(seriesInput, S1)
    await s.setException(S1, { originalDate: '2026-10-19', cancelled: true })
    const r = await s.updateSeries(S1, { ...seriesInput, title: 'Renamed' }, [])
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.error).toMatch(/outdated exception/)
    expect(cloud.series.get(ALICE)![0].title).toBe('Renamed') // the schedule itself WAS saved
    expect(cloud.exceptions.get(ALICE)).toHaveLength(1) // and the exception was not lost
  })
})

describe('stale responses and account safety', () => {
  it('a read that started before a write finished never overwrites newer data', async () => {
    const cloud = new FakeCloud()
    const real = cloud.apiFor(ALICE)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let first = true
    const api: CloudApi = {
      ...real,
      loadEvents: async () => {
        const snapshot = await real.loadEvents() // taken NOW (before the write)
        if (first) {
          first = false
          await gate // …but delivered late
        }
        return snapshot
      },
    }
    const s = createCloudSource(api, { userId: ALICE })
    const counts: number[] = []
    s.subscribe(() => counts.push(s.getSnapshot().events.length))
    const stale = s.refresh() // slow read begins with an empty calendar
    await tick()
    await s.createEvent(eventInput, E1) // write completes meanwhile
    release()
    await stale
    await settle()
    expect(ids(s)).toEqual([E1]) // the late, empty read did not wipe the new event
    // …and it never even flashed back to empty: once the saved event is visible it stays visible
    const firstShown = counts.indexOf(1)
    expect(firstShown).toBeGreaterThanOrEqual(0)
    expect(counts.slice(firstShown).every((n) => n === 1)).toBe(true)
  })

  it('a disposed (signed-out) source ignores late responses and refuses writes', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(ALICE, eventToWrite(eventInput, E1) as never)
    const s = createCloudSource(cloud.apiFor(ALICE), { userId: ALICE })
    cloud.holdResponses()
    const load = s.refresh()
    const listener = vi.fn()
    s.subscribe(listener)
    s.dispose()
    cloud.releaseResponses()
    await load
    expect(listener).not.toHaveBeenCalled()
    expect(s.getSnapshot().events).toEqual([]) // private data dropped from memory
    expect(await s.createEvent(eventInput, E2)).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('users are isolated: one account cannot read or change another account\'s rows', async () => {
    const cloud = new FakeCloud()
    const alice = await open(cloud, ALICE)
    await alice.createEvent(eventInput, E1)
    const bob = await open(cloud, BOB)
    expect(bob.getSnapshot().events).toEqual([])
    // Bob's client doesn't even see Alice's id; an attempted update is treated as "changed/vanished"
    expect(await bob.updateEvent(E1, { ...eventInput, title: 'hacked' })).toMatchObject({ ok: false })
    expect(cloud.events.get(ALICE)![0].title).toBe('Lecture')
    const aliceApi = cloud.apiFor(ALICE)
    expect(await cloud.apiFor(BOB).updateEvent(E1, { title: 'x' } as never, (await aliceApi.loadEvents())[0].updated_at)).toBeNull()
    expect(await cloud.apiFor(BOB).deleteEvent(E1, (await aliceApi.loadEvents())[0].updated_at)).toBe(false)
  })

  it('exceptions of a series you do not own are refused', async () => {
    const cloud = new FakeCloud()
    const alice = await open(cloud, ALICE)
    await alice.createSeries(seriesInput, S1)
    await expect(cloud.apiFor(BOB).upsertException({ series_id: S1, original_date: '2026-10-19', cancelled: true, override: null })).rejects.toMatchObject({ kind: 'permission' })
  })
})

describe('calendar manager: sign-in, sign-out and account switching', () => {
  const make = (cloud: FakeCloud) => createCalendarManager({ createApi: (id) => cloud.apiFor(id), autoRefresh: () => () => {} })

  it('creates a session on sign-in and drops all private data on sign-out', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(ALICE, eventToWrite(eventInput, E1) as never)
    const m = make(cloud)
    expect(m.getSnapshot()).toBeNull()
    m.setUser(ALICE)
    const session = m.getSnapshot()!
    await settle()
    expect(session.source.getSnapshot().events).toHaveLength(1)
    m.setUser(null)
    expect(m.getSnapshot()).toBeNull()
    expect(session.source.getSnapshot().events).toEqual([]) // cleared from memory
  })

  it('switching accounts never shows the previous account\'s data, even with late responses', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(ALICE, { ...eventToWrite({ ...eventInput, title: 'Alice private' }, E1) } as never)
    cloud.seedEvent(BOB, { ...eventToWrite({ ...eventInput, title: 'Bob private' }, E2) } as never)
    const m = make(cloud)
    cloud.holdResponses()
    m.setUser(ALICE) // Alice's read is in flight…
    const aliceSource = m.getSnapshot()!.source
    m.setUser(BOB) // …when Bob signs in on the same browser
    const bobSource = m.getSnapshot()!.source
    expect(bobSource.userId).toBe(BOB)
    cloud.releaseResponses()
    await settle()
    expect(JSON.stringify(bobSource.getSnapshot())).not.toContain('Alice private')
    expect(bobSource.getSnapshot().events.map((e) => e.title)).toEqual(['Bob private'])
    expect(aliceSource.getSnapshot().events).toEqual([])
  })

  it('setting the same user again keeps the session (no duplicate sessions)', async () => {
    const m = make(new FakeCloud())
    m.setUser(ALICE)
    const a = m.getSnapshot()
    m.setUser(ALICE)
    expect(m.getSnapshot()).toBe(a)
  })

  it('yields no session when no API is available', () => {
    const m = createCalendarManager({ createApi: () => null, autoRefresh: () => () => {} })
    m.setUser(ALICE)
    expect(m.getSnapshot()).toBeNull()
  })
})

describe('refreshing', () => {
  it('another device\'s changes appear after a refresh, without signing out', async () => {
    const cloud = new FakeCloud()
    const s = await open(cloud)
    expect(s.getSnapshot().events).toEqual([])
    cloud.seedEvent(ALICE, eventToWrite({ ...eventInput, title: 'Added on phone' }, E2) as never)
    await s.refresh()
    expect(s.getSnapshot().events.map((e) => e.title)).toEqual(['Added on phone'])
    cloud.touchEvent(ALICE, E2, { title: 'Renamed on phone' })
    await s.refresh()
    expect(s.getSnapshot().events[0].title).toBe('Renamed on phone')
  })

  it('auto-refresh fires on focus / visibility / online / poll, not while hidden, and is rate limited', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn(async () => {})
      const listeners = new Map<string, () => void>()
      const target = {
        addEventListener: (t: string, f: () => void) => listeners.set(t, f),
        removeEventListener: (t: string) => listeners.delete(t),
      }
      let clock = 1_000_000
      const doc = { ...target, visibilityState: 'visible' as DocumentVisibilityState }
      const stop = startAutoRefresh({ refresh }, { win: target, doc, now: () => clock, pollMs: 60_000, minGapMs: 2_000 })
      clock += 5_000
      listeners.get('focus')!()
      expect(refresh).toHaveBeenCalledTimes(1)
      listeners.get('focus')!() // immediately again: rate limited
      expect(refresh).toHaveBeenCalledTimes(1)
      clock += 5_000
      listeners.get('online')!()
      expect(refresh).toHaveBeenCalledTimes(2)
      clock += 5_000
      listeners.get('visibilitychange')!()
      expect(refresh).toHaveBeenCalledTimes(3)
      doc.visibilityState = 'hidden'
      clock += 5_000
      listeners.get('focus')!()
      expect(refresh).toHaveBeenCalledTimes(3) // hidden tabs do not poll
      doc.visibilityState = 'visible'
      clock += 61_000
      vi.advanceTimersByTime(60_000) // poll tick
      expect(refresh).toHaveBeenCalledTimes(4)
      stop()
      expect(listeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('realtime (optional) triggers a debounced re-read and cleans up', () => {
    vi.useFakeTimers()
    try {
      const handlers: (() => void)[] = []
      const channel = { on: vi.fn((_t: string, _f: unknown, cb: () => void) => { handlers.push(cb); return channel }), subscribe: vi.fn(() => channel) }
      const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(async () => 'ok') }
      const onChange = vi.fn()
      const stop = subscribeRealtime(client as never, ALICE, onChange, 100)
      expect(handlers).toHaveLength(3) // events, recurring_series, series_exceptions
      handlers[0]()
      handlers[1]()
      handlers[2]()
      vi.advanceTimersByTime(99)
      expect(onChange).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(onChange).toHaveBeenCalledTimes(1) // three rapid changes -> one refresh
      stop()
      expect(client.removeChannel).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('realtime setup errors are swallowed (polling remains)', () => {
    const client = { channel: () => { throw new Error('no websocket') }, removeChannel: vi.fn() }
    expect(() => subscribeRealtime(client as never, ALICE, () => {})()).not.toThrow()
  })
})

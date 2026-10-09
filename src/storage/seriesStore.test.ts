import { describe, expect, it, vi } from 'vitest'
import type { EventInput, SeriesInput } from '../types'
import { createEventStore, STORAGE_KEY } from './eventStore'
import { createSaveStatus } from './saveStatus'
import type { StorageLike } from './collection'
import { createSeriesStore, SERIES_STORAGE_KEY, sanitizeSeries } from './seriesStore'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

const input: SeriesInput = {
  title: 'Maths',
  category: 'university',
  timeZone: 'Europe/Berlin',
  recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-03-02', untilDate: '2026-04-27' },
  startTime: '09:00',
  endTime: '10:30',
  endDayOffset: 0,
}

function makeStore(storage: StorageLike | null, status = createSaveStatus()) {
  let n = 0
  let t = 0
  return createSeriesStore(storage, () => `s-${++n}`, () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t)), status)
}

describe('seriesStore CRUD', () => {
  it('creates, updates (keeping exceptions), and removes a series', () => {
    const store = makeStore(memoryStorage())
    const s = store.create(input)
    expect(s.exceptions).toEqual([])
    store.setException(s.id, { originalDate: '2026-03-09', cancelled: true })
    const updated = store.update(s.id, { ...input, title: 'Algebra' })
    expect(updated?.title).toBe('Algebra')
    expect(updated?.exceptions).toHaveLength(1)
    expect(updated?.createdAt).toBe(s.createdAt)
    expect(store.remove(s.id)).toBe(true)
    expect(store.getSnapshot()).toEqual([])
    expect(store.remove(s.id)).toBe(false)
  })

  it('cancels, replaces and restores occurrences via exceptions', () => {
    const store = makeStore(memoryStorage())
    const s = store.create(input)
    store.setException(s.id, { originalDate: '2026-03-09', cancelled: true })
    store.setException(s.id, { originalDate: '2026-03-09', override: { title: 'Exam' } })
    expect(store.getSnapshot()[0].exceptions).toEqual([{ originalDate: '2026-03-09', override: { title: 'Exam' } }])
    store.clearException(s.id, '2026-03-09')
    expect(store.getSnapshot()[0].exceptions).toEqual([])
  })

  it('persists across store instances', () => {
    const storage = memoryStorage()
    const s = makeStore(storage).create(input)
    makeStore(storage).setException(s.id, { originalDate: '2026-03-09', cancelled: true })
    const reloaded = makeStore(storage).getSnapshot()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].exceptions[0].cancelled).toBe(true)
  })

  it('stores one record per series, not one per occurrence', () => {
    const storage = memoryStorage()
    makeStore(storage).create({ ...input, recurrence: { ...input.recurrence, untilDate: '2028-12-31' } })
    expect(JSON.parse(storage.data[SERIES_STORAGE_KEY])).toHaveLength(1)
  })
})

describe('compatibility with Phase 2A events', () => {
  const oldEvent: EventInput & { id: string; createdAt: string; updatedAt: string } = {
    id: 'e1',
    title: 'Old event',
    category: 'personal',
    start: '2026-10-09T08:00:00.000Z',
    end: '2026-10-09T09:00:00.000Z',
    timeZone: 'Europe/Berlin',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }

  it('loads existing events untouched and never rewrites their key when series change', () => {
    const raw = JSON.stringify([oldEvent])
    const storage = memoryStorage({ [STORAGE_KEY]: raw })
    const events = createEventStore(storage)
    expect(events.getSnapshot()).toEqual([oldEvent])

    const series = makeStore(storage)
    const s = series.create(input)
    series.setException(s.id, { originalDate: '2026-03-09', cancelled: true })
    series.remove(s.id)
    expect(storage.data[STORAGE_KEY]).toBe(raw)
  })

  it('works when only the old key exists (no series key yet)', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify([oldEvent]) })
    expect(makeStore(storage).getSnapshot()).toEqual([])
  })
})

describe('validation of stored series', () => {
  const good = { ...input, id: 'a', exceptions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

  it('accepts a valid record', () => {
    expect(sanitizeSeries(good)?.lossy).toBe(false)
  })

  it('rejects structurally invalid series', () => {
    expect(sanitizeSeries(null)).toBeNull()
    expect(sanitizeSeries({ ...good, category: 'bogus' })).toBeNull()
    expect(sanitizeSeries({ ...good, startTime: '25:00' })).toBeNull()
    expect(sanitizeSeries({ ...good, endDayOffset: 9 })).toBeNull()
    expect(sanitizeSeries({ ...good, recurrence: { ...good.recurrence, weekdays: [] } })).toBeNull()
    expect(sanitizeSeries({ ...good, recurrence: { ...good.recurrence, weekdays: [7] } })).toBeNull()
    expect(sanitizeSeries({ ...good, recurrence: { ...good.recurrence, untilDate: '2026-01-01' } })).toBeNull()
    expect(sanitizeSeries({ ...good, exceptions: 'nope' })).toBeNull()
  })

  it('keeps a series but drops bad exceptions, flagged as lossy', () => {
    const r = sanitizeSeries({
      ...good,
      exceptions: [
        { originalDate: '2026-03-09', cancelled: true },
        { originalDate: 'garbage' },
        { originalDate: '2026-03-16', override: { start: '2026-03-16T08:00:00.000Z' } }, // start without end
        { originalDate: '2026-03-09', cancelled: true }, // duplicate
      ],
    })
    expect(r?.item.exceptions).toEqual([{ originalDate: '2026-03-09', cancelled: true }])
    expect(r?.lossy).toBe(true)
  })

  it('backs up the raw series data once when records had to be dropped, and still loads the rest', () => {
    const raw = JSON.stringify([good, { id: 'bad' }])
    const storage = memoryStorage({ [SERIES_STORAGE_KEY]: raw })
    const store = makeStore(storage)
    expect(store.getSnapshot().map((s) => s.id)).toEqual(['a'])
    expect(storage.data[`${SERIES_STORAGE_KEY}.backup`]).toBe(raw)
  })

  it('treats corrupt JSON as empty and keeps a backup', () => {
    const storage = memoryStorage({ [SERIES_STORAGE_KEY]: '{oops' })
    expect(makeStore(storage).getSnapshot()).toEqual([])
    expect(storage.data[`${SERIES_STORAGE_KEY}.backup`]).toBe('{oops')
  })
})

describe('cross-tab updates', () => {
  it('another instance sees changes after reload() and listeners fire', () => {
    const storage = memoryStorage()
    const tabA = makeStore(storage)
    const tabB = makeStore(storage)
    const listener = vi.fn()
    tabB.subscribe(listener)
    tabA.create(input)
    expect(tabB.getSnapshot()).toHaveLength(0) // stale until the storage event arrives
    tabB.reload()
    expect(tabB.getSnapshot()).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('save failures are reported', () => {
  it('reports an error when the write fails and clears it after a successful write', () => {
    let fail = true
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        if (fail) throw new Error('quota')
      },
    }
    const status = createSaveStatus()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = makeStore(storage, status)
    store.create(input)
    expect(status.getSnapshot()).toMatch(/Could not save/)
    fail = false
    store.create(input)
    expect(status.getSnapshot()).toBeNull()
    spy.mockRestore()
  })

  it('reports when storage is unavailable', () => {
    const status = createSaveStatus()
    makeStore(null, status).create(input)
    expect(status.getSnapshot()).toMatch(/unavailable/)
  })
})

describe('no-op exceptions (same rule as the database)', () => {
  const base = { ...input, id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

  it('drops exceptions that neither cancel nor change anything, keeps cancellations and real changes', () => {
    const r = sanitizeSeries({
      ...base,
      exceptions: [
        { originalDate: '2026-03-02', override: {} },
        { originalDate: '2026-03-09' },
        { originalDate: '2026-03-16', cancelled: false, override: {} },
        { originalDate: '2026-03-23', cancelled: true, override: {} },
        { originalDate: '2026-03-30', override: { location: '' } },
      ],
    })
    expect(r?.item.exceptions).toEqual([
      { originalDate: '2026-03-23', cancelled: true },
      { originalDate: '2026-03-30', override: { location: '' } },
    ])
    expect(r?.lossy).toBe(true)
  })
})

describe('university metadata validation', () => {
  const good = { ...input, id: 'a', exceptions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

  it('keeps valid metadata on series and overrides', () => {
    const r = sanitizeSeries({
      ...good,
      courseCode: 'CS201',
      sessionType: 'practical',
      groupLabel: 'Group B',
      exceptions: [{ originalDate: '2026-03-09', override: { sessionType: '', courseCode: 'CS202' } }],
    })
    expect(r?.lossy).toBe(false)
    expect(r?.item).toMatchObject({ courseCode: 'CS201', sessionType: 'practical', groupLabel: 'Group B' })
    expect(r?.item.exceptions[0].override).toEqual({ sessionType: '', courseCode: 'CS202' })
  })

  it('rejects an unknown session type on a series and drops it on an override', () => {
    expect(sanitizeSeries({ ...good, sessionType: 'lecture-ish' })).toBeNull()
    const r = sanitizeSeries({ ...good, exceptions: [{ originalDate: '2026-03-09', override: { sessionType: 'bogus' } }] })
    expect(r?.item.exceptions).toEqual([])
    expect(r?.lossy).toBe(true)
  })

  it('old records without metadata still load', () => {
    expect(sanitizeSeries(good)?.item.courseCode).toBeUndefined()
  })
})

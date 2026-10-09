import { describe, expect, it, vi } from 'vitest'
import type { EventInput } from '../types'
import { createEventStore, parseStoredEvents, STORAGE_KEY } from './eventStore'
import type { StorageLike } from './eventStore'

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

const input: EventInput = {
  title: 'Lecture',
  category: 'university',
  start: '2026-10-09T08:00:00.000Z',
  end: '2026-10-09T09:30:00.000Z',
  timeZone: 'Europe/Berlin',
}

function makeStore(storage: StorageLike | null) {
  let n = 0
  let t = 0
  return createEventStore(storage, () => `id-${++n}`, () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t)))
}

describe('eventStore CRUD', () => {
  it('creates, updates, and removes events', () => {
    const store = makeStore(memoryStorage())
    const created = store.create(input)
    expect(created.id).toBe('id-1')
    expect(store.getSnapshot()).toHaveLength(1)

    const updated = store.update(created.id, { ...input, title: 'Seminar' })
    expect(updated?.title).toBe('Seminar')
    expect(updated?.createdAt).toBe(created.createdAt)
    expect(updated?.updatedAt).not.toBe(created.updatedAt)

    expect(store.remove(created.id)).toBe(true)
    expect(store.remove(created.id)).toBe(false)
    expect(store.getSnapshot()).toHaveLength(0)
  })

  it('returns undefined when updating a missing event', () => {
    expect(makeStore(memoryStorage()).update('nope', input)).toBeUndefined()
  })

  it('persists across store instances (page refresh)', () => {
    const storage = memoryStorage()
    makeStore(storage).create(input)
    const reloaded = makeStore(storage)
    expect(reloaded.getSnapshot()).toHaveLength(1)
    expect(reloaded.getSnapshot()[0].title).toBe('Lecture')
  })

  it('notifies subscribers and gives a new snapshot reference on change', () => {
    const store = makeStore(memoryStorage())
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const before = store.getSnapshot()
    store.create(input)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).not.toBe(before)
    unsubscribe()
    store.create(input)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('works in memory when storage is unavailable', () => {
    const store = makeStore(null)
    store.create(input)
    expect(store.getSnapshot()).toHaveLength(1)
  })
})

describe('invalid storage data', () => {
  it('returns [] for corrupt JSON and keeps a backup', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: '{not json' })
    const store = makeStore(storage)
    expect(store.getSnapshot()).toEqual([])
    expect(storage.data[`${STORAGE_KEY}.backup`]).toBe('{not json')
  })

  it('returns [] when the stored value is not an array', () => {
    expect(parseStoredEvents('{"a":1}')).toEqual([])
    expect(parseStoredEvents(null)).toEqual([])
  })

  it('drops invalid and duplicate records but keeps valid ones', () => {
    const good = { ...input, id: 'a', createdAt: input.start, updatedAt: input.start }
    const raw = JSON.stringify([
      good,
      good, // duplicate id
      { ...good, id: 'b', category: 'bogus' },
      { ...good, id: 'c', title: '' },
      { ...good, id: 'd', start: 'not a date' },
      { ...good, id: 'e', end: '2026-10-09T07:00:00.000Z' }, // ends before start
      null,
      'junk',
    ])
    expect(parseStoredEvents(raw).map((e) => e.id)).toEqual(['a'])
  })

  it('survives a storage that throws on write', () => {
    const storage: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = makeStore(storage)
    expect(() => store.create(input)).not.toThrow()
    expect(store.getSnapshot()).toHaveLength(1)
    spy.mockRestore()
  })
})

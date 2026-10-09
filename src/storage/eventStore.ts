import { EVENT_CATEGORIES } from '../types'
import type { CalendarEvent, EventInput } from '../types'

export const STORAGE_KEY = 'orbit.events.v1'

/** The subset of the Web Storage API we use. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface EventStore {
  /** Stable reference until the data changes (for useSyncExternalStore). */
  getSnapshot(): readonly CalendarEvent[]
  subscribe(listener: () => void): () => void
  create(input: EventInput): CalendarEvent
  update(id: string, input: EventInput): CalendarEvent | undefined
  remove(id: string): boolean
  /** Re-read from storage, e.g. after another tab changed it. */
  reload(): void
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isOptionalString = (v: unknown) => v === undefined || typeof v === 'string'

export function isCalendarEvent(v: unknown): v is CalendarEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.title === 'string' &&
    e.title.trim().length > 0 &&
    typeof e.category === 'string' &&
    (EVENT_CATEGORIES as readonly string[]).includes(e.category) &&
    isIso(e.start) &&
    isIso(e.end) &&
    Date.parse(e.end) >= Date.parse(e.start) &&
    typeof e.timeZone === 'string' &&
    e.timeZone.length > 0 &&
    isOptionalString(e.location) &&
    isOptionalString(e.description) &&
    isIso(e.createdAt) &&
    isIso(e.updatedAt)
  )
}

/** Parses raw storage text; returns only valid records, never throws. */
export function parseStoredEvents(raw: string | null): CalendarEvent[] {
  if (!raw) return []
  try {
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    const seen = new Set<string>()
    return data.filter((item): item is CalendarEvent => {
      if (!isCalendarEvent(item) || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
  } catch {
    return []
  }
}

export function createEventStore(
  storage: StorageLike | null,
  newId: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
): EventStore {
  const listeners = new Set<() => void>()

  function load(): CalendarEvent[] {
    if (!storage) return []
    try {
      const raw = storage.getItem(STORAGE_KEY)
      const events = parseStoredEvents(raw)
      // Keep a copy of unreadable data so a later save can't destroy it.
      if (raw && events.length === 0 && raw.trim() !== '[]') {
        try {
          storage.setItem(`${STORAGE_KEY}.backup`, raw)
        } catch {
          /* ignore */
        }
      }
      return events
    } catch {
      return []
    }
  }

  let cache = load()

  function commit(next: CalendarEvent[]) {
    cache = next
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (err) {
      console.error('ORBIT: could not save events to localStorage', err)
    }
    listeners.forEach((l) => l())
  }

  return {
    getSnapshot: () => cache,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    create(input) {
      const ts = now().toISOString()
      const event: CalendarEvent = { ...input, id: newId(), createdAt: ts, updatedAt: ts }
      commit([...cache, event])
      return event
    },
    update(id, input) {
      const existing = cache.find((e) => e.id === id)
      if (!existing) return undefined
      const updated: CalendarEvent = {
        ...input,
        id,
        createdAt: existing.createdAt,
        updatedAt: now().toISOString(),
      }
      commit(cache.map((e) => (e.id === id ? updated : e)))
      return updated
    },
    remove(id) {
      if (!cache.some((e) => e.id === id)) return false
      commit(cache.filter((e) => e.id !== id))
      return true
    },
    reload() {
      cache = load()
      listeners.forEach((l) => l())
    },
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const eventStore = createEventStore(browserStorage())

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) eventStore.reload()
  })
}

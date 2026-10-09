import { EVENT_CATEGORIES, SESSION_TYPES } from '../types'
import type { CalendarEvent, EventInput } from '../types'
import { createCollection, parseCollection } from './collection'
import type { StorageLike } from './collection'
import { saveStatus } from './saveStatus'
import type { SaveStatus } from './saveStatus'

export type { StorageLike } from './collection'

/** Key unchanged since Phase 2A: existing one-off events load as-is, no migration needed. */
export const STORAGE_KEY = 'orbit.events.v1'

export interface EventStore {
  getSnapshot(): readonly CalendarEvent[]
  subscribe(listener: () => void): () => void
  create(input: EventInput): CalendarEvent
  update(id: string, input: EventInput): CalendarEvent | undefined
  remove(id: string): boolean
  reload(): void
}

export const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
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
    isOptionalString(e.courseCode) &&
    isOptionalString(e.groupLabel) &&
    (e.sessionType === undefined || (SESSION_TYPES as readonly unknown[]).includes(e.sessionType)) &&
    isIso(e.createdAt) &&
    isIso(e.updatedAt)
  )
}

const sanitizeEvent = (v: unknown) => (isCalendarEvent(v) ? { item: v } : null)

/** Parses raw storage text; returns only valid records, never throws. */
export function parseStoredEvents(raw: string | null): CalendarEvent[] {
  return parseCollection(raw, sanitizeEvent).items
}

export function createEventStore(
  storage: StorageLike | null,
  newId: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
  status: SaveStatus = saveStatus,
): EventStore {
  const col = createCollection<CalendarEvent>(storage, STORAGE_KEY, sanitizeEvent, status)

  return {
    getSnapshot: col.getSnapshot,
    subscribe: col.subscribe,
    reload: col.reload,
    create(input) {
      const ts = now().toISOString()
      const event: CalendarEvent = { ...input, id: newId(), createdAt: ts, updatedAt: ts }
      col.commit([...col.getSnapshot(), event])
      return event
    },
    update(id, input) {
      const existing = col.getSnapshot().find((e) => e.id === id)
      if (!existing) return undefined
      const updated: CalendarEvent = { ...input, id, createdAt: existing.createdAt, updatedAt: now().toISOString() }
      col.commit(col.getSnapshot().map((e) => (e.id === id ? updated : e)))
      return updated
    },
    remove(id) {
      if (!col.getSnapshot().some((e) => e.id === id)) return false
      col.commit(col.getSnapshot().filter((e) => e.id !== id))
      return true
    },
  }
}

export function browserStorage(): StorageLike | null {
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

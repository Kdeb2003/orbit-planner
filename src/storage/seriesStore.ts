import { EVENT_CATEGORIES, SESSION_TYPES } from '../types'
import type { OccurrenceOverride, RecurringSeries, SeriesException, SeriesInput } from '../types'
import { createCollection } from './collection'
import type { StorageLike } from './collection'
import { browserStorage, isIso } from './eventStore'
import { saveStatus } from './saveStatus'
import type { SaveStatus } from './saveStatus'
import { isValidDateKey, isValidTime } from '../utils/time'

/**
 * Recurring series live under their own key so the Phase 2A events key is never
 * touched. Each record embeds its exceptions (one JSON document per series).
 */
export const SERIES_STORAGE_KEY = 'orbit.series.v1'

const isOptionalString = (v: unknown) => v === undefined || typeof v === 'string'
const isSessionType = (v: unknown, allowEmpty = false) =>
  v === undefined || (allowEmpty && v === '') || (SESSION_TYPES as readonly unknown[]).includes(v)
const isCategory = (v: unknown) => typeof v === 'string' && (EVENT_CATEGORIES as readonly string[]).includes(v)

function sanitizeOverride(v: unknown): OccurrenceOverride | undefined | null {
  if (v === undefined) return undefined
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const hasStart = o.start !== undefined
  const hasEnd = o.end !== undefined
  if (hasStart !== hasEnd) return null
  if (hasStart && !(isIso(o.start) && isIso(o.end) && Date.parse(o.end as string) > Date.parse(o.start as string))) return null
  if (o.title !== undefined && !(typeof o.title === 'string' && o.title.trim())) return null
  if (o.category !== undefined && !isCategory(o.category)) return null
  if (!isOptionalString(o.location) || !isOptionalString(o.description)) return null
  if (!isOptionalString(o.courseCode) || !isOptionalString(o.groupLabel) || !isSessionType(o.sessionType, true)) return null
  const out: OccurrenceOverride = {}
  if (o.title !== undefined) out.title = o.title as string
  if (o.category !== undefined) out.category = o.category as OccurrenceOverride['category']
  if (hasStart) {
    out.start = o.start as string
    out.end = o.end as string
  }
  if (o.location !== undefined) out.location = o.location as string
  if (o.description !== undefined) out.description = o.description as string
  if (o.courseCode !== undefined) out.courseCode = o.courseCode as string
  if (o.sessionType !== undefined) out.sessionType = o.sessionType as OccurrenceOverride['sessionType']
  if (o.groupLabel !== undefined) out.groupLabel = o.groupLabel as string
  return out
}

function sanitizeException(v: unknown): SeriesException | null {
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  if (typeof e.originalDate !== 'string' || !isValidDateKey(e.originalDate)) return null
  if (e.cancelled !== undefined && typeof e.cancelled !== 'boolean') return null
  const parsed = sanitizeOverride(e.override)
  if (parsed === null) return null
  // An empty override changes nothing; keep the exception only if it cancels (matches the
  // database rule exception_has_effect).
  const override = parsed && Object.keys(parsed).length > 0 ? parsed : undefined
  if (!e.cancelled && !override) return null
  return {
    originalDate: e.originalDate,
    ...(e.cancelled && { cancelled: true }),
    ...(override && { override }),
  }
}

/** Validates a stored series; invalid exceptions are dropped (flagged `lossy`), invalid series are rejected. */
export function sanitizeSeries(v: unknown): { item: RecurringSeries; lossy: boolean } | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  const r = s.recurrence as Record<string, unknown> | undefined
  if (
    typeof s.id !== 'string' ||
    !s.id ||
    typeof s.title !== 'string' ||
    !s.title.trim() ||
    !isCategory(s.category) ||
    typeof s.timeZone !== 'string' ||
    !s.timeZone ||
    !isOptionalString(s.location) ||
    !isOptionalString(s.description) ||
    !isOptionalString(s.courseCode) ||
    !isOptionalString(s.groupLabel) ||
    !isSessionType(s.sessionType) ||
    typeof s.startTime !== 'string' ||
    !isValidTime(s.startTime) ||
    typeof s.endTime !== 'string' ||
    !isValidTime(s.endTime) ||
    typeof s.endDayOffset !== 'number' ||
    !Number.isInteger(s.endDayOffset) ||
    s.endDayOffset < 0 ||
    s.endDayOffset > 6 ||
    !isIso(s.createdAt) ||
    !isIso(s.updatedAt) ||
    typeof r !== 'object' ||
    r === null ||
    r.frequency !== 'weekly' ||
    !Array.isArray(r.weekdays) ||
    r.weekdays.length === 0 ||
    !r.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ||
    typeof r.startDate !== 'string' ||
    !isValidDateKey(r.startDate) ||
    typeof r.untilDate !== 'string' ||
    !isValidDateKey(r.untilDate) ||
    r.untilDate < r.startDate ||
    !Array.isArray(s.exceptions)
  ) {
    return null
  }
  const exceptions: SeriesException[] = []
  const seen = new Set<string>()
  let lossy = false
  for (const raw of s.exceptions) {
    const ex = sanitizeException(raw)
    if (!ex || seen.has(ex.originalDate)) lossy = true
    else {
      seen.add(ex.originalDate)
      exceptions.push(ex)
    }
  }
  const { frequency, startDate, untilDate } = r as { frequency: 'weekly'; startDate: string; untilDate: string }
  return {
    lossy,
    item: {
      id: s.id,
      title: s.title,
      category: s.category as RecurringSeries['category'],
      timeZone: s.timeZone,
      ...(s.location ? { location: s.location as string } : {}),
      ...(s.description ? { description: s.description as string } : {}),
      ...(s.courseCode ? { courseCode: s.courseCode as string } : {}),
      ...(s.sessionType ? { sessionType: s.sessionType as RecurringSeries['sessionType'] } : {}),
      ...(s.groupLabel ? { groupLabel: s.groupLabel as string } : {}),
      recurrence: {
        frequency,
        weekdays: [...new Set(r.weekdays as number[])].sort() as RecurringSeries['recurrence']['weekdays'],
        startDate,
        untilDate,
      },
      startTime: s.startTime,
      endTime: s.endTime,
      endDayOffset: s.endDayOffset,
      exceptions,
      createdAt: s.createdAt as string,
      updatedAt: s.updatedAt as string,
    },
  }
}

export interface SeriesStore {
  getSnapshot(): readonly RecurringSeries[]
  subscribe(listener: () => void): () => void
  create(input: SeriesInput): RecurringSeries
  /** Replace the schedule. Exceptions are kept unless `exceptions` is given. */
  update(id: string, input: SeriesInput, exceptions?: SeriesException[]): RecurringSeries | undefined
  remove(id: string): boolean
  /** Add or replace the exception for `exception.originalDate`. */
  setException(id: string, exception: SeriesException): boolean
  /** Remove the exception for `originalDate` (restores the series default). */
  clearException(id: string, originalDate: string): boolean
  reload(): void
}

export function createSeriesStore(
  storage: StorageLike | null,
  newId: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
  status: SaveStatus = saveStatus,
): SeriesStore {
  const col = createCollection<RecurringSeries>(storage, SERIES_STORAGE_KEY, sanitizeSeries, status)

  function change(id: string, fn: (s: RecurringSeries) => RecurringSeries): RecurringSeries | undefined {
    const existing = col.getSnapshot().find((s) => s.id === id)
    if (!existing) return undefined
    const updated = { ...fn(existing), updatedAt: now().toISOString() }
    col.commit(col.getSnapshot().map((s) => (s.id === id ? updated : s)))
    return updated
  }

  return {
    getSnapshot: col.getSnapshot,
    subscribe: col.subscribe,
    reload: col.reload,
    create(input) {
      const ts = now().toISOString()
      const series: RecurringSeries = { ...input, id: newId(), exceptions: [], createdAt: ts, updatedAt: ts }
      col.commit([...col.getSnapshot(), series])
      return series
    },
    update: (id, input, exceptions) =>
      change(id, (s) => ({ ...input, id, exceptions: exceptions ?? s.exceptions, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    remove(id) {
      if (!col.getSnapshot().some((s) => s.id === id)) return false
      col.commit(col.getSnapshot().filter((s) => s.id !== id))
      return true
    },
    setException: (id, exception) =>
      !!change(id, (s) => ({
        ...s,
        exceptions: [...s.exceptions.filter((e) => e.originalDate !== exception.originalDate), exception],
      })),
    clearException: (id, originalDate) =>
      !!change(id, (s) => ({ ...s, exceptions: s.exceptions.filter((e) => e.originalDate !== originalDate) })),
  }
}

export const seriesStore = createSeriesStore(browserStorage())

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SERIES_STORAGE_KEY || e.key === null) seriesStore.reload()
  })
}

import { EVENT_CATEGORIES, SESSION_TYPES } from '../types'
import type {
  CalendarEvent,
  EventInput,
  OccurrenceOverride,
  RecurringSeries,
  SeriesException,
  SeriesInput,
  Weekday,
} from '../types'
import { daysBetween, isValidDateKey, isValidTime } from '../utils/time'
import type {
  EventPatch,
  EventRow,
  EventWrite,
  ExceptionRow,
  ExceptionWrite,
  SeriesPatch,
  SeriesRow,
  SeriesWrite,
} from './types'

/**
 * Typed conversion between the app's TypeScript models and the PostgreSQL rows.
 * Documented differences (supabase/README.md) are handled here:
 *  1 ids must be UUIDs            -> ids.ts (generated / deterministic mapping)
 *  2 optional <-> NULL            -> nn() / `?? undefined`
 *  3 length limits                -> validate*ForCloud()
 *  4 time zones                   -> isValidTimeZone()
 *  5 series span <= 1100 days     -> validateSeriesForCloud()
 *  6 orphaned exceptions          -> kept and reported (never dropped), see isOrphaned()
 *  7 server timestamps            -> never sent on UPDATE; updated_at kept raw as version token
 *  8 DST                          -> series keep LOCAL times + zone; events keep UTC instants
 */

export const LIMITS = {
  title: 120,
  location: 120,
  description: 2000,
  courseCode: 30,
  groupLabel: 40,
  timeZone: 64,
  maxSeriesDays: 1100,
} as const

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > LIMITS.timeZone || tz !== tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)
  } catch {
    return false
  }
}

/** Optional text -> trimmed string, or NULL when absent/blank. */
const nn = (v: string | undefined): string | null => {
  const t = v?.trim()
  return t ? t : null
}
const undef = (v: string | null): string | undefined => (v === null || v === '' ? undefined : v)
const normIso = (v: string): string => new Date(v).toISOString()
const validInstant = (v: string) => !Number.isNaN(Date.parse(v))

// ---------------------------------------------------------------------------
// Validation (what the database would reject, checked up front with clear messages)
// ---------------------------------------------------------------------------

function textProblems(p: string[], o: { title?: string; location?: string; description?: string; courseCode?: string; groupLabel?: string; sessionType?: string }) {
  const t = (o.title ?? '').trim()
  if (o.title !== undefined && (t.length < 1 || t.length > LIMITS.title)) p.push(`title must be 1–${LIMITS.title} characters`)
  if ((o.location ?? '').length > LIMITS.location) p.push(`location must be at most ${LIMITS.location} characters`)
  if ((o.description ?? '').length > LIMITS.description) p.push(`notes must be at most ${LIMITS.description} characters`)
  if ((o.courseCode ?? '').length > LIMITS.courseCode) p.push(`course code must be at most ${LIMITS.courseCode} characters`)
  if ((o.groupLabel ?? '').length > LIMITS.groupLabel) p.push(`group label must be at most ${LIMITS.groupLabel} characters`)
  if (o.sessionType && !(SESSION_TYPES as readonly string[]).includes(o.sessionType)) p.push('unknown session type')
}

export function validateEventForCloud(e: EventInput): string[] {
  const p: string[] = []
  textProblems(p, e)
  if (!(EVENT_CATEGORIES as readonly string[]).includes(e.category)) p.push('unknown category')
  if (!validInstant(e.start) || !validInstant(e.end)) p.push('start/end is not a valid date and time')
  else if (Date.parse(e.end) < Date.parse(e.start)) p.push('end is before start')
  if (!isValidTimeZone(e.timeZone)) p.push(`time zone "${e.timeZone}" is not a valid IANA zone`)
  return p
}

export function validateOverride(o: OccurrenceOverride): string[] {
  const p: string[] = []
  textProblems(p, { ...o, sessionType: o.sessionType || undefined })
  if (o.category !== undefined && !(EVENT_CATEGORIES as readonly string[]).includes(o.category)) p.push('unknown category')
  if ((o.start === undefined) !== (o.end === undefined)) p.push('start and end must be given together')
  else if (o.start !== undefined && o.end !== undefined) {
    if (!validInstant(o.start) || !validInstant(o.end)) p.push('moved start/end is not a valid date and time')
    else if (Date.parse(o.end) <= Date.parse(o.start)) p.push('moved end must be after start')
  }
  return p
}

export function validateExceptionForCloud(ex: SeriesException): string[] {
  const p: string[] = []
  if (!isValidDateKey(ex.originalDate)) p.push('exception date is invalid')
  const hasOverride = !!ex.override && Object.keys(ex.override).length > 0
  if (!ex.cancelled && !hasOverride) p.push('exception neither cancels nor changes anything')
  if (ex.override) p.push(...validateOverride(ex.override))
  return p
}

export function validateSeriesForCloud(s: SeriesInput & { exceptions?: SeriesException[] }): string[] {
  const p: string[] = []
  textProblems(p, s)
  if (!(EVENT_CATEGORIES as readonly string[]).includes(s.category)) p.push('unknown category')
  if (!isValidTimeZone(s.timeZone)) p.push(`time zone "${s.timeZone}" is not a valid IANA zone`)
  const r = s.recurrence
  const wd = r.weekdays as number[]
  if (r.frequency !== 'weekly') p.push('only weekly repeats are supported')
  if (wd.length < 1 || wd.length > 7 || wd.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(wd).size !== wd.length) {
    p.push('weekdays must be 1–7 distinct values between 0 (Mon) and 6 (Sun)')
  }
  if (!isValidDateKey(r.startDate) || !isValidDateKey(r.untilDate)) p.push('start/end date is invalid')
  else {
    if (r.untilDate < r.startDate) p.push('repeat-until is before the start date')
    else if (daysBetween(r.startDate, r.untilDate) > LIMITS.maxSeriesDays) p.push(`a series can span at most ${LIMITS.maxSeriesDays} days`)
  }
  if (!isValidTime(s.startTime) || !isValidTime(s.endTime)) p.push('start/end time is invalid')
  if (!Number.isInteger(s.endDayOffset) || s.endDayOffset < 0 || s.endDayOffset > 6) p.push('duration may span at most 7 days')
  else if (s.endDayOffset === 0 && isValidTime(s.startTime) && isValidTime(s.endTime) && s.endTime <= s.startTime) {
    p.push('a same-day event must end after it starts')
  }
  for (const ex of s.exceptions ?? []) for (const m of validateExceptionForCloud(ex)) p.push(`${ex.originalDate}: ${m}`)
  return p
}

/** Orphaned: the exception's date is not part of the series schedule (tolerated by the app; kept, never silently dropped). */
export function isOrphaned(s: Pick<RecurringSeries, 'recurrence'>, ex: SeriesException): boolean {
  const r = s.recurrence
  if (ex.originalDate < r.startDate || ex.originalDate > r.untilDate) return true
  const wd = (new Date(`${ex.originalDate}T00:00:00Z`).getUTCDay() + 6) % 7
  return !(r.weekdays as number[]).includes(wd)
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function eventPatch(e: EventInput): EventPatch {
  return {
    title: e.title.trim(),
    category: e.category,
    starts_at: normIso(e.start),
    ends_at: normIso(e.end),
    time_zone: e.timeZone,
    location: nn(e.location),
    description: nn(e.description),
    course_code: nn(e.courseCode),
    session_type: e.sessionType ?? null,
    group_label: nn(e.groupLabel),
  }
}

/** INSERT payload. `createdAt` is only passed by the explicit import, to preserve history. */
export function eventToWrite(e: EventInput, id: string, createdAt?: string): EventWrite {
  return { id, ...eventPatch(e), ...(createdAt && { created_at: normIso(createdAt) }) }
}

export function rowToEvent(r: EventRow): CalendarEvent {
  return {
    id: r.id,
    title: r.title,
    category: r.category as CalendarEvent['category'],
    start: normIso(r.starts_at),
    end: normIso(r.ends_at),
    timeZone: r.time_zone,
    ...(undef(r.location) && { location: r.location! }),
    ...(undef(r.description) && { description: r.description! }),
    ...(undef(r.course_code) && { courseCode: r.course_code! }),
    ...(r.session_type && { sessionType: r.session_type as CalendarEvent['sessionType'] }),
    ...(undef(r.group_label) && { groupLabel: r.group_label! }),
    createdAt: r.created_at,
    updatedAt: r.updated_at, // raw: used as the version token for conditional updates
  }
}

// ---------------------------------------------------------------------------
// Series and exceptions
// ---------------------------------------------------------------------------

export function seriesPatch(s: SeriesInput): SeriesPatch {
  return {
    title: s.title.trim(),
    category: s.category,
    time_zone: s.timeZone,
    location: nn(s.location),
    description: nn(s.description),
    course_code: nn(s.courseCode),
    session_type: s.sessionType ?? null,
    group_label: nn(s.groupLabel),
    frequency: s.recurrence.frequency,
    weekdays: [...s.recurrence.weekdays],
    start_date: s.recurrence.startDate,
    until_date: s.recurrence.untilDate,
    start_time: s.startTime, // 'HH:mm' local wall-clock time
    end_time: s.endTime,
    end_day_offset: s.endDayOffset,
  }
}

export function seriesToWrite(s: SeriesInput, id: string, createdAt?: string): SeriesWrite {
  return { id, ...seriesPatch(s), ...(createdAt && { created_at: normIso(createdAt) }) }
}

export function exceptionToWrite(seriesId: string, ex: SeriesException): ExceptionWrite {
  const override = ex.override && Object.keys(ex.override).length > 0 ? { ...ex.override } : null
  if (override?.start !== undefined && override.end !== undefined) {
    override.start = normIso(override.start) // DB requires Date.toISOString() format
    override.end = normIso(override.end)
  }
  return { series_id: seriesId, original_date: ex.originalDate, cancelled: !!ex.cancelled, override }
}

export function rowToException(r: ExceptionRow): SeriesException {
  const hasOverride = r.override && Object.keys(r.override).length > 0
  return {
    originalDate: r.original_date,
    ...(r.cancelled && { cancelled: true }),
    ...(hasOverride && { override: r.override! }),
  }
}

export function rowToSeries(r: SeriesRow, exceptions: ExceptionRow[]): RecurringSeries {
  return {
    id: r.id,
    title: r.title,
    category: r.category as RecurringSeries['category'],
    timeZone: r.time_zone,
    ...(undef(r.location) && { location: r.location! }),
    ...(undef(r.description) && { description: r.description! }),
    ...(undef(r.course_code) && { courseCode: r.course_code! }),
    ...(r.session_type && { sessionType: r.session_type as RecurringSeries['sessionType'] }),
    ...(undef(r.group_label) && { groupLabel: r.group_label! }),
    recurrence: {
      frequency: 'weekly',
      weekdays: [...r.weekdays].sort((a, b) => a - b) as Weekday[],
      startDate: r.start_date,
      untilDate: r.until_date,
    },
    startTime: r.start_time.slice(0, 5), // 'HH:MM:SS' -> 'HH:mm'
    endTime: r.end_time.slice(0, 5),
    endDayOffset: r.end_day_offset,
    exceptions: exceptions
      .filter((x) => x.series_id === r.id)
      .map(rowToException)
      .sort((a, b) => a.originalDate.localeCompare(b.originalDate)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

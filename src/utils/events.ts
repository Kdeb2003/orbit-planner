import { EVENT_CATEGORIES, SESSION_TYPES } from '../types'
import type { CalendarEvent, EventCategory, EventInput, SeriesInput, SessionType, Weekday } from '../types'
import {
  addDays,
  dateKey,
  dayRange,
  daysBetween,
  isValidDateKey,
  isValidTime,
  resolveLocalTime,
  TIME_ZONE,
  timeKey,
  zonedTimeToUtc,
} from './time'
import type { DateKey } from './time'

const HOUR_MS = 3_600_000

export function sortEvents<T extends CalendarEvent>(events: readonly T[]): T[] {
  return [...events].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title),
  )
}

/** Whether `ev` overlaps [rangeStart, rangeEnd) (ms). Zero-length events count if they start inside. */
export function overlapsRange(ev: Pick<CalendarEvent, 'start' | 'end'>, rangeStart: number, rangeEnd: number): boolean {
  const evStart = Date.parse(ev.start)
  const evEnd = Date.parse(ev.end)
  if (evEnd <= evStart) return evStart >= rangeStart && evStart < rangeEnd
  return evStart < rangeEnd && evEnd > rangeStart
}

/** Events overlapping the calendar day `day`, sorted by start. Handles events spanning midnight. */
export function eventsOnDay<T extends CalendarEvent>(
  events: readonly T[],
  day: DateKey,
  timeZone: string = TIME_ZONE,
): T[] {
  const { start, end } = dayRange(day, timeZone)
  return sortEvents(events.filter((ev) => overlapsRange(ev, start.getTime(), end.getTime())))
}

/** The event running at `now` (earliest start if several overlap). */
export function currentEvent<T extends CalendarEvent>(events: readonly T[], now: Date): T | undefined {
  const t = now.getTime()
  return sortEvents(events).find((ev) => Date.parse(ev.start) <= t && t < Date.parse(ev.end))
}

/** The soonest event that starts after `now`. */
export function nextEvent<T extends CalendarEvent>(events: readonly T[], now: Date): T | undefined {
  const t = now.getTime()
  return sortEvents(events).find((ev) => Date.parse(ev.start) > t)
}

/** Minutes of `ev` that fall inside calendar day `day`. */
export function minutesOnDay(ev: CalendarEvent, day: DateKey, timeZone: string = TIME_ZONE): number {
  const range = dayRange(day, timeZone)
  const from = Math.max(Date.parse(ev.start), range.start.getTime())
  const to = Math.min(Date.parse(ev.end), range.end.getTime())
  return Math.max(0, (to - from) / 60_000)
}

export function summarizeDay(
  events: readonly CalendarEvent[],
  day: DateKey,
  category: EventCategory,
  timeZone: string = TIME_ZONE,
) {
  const { start, end } = dayRange(day, timeZone)
  const items = events.filter(
    (e) => e.category === category && overlapsRange(e, start.getTime(), end.getTime()),
  )
  return { count: items.length, minutes: items.reduce((s, e) => s + minutesOnDay(e, day, timeZone), 0) }
}

/** Human-readable time span of `ev` as seen on calendar day `day`. */
export function eventTimeLabel(ev: CalendarEvent, day: DateKey, timeZone: string = TIME_ZONE): string {
  const start = new Date(ev.start)
  const end = new Date(ev.end)
  const startDay = dateKey(start, timeZone)
  // An event ending exactly at midnight belongs to the previous day.
  const endDay = dateKey(end > start ? new Date(end.getTime() - 1) : end, timeZone)
  const s = timeKey(start, timeZone)
  const e = timeKey(end, timeZone)
  if (startDay === endDay) return s === e ? s : `${s} – ${e}`
  if (day === startDay) return `${s} → ${e} (+${daysBetween(startDay, endDay)}d)`
  if (day === endDay) return `until ${e}`
  return 'All day'
}

// ---- Form handling ----

export interface EventFormValues {
  title: string
  category: EventCategory
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  location: string
  description: string
  courseCode: string
  sessionType: SessionType | ''
  groupLabel: string
}

export type EventFormErrors = Partial<Record<keyof EventFormValues, string>>

/** The "Repeat" section of the form. */
export interface RepeatFormValues {
  mode: 'none' | 'weekly'
  weekdays: Weekday[]
  until: string
}

export type SeriesFormErrors = EventFormErrors & { weekdays?: string; until?: string }

function fieldsOf(d: Date, timeZone: string) {
  return { date: dateKey(d, timeZone), time: timeKey(d, timeZone) }
}

/** Defaults for a new event on `day`: next full hour if today, otherwise 09:00; one hour long. */
export function emptyFormValues(day: DateKey, now: Date, timeZone: string = TIME_ZONE): EventFormValues {
  let start = zonedTimeToUtc(day, '09:00', timeZone)
  const nextHour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS)
  if (dateKey(nextHour, timeZone) === day) start = nextHour
  const s = fieldsOf(start, timeZone)
  const e = fieldsOf(new Date(start.getTime() + HOUR_MS), timeZone)
  return {
    title: '',
    category: 'personal',
    startDate: s.date,
    startTime: s.time,
    endDate: e.date,
    endTime: e.time,
    location: '',
    description: '',
    courseCode: '',
    sessionType: '',
    groupLabel: '',
  }
}

export function eventToFormValues(ev: CalendarEvent): EventFormValues {
  const s = fieldsOf(new Date(ev.start), ev.timeZone)
  const e = fieldsOf(new Date(ev.end), ev.timeZone)
  return {
    title: ev.title,
    category: ev.category,
    startDate: s.date,
    startTime: s.time,
    endDate: e.date,
    endTime: e.time,
    location: ev.location ?? '',
    description: ev.description ?? '',
    courseCode: ev.courseCode ?? '',
    sessionType: ev.sessionType ?? '',
    groupLabel: ev.groupLabel ?? '',
  }
}

export function defaultRepeat(startDate: DateKey): RepeatFormValues {
  const weekday = ((new Date(`${startDate}T00:00:00Z`).getUTCDay() + 6) % 7) as Weekday
  return { mode: 'none', weekdays: [weekday], until: addDays(startDate, 12 * 7) }
}

export type ValidationResult = { ok: true; input: EventInput } | { ok: false; errors: EventFormErrors }
export type SeriesValidationResult = { ok: true; input: SeriesInput } | { ok: false; errors: SeriesFormErrors }

const GAP_MESSAGE = 'This time does not exist on that date (clocks move forward).'

function checkCommon(v: EventFormValues, timeZone: string, checkGap: boolean): EventFormErrors {
  const errors: EventFormErrors = {}
  if (!v.title.trim()) errors.title = 'Title is required.'
  else if (v.title.trim().length > 120) errors.title = 'Title must be 120 characters or fewer.'
  if (!EVENT_CATEGORIES.includes(v.category)) errors.category = 'Choose a category.'
  if (!isValidDateKey(v.startDate)) errors.startDate = 'Enter a valid start date.'
  if (!isValidTime(v.startTime)) errors.startTime = 'Enter a valid start time.'
  if (!isValidDateKey(v.endDate)) errors.endDate = 'Enter a valid end date.'
  if (!isValidTime(v.endTime)) errors.endTime = 'Enter a valid end time.'
  if (v.location.trim().length > 120) errors.location = 'Location must be 120 characters or fewer.'
  if (v.courseCode.trim().length > 30) errors.courseCode = 'Course code must be 30 characters or fewer.'
  if (v.groupLabel.trim().length > 40) errors.groupLabel = 'Group label must be 40 characters or fewer.'
  if (v.sessionType !== '' && !SESSION_TYPES.includes(v.sessionType)) errors.sessionType = 'Choose a session type.'
  if (v.description.trim().length > 2000) errors.description = 'Notes must be 2000 characters or fewer.'

  if (!errors.startDate && !errors.startTime && !errors.endDate && !errors.endTime) {
    if (checkGap) {
      if (resolveLocalTime(v.startDate, v.startTime, timeZone).status === 'nonexistent') errors.startTime = GAP_MESSAGE
      if (resolveLocalTime(v.endDate, v.endTime, timeZone).status === 'nonexistent') errors.endTime = GAP_MESSAGE
    }
    const start = zonedTimeToUtc(v.startDate, v.startTime, timeZone)
    const end = zonedTimeToUtc(v.endDate, v.endTime, timeZone)
    if (end <= start && !errors.endTime) errors.endTime = 'End must be after the start.'
  }
  return errors
}

function optionalText(v: EventFormValues) {
  const location = v.location.trim()
  const description = v.description.trim()
  const courseCode = v.courseCode.trim()
  const groupLabel = v.groupLabel.trim()
  return {
    ...(location && { location }),
    ...(description && { description }),
    ...(courseCode && { courseCode }),
    ...(v.sessionType && { sessionType: v.sessionType }),
    ...(groupLabel && { groupLabel }),
  }
}

/** Informational notes (not errors) about DST for the entered one-off times. */
export function timeNotes(v: EventFormValues, timeZone: string = TIME_ZONE): string[] {
  const notes: string[] = []
  const ambiguous = (d: string, t: string) =>
    isValidDateKey(d) && isValidTime(t) && resolveLocalTime(d, t, timeZone).status === 'ambiguous'
  if (ambiguous(v.startDate, v.startTime) || ambiguous(v.endDate, v.endTime)) {
    notes.push('A time you entered happens twice that night (clocks move back). The first occurrence is used.')
  }
  return notes
}

export function validateEventForm(v: EventFormValues, timeZone: string = TIME_ZONE): ValidationResult {
  const errors = checkCommon(v, timeZone, true)
  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    input: {
      title: v.title.trim(),
      category: v.category,
      start: zonedTimeToUtc(v.startDate, v.startTime, timeZone).toISOString(),
      end: zonedTimeToUtc(v.endDate, v.endTime, timeZone).toISOString(),
      timeZone,
      ...optionalText(v),
    },
  }
}

const MAX_SERIES_DAYS = 1100

/**
 * Validates the form as a weekly series. Start date = first active date; the
 * end date/time give the duration (end date may be later for overnight events).
 */
export function validateSeriesForm(
  v: EventFormValues,
  repeat: RepeatFormValues,
  timeZone: string = TIME_ZONE,
): SeriesValidationResult {
  // DST gaps are reported as non-blocking warnings for series, not errors.
  const errors: SeriesFormErrors = checkCommon(v, timeZone, false)
  if (repeat.weekdays.length === 0) errors.weekdays = 'Choose at least one weekday.'
  if (!isValidDateKey(repeat.until)) errors.until = 'Enter a valid repeat-until date.'
  else if (!errors.startDate && repeat.until < v.startDate) errors.until = 'Repeat-until must not be before the start date.'
  else if (!errors.startDate && daysBetween(v.startDate, repeat.until) > MAX_SERIES_DAYS) {
    errors.until = 'A series can span at most about 3 years.'
  }
  if (!errors.startDate && !errors.endDate) {
    const offset = daysBetween(v.startDate, v.endDate)
    if (offset > 6) errors.endDate = 'A repeating event can last at most 7 days.'
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    input: {
      title: v.title.trim(),
      category: v.category,
      timeZone,
      recurrence: {
        frequency: 'weekly',
        weekdays: [...new Set(repeat.weekdays)].sort() as Weekday[],
        startDate: v.startDate,
        untilDate: repeat.until,
      },
      startTime: v.startTime,
      endTime: v.endTime,
      endDayOffset: daysBetween(v.startDate, v.endDate),
      ...optionalText(v),
    },
  }
}

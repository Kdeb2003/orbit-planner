import { EVENT_CATEGORIES } from '../types'
import type { CalendarEvent, EventCategory, EventInput } from '../types'
import {
  addDays,
  dateKey,
  dayRange,
  isValidDateKey,
  isValidTime,
  TIME_ZONE,
  timeKey,
  zonedTimeToUtc,
} from './time'
import type { DateKey } from './time'

const HOUR_MS = 3_600_000

export function sortEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title),
  )
}

/** Events overlapping the calendar day `day`, sorted by start. Handles events spanning midnight. */
export function eventsOnDay(events: readonly CalendarEvent[], day: DateKey, timeZone: string = TIME_ZONE) {
  const { start, end } = dayRange(day, timeZone)
  const s = start.getTime()
  const e = end.getTime()
  return sortEvents(
    events.filter((ev) => {
      const evStart = Date.parse(ev.start)
      const evEnd = Date.parse(ev.end)
      if (evEnd <= evStart) return evStart >= s && evStart < e // zero-length (point) event
      return evStart < e && evEnd > s
    }),
  )
}

/** The event running at `now` (earliest start if several overlap). */
export function currentEvent(events: readonly CalendarEvent[], now: Date): CalendarEvent | undefined {
  const t = now.getTime()
  return sortEvents(events).find((ev) => Date.parse(ev.start) <= t && t < Date.parse(ev.end))
}

/** The soonest event that starts after `now`. */
export function nextEvent(events: readonly CalendarEvent[], now: Date): CalendarEvent | undefined {
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
  const items = events.filter((e) => e.category === category)
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
  if (day === startDay) return `${s} → ${e} (+${dayDiff(startDay, endDay)}d)`
  if (day === endDay) return `until ${e}`
  return 'All day'
}

function dayDiff(a: DateKey, b: DateKey): number {
  let n = 0
  let cur = a
  while (cur < b && n < 3660) {
    cur = addDays(cur, 1)
    n++
  }
  return n
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
}

export type EventFormErrors = Partial<Record<keyof EventFormValues, string>>

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
  }
}

export type ValidationResult = { ok: true; input: EventInput } | { ok: false; errors: EventFormErrors }

export function validateEventForm(v: EventFormValues, timeZone: string = TIME_ZONE): ValidationResult {
  const errors: EventFormErrors = {}
  const title = v.title.trim()
  const location = v.location.trim()
  const description = v.description.trim()

  if (!title) errors.title = 'Title is required.'
  else if (title.length > 120) errors.title = 'Title must be 120 characters or fewer.'
  if (!EVENT_CATEGORIES.includes(v.category)) errors.category = 'Choose a category.'
  if (!isValidDateKey(v.startDate)) errors.startDate = 'Enter a valid start date.'
  if (!isValidTime(v.startTime)) errors.startTime = 'Enter a valid start time.'
  if (!isValidDateKey(v.endDate)) errors.endDate = 'Enter a valid end date.'
  if (!isValidTime(v.endTime)) errors.endTime = 'Enter a valid end time.'
  if (location.length > 120) errors.location = 'Location must be 120 characters or fewer.'
  if (description.length > 2000) errors.description = 'Notes must be 2000 characters or fewer.'

  if (!errors.startDate && !errors.startTime && !errors.endDate && !errors.endTime) {
    const start = zonedTimeToUtc(v.startDate, v.startTime, timeZone)
    const end = zonedTimeToUtc(v.endDate, v.endTime, timeZone)
    if (end <= start) errors.endTime = 'End must be after the start.'
    else if (Object.keys(errors).length === 0) {
      return {
        ok: true,
        input: {
          title,
          category: v.category,
          start: start.toISOString(),
          end: end.toISOString(),
          timeZone,
          ...(location && { location }),
          ...(description && { description }),
        },
      }
    }
  }
  return { ok: false, errors }
}

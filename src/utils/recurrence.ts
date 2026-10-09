import type {
  EventInput,
  OccurrenceOverride,
  RecurringSeries,
  ScheduledItem,
  SeriesException,
  SeriesInput,
  Weekday,
} from '../types'
import { overlapsRange } from './events'
import type { EventFormValues, RepeatFormValues } from './events'
import { addDays, dayRange, formatDayShort, resolveLocalTime, weekdayIndex } from './time'
import type { DateKey } from './time'

/** Stable identity of one occurrence: series id + original scheduled date. */
export function occurrenceId(seriesId: string, originalDate: DateKey): string {
  return `${seriesId}:${originalDate}`
}

/** Whether the series schedule (weekdays within the active range) includes `day`. */
export function occursOn(series: Pick<RecurringSeries, 'recurrence'>, day: DateKey): boolean {
  const r = series.recurrence
  return day >= r.startDate && day <= r.untilDate && r.weekdays.includes(weekdayIndex(day) as Weekday)
}

/** Series-default start/end for the occurrence on `day`, ignoring exceptions. */
export function baseOccurrence(series: RecurringSeries, day: DateKey) {
  const s = resolveLocalTime(day, series.startTime, series.timeZone)
  const e = resolveLocalTime(addDays(day, series.endDayOffset), series.endTime, series.timeZone)
  return {
    start: s.utc,
    end: e.utc,
    dstAdjusted: s.status === 'nonexistent' || e.status === 'nonexistent',
  }
}

/** The effective occurrence for original date `day`, with its exception (if any) applied. */
export function resolveOccurrence(series: RecurringSeries, day: DateKey): ScheduledItem {
  const base = baseOccurrence(series, day)
  const ex = series.exceptions.find((x) => x.originalDate === day)
  const ov = ex?.override
  const moved = ov?.start !== undefined && ov?.end !== undefined
  const location = ov?.location !== undefined ? ov.location : series.location
  const description = ov?.description !== undefined ? ov.description : series.description
  const courseCode = ov?.courseCode !== undefined ? ov.courseCode : series.courseCode
  const sessionType = ov?.sessionType !== undefined ? ov.sessionType : series.sessionType
  const groupLabel = ov?.groupLabel !== undefined ? ov.groupLabel : series.groupLabel
  return {
    id: occurrenceId(series.id, day),
    seriesId: series.id,
    originalDate: day,
    title: ov?.title ?? series.title,
    category: ov?.category ?? series.category,
    start: moved ? ov.start! : base.start.toISOString(),
    end: moved ? ov.end! : base.end.toISOString(),
    timeZone: series.timeZone,
    ...(location && { location }),
    ...(description && { description }),
    ...(courseCode && { courseCode }),
    ...(sessionType && { sessionType }),
    ...(groupLabel && { groupLabel }),
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    ...(ov && Object.keys(ov).length > 0 && { modified: true }),
    ...(ex?.cancelled && { cancelled: true }),
    ...(base.dstAdjusted && !moved && { dstAdjusted: true }),
  }
}

/**
 * Occurrences of `series` overlapping the days [fromDay, toDay] (inclusive).
 * Bounded by the range; never generates the whole series. Moved occurrences
 * appear only at their new position, never at their original date.
 */
export function expandSeries(
  series: RecurringSeries,
  fromDay: DateKey,
  toDay: DateKey,
  { includeCancelled = false }: { includeCancelled?: boolean } = {},
): ScheduledItem[] {
  const r = series.recurrence
  const lo = addDays(fromDay, -series.endDayOffset)
  const first = lo > r.startDate ? lo : r.startDate
  const last = toDay < r.untilDate ? toDay : r.untilDate

  const dates = new Set<DateKey>()
  for (let d = first; d <= last; d = addDays(d, 1)) if (occursOn(series, d)) dates.add(d)
  // Moved occurrences may belong to a date outside the range being viewed.
  for (const ex of series.exceptions) if (occursOn(series, ex.originalDate)) dates.add(ex.originalDate)

  const rangeStart = dayRange(fromDay, series.timeZone).start.getTime()
  const rangeEnd = dayRange(toDay, series.timeZone).end.getTime()
  const items: ScheduledItem[] = []
  for (const d of dates) {
    const item = resolveOccurrence(series, d)
    if (item.cancelled && !includeCancelled) continue
    if (overlapsRange(item, rangeStart, rangeEnd)) items.push(item)
  }
  return items
}

/** Exceptions whose original date is no longer part of the series schedule. */
export function orphanedExceptions(series: RecurringSeries): SeriesException[] {
  return series.exceptions.filter((ex) => !occursOn(series, ex.originalDate))
}

/** Scheduled dates (not exceptions) of the series, capped for safety. */
export function scheduledDates(series: Pick<RecurringSeries, 'recurrence'>, limit = 800): DateKey[] {
  const out: DateKey[] = []
  for (let d = series.recurrence.startDate; d <= series.recurrence.untilDate && out.length < limit; d = addDays(d, 1)) {
    if (occursOn(series, d)) out.push(d)
  }
  return out
}

/** Human-readable DST problems for occurrences whose local times are skipped or repeated. */
export function dstWarnings(series: SeriesInput, max = 3): string[] {
  const lines: string[] = []
  for (const d of scheduledDates(series)) {
    for (const [label, day, time] of [
      ['start', d, series.startTime],
      ['end', addDays(d, series.endDayOffset), series.endTime],
    ] as const) {
      const status = resolveLocalTime(day, time, series.timeZone).status
      if (status === 'nonexistent') {
        lines.push(`${formatDayShort(day)}: ${time} does not exist (clocks move forward), so the ${label} is shifted an hour later.`)
      } else if (status === 'ambiguous') {
        lines.push(`${formatDayShort(day)}: ${time} happens twice (clocks move back); the first occurrence is used for the ${label}.`)
      }
    }
  }
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more DST notices.`] : lines
}

/** Form values for editing the whole series. */
export function seriesToFormValues(series: RecurringSeries): { values: EventFormValues; repeat: RepeatFormValues } {
  const r = series.recurrence
  return {
    values: {
      title: series.title,
      category: series.category,
      startDate: r.startDate,
      startTime: series.startTime,
      endDate: addDays(r.startDate, series.endDayOffset),
      endTime: series.endTime,
      location: series.location ?? '',
      description: series.description ?? '',
      courseCode: series.courseCode ?? '',
      sessionType: series.sessionType ?? '',
      groupLabel: series.groupLabel ?? '',
    },
    repeat: { mode: 'weekly', weekdays: [...r.weekdays], until: r.untilDate },
  }
}

/** The minimal override that turns the series default for `day` into `input`; undefined if identical. */
export function overrideFromInput(series: RecurringSeries, day: DateKey, input: EventInput): OccurrenceOverride | undefined {
  const base = baseOccurrence(series, day)
  const o: OccurrenceOverride = {}
  if (input.title !== series.title) o.title = input.title
  if (input.category !== series.category) o.category = input.category
  if ((input.location ?? '') !== (series.location ?? '')) o.location = input.location ?? ''
  if ((input.description ?? '') !== (series.description ?? '')) o.description = input.description ?? ''
  if ((input.courseCode ?? '') !== (series.courseCode ?? '')) o.courseCode = input.courseCode ?? ''
  if ((input.sessionType ?? '') !== (series.sessionType ?? '')) o.sessionType = input.sessionType ?? ''
  if ((input.groupLabel ?? '') !== (series.groupLabel ?? '')) o.groupLabel = input.groupLabel ?? ''
  if (input.start !== base.start.toISOString() || input.end !== base.end.toISOString()) {
    o.start = input.start
    o.end = input.end
  }
  return Object.keys(o).length ? o : undefined
}

/** Occurrences of a (possibly unsaved) series for conflict checks, capped at ~2 years from its start. */
export function expandSeriesForCandidates(series: RecurringSeries): ScheduledItem[] {
  const r = series.recurrence
  const cap = addDays(r.startDate, 730)
  return expandSeries(series, r.startDate, r.untilDate < cap ? r.untilDate : cap)
}

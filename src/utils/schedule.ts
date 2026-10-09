import type { CalendarEvent, RecurringSeries, ScheduledItem } from '../types'
import { findConflicts } from './conflicts'
import type { Conflict } from './conflicts'
import { overlapsRange, sortEvents } from './events'
import { expandSeries } from './recurrence'
import { dateKey, dayRange, TIME_ZONE } from './time'
import type { DateKey } from './time'

/**
 * One-off events plus generated occurrences overlapping the days [fromDay, toDay], sorted.
 * Cancelled occurrences are omitted unless `includeCancelled` is set (for display/restore only).
 */
export function expandItems(
  events: readonly CalendarEvent[],
  series: readonly RecurringSeries[],
  fromDay: DateKey,
  toDay: DateKey,
  options: { includeCancelled?: boolean } = {},
): ScheduledItem[] {
  const rangeStart = dayRange(fromDay, TIME_ZONE).start.getTime()
  const rangeEnd = dayRange(toDay, TIME_ZONE).end.getTime()
  const singles: ScheduledItem[] = events.filter((e) => overlapsRange(e, rangeStart, rangeEnd))
  const occurrences = series.flatMap((s) => expandSeries(s, fromDay, toDay, options))
  return sortEvents([...singles, ...occurrences])
}

/**
 * Overlaps between `candidates` (not yet saved) and everything already scheduled.
 * `isSelf` excludes the item(s) being edited so nothing conflicts with itself.
 */
export function conflictsFor(
  candidates: readonly ScheduledItem[],
  events: readonly CalendarEvent[],
  series: readonly RecurringSeries[],
  isSelf: (item: ScheduledItem) => boolean = () => false,
): Conflict[] {
  const active = candidates.filter((c) => !c.cancelled)
  if (active.length === 0) return []
  const from = dateKey(new Date(Math.min(...active.map((c) => Date.parse(c.start)))), TIME_ZONE)
  const to = dateKey(new Date(Math.max(...active.map((c) => Date.parse(c.end)))), TIME_ZONE)
  const others = expandItems(events, series, from, to).filter((o) => !isSelf(o))
  return findConflicts(active, others)
}

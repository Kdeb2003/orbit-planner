import type { ScheduledItem } from '../types'
import { eventTimeLabel } from './events'
import { dateKey, formatDayShort } from './time'

export interface Conflict {
  a: ScheduledItem
  b: ScheduledItem
}

/**
 * Two items overlap when each starts before the other ends. Touching at a
 * boundary (one ends exactly when the next starts) is NOT an overlap.
 * Deadlines are reminders, not time blocks, so they never conflict.
 */
export function overlaps(a: ScheduledItem, b: ScheduledItem): boolean {
  if (a.category === 'deadline' || b.category === 'deadline') return false
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)
}

/** Pairs (candidate, other) that overlap. Cancelled items and an item with itself are ignored. */
export function findConflicts(candidates: readonly ScheduledItem[], others: readonly ScheduledItem[]): Conflict[] {
  const out: Conflict[] = []
  for (const a of candidates) {
    if (a.cancelled) continue
    for (const b of others) {
      if (b.cancelled || b.id === a.id) continue
      if (overlaps(a, b)) out.push({ a, b })
    }
  }
  return out
}

function describe(item: ScheduledItem): string {
  const day = dateKey(new Date(item.start), item.timeZone)
  return `${formatDayShort(day)} ${eventTimeLabel(item, day, item.timeZone)}`
}

/** User-facing summary lines, e.g. 'Fri 9 Oct 10:00 – 11:00 “Lecture” overlaps “Shift” (10:30 – 12:00)'. */
export function conflictLines(conflicts: readonly Conflict[], max = 4): string[] {
  const lines = conflicts.slice(0, max).map(({ a, b }) => `“${b.title}” (${describe(b)}) overlaps ${describe(a)}`)
  if (conflicts.length > max) lines.push(`…and ${conflicts.length - max} more overlaps.`)
  return lines
}

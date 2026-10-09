export const EVENT_CATEGORIES = [
  'university',
  'work',
  'study',
  'german',
  'research',
  'personal',
  'deadline',
] as const

export type EventCategory = (typeof EVENT_CATEGORIES)[number]

/**
 * A calendar event. `start` and `end` are absolute instants (ISO 8601, UTC),
 * so they are unambiguous across DST changes. `timeZone` is the IANA zone the
 * event was entered in; wall-clock times are derived from it.
 *
 * Phase 2B can add optional `recurrence` / `exceptions` fields without
 * changing existing records.
 */
export interface CalendarEvent {
  id: string
  title: string
  category: EventCategory
  start: string
  end: string
  timeZone: string
  location?: string
  description?: string
  createdAt: string
  updatedAt: string
}

/** Everything the caller supplies; id and timestamps are set by the store. */
export type EventInput = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>

export interface StudyGoal {
  id: string
  subject: string
  targetHours: number
  doneHours: number
}

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

export const SESSION_TYPES = ['main', 'tutorial', 'seminar', 'practical', 'other'] as const
export type SessionType = (typeof SESSION_TYPES)[number]

/** Optional university metadata (course code, kind of session, group). */
export interface UniversityMeta {
  courseCode?: string
  sessionType?: SessionType
  /** Free-form group label, e.g. 'Group B'. */
  groupLabel?: string
}

/**
 * A one-off calendar event. `start` and `end` are absolute instants (ISO 8601,
 * UTC), so they are unambiguous across DST changes. `timeZone` is the IANA zone
 * the event was entered in; wall-clock times are derived from it.
 */
export interface CalendarEvent extends UniversityMeta {
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

// ---- Recurring schedules (Phase 2B) ----

/** Monday = 0 … Sunday = 6. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Per-occurrence change to a series, identified by the occurrence's ORIGINAL
 * scheduled date (so it stays attached even if the occurrence is moved).
 * Only differing fields are stored; everything else follows the series.
 * `start`/`end` are always set together (UTC instants) when moved or retimed.
 */
export interface OccurrenceOverride {
  title?: string
  category?: EventCategory
  start?: string
  end?: string
  /** '' clears the series location for this occurrence. */
  location?: string
  /** '' clears the series notes for this occurrence. */
  description?: string
  /** '' clears the series value for this occurrence. */
  courseCode?: string
  sessionType?: SessionType | ''
  groupLabel?: string
}

export interface SeriesException {
  /** 'YYYY-MM-DD' in the series time zone: the date this occurrence would normally fall on. */
  originalDate: string
  cancelled?: boolean
  override?: OccurrenceOverride
}

/**
 * A weekly repeating schedule stored as ONE record. Occurrences are generated
 * on demand. Times are local wall-clock times in `timeZone`, so a 09:00 class
 * stays at 09:00 across daylight saving changes.
 */
export interface RecurringSeries extends UniversityMeta {
  id: string
  title: string
  category: EventCategory
  timeZone: string
  location?: string
  description?: string
  recurrence: {
    frequency: 'weekly'
    weekdays: Weekday[]
    /** First active date (inclusive). */
    startDate: string
    /** Last active date (inclusive). */
    untilDate: string
  }
  /** Local 'HH:mm' on the occurrence date. */
  startTime: string
  /** Local 'HH:mm' on occurrence date + endDayOffset. */
  endTime: string
  /** 0 = same day, 1 = ends the next day (overnight), … up to 6. */
  endDayOffset: number
  exceptions: SeriesException[]
  createdAt: string
  updatedAt: string
}

export type SeriesInput = Omit<RecurringSeries, 'id' | 'createdAt' | 'updatedAt' | 'exceptions'>

/**
 * What the UI displays: a one-off event or one generated occurrence.
 * Occurrences have id `${seriesId}:${originalDate}` (stable across renders).
 */
export interface ScheduledItem extends CalendarEvent {
  seriesId?: string
  originalDate?: string
  /** Occurrence differs from its series (moved or edited). */
  modified?: boolean
  cancelled?: boolean
  /** A local time did not exist on this date (DST) and was shifted forward. */
  dstAdjusted?: boolean
}

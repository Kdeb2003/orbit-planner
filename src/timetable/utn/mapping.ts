import type { EventCategory, EventInput, SessionType } from '../../types/index.ts'
import { zonedTimeToUtc } from '../../utils/time.ts'
import type { SelectedSession } from './selection.ts'
import type { SessionKind, TimetableSession } from './types.ts'

/**
 * A reviewable DRAFT of a one-off calendar event for an extracted session.
 *
 * Nothing calls this on the import path yet and nothing is persisted: it only shows
 * (and tests) how verified sessions map onto the existing CalendarEvent model, using
 * real dated one-off events rather than invented weekly recurrences.
 */
export interface EventDraft {
  /**
   * Content-based identity (`utn-wise2627|date|start-end|code|type`). A future import
   * derives the row id from it with `deterministicUuid(`${userId}:event`, importKey)`
   * (src/cloud/ids.ts), so re-importing the same PDF content is idempotent.
   */
  importKey: string
  event: EventInput
}

export const SESSION_TYPE: Record<SessionKind, SessionType> = {
  main: 'main',
  tutorial: 'tutorial',
  project: 'other',
  excursion: 'other',
  language: 'other',
  other: 'other',
}

/** The provenance line written into an imported event's description. */
export function sourceDescription(session: Pick<TimetableSession, 'semesterWeek' | 'source'>): string {
  const pages = [...new Set(session.source.map((s) => s.page))].join(', ')
  return `UTN timetable WiSe 2026/27 (preliminary), semester week ${session.semesterWeek}, PDF page ${pages}.`
}

export function toEventDraft(item: SelectedSession): EventDraft {
  const { session, course } = item
  if (session.date === null) throw new Error(`Session ${session.sourceKey} has no date and cannot be mapped.`)
  const category: EventCategory = course.category
  const suffix = session.kind === 'tutorial' ? ' — Tutorial' : ''
  const location = session.location ? (session.location.kind === 'online' ? 'Online' : session.location.raw) : undefined
  const event: EventInput = {
    title: `${course.displayName}${suffix}`,
    category,
    start: zonedTimeToUtc(session.date, session.startTime, session.timeZone).toISOString(),
    end: zonedTimeToUtc(session.date, session.endTime, session.timeZone).toISOString(),
    timeZone: session.timeZone,
    courseCode: session.courseCode,
    sessionType: SESSION_TYPE[session.kind],
    ...(session.groups.length ? { groupLabel: `Group ${session.groups.join(', ')}` } : {}),
    ...(location ? { location } : {}),
    description: sourceDescription(session),
  }
  return { importKey: session.sourceKey, event }
}

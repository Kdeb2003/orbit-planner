import type { CalendarEvent, RecurringSeries, ScheduledItem } from '../types'
import type { CodeSessions, CourseMatch, CourseSession, CourseSuggestions, MatchableCourse } from '../types/planner'
import { expandSeries, occursOn } from '../utils/recurrence'
import { addDays, dateKey, isValidDateKey } from '../utils/time'
import type { DateKey } from '../utils/time'
import { normaliseCourseCode } from './normalise'

export { normaliseCourseCode, normaliseKey } from './normalise'

type TermClass = 'in' | 'out' | 'unknown' | 'invalid'

function classify(course: MatchableCourse, day: DateKey): TermClass {
  const hasStart = !!course.termStart
  const hasEnd = !!course.termEnd
  if (!hasStart && !hasEnd) return 'unknown'
  // Malformed term data (validation and the database forbid it) can never rule a course in or out.
  if (!hasStart || !hasEnd) return 'invalid'
  const { termStart, termEnd } = course
  if (!isValidDateKey(termStart!) || !isValidDateKey(termEnd!) || termEnd! < termStart!) return 'invalid'
  return day >= termStart! && day <= termEnd! ? 'in' : 'out'
}

/** The session's local date in its own zone, or undefined for an unreadable instant or zone. */
export function sessionDay(session: CourseSession): DateKey | undefined {
  const t = Date.parse(session.start)
  if (Number.isNaN(t)) return undefined
  try {
    return dateKey(new Date(t), session.timeZone)
  } catch {
    return undefined
  }
}

/**
 * Associate a session with one of the user's courses (DOMAIN_MODEL §6.2).
 * Active and archived courses both take part; institution never decides. Pure.
 */
export function matchCourse(session: CourseSession, courses: readonly MatchableCourse[]): CourseMatch {
  const key = normaliseCourseCode(session.courseCode)
  if (key === '') return { status: 'none' }
  const day = sessionDay(session)
  if (day === undefined) return { status: 'none' }

  const candidates = courses
    .filter((c) => normaliseCourseCode(c.code) === key)
    .map((course) => ({ course, term: classify(course, day) }))
  if (candidates.length === 0) return { status: 'none' }

  const remaining = candidates.filter((c) => c.term !== 'out')
  if (remaining.length === 0) return { status: 'outside-term' }

  // Rule 7: with several candidates left, only "exactly one dated-in and no undated" matches.
  // A candidate with malformed term data cannot be ruled out, so it prevents any confident match.
  if (remaining.some((c) => c.term === 'invalid')) return { status: 'ambiguous' }
  const dated = remaining.filter((c) => c.term === 'in')
  const undated = remaining.length - dated.length
  const unique = remaining.length === 1 || (dated.length === 1 && undated === 0) ? dated[0] ?? remaining[0] : undefined
  if (!unique) return { status: 'ambiguous' }
  return {
    status: 'matched',
    courseId: unique.course.id,
    confidence: unique.term === 'in' ? 'dated' : 'by-code',
    archived: unique.course.archivedAt !== undefined,
  }
}

/** The matched course, or undefined for `none`, `outside-term` and `ambiguous` (never a guess). */
export function courseForSession<C extends MatchableCourse>(
  session: CourseSession,
  courses: readonly C[],
): C | undefined {
  const m = matchCourse(session, courses)
  return m.status === 'matched' ? courses.find((c) => c.id === m.courseId) : undefined
}

/** Series are limited to ~3 years; never expand beyond this many days from a series' start. */
const MAX_SERIES_DAYS = 1100

/** A calendar item that can take part in matching: one-off events and generated occurrences alike. */
export type CalendarSession = ScheduledItem

/**
 * Every session of the calendar that carries a course code: one-off events, plus each recurring occurrence exactly
 * once, at its EFFECTIVE position (moved occurrences at their new date, edited codes applied, cancelled occurrences
 * dropped), via the same recurrence engine the calendar displays. Bounded: at most ~3 years per series, plus
 * wherever its occurrences were moved to.
 */
export function calendarSessions(events: readonly CalendarEvent[], series: readonly RecurringSeries[]): CalendarSession[] {
  const hasCode = (c: CourseSession) => normaliseCourseCode(c.courseCode) !== ''
  const out: CalendarSession[] = events.filter(hasCode)
  for (const s of series) {
    const r = s.recurrence
    const cap = addDays(r.startDate, MAX_SERIES_DAYS)
    let from: DateKey = r.startDate
    let to: DateKey = r.untilDate < cap ? r.untilDate : cap
    // an occurrence moved outside the series' own dates still exists where it was moved to
    for (const ex of s.exceptions) {
      const moved = ex.override?.start
      if (!moved || Number.isNaN(Date.parse(moved)) || !occursOn(s, ex.originalDate)) continue
      const d = dateKey(new Date(moved), s.timeZone)
      if (d < from) from = d
      if (d > to) to = d
    }
    for (const item of expandSeries(s, from, to)) if (hasCode(item)) out.push(item)
  }
  return out
}

type Bucket = Map<string, { count: number; first: DateKey; last: DateKey }>

function toList(b: Bucket): CodeSessions[] {
  return [...b.entries()]
    .sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0))
    .map(([code, v]) => ({ code, sessionCount: v.count, firstDate: v.first, lastDate: v.last }))
}

/**
 * Course codes in the calendar that no existing course resolves (acceptance C-9).
 * Suggests only; creates nothing. Pure, deterministic (sorted by code), idempotent.
 * Cancelled occurrences are not sessions. A code appears in several lists when its
 * sessions split (e.g. some inside a term, some outside); fully resolved codes appear in none.
 */
export function suggestCoursesFromEvents(
  events: readonly CalendarEvent[],
  series: readonly RecurringSeries[],
  courses: readonly MatchableCourse[],
): CourseSuggestions {
  const none: Bucket = new Map()
  const outside: Bucket = new Map()
  const ambiguous: Bucket = new Map()

  for (const session of calendarSessions(events, series)) {
    const day = sessionDay(session)
    if (day === undefined) continue
    const status = matchCourse(session, courses).status
    const bucket = status === 'none' ? none : status === 'outside-term' ? outside : status === 'ambiguous' ? ambiguous : undefined
    if (!bucket) continue
    const code = normaliseCourseCode(session.courseCode)
    const cur = bucket.get(code)
    if (!cur) bucket.set(code, { count: 1, first: day, last: day })
    else {
      cur.count += 1
      if (day < cur.first) cur.first = day
      if (day > cur.last) cur.last = day
    }
  }
  return { suggestions: toList(none), outsideTerm: toList(outside), ambiguous: toList(ambiguous) }
}

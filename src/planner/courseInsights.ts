import type { CourseColor, MatchableCourse } from '../types/planner'
import { COURSE_COLORS } from '../types/planner'
import { matchCourse, normaliseCourseCode, sessionDay } from './courses'
import type { CalendarSession } from './courses'
import type { DateKey } from '../utils/time'

/**
 * Read-only projections of "which calendar sessions belong to which course" (DOMAIN_MODEL §6). Everything here is
 * derived on demand from the calendar and the courses with the ONE matching algorithm (`matchCourse`); nothing is
 * stored, and no event, series or exception is ever touched (ACCEPTANCE C-8).
 */

/** Sessions of one course, by how they were matched. */
export interface CourseCounts {
  /** Matched because the session's date lies inside the course's term dates. */
  dated: number
  /** Matched by code only (the course has no term dates, and no other course shares the code). */
  byCode: number
}

/** Everything known about one code that at least one course uses. These are CODE-level numbers, not per course. */
export interface CodeLevel {
  /** Normalised code key (rule N). */
  code: string
  /** Every course (active or archived) using this code. */
  courseIds: string[]
  total: number
  dated: number
  byCode: number
  /** Sessions that cannot be told apart between several courses. */
  ambiguous: number
  /** Sessions whose date lies outside the term dates of every course with this code. */
  outsideTerm: number
}

/** A code in the calendar that no course uses yet. */
export interface SuggestionGroup {
  code: string
  sessionCount: number
  firstDate: DateKey
  lastDate: DateKey
  /** Title of the earliest session (ties: smallest id). */
  exampleTitle: string
  /** Most frequent session title (ties: the alphabetically first). Only a suggestion, never authoritative. */
  suggestedName: string
}

/** A code that needs attention because its sessions are outside every term or cannot be told apart. */
export interface AttentionGroup {
  code: string
  sessionCount: number
  firstDate: DateKey
  lastDate: DateKey
  exampleTitle: string
  suggestedName: string
  /** The existing courses that use this code. */
  courseIds: string[]
}

export interface CalendarInsights {
  perCourse: ReadonlyMap<string, CourseCounts>
  perCode: ReadonlyMap<string, CodeLevel>
  suggestions: SuggestionGroup[]
  outsideTerm: AttentionGroup[]
  ambiguous: AttentionGroup[]
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const cleanTitle = (t: string) => t.replace(/\s+/g, ' ').trim()

interface Acc {
  count: number
  first: DateKey
  last: DateKey
  firstStart: number
  firstId: string
  firstTitle: string
  titles: Map<string, number>
}

function add(map: Map<string, Acc>, code: string, day: DateKey, s: CalendarSession) {
  const start = Date.parse(s.start)
  const title = cleanTitle(s.title)
  let a = map.get(code)
  if (!a) {
    a = { count: 0, first: day, last: day, firstStart: start, firstId: s.id, firstTitle: title, titles: new Map() }
    map.set(code, a)
  }
  a.count++
  if (day < a.first) a.first = day
  if (day > a.last) a.last = day
  if (start < a.firstStart || (start === a.firstStart && s.id < a.firstId)) {
    a.firstStart = start
    a.firstId = s.id
    a.firstTitle = title
  }
  if (title) a.titles.set(title, (a.titles.get(title) ?? 0) + 1)
}

function describe(code: string, a: Acc) {
  let name = ''
  let best = -1
  for (const [t, n] of [...a.titles].sort(([x], [y]) => cmp(x, y))) {
    if (n > best) {
      best = n
      name = t
    }
  }
  return { code, sessionCount: a.count, firstDate: a.first, lastDate: a.last, exampleTitle: a.firstTitle, suggestedName: name || a.firstTitle }
}

export function analyseCalendar(sessions: readonly CalendarSession[], courses: readonly MatchableCourse[]): CalendarInsights {
  const perCourse = new Map<string, CourseCounts>()
  const perCode = new Map<string, CodeLevel>()
  const none = new Map<string, Acc>()
  const outside = new Map<string, Acc>()
  const ambiguous = new Map<string, Acc>()

  const idsByCode = new Map<string, string[]>()
  for (const c of courses) {
    const k = normaliseCourseCode(c.code)
    if (k !== '') idsByCode.set(k, [...(idsByCode.get(k) ?? []), c.id])
  }
  for (const c of courses) perCourse.set(c.id, { dated: 0, byCode: 0 })
  const level = (code: string): CodeLevel => {
    let l = perCode.get(code)
    if (!l) {
      l = { code, courseIds: idsByCode.get(code) ?? [], total: 0, dated: 0, byCode: 0, ambiguous: 0, outsideTerm: 0 }
      perCode.set(code, l)
    }
    return l
  }

  for (const s of sessions) {
    const code = normaliseCourseCode(s.courseCode)
    const day = sessionDay(s)
    if (code === '' || day === undefined) continue
    const m = matchCourse(s, courses)
    if (m.status === 'none') {
      add(none, code, day, s)
      continue
    }
    const l = level(code)
    l.total++
    if (m.status === 'matched') {
      const c = perCourse.get(m.courseId)!
      if (m.confidence === 'dated') {
        c.dated++
        l.dated++
      } else {
        c.byCode++
        l.byCode++
      }
    } else if (m.status === 'ambiguous') {
      l.ambiguous++
      add(ambiguous, code, day, s)
    } else if (m.status === 'outside-term') {
      l.outsideTerm++
      add(outside, code, day, s)
    }
  }

  const list = <T>(m: Map<string, Acc>, f: (code: string, a: Acc) => T): T[] => [...m].sort(([x], [y]) => cmp(x, y)).map(([code, a]) => f(code, a))
  const attention = (code: string, a: Acc): AttentionGroup => ({ ...describe(code, a), courseIds: idsByCode.get(code) ?? [] })
  return {
    perCourse,
    perCode,
    suggestions: list(none, describe),
    outsideTerm: list(outside, attention),
    ambiguous: list(ambiguous, attention),
  }
}

/** How a proposed course (new, or an edit of an existing one) would change which sessions are matched. */
export interface MatchImpact {
  /** Sessions matched today that would become ambiguous. */
  becomeAmbiguous: number
  /** Sessions matched today that would fall outside every term. */
  becomeOutsideTerm: number
  /** Sessions matched today that would no longer belong to any course (e.g. the code was changed). */
  becomeUnassigned: number
  /** The courses those sessions are matched to today. */
  fromCourseIds: string[]
}

export interface ProposedCourse {
  /** Set when editing an existing course (it is replaced by the proposal). */
  id?: string
  code?: string
  termStart?: string
  termEnd?: string
  archivedAt?: string
}

const PROPOSED_ID = '\u0000proposed'

/**
 * The real effect of saving `proposed`, computed with the real matching rules (not just "dates overlap"): the sessions
 * that are matched now and would stop being matched. Used for the non-blocking "this makes N sessions ambiguous" warning.
 */
export function matchImpact(sessions: readonly CalendarSession[], courses: readonly MatchableCourse[], proposed: ProposedCourse): MatchImpact {
  const old = proposed.id ? courses.find((c) => c.id === proposed.id) : undefined
  const keys = new Set([normaliseCourseCode(proposed.code), normaliseCourseCode(old?.code)].filter((k) => k !== ''))
  const out: MatchImpact = { becomeAmbiguous: 0, becomeOutsideTerm: 0, becomeUnassigned: 0, fromCourseIds: [] }
  if (keys.size === 0) return out
  const id = proposed.id ?? PROPOSED_ID
  const after: MatchableCourse[] = [...courses.filter((c) => c.id !== proposed.id), { id, code: proposed.code, termStart: proposed.termStart || undefined, termEnd: proposed.termEnd || undefined, archivedAt: proposed.archivedAt }]
  const from = new Set<string>()
  for (const s of sessions) {
    if (!keys.has(normaliseCourseCode(s.courseCode))) continue
    const before = matchCourse(s, courses)
    if (before.status !== 'matched') continue
    const next = matchCourse(s, after)
    if (next.status === 'matched' && next.courseId === (before.courseId === proposed.id ? id : before.courseId)) continue
    from.add(before.courseId)
    if (next.status === 'ambiguous') out.becomeAmbiguous++
    else if (next.status === 'outside-term') out.becomeOutsideTerm++
    else out.becomeUnassigned++
  }
  out.fromCourseIds = [...from].sort()
  return out
}

/** Colours for `n` new courses: first those no active course uses, then wrapping around. Deterministic. */
export function suggestColors(courses: readonly { color: CourseColor; archivedAt?: string }[], n: number): CourseColor[] {
  const used = new Set(courses.filter((c) => !c.archivedAt).map((c) => c.color))
  const free = COURSE_COLORS.filter((c) => !used.has(c))
  const order = [...free, ...COURSE_COLORS.filter((c) => used.has(c))]
  return Array.from({ length: n }, (_, i) => order[i % order.length])
}

/** What the calendar and the courses together say about ONE session, for a read-only annotation. */
export interface SessionCourse {
  courseId: string
  confidence: 'dated' | 'by-code'
  archived: boolean
}

/** The single course a session belongs to, or undefined (none, ambiguous and outside-term sessions are never annotated). */
export function sessionCourse(session: CalendarSession, courses: readonly MatchableCourse[]): SessionCourse | undefined {
  const m = matchCourse(session, courses)
  return m.status === 'matched' ? { courseId: m.courseId, confidence: m.confidence, archived: m.archived } : undefined
}

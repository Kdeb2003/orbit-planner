import { describe, expect, it } from 'vitest'
import type { CalendarEvent, RecurringSeries } from '../types'
import type { Course } from '../types/planner'
import { analyseCalendar, matchImpact, sessionCourse, suggestColors } from './courseInsights'
import { calendarSessions, suggestCoursesFromEvents } from './courses'

const event = (id: string, day: string, courseCode?: string, title = id): CalendarEvent => ({
  id, title, category: 'university', start: `${day}T09:00:00.000Z`, end: `${day}T10:30:00.000Z`,
  timeZone: 'Europe/Berlin', ...(courseCode && { courseCode }), createdAt: '', updatedAt: '',
})
const weekly = (id: string, courseCode: string, startDate: string, untilDate: string, title = id): RecurringSeries => ({
  id, title, category: 'university', timeZone: 'Europe/Berlin', courseCode,
  recurrence: { frequency: 'weekly', weekdays: [0], startDate, untilDate }, // Mondays
  startTime: '10:00', endTime: '11:30', endDayOffset: 0, exceptions: [], createdAt: '', updatedAt: '',
})
const course = (id: string, code: string | undefined, over: Partial<Course> = {}): Course => ({
  id, userId: 'u', name: id, color: 'c1', createdAt: '', updatedAt: '', ...(code !== undefined && { code }), ...over,
})
const analyse = (events: CalendarEvent[], series: RecurringSeries[], courses: Course[]) => analyseCalendar(calendarSessions(events, series), courses)

describe('calendar sessions', () => {
  it('counts each recurring occurrence once, drops cancelled ones, applies code overrides and finds moved occurrences wherever they went', () => {
    const s = weekly('s', 'X', '2026-11-02', '2026-11-23') // Mondays 2, 9, 16, 23
    s.exceptions = [
      { originalDate: '2026-11-02', cancelled: true },
      { originalDate: '2026-11-09', override: { courseCode: '' } }, // no longer a session of any course
      { originalDate: '2026-11-16', override: { start: '2027-03-02T09:00:00.000Z', end: '2027-03-02T10:00:00.000Z' } }, // moved far outside the series
    ]
    const sessions = calendarSessions([], [s])
    expect(sessions.map((x) => x.originalDate).sort()).toEqual(['2026-11-16', '2026-11-23'])
    expect(sessions.find((x) => x.originalDate === '2026-11-16')!.start).toBe('2027-03-02T09:00:00.000Z')
    const r = analyseCalendar(sessions, [])
    expect(r.suggestions).toEqual([expect.objectContaining({ code: 'X', sessionCount: 2, firstDate: '2026-11-23', lastDate: '2027-03-02' })])
  })

  it('a one-off event and a series with the same code are all counted, none twice', () => {
    const r = analyse([event('e1', '2026-11-05', 'x'), event('e2', '2026-11-05', ' X ')], [weekly('s', 'X', '2026-11-02', '2026-11-09')], [])
    expect(r.suggestions[0].sessionCount).toBe(4)
  })
})

describe('suggestions', () => {
  it('agree with suggestCoursesFromEvents on code, count and dates (one matching algorithm)', () => {
    const events = [event('a', '2026-11-05', 'inf 101'), event('b', '2026-11-20', 'INF  101'), event('c', '2027-03-15', 'X'), event('d', '2026-11-05', 'Y'), event('e', '2026-11-12', 'Y'), event('f', '2026-11-12')]
    const courses = [course('A', 'X', { termStart: '2026-10-01', termEnd: '2026-12-31' }), course('B', 'X', { termStart: '2027-04-01', termEnd: '2027-09-30' }), course('Y1', 'Y'), course('Y2', 'Y')]
    const old = suggestCoursesFromEvents(events, [], courses)
    const now = analyse(events, [], courses)
    const strip = (l: { code: string; sessionCount: number; firstDate: string; lastDate: string }[]) => l.map(({ code, sessionCount, firstDate, lastDate }) => ({ code, sessionCount, firstDate, lastDate }))
    expect(strip(now.suggestions)).toEqual(old.suggestions)
    expect(strip(now.outsideTerm)).toEqual(old.outsideTerm)
    expect(strip(now.ambiguous)).toEqual(old.ambiguous)
  })

  it('a code fully resolved by an existing course is not suggested; sessions without a code are ignored', () => {
    const r = analyse([event('a', '2026-11-05', 'X'), event('b', '2026-11-06'), event('c', '2026-11-06', '   ')], [], [course('A', 'x')])
    expect(r.suggestions).toEqual([])
    expect(r.outsideTerm).toEqual([])
    expect(r.ambiguous).toEqual([])
  })

  it('suggests the most frequent title, breaks ties alphabetically, and shows the earliest title as the example', () => {
    const events = [
      event('1', '2026-11-03', 'M', 'Lecture B'), event('2', '2026-11-10', 'M', 'Lecture A'), event('3', '2026-11-17', 'M', 'Lecture  A'), event('4', '2026-11-24', 'M', 'Lecture B'),
      event('5', '2026-11-02', 'T', 'Zebra'), event('6', '2026-11-09', 'T', 'Apple'),
    ]
    const r = analyse(events, [], [])
    const m = r.suggestions.find((x) => x.code === 'M')!
    expect(m.suggestedName).toBe('Lecture A') // 2 vs 2 → alphabetical; whitespace is collapsed first
    expect(m.exampleTitle).toBe('Lecture B') // the earliest session
    expect(r.suggestions.find((x) => x.code === 'T')).toMatchObject({ suggestedName: 'Apple', exampleTitle: 'Zebra' })
  })

  it('is deterministic and idempotent: input order does not matter, nothing is mutated', () => {
    const events = [event('1', '2026-11-03', 'M', 'A'), event('2', '2026-11-04', 'N', 'B'), event('3', '2026-11-05', 'M', 'C')]
    const before = JSON.stringify(events)
    const a = analyse(events, [], [])
    expect(analyse([...events].reverse(), [], [])).toEqual(a)
    expect(analyse(events, [], [])).toEqual(a)
    expect(JSON.stringify(events)).toBe(before)
  })

  it('reports a range longer than a term honestly (no clipping): first and last are the real dates', () => {
    const r = analyse([event('1', '2025-09-01', 'L'), event('2', '2027-01-15', 'L')], [], [])
    expect(r.suggestions[0]).toMatchObject({ firstDate: '2025-09-01', lastDate: '2027-01-15' })
  })

  it('lists outside-term and ambiguous groups with the courses that share the code', () => {
    const courses = [course('A', 'X', { termStart: '2026-10-01', termEnd: '2027-02-28' }), course('B', 'X', { termStart: '2027-04-01', termEnd: '2027-09-30' }), course('P', 'Y', { institution: 'P' }), course('Q', 'Y', { institution: 'Q' })]
    const r = analyse([event('o', '2027-03-15', 'X'), event('a', '2026-11-05', 'y')], [], courses)
    expect(r.outsideTerm).toEqual([expect.objectContaining({ code: 'X', sessionCount: 1, courseIds: ['A', 'B'] })])
    expect(r.ambiguous).toEqual([expect.objectContaining({ code: 'Y', sessionCount: 1, courseIds: ['P', 'Q'] })])
  })
})

describe('per-course counts', () => {
  it('separates dated matches, by-code matches, and the code-level ambiguous / outside-term sessions', () => {
    const A = course('A', 'X', { termStart: '2026-10-01', termEnd: '2027-02-28' })
    const B = course('B', 'X', { termStart: '2027-04-01', termEnd: '2027-09-30' })
    const U = course('U', 'U')
    const events = [event('1', '2026-11-10', 'X'), event('2', '2026-11-17', 'X'), event('3', '2027-05-01', 'X'), event('4', '2027-03-15', 'X'), event('5', '2026-11-10', 'U'), event('6', '2026-11-11')]
    const r = analyse(events, [], [A, B, U])
    expect(r.perCourse.get('A')).toEqual({ dated: 2, byCode: 0 })
    expect(r.perCourse.get('B')).toEqual({ dated: 1, byCode: 0 })
    expect(r.perCourse.get('U')).toEqual({ dated: 0, byCode: 1 })
    expect(r.perCode.get('X')).toMatchObject({ total: 4, dated: 3, ambiguous: 0, outsideTerm: 1, courseIds: ['A', 'B'] })
  })

  it('same code at two institutions with overlapping or missing dates is ambiguous and assigned to neither', () => {
    const P = course('P', 'X', { institution: 'P', termStart: '2026-10-01', termEnd: '2027-02-28' })
    const Q = course('Q', 'X', { institution: 'Q', termStart: '2026-10-01', termEnd: '2027-02-28' })
    const r = analyse([event('1', '2026-11-10', 'X')], [], [P, Q])
    expect(r.perCourse.get('P')).toEqual({ dated: 0, byCode: 0 })
    expect(r.perCourse.get('Q')).toEqual({ dated: 0, byCode: 0 })
    expect(r.perCode.get('X')).toMatchObject({ ambiguous: 1, total: 1 })
  })

  it('archived courses still take part in matching', () => {
    const old = course('A', 'X', { archivedAt: '2027-03-01T00:00:00Z' })
    const r = analyse([event('1', '2026-11-10', 'X')], [], [old])
    expect(r.perCourse.get('A')).toEqual({ dated: 0, byCode: 1 })
    expect(r.suggestions).toEqual([])
  })

  it('recurring sessions are counted per occurrence: cancelled and re-coded ones are not, moved ones count where they are', () => {
    const s = weekly('s', 'X', '2026-11-02', '2026-11-23')
    s.exceptions = [
      { originalDate: '2026-11-02', cancelled: true },
      { originalDate: '2026-11-09', override: { courseCode: 'OTHER' } },
      { originalDate: '2026-11-16', override: { start: '2027-06-01T09:00:00.000Z', end: '2027-06-01T10:00:00.000Z' } },
    ]
    const A = course('A', 'X', { termStart: '2026-10-01', termEnd: '2026-12-31' })
    const r = analyse([], [s], [A])
    expect(r.perCourse.get('A')).toEqual({ dated: 1, byCode: 0 }) // 23 Nov only
    expect(r.perCode.get('X')).toMatchObject({ total: 2, dated: 1, outsideTerm: 1 }) // the moved one is outside the term
    expect(r.suggestions.map((x) => x.code)).toEqual(['OTHER'])
  })
})

describe('matchImpact (C-12)', () => {
  const events = [event('1', '2026-11-10', 'X'), event('2', '2026-11-17', 'X'), event('3', '2026-11-17', 'Z')]
  const sessions = calendarSessions(events, [])
  const U = course('U', 'X')

  it('a second course with a reused code makes sessions that are matched by code ambiguous (counted with the real rules)', () => {
    const m = matchImpact(sessions, [U], { code: ' x ' })
    expect(m).toEqual({ becomeAmbiguous: 2, becomeOutsideTerm: 0, becomeUnassigned: 0, fromCourseIds: ['U'] })
  })

  it('a second course in a clearly different term does not disturb a dated match', () => {
    const dated = course('D', 'X', { termStart: '2026-10-01', termEnd: '2027-02-28' })
    expect(matchImpact(sessions, [dated], { code: 'X', termStart: '2027-04-01', termEnd: '2027-09-30' }).becomeAmbiguous).toBe(0)
    expect(matchImpact(sessions, [dated], { code: 'X', termStart: '2027-01-01', termEnd: '2027-09-30' }).becomeAmbiguous).toBe(0) // overlap of dates, but no session in it
    expect(matchImpact(sessions, [dated], { code: 'X', termStart: '2026-11-15', termEnd: '2027-09-30' }).becomeAmbiguous).toBe(1) // only the 17 Nov session
  })

  it('editing a course: narrowing its dates or changing its code unassigns sessions; unrelated codes are untouched', () => {
    const dated = course('D', 'X', { termStart: '2026-10-01', termEnd: '2027-02-28' })
    expect(matchImpact(sessions, [dated], { id: 'D', code: 'X', termStart: '2026-11-15', termEnd: '2027-02-28' })).toMatchObject({ becomeOutsideTerm: 1, fromCourseIds: ['D'] })
    expect(matchImpact(sessions, [dated], { id: 'D', code: 'Q', termStart: '2026-10-01', termEnd: '2027-02-28' })).toMatchObject({ becomeUnassigned: 2 })
    expect(matchImpact(sessions, [dated], { id: 'D', code: 'X', termStart: '2026-10-01', termEnd: '2027-02-28' })).toMatchObject({ becomeAmbiguous: 0, becomeOutsideTerm: 0, becomeUnassigned: 0 })
  })

  it('a course without a code affects nothing', () => {
    expect(matchImpact(sessions, [U], { code: '' })).toMatchObject({ becomeAmbiguous: 0 })
  })
})

describe('helpers', () => {
  it('suggestColors prefers colours no active course uses, then wraps; archived courses do not hold a colour', () => {
    const c = [{ color: 'c1' as const }, { color: 'c2' as const }, { color: 'c3' as const, archivedAt: 'x' }]
    expect(suggestColors(c, 3)).toEqual(['c3', 'c4', 'c5'])
    expect(suggestColors([], 9)[8]).toBe('c1')
    expect(suggestColors(c, 0)).toEqual([])
  })

  it('sessionCourse annotates only a confident single match', () => {
    const s = calendarSessions([event('1', '2026-11-10', 'X')], [])[0]
    expect(sessionCourse(s, [course('A', 'X')])).toEqual({ courseId: 'A', confidence: 'by-code', archived: false })
    expect(sessionCourse(s, [course('A', 'X', { termStart: '2026-10-01', termEnd: '2026-12-31', archivedAt: 'x' })])).toEqual({ courseId: 'A', confidence: 'dated', archived: true })
    expect(sessionCourse(s, [course('A', 'X'), course('B', 'X')])).toBeUndefined() // ambiguous: never guessed
    expect(sessionCourse(s, [course('A', 'X', { termStart: '2027-01-01', termEnd: '2027-02-01' })])).toBeUndefined() // outside term
    expect(sessionCourse(s, [])).toBeUndefined()
  })
})

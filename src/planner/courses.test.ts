import { describe, expect, it } from 'vitest'
import type { CalendarEvent, RecurringSeries } from '../types'
import type { CourseInput, CourseSession, MatchableCourse } from '../types/planner'
import vectors from './__fixtures__/normalisation-vectors.json'
import { validateCourseInput } from './courseValidation'
import { courseForSession, matchCourse, normaliseKey, suggestCoursesFromEvents } from './courses'

const course = (id: string, code: string | undefined, extra: Partial<MatchableCourse> = {}): MatchableCourse => ({
  id,
  code,
  ...extra,
})
const A = course('A', 'X', { termStart: '2026-10-01', termEnd: '2027-02-28' })
const B = course('B', 'X', { termStart: '2027-04-01', termEnd: '2027-09-30' })

/** A session at 10:00 Berlin on `day` (winter dates only, so 09:00Z). */
const on = (day: string, ...code: [string?]): CourseSession => ({
  courseCode: code.length ? code[0] : 'X',
  start: `${day}T09:00:00.000Z`,
  timeZone: 'Europe/Berlin',
})

describe('normaliseKey golden vectors (rule N)', () => {
  for (const v of vectors.vectors) {
    it(v.name, () => expect(normaliseKey(v.input)).toBe(v.key))
  }
  it('is idempotent', () => {
    for (const v of vectors.vectors) expect(normaliseKey(v.key)).toBe(v.key)
  })
})

describe('matchCourse', () => {
  it('no code or whitespace-only code → none', () => {
    expect(matchCourse(on('2026-11-10', undefined), [A])).toEqual({ status: 'none' })
    expect(matchCourse(on('2026-11-10', '  \t'), [A])).toEqual({ status: 'none' })
  })

  it('no course with that code → none', () => {
    expect(matchCourse(on('2026-11-10', 'Y'), [A])).toEqual({ status: 'none' })
    expect(matchCourse(on('2026-11-10'), [])).toEqual({ status: 'none' })
  })

  it('matches regardless of case and spacing', () => {
    expect(matchCourse(on('2026-11-10', 'inf  101'), [course('C', 'INF 101')])).toMatchObject({ status: 'matched', courseId: 'C' })
  })

  it('one undated course → matched by-code', () => {
    expect(matchCourse(on('2026-11-10'), [course('U', 'X')])).toEqual({
      status: 'matched', courseId: 'U', confidence: 'by-code', archived: false,
    })
  })

  it('one dated course containing the session → matched dated (term bounds inclusive)', () => {
    for (const day of ['2026-10-01', '2026-11-10', '2027-02-28']) {
      expect(matchCourse(on(day), [A])).toMatchObject({ status: 'matched', courseId: 'A', confidence: 'dated' })
    }
  })

  it('all dated candidates excluding the date → outside-term', () => {
    expect(matchCourse(on('2027-03-15'), [A, B])).toEqual({ status: 'outside-term' })
    expect(matchCourse(on('2026-09-30'), [A])).toEqual({ status: 'outside-term' })
  })

  it('cross-semester: the date picks the course', () => {
    expect(matchCourse(on('2026-11-10'), [A, B])).toMatchObject({ courseId: 'A', confidence: 'dated' })
    expect(matchCourse(on('2027-05-01'), [A, B])).toMatchObject({ courseId: 'B', confidence: 'dated' })
  })

  it('cross-semester, both undated → ambiguous', () => {
    expect(matchCourse(on('2026-11-10'), [course('P', 'X'), course('Q', 'X')])).toEqual({ status: 'ambiguous' })
  })

  it('one dated-in plus one undated → ambiguous', () => {
    expect(matchCourse(on('2026-11-10'), [A, course('U', 'X')])).toEqual({ status: 'ambiguous' })
  })

  it('one undated plus one dated-out → matched by-code (the out course is dropped)', () => {
    expect(matchCourse(on('2026-11-10'), [B, course('U', 'X')])).toMatchObject({ courseId: 'U', confidence: 'by-code' })
  })

  it('overlapping terms → ambiguous', () => {
    const A2 = course('A2', 'X', { termStart: '2026-12-01', termEnd: '2027-03-31' })
    expect(matchCourse(on('2026-12-15'), [A, A2])).toEqual({ status: 'ambiguous' })
    expect(matchCourse(on('2026-11-10'), [A, A2])).toMatchObject({ courseId: 'A' })
  })

  it('institution alone never decides: same code, same dates → ambiguous', () => {
    const P = { ...A, id: 'P', institution: 'Uni P' }
    const Q = { ...A, id: 'Q', institution: 'Uni Q' }
    expect(matchCourse(on('2026-11-10'), [P, Q])).toEqual({ status: 'ambiguous' })
  })

  it('same code at two institutions with disjoint terms is resolved by date', () => {
    const P = { ...A, id: 'P', institution: 'Uni P' }
    const Q = { ...B, id: 'Q', institution: 'Uni Q' }
    expect(matchCourse(on('2027-05-01'), [P, Q])).toMatchObject({ courseId: 'Q' })
  })

  it('archived: sole compatible candidate matches, flagged archived', () => {
    const old = { ...A, archivedAt: '2027-03-01T00:00:00Z' }
    expect(matchCourse(on('2026-11-10'), [old])).toEqual({ status: 'matched', courseId: 'A', confidence: 'dated', archived: true })
  })

  it('archived + active both remaining → ambiguous; archived with excluding term is dropped', () => {
    const archivedUndated = course('R', 'X', { archivedAt: '2027-03-01T00:00:00Z' })
    expect(matchCourse(on('2026-11-10'), [archivedUndated, course('U', 'X')])).toEqual({ status: 'ambiguous' })
    const oldA = { ...A, archivedAt: '2027-03-01T00:00:00Z' }
    expect(matchCourse(on('2027-05-01'), [oldA, B])).toMatchObject({ courseId: 'B', archived: false })
  })

  it('ambiguous / outside-term / none results never carry a course id', () => {
    const results = [
      matchCourse(on('2026-11-10'), [course('P', 'X'), course('Q', 'X')]),
      matchCourse(on('2027-03-15'), [A, B]),
      matchCourse(on('2026-11-10', 'Z'), [A]),
    ]
    for (const r of results) expect(r).not.toHaveProperty('courseId')
  })

  it('uses the local date in the session zone, not the UTC date', () => {
    const edge = course('E', 'X', { termStart: '2026-11-11', termEnd: '2026-11-30' })
    // 23:30Z on the 10th is 00:30 on the 11th in Berlin.
    expect(matchCourse({ courseCode: 'X', start: '2026-11-10T23:30:00Z', timeZone: 'Europe/Berlin' }, [edge])).toMatchObject({ status: 'matched' })
    expect(matchCourse({ courseCode: 'X', start: '2026-11-10T23:30:00Z', timeZone: 'UTC' }, [edge])).toEqual({ status: 'outside-term' })
  })

  it('term label and institution are ignored', () => {
    const withLabel = { ...A, termLabel: 'WS 26/27' } as MatchableCourse
    const other = { ...A, termLabel: 'something else' } as MatchableCourse
    expect(matchCourse(on('2026-11-10'), [withLabel])).toEqual(matchCourse(on('2026-11-10'), [other]))
  })

  it('invalid start or zone → none', () => {
    expect(matchCourse({ courseCode: 'X', start: 'nope', timeZone: 'Europe/Berlin' }, [A])).toEqual({ status: 'none' })
    expect(matchCourse({ courseCode: 'X', start: '2026-11-10T09:00:00Z', timeZone: 'Not/AZone' }, [A])).toEqual({ status: 'none' })
  })

  it('does not mutate inputs and repeats consistently', () => {
    const courses = [A, B, course('U', 'X')]
    const session = on('2026-11-10')
    const before = JSON.stringify({ courses, session })
    const first = matchCourse(session, courses)
    expect(matchCourse(session, courses)).toEqual(first)
    expect(JSON.stringify({ courses, session })).toBe(before)
  })
})

describe('matchCourse with malformed term data', () => {
  const only = (id: string, termStart?: string, termEnd?: string) => course(id, 'X', { termStart, termEnd })
  const cases: [string, MatchableCourse][] = [
    ['only termStart', only('M', '2026-10-01')],
    ['only termEnd', only('M', undefined, '2027-02-28')],
    ['invalid date', only('M', '2026-02-30', '2027-02-28')],
    ['non-date text', only('M', 'soon', 'later')],
    ['end before start', only('M', '2027-02-28', '2026-10-01')],
  ]
  for (const [name, bad] of cases) {
    it(`${name}: sole candidate → ambiguous, no id`, () => {
      const r = matchCourse(on('2026-11-10'), [bad])
      expect(r).toEqual({ status: 'ambiguous' })
      expect(r).not.toHaveProperty('courseId')
    })
    it(`${name}: prevents a confident match against a valid course`, () => {
      expect(matchCourse(on('2026-11-10'), [A, bad])).toEqual({ status: 'ambiguous' })
      expect(matchCourse(on('2027-03-15'), [A, bad])).toEqual({ status: 'ambiguous' })
    })
  }
  it('valid courses are unaffected by an unrelated malformed course with another code', () => {
    const other = course('O', 'OTHER', { termStart: '2026-10-01' })
    expect(matchCourse(on('2026-11-10'), [A, other])).toMatchObject({ status: 'matched', courseId: 'A' })
  })
  it('empty-string term dates count as absent', () => {
    expect(matchCourse(on('2026-11-10'), [only('E', '', '')])).toMatchObject({ status: 'matched', confidence: 'by-code' })
  })
})

describe('courseForSession', () => {
  it('returns the course only for a match', () => {
    const full = [{ ...A, name: 'Alpha' }, { ...B, name: 'Beta' }]
    expect(courseForSession(on('2027-05-01'), full)?.name).toBe('Beta')
    expect(courseForSession(on('2027-03-15'), full)).toBeUndefined()
  })
})

describe('validateCourseInput', () => {
  const base: CourseInput = { name: 'Algorithms', color: 'c1' }
  const fields = (i: CourseInput) => validateCourseInput(i).map((e) => e.field)

  it('accepts a name only', () => expect(validateCourseInput(base)).toEqual([]))
  it('accepts a full valid course', () => {
    expect(validateCourseInput({ ...base, code: 'INF 101', institution: 'U', termLabel: 'WS', termStart: '2026-10-01', termEnd: '2027-02-28', description: 'd' })).toEqual([])
  })
  it('requires a name', () => {
    expect(fields({ ...base, name: '   ' })).toEqual(['name'])
    expect(fields({ ...base, name: 'x'.repeat(121) })).toEqual(['name'])
  })
  it('rejects an empty-key or too long code', () => {
    expect(fields({ ...base, code: '   ' })).toEqual(['code'])
    expect(fields({ ...base, code: 'x'.repeat(31) })).toEqual(['code'])
  })
  it('rejects an unknown colour', () => expect(fields({ ...base, color: '#fff' as CourseInput['color'] })).toEqual(['color']))

  describe('term dates (C-6)', () => {
    it('both or neither', () => {
      expect(fields({ ...base, termStart: '2026-10-01' })).toEqual(['termEnd'])
      expect(fields({ ...base, termEnd: '2026-10-01' })).toEqual(['termStart'])
    })
    it('real dates only', () => {
      expect(fields({ ...base, termStart: '2026-02-30', termEnd: '2026-03-30' })).toEqual(['termStart'])
      expect(fields({ ...base, termStart: '2026-10-01', termEnd: 'soon' })).toEqual(['termEnd'])
    })
    it('end not before start; same day allowed', () => {
      expect(fields({ ...base, termStart: '2026-10-02', termEnd: '2026-10-01' })).toEqual(['termEnd'])
      expect(validateCourseInput({ ...base, termStart: '2026-10-01', termEnd: '2026-10-01' })).toEqual([])
    })
    it('span is at most 400 days', () => {
      expect(validateCourseInput({ ...base, termStart: '2026-01-01', termEnd: '2027-02-05' })).toEqual([]) // 400 days
      expect(fields({ ...base, termStart: '2026-01-01', termEnd: '2027-02-06' })).toEqual(['termEnd']) // 401 days
    })
    it('does not mutate input', () => {
      const input = { ...base, termStart: '2026-10-02', termEnd: '2026-10-01' }
      const copy = structuredClone(input)
      validateCourseInput(input)
      expect(input).toEqual(copy)
    })
  })
})

describe('suggestCoursesFromEvents', () => {
  const event = (id: string, day: string, courseCode?: string): CalendarEvent => ({
    id, title: id, category: 'university', start: `${day}T09:00:00.000Z`, end: `${day}T10:30:00.000Z`,
    timeZone: 'Europe/Berlin', ...(courseCode && { courseCode }), createdAt: '', updatedAt: '',
  })
  const weekly = (id: string, courseCode: string, startDate: string, untilDate: string): RecurringSeries => ({
    id, title: id, category: 'university', timeZone: 'Europe/Berlin', courseCode,
    recurrence: { frequency: 'weekly', weekdays: [0], startDate, untilDate },
    startTime: '10:00', endTime: '11:30', endDayOffset: 0, exceptions: [], createdAt: '', updatedAt: '',
  })

  it('one suggestion per distinct normalised code, with first/last session dates', () => {
    const events = [event('e1', '2026-11-20', 'inf 101'), event('e2', '2026-11-05', 'INF  101'), event('e3', '2026-11-10')]
    const series = [weekly('s1', 'MA 1', '2026-11-02', '2026-11-16')] // Mondays 2, 9, 16
    expect(suggestCoursesFromEvents(events, series, [])).toEqual({
      suggestions: [
        { code: 'INF 101', sessionCount: 2, firstDate: '2026-11-05', lastDate: '2026-11-20' },
        { code: 'MA 1', sessionCount: 3, firstDate: '2026-11-02', lastDate: '2026-11-16' },
      ],
      outsideTerm: [],
      ambiguous: [],
    })
  })

  it('does not suggest codes an existing course resolves', () => {
    const events = [event('e1', '2026-11-05', 'X'), event('e2', '2026-11-06', 'NEW')]
    const r = suggestCoursesFromEvents(events, [], [A])
    expect(r.suggestions.map((s) => s.code)).toEqual(['NEW'])
    expect(r.outsideTerm).toEqual([])
    expect(r.ambiguous).toEqual([])
  })

  it('lists outside-term and ambiguous codes separately, with their own dates', () => {
    const events = [
      event('o1', '2027-03-15', 'X'), // between A and B
      event('o2', '2027-03-20', 'X'),
      event('a1', '2026-11-05', 'Y'),
      event('a2', '2026-11-12', 'Y'),
    ]
    const courses = [A, B, course('Y1', 'Y'), course('Y2', 'Y')]
    expect(suggestCoursesFromEvents(events, [], courses)).toEqual({
      suggestions: [],
      outsideTerm: [{ code: 'X', sessionCount: 2, firstDate: '2027-03-15', lastDate: '2027-03-20' }],
      ambiguous: [{ code: 'Y', sessionCount: 2, firstDate: '2026-11-05', lastDate: '2026-11-12' }],
    })
  })

  it('archived courses resolve their codes', () => {
    const old = { ...A, archivedAt: '2027-03-01T00:00:00Z' }
    expect(suggestCoursesFromEvents([event('e', '2026-11-05', 'X')], [], [old])).toEqual({ suggestions: [], outsideTerm: [], ambiguous: [] })
  })

  it('ignores cancelled occurrences and sessions without a code', () => {
    const s = weekly('s', 'Z', '2026-11-02', '2026-11-16')
    s.exceptions = [{ originalDate: '2026-11-02', cancelled: true }, { originalDate: '2026-11-09', override: { courseCode: '' } }]
    const r = suggestCoursesFromEvents([event('e', '2026-11-05')], [s], [])
    expect(r.suggestions).toEqual([{ code: 'Z', sessionCount: 1, firstDate: '2026-11-16', lastDate: '2026-11-16' }])
  })

  it('ignores whitespace-only codes on one-off events', () => {
    const events = [event('e1', '2026-11-05', '  	'), event('e2', '2026-11-06', '   ')]
    expect(suggestCoursesFromEvents(events, [], [])).toEqual({ suggestions: [], outsideTerm: [], ambiguous: [] })
  })

  it('ignores whitespace-only codes on recurring sessions, keeps valid ones', () => {
    const blank = weekly('b', '   ', '2026-11-02', '2026-11-16')
    const good = weekly('g', ' ma 1 ', '2026-11-02', '2026-11-09')
    const r = suggestCoursesFromEvents([], [blank, good], [])
    expect(r.suggestions).toEqual([{ code: 'MA 1', sessionCount: 2, firstDate: '2026-11-02', lastDate: '2026-11-09' }])
  })

  it('lists one code in each affected category when its sessions split', () => {
    // X: undated + dated-in A overlap → ambiguous in A's term; outside every term otherwise.
    const courses = [course('A1', 'X', { termStart: '2026-10-01', termEnd: '2026-12-31' }), course('A2', 'X', { termStart: '2026-11-01', termEnd: '2027-01-31' }), course('A3', 'X', { termStart: '2026-10-01', termEnd: '2027-01-31' })]
    const events = [event('amb', '2026-11-10', 'X'), event('out', '2027-06-01', 'X')]
    const r = suggestCoursesFromEvents(events, [], courses)
    expect(r.ambiguous).toEqual([{ code: 'X', sessionCount: 1, firstDate: '2026-11-10', lastDate: '2026-11-10' }])
    expect(r.outsideTerm).toEqual([{ code: 'X', sessionCount: 1, firstDate: '2027-06-01', lastDate: '2027-06-01' }])
    expect(r.suggestions).toEqual([])
  })

  it('does not mutate inputs and is idempotent', () => {
    const events = [event('e1', '2026-11-05', 'N'), event('e2', '2026-11-06', 'M')]
    const series = [weekly('s', 'N', '2026-11-02', '2026-11-30')]
    const courses = [A]
    const before = JSON.stringify({ events, series, courses })
    const first = suggestCoursesFromEvents(events, series, courses)
    expect(suggestCoursesFromEvents(events, series, courses)).toEqual(first)
    expect(suggestCoursesFromEvents([...events].reverse(), series, courses)).toEqual(first)
    expect(JSON.stringify({ events, series, courses })).toBe(before)
  })

  it('stays bounded for a very long series', () => {
    const long = weekly('long', 'L', '2026-01-05', '2099-12-31')
    const r = suggestCoursesFromEvents([], [long], [])
    expect(r.suggestions[0].sessionCount).toBeLessThanOrEqual(160) // ≤ 1100 days of weekly occurrences
  })
})

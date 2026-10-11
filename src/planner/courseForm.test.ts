import { describe, expect, it } from 'vitest'
import type { Course } from '../types/planner'
import { changedFields, courseFieldErrors, courseMatchesForm, courseToForm, emptyCourseForm, findSameKey, formToInput, nextFreeColor } from './courseForm'
import { sharedCodeCourses } from './courseOverlap'

const course = (over: Partial<Course> & Pick<Course, 'id' | 'name'>): Course => ({
  userId: 'u',
  color: 'c1',
  createdAt: '2026-01-01T00:00:00+00:00',
  updatedAt: '2026-01-01T00:00:00+00:00',
  ...over,
})

describe('form values', () => {
  it('a new form has only defaults, and a stored course round-trips through the form', () => {
    expect(emptyCourseForm('c3')).toEqual({ name: '', code: '', institution: '', termLabel: '', termStart: '', termEnd: '', description: '', color: 'c3' })
    const c = course({ id: '1', name: 'A', code: 'X 1', termStart: '2026-10-01', termEnd: '2027-02-01', color: 'c5' })
    const f = courseToForm(c)
    expect(f).toMatchObject({ name: 'A', code: 'X 1', institution: '', termStart: '2026-10-01', color: 'c5' })
    expect(courseMatchesForm(c, f)).toBe(true)
    expect(courseMatchesForm(c, { ...f, name: 'B' })).toBe(false)
    expect(changedFields(c, { ...f, name: 'B', termEnd: '' })).toEqual(['Name', 'Term end'])
  })

  it('reports the first message per field using the shared validator', () => {
    const f = { ...emptyCourseForm('c1'), name: ' ', termStart: '2026-10-12' }
    expect(courseFieldErrors(f)).toEqual({ name: 'Name is required.', termEnd: 'Set both term dates or neither.' })
    expect(courseFieldErrors({ ...f, name: 'ok', termStart: '', termEnd: '' })).toEqual({})
    expect(formToInput(f)).toMatchObject({ name: ' ', color: 'c1' })
  })

  it('picks the first colour no active course uses (archived ones do not count), and wraps around', () => {
    expect(nextFreeColor([])).toBe('c1')
    expect(nextFreeColor([course({ id: '1', name: 'a', color: 'c1' }), course({ id: '2', name: 'b', color: 'c2', archivedAt: 'x' })])).toBe('c2')
    const all = (['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const).map((color, i) => course({ id: String(i), name: 'n', color }))
    expect(all).toHaveLength(8)
    expect(nextFreeColor(all)).toBe('c1')
  })

  it('finds the course the database would call a duplicate (rule N on code, institution and term label)', () => {
    const existing = course({ id: '1', name: 'Algebra', code: 'MATH 101', institution: 'Uni', termLabel: 'WS' })
    const base = { code: ' math  101', institution: 'UNI ', termLabel: 'ws' }
    expect(findSameKey([existing], base)?.id).toBe('1')
    expect(findSameKey([existing], base, '1')).toBeUndefined() // itself is not a duplicate
    expect(findSameKey([existing], { ...base, termLabel: 'SS' })).toBeUndefined()
    expect(findSameKey([existing], { ...base, institution: 'Other' })).toBeUndefined()
    expect(findSameKey([existing], { ...base, code: '' })).toBeUndefined() // no code, no uniqueness
  })
})

describe('sharedCodeCourses', () => {
  const a = course({ id: 'a', name: 'A', code: 'CS 1', termStart: '2026-10-01', termEnd: '2027-02-01' })
  it('ignores other codes, itself, and clearly separate terms', () => {
    const b = course({ id: 'b', name: 'B', code: 'cs  1', termStart: '2027-04-01', termEnd: '2027-08-01' })
    const c = course({ id: 'c', name: 'C', code: 'OTHER' })
    expect(sharedCodeCourses([a, b, c], a)).toEqual([])
  })
  it('flags overlapping terms (touching ends count) and missing dates on either side, whatever the institution', () => {
    const overlap = course({ id: 'o', name: 'O', code: 'CS 1', institution: 'Elsewhere', termStart: '2027-02-01', termEnd: '2027-06-01' })
    const undated = course({ id: 'u', name: 'U', code: 'cs 1' })
    expect(sharedCodeCourses([a, overlap, undated], a).map((s) => [s.course.id, s.reason])).toEqual([['o', 'overlap'], ['u', 'missing']])
  })
  it('an unsaved form without dates conflicts with any same-code course; a form without a code with none', () => {
    expect(sharedCodeCourses([a], { code: ' cs 1' }).map((s) => s.reason)).toEqual(['missing'])
    expect(sharedCodeCourses([a], { code: '', termStart: '', termEnd: '' })).toEqual([])
    expect(sharedCodeCourses([a], { code: 'CS 1', termStart: '2028-01-01', termEnd: '2028-05-01' })).toEqual([])
  })
})

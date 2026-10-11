import { describe, expect, it } from 'vitest'
import { COURSE_LIMITS } from '../planner/courseValidation'
import type { CourseInput } from '../types/planner'
import {
  COURSE_COLUMNS,
  coursePatch,
  courseProblems,
  courseToWrite,
  rowMatchesWrite,
  rowToCourse,
} from './plannerMappers'
import type { CourseRow } from './plannerTypes'

const ID = 'c0c0c0c0-0000-4000-8000-000000000001'
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

const input: CourseInput = {
  name: ' Linear Algebra ',
  code: ' MATH 101 ',
  institution: 'Example University',
  termLabel: 'WS 26/27',
  termStart: '2026-10-12',
  termEnd: '2027-02-12',
  description: 'Synthetic description',
  color: 'c3',
}

const row = (over: Partial<CourseRow> = {}): CourseRow => ({
  id: ID,
  user_id: USER,
  name: 'Linear Algebra',
  code: 'MATH 101',
  institution: 'Example University',
  term_label: 'WS 26/27',
  term_start: '2026-10-12',
  term_end: '2027-02-12',
  description: 'Synthetic description',
  color: 'c3',
  archived_at: null,
  created_at: '2026-10-01T09:00:00.123456+00:00',
  updated_at: '2026-10-02T09:00:00.654321+00:00',
  ...over,
})

describe('courseToWrite / coursePatch', () => {
  it('maps a full input to the writable columns, trimming text and keeping the id', () => {
    expect(courseToWrite(input, ID)).toEqual({
      id: ID,
      name: 'Linear Algebra',
      code: 'MATH 101',
      institution: 'Example University',
      term_label: 'WS 26/27',
      term_start: '2026-10-12',
      term_end: '2027-02-12',
      description: 'Synthetic description',
      color: 'c3',
    })
  })

  it('writes NULL for every absent or blank optional field', () => {
    const minimal: CourseInput = { name: 'Only a name', color: 'c1' }
    expect(coursePatch(minimal)).toEqual({
      name: 'Only a name',
      code: null,
      institution: null,
      term_label: null,
      term_start: null,
      term_end: null,
      description: null,
      color: 'c1',
    })
    const blanks: CourseInput = { name: 'X', code: '', institution: '   ', termLabel: '', termStart: '', termEnd: '', description: '\n ', color: 'c2' }
    expect(coursePatch(blanks)).toMatchObject({ code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null })
    expect(Object.values(coursePatch(minimal)).filter((v) => v === '')).toEqual([])
  })

  it('sends every writable key explicitly on update, so a cleared field is written as NULL (never omitted)', () => {
    expect(Object.keys(coursePatch({ name: 'X', color: 'c1' })).sort()).toEqual(
      ['code', 'color', 'description', 'institution', 'name', 'term_end', 'term_label', 'term_start'],
    )
  })

  it('never carries owner, timestamps, archive state or the SQL-generated key columns', () => {
    const w = courseToWrite(input, ID) as Record<string, unknown>
    for (const k of ['user_id', 'created_at', 'updated_at', 'archived_at', 'code_key', 'institution_key', 'term_key']) {
      expect(k in w, k).toBe(false)
    }
    // user-controlled extra properties on the input are not forwarded either
    const sneaky = { ...input, userId: 'x', user_id: 'y', code_key: 'Z', archivedAt: 'now', updatedAt: 'q' } as unknown as CourseInput
    const keys = Object.keys(courseToWrite(sneaky, ID)).sort()
    expect(keys).toEqual(['code', 'color', 'description', 'id', 'institution', 'name', 'term_end', 'term_label', 'term_start'])
  })

  it('keeps internal whitespace of a code (the database key collapses it; the display value is the user\'s)', () => {
    expect(coursePatch({ name: 'X', code: 'inf   101', color: 'c1' }).code).toBe('inf   101')
  })

  it('selects an explicit column list that does not include the generated key columns', () => {
    expect(COURSE_COLUMNS.split(',')).toEqual([
      'id', 'user_id', 'name', 'code', 'institution', 'term_label', 'term_start', 'term_end', 'description', 'color', 'archived_at', 'created_at', 'updated_at',
    ])
  })
})

describe('courseProblems (client validation against COURSE_LIMITS)', () => {
  it('accepts a valid course and a minimal one', () => {
    expect(courseProblems(input)).toEqual([])
    expect(courseProblems({ name: 'A', color: 'c8' })).toEqual([])
  })

  it('rejects over-long fields at exactly one past each limit, and accepts the limit itself', () => {
    const base: CourseInput = { name: 'A', color: 'c1' }
    for (const [field, limit] of [['name', COURSE_LIMITS.name], ['code', COURSE_LIMITS.code], ['institution', COURSE_LIMITS.institution], ['termLabel', COURSE_LIMITS.termLabel], ['description', COURSE_LIMITS.description]] as const) {
      expect(courseProblems({ ...base, [field]: 'a'.repeat(limit) }), `${field} at limit`).toEqual([])
      expect(courseProblems({ ...base, [field]: 'a'.repeat(limit + 1) }).length, `${field} over limit`).toBeGreaterThan(0)
    }
  })

  it('rejects a blank name, a whitespace-only code, a lone term date, a reversed or over-long term and unknown colours', () => {
    expect(courseProblems({ name: '   ', color: 'c1' })).not.toEqual([])
    expect(courseProblems({ name: 'A', code: '   ', color: 'c1' })).not.toEqual([])
    expect(courseProblems({ name: 'A', termStart: '2026-10-12', color: 'c1' })).not.toEqual([])
    expect(courseProblems({ name: 'A', termStart: '2026-10-12', termEnd: '2026-10-01', color: 'c1' })).not.toEqual([])
    expect(courseProblems({ name: 'A', termStart: '2026-01-01', termEnd: '2027-03-01', color: 'c1' })).not.toEqual([])
    expect(courseProblems({ name: 'A', color: 'red' as never })).not.toEqual([])
  })
})

describe('rowToCourse', () => {
  it('maps a full row, keeping the raw timestamps byte for byte', () => {
    expect(rowToCourse(row())).toEqual({
      id: ID,
      userId: USER,
      name: 'Linear Algebra',
      code: 'MATH 101',
      institution: 'Example University',
      termLabel: 'WS 26/27',
      termStart: '2026-10-12',
      termEnd: '2027-02-12',
      description: 'Synthetic description',
      color: 'c3',
      createdAt: '2026-10-01T09:00:00.123456+00:00',
      updatedAt: '2026-10-02T09:00:00.654321+00:00',
    })
  })

  it('reads NULL (and a stored empty string) as an absent field, and keeps the archive instant raw', () => {
    const c = rowToCourse(row({ code: null, institution: '', term_label: null, term_start: null, term_end: null, description: null, archived_at: '2026-10-05T10:00:00.000001+00:00' }))!
    expect(c).not.toHaveProperty('code')
    expect(c).not.toHaveProperty('institution')
    expect(c).not.toHaveProperty('termStart')
    expect(c).not.toHaveProperty('description')
    expect(c.archivedAt).toBe('2026-10-05T10:00:00.000001+00:00')
  })

  it('does not trim or otherwise repair stored data', () => {
    expect(rowToCourse(row({ name: '  padded  ' }))!.name).toBe('  padded  ')
  })

  it('rejects rows that are malformed or break a course rule (they are skipped by the caller, never shown half-parsed)', () => {
    const bad: Partial<CourseRow>[] = [
      { id: 'not-a-uuid' },
      { name: '   ' },
      { name: 'a'.repeat(COURSE_LIMITS.name + 1) },
      { color: 'c9' },
      { term_start: '2026-10-12', term_end: null },
      { term_start: '2027-02-12', term_end: '2026-10-12' },
      { term_start: '2026-13-40', term_end: '2026-14-40' },
      { code: '   ' },
      { created_at: 'yesterday' },
      { updated_at: '' },
      { archived_at: 'sometime' },
      { user_id: '' },
      { name: 42 as unknown as string },
      { code: 7 as unknown as string },
    ]
    for (const b of bad) expect(rowToCourse(row(b)), JSON.stringify(b)).toBeNull()
  })

  it('ignores unknown extra columns such as the generated keys', () => {
    const c = rowToCourse({ ...row(), code_key: 'MATH 101', institution_key: 'X', term_key: 'Y' } as CourseRow)
    expect(c).not.toBeNull()
    expect(c).not.toHaveProperty('code_key')
  })
})

describe('rowMatchesWrite (verifying an existing id on a retried create)', () => {
  const write = courseToWrite(input, ID)
  it('is true for the row we wrote, treating NULL and blank as the same', () => {
    expect(rowMatchesWrite(row(), write)).toBe(true)
    const sparse = courseToWrite({ name: 'N', color: 'c1' }, ID)
    expect(rowMatchesWrite(row({ name: 'N', code: null, institution: '', term_label: null, term_start: null, term_end: null, description: null, color: 'c1' }), sparse)).toBe(true)
  })
  it('is false when anything differs', () => {
    expect(rowMatchesWrite(row({ name: 'Other' }), write)).toBe(false)
    expect(rowMatchesWrite(row({ code: 'MATH 102' }), write)).toBe(false)
    expect(rowMatchesWrite(row({ color: 'c4' }), write)).toBe(false)
    expect(rowMatchesWrite(row({ term_end: '2027-02-13' }), write)).toBe(false)
    expect(rowMatchesWrite(row({ id: 'c0c0c0c0-0000-4000-8000-000000000009' }), write)).toBe(false)
  })
})

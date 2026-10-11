import type { Course } from '../types/planner'
import { isValidDateKey } from '../utils/time'
import { normaliseCourseCode } from './normalise'

/** The fields of a course (or of an unsaved form) that decide whether it can be told apart from another. */
export interface OverlapSubject {
  id?: string
  code?: string
  termStart?: string
  termEnd?: string
}

export interface SharedCode {
  course: Course
  /** `missing`: one of the two has no usable term dates; `overlap`: both have dates and the terms intersect. */
  reason: 'missing' | 'overlap'
}

const range = (c: OverlapSubject): [string, string] | null => {
  const { termStart: a, termEnd: b } = c
  return a && b && isValidDateKey(a) && isValidDateKey(b) && b >= a ? [a, b] : null
}

/**
 * Other courses that share this course's normalised code AND cannot be told apart by term dates (DOMAIN_MODEL §6.2:
 * institution never decides). Courses with the same code in clearly separate terms are fine and are not returned.
 * Archived courses take part. Non-blocking information only: the database's uniqueness rule stays authoritative.
 */
export function sharedCodeCourses(courses: readonly Course[], subject: OverlapSubject): SharedCode[] {
  const key = normaliseCourseCode(subject.code)
  if (key === '') return []
  const mine = range(subject)
  const out: SharedCode[] = []
  for (const course of courses) {
    if (course.id === subject.id || normaliseCourseCode(course.code) !== key) continue
    const theirs = range(course)
    if (!mine || !theirs) out.push({ course, reason: 'missing' })
    else if (mine[0] <= theirs[1] && theirs[0] <= mine[1]) out.push({ course, reason: 'overlap' })
  }
  return out
}

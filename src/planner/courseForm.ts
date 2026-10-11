import { COURSE_COLORS } from '../types/planner'
import type { Course, CourseColor, CourseInput } from '../types/planner'
import { validateCourseInput } from './courseValidation'
import { normaliseKey } from './normalise'

/** Text-field state of the course form: every value is a plain string ('' = not given). */
export interface CourseFormValues {
  name: string
  code: string
  institution: string
  termLabel: string
  termStart: string
  termEnd: string
  description: string
  color: CourseColor
}

export type CourseFieldErrors = Partial<Record<keyof CourseInput, string>>

export const COURSE_COLOR_NAMES: Record<CourseColor, string> = {
  c1: 'Violet',
  c2: 'Blue',
  c3: 'Cyan',
  c4: 'Green',
  c5: 'Amber',
  c6: 'Orange',
  c7: 'Pink',
  c8: 'Red',
}

/** First colour no active course uses yet (wraps around when all eight are taken). */
export function nextFreeColor(courses: readonly Course[]): CourseColor {
  const used = new Set(courses.filter((c) => !c.archivedAt).map((c) => c.color))
  return COURSE_COLORS.find((c) => !used.has(c)) ?? COURSE_COLORS[courses.length % COURSE_COLORS.length]
}

export const emptyCourseForm = (color: CourseColor): CourseFormValues => ({
  name: '',
  code: '',
  institution: '',
  termLabel: '',
  termStart: '',
  termEnd: '',
  description: '',
  color,
})

export const courseToForm = (c: Course): CourseFormValues => ({
  name: c.name,
  code: c.code ?? '',
  institution: c.institution ?? '',
  termLabel: c.termLabel ?? '',
  termStart: c.termStart ?? '',
  termEnd: c.termEnd ?? '',
  description: c.description ?? '',
  color: c.color,
})

/** Form text -> `CourseInput`. Blank optionals stay '' (the mapper stores them as NULL, which also clears them on edit). */
export const formToInput = (v: CourseFormValues): CourseInput => ({ ...v })

/** First message per field from the shared validator (the same rules as the database CHECKs). */
export function courseFieldErrors(v: CourseFormValues): CourseFieldErrors {
  const out: CourseFieldErrors = {}
  for (const e of validateCourseInput(formToInput(v))) out[e.field] ??= e.message
  return out
}

/** Does this stored course hold exactly what the form says? (blank and absent are the same). Used after an uncertain save. */
export function courseMatchesForm(c: Course, v: CourseFormValues): boolean {
  const a = courseToForm(c)
  const norm = (x: string) => x.trim()
  return (
    norm(a.name) === norm(v.name) &&
    norm(a.code) === norm(v.code) &&
    norm(a.institution) === norm(v.institution) &&
    norm(a.termLabel) === norm(v.termLabel) &&
    a.termStart === v.termStart &&
    a.termEnd === v.termEnd &&
    norm(a.description) === norm(v.description) &&
    a.color === v.color
  )
}

/** The course the database would call a duplicate: same normalised code, institution and term label (rule N). */
export function findSameKey(courses: readonly Course[], v: Pick<CourseFormValues, 'code' | 'institution' | 'termLabel'>, excludeId?: string): Course | undefined {
  const code = normaliseKey(v.code)
  if (code === '') return undefined
  const inst = normaliseKey(v.institution)
  const term = normaliseKey(v.termLabel)
  return courses.find(
    (c) =>
      c.id !== excludeId &&
      normaliseKey(c.code ?? '') === code &&
      normaliseKey(c.institution ?? '') === inst &&
      normaliseKey(c.termLabel ?? '') === term,
  )
}

/** Labels of the fields that differ between a stored course and the form (for the stale-edit review). */
export function changedFields(c: Course, v: CourseFormValues): string[] {
  const a = courseToForm(c)
  const labels: [keyof CourseFormValues, string][] = [
    ['name', 'Name'],
    ['code', 'Code'],
    ['institution', 'Institution'],
    ['termLabel', 'Term label'],
    ['termStart', 'Term start'],
    ['termEnd', 'Term end'],
    ['description', 'Description'],
    ['color', 'Colour'],
  ]
  return labels.filter(([k]) => String(a[k]).trim() !== String(v[k]).trim()).map(([, l]) => l)
}

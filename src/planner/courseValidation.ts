import type { CourseInput, CourseValidationError } from '../types/planner'
import { COURSE_COLORS } from '../types/planner'
import { daysBetween, isValidDateKey } from '../utils/time'
import { normaliseCourseCode } from './normalise'

/** Mirrors the planned database limits (DATABASE_PROPOSAL §3.1). */
export const COURSE_LIMITS = {
  name: 120,
  code: 30,
  institution: 120,
  termLabel: 40,
  description: 2000,
  maxTermDays: 400,
} as const

/** Every violation of the course constraints, in field order; empty = valid. Never mutates `input`. */
export function validateCourseInput(input: CourseInput): CourseValidationError[] {
  const errors: CourseValidationError[] = []
  const add = (field: CourseValidationError['field'], message: string) => errors.push({ field, message })

  const name = input.name.trim()
  if (name.length === 0) add('name', 'Name is required.')
  else if (name.length > COURSE_LIMITS.name) add('name', `Name can be at most ${COURSE_LIMITS.name} characters.`)

  if (input.code !== undefined && input.code !== '') {
    if (input.code.length > COURSE_LIMITS.code) add('code', `Code can be at most ${COURSE_LIMITS.code} characters.`)
    else if (normaliseCourseCode(input.code) === '') add('code', 'Code cannot be only spaces.')
  }
  if (input.institution !== undefined && input.institution.length > COURSE_LIMITS.institution)
    add('institution', `Institution can be at most ${COURSE_LIMITS.institution} characters.`)
  if (input.termLabel !== undefined && input.termLabel.length > COURSE_LIMITS.termLabel)
    add('termLabel', `Term label can be at most ${COURSE_LIMITS.termLabel} characters.`)
  if (input.description !== undefined && input.description.length > COURSE_LIMITS.description)
    add('description', `Description can be at most ${COURSE_LIMITS.description} characters.`)
  if (!(COURSE_COLORS as readonly string[]).includes(input.color)) add('color', 'Pick one of the colours offered.')

  const { termStart, termEnd } = input
  const hasStart = termStart !== undefined && termStart !== ''
  const hasEnd = termEnd !== undefined && termEnd !== ''
  if (hasStart !== hasEnd) {
    add(hasStart ? 'termEnd' : 'termStart', 'Set both term dates or neither.')
  } else if (hasStart && hasEnd) {
    const startOk = isValidDateKey(termStart)
    const endOk = isValidDateKey(termEnd)
    if (!startOk) add('termStart', 'Term start is not a valid date.')
    if (!endOk) add('termEnd', 'Term end is not a valid date.')
    if (startOk && endOk) {
      const span = daysBetween(termStart, termEnd)
      if (span < 0) add('termEnd', 'Term end cannot be before term start.')
      else if (span > COURSE_LIMITS.maxTermDays)
        add('termEnd', `A term can span at most ${COURSE_LIMITS.maxTermDays} days.`)
    }
  }
  return errors
}

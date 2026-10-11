import { validateCourseInput } from '../planner/courseValidation'
import { COURSE_COLORS } from '../types/planner'
import type { Course, CourseColor, CourseInput } from '../types/planner'
import { isUuid } from './ids'
import type { CoursePatch, CourseRow, CourseWrite } from './plannerTypes'

/**
 * Typed conversion between the planner models and the PostgreSQL rows (courses).
 *  - optional <-> NULL: a blank optional value is stored as NULL, NULL is read back as "absent";
 *  - limits and term rules come from the TypeScript validator (`validateCourseInput`), which mirrors the SQL checks;
 *  - the SQL-generated key columns are neither selected nor written;
 *  - `createdAt`/`updatedAt`/`archivedAt` stay the raw server strings (updatedAt is the version token).
 */

/** Explicit column list (no `*`): the generated `*_key` columns are not needed by the client. */
export const COURSE_COLUMNS =
  'id,user_id,name,code,institution,term_label,term_start,term_end,description,color,archived_at,created_at,updated_at'

/** Every violation of the course rules as a plain message; empty = may be sent to the server. */
export function courseProblems(input: CourseInput): string[] {
  return validateCourseInput(input).map((e) => e.message)
}

/** Optional text -> trimmed string, or NULL when absent/blank. */
const nn = (v: string | undefined): string | null => {
  const t = v?.trim()
  return t ? t : null
}

/**
 * Code: '' / absent = no code (NULL). A non-empty code is validated first (a whitespace-only code is rejected by
 * `validateCourseInput`, never silently turned into NULL).
 */
const codeOf = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v.trim())

/**
 * Term dates are paired by validation; a lone/blank date never reaches the database as ''.
 * Leading/trailing whitespace is NOT trimmed away here: an invalid date must be rejected, not repaired.
 */
const dateOf = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v)

/** Writable columns shared by INSERT and UPDATE. `input` must already be valid (`courseProblems(input)` is empty). */
export function coursePatch(input: CourseInput): CoursePatch {
  return {
    name: input.name.trim(),
    code: codeOf(input.code),
    institution: nn(input.institution),
    term_label: nn(input.termLabel),
    term_start: dateOf(input.termStart),
    term_end: dateOf(input.termEnd),
    description: nn(input.description),
    color: input.color,
  }
}

/** INSERT payload with the client-generated id (makes the create idempotent). Never carries user_id/timestamps/archive state. */
export function courseToWrite(input: CourseInput, id: string): CourseWrite {
  return { id, ...coursePatch(input) }
}

const blankToNull = (v: string | null | undefined): string | null => (v === null || v === undefined || v === '' ? null : v)

/** Does a stored row hold exactly the content we tried to create? (blank and NULL count as the same.) */
export function rowMatchesWrite(row: CourseRow, write: CourseWrite): boolean {
  return (
    row.id === write.id &&
    row.name === write.name &&
    blankToNull(row.code) === write.code &&
    blankToNull(row.institution) === write.institution &&
    blankToNull(row.term_label) === write.term_label &&
    blankToNull(row.term_start) === write.term_start &&
    blankToNull(row.term_end) === write.term_end &&
    blankToNull(row.description) === write.description &&
    row.color === write.color
  )
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const validTimestamp = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v))
const present = (v: string | null | undefined): string | undefined => (v === null || v === undefined || v === '' ? undefined : v)

/**
 * A server row as a `Course`, or null when the row is malformed or breaks a course rule (it is then skipped and
 * counted, never shown half-parsed). Existing data is never repaired or re-written here.
 */
export function rowToCourse(row: CourseRow): Course | null {
  const r = row as unknown as Record<string, unknown>
  if (!isStr(r.id) || !isUuid(r.id) || !isStr(r.user_id) || r.user_id === '') return null
  if (!isStr(r.name) || !isStr(r.color) || !(COURSE_COLORS as readonly string[]).includes(r.color)) return null
  for (const k of ['code', 'institution', 'term_label', 'term_start', 'term_end', 'description', 'archived_at'] as const) {
    if (!isStrOrNull(r[k])) return null
  }
  if (!validTimestamp(r.created_at) || !validTimestamp(r.updated_at)) return null
  if (r.archived_at !== null && !validTimestamp(r.archived_at)) return null

  const input: CourseInput = {
    name: r.name,
    code: present(row.code),
    institution: present(row.institution),
    termLabel: present(row.term_label),
    termStart: present(row.term_start),
    termEnd: present(row.term_end),
    description: present(row.description),
    color: r.color as CourseColor,
  }
  if (courseProblems(input).length > 0) return null

  return {
    id: r.id,
    userId: r.user_id,
    name: input.name,
    ...(input.code !== undefined && { code: input.code }),
    ...(input.institution !== undefined && { institution: input.institution }),
    ...(input.termLabel !== undefined && { termLabel: input.termLabel }),
    ...(input.termStart !== undefined && { termStart: input.termStart }),
    ...(input.termEnd !== undefined && { termEnd: input.termEnd }),
    ...(input.description !== undefined && { description: input.description }),
    color: input.color,
    ...(row.archived_at && { archivedAt: row.archived_at }),
    createdAt: r.created_at,
    updatedAt: r.updated_at, // raw: the version token for conditional updates and deletes
  }
}

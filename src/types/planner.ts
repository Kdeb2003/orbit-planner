// Phase 4B planner types. Pure data shapes: no persistence details.

/** Theme token keys for course colours (mapped in the theme CSS, never hex). */
export const COURSE_COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const
export type CourseColor = (typeof COURSE_COLORS)[number]

/**
 * A subject studied in one term at one institution. Identified by `id`, never
 * by `code`. `termStart`/`termEnd` ('YYYY-MM-DD') are both set or both absent
 * and are the only term fields used for session matching (`termLabel` is display only).
 */
export interface Course {
  id: string
  userId: string
  name: string
  code?: string
  institution?: string
  termLabel?: string
  termStart?: string
  termEnd?: string
  description?: string
  color: CourseColor
  /** ISO instant; present = archived (still takes part in matching). */
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

/** What the caller supplies; id, owner, archive state and timestamps are set elsewhere. */
export type CourseInput = Omit<Course, 'id' | 'userId' | 'archivedAt' | 'createdAt' | 'updatedAt'>

/** The fields of a course that take part in matching. */
export type MatchableCourse = Pick<Course, 'id' | 'code' | 'termStart' | 'termEnd' | 'archivedAt'>

/** The fields of a calendar item that take part in matching. */
export interface CourseSession {
  courseCode?: string
  /** UTC ISO instant. */
  start: string
  /** IANA zone; the session's local date is taken in this zone. */
  timeZone: string
}

/**
 * Result of matching a session to the user's courses (DOMAIN_MODEL §6.2).
 * Only `matched` carries a course id; `ambiguous` deliberately has none.
 */
export type CourseMatch =
  | { status: 'none' }
  | { status: 'outside-term' }
  | { status: 'ambiguous' }
  | { status: 'matched'; courseId: string; confidence: 'dated' | 'by-code'; archived: boolean }

export interface CourseValidationError {
  field: keyof CourseInput
  message: string
}

/** A distinct course code seen in the calendar, with the span of the relevant sessions. */
export interface CodeSessions {
  /** Normalised code key (rule N). */
  code: string
  sessionCount: number
  /** First/last session local date ('YYYY-MM-DD'), in each session's own zone. */
  firstDate: string
  lastDate: string
}

export interface CourseSuggestions {
  /** Codes with sessions and no course at all: candidates to create (nothing is created here). */
  suggestions: CodeSessions[]
  /** Codes whose sessions fall outside every course's term. */
  outsideTerm: CodeSessions[]
  /** Codes whose sessions cannot be told apart between several courses. */
  ambiguous: CodeSessions[]
}

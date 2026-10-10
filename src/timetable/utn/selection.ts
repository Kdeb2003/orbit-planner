import type { TimetableSession } from './types.ts'

/**
 * The user's own course choices. This is configuration, not extraction: the parser
 * never decides what the user attends. Everything not listed here is ignored, and
 * anything uncertain is surfaced for manual review instead of being assumed.
 */
export interface SelectedCourseDef {
  code: string
  displayName: string
  category: 'university' | 'german'
  /** When set, only sessions printing exactly this group are taken (e.g. AI Group B). */
  onlyGroup?: string
}

export const SELECTED_COURSES: readonly SelectedCourseDef[] = [
  { code: 'W26M-AINBA', displayName: 'Artificial Intelligence Basic', category: 'university', onlyGroup: 'B' },
  { code: 'W26M-RBTAD', displayName: 'Advanced Robotics', category: 'university' },
  { code: 'W26M-NLGAD', displayName: 'Natural Language Generation and Evaluation', category: 'university' },
  { code: 'W26M-NLUAD', displayName: 'Natural Language Understanding', category: 'university' },
  { code: 'W26M-MMFAD', displayName: 'Multimodal Foundation Models', category: 'university' },
  { code: 'W26M-LLMAD', displayName: 'Large Language Models', category: 'university' },
  { code: 'W26M-INSIN', displayName: 'Informatics & Society', category: 'university' },
  { code: 'W26M-Deutsch A2', displayName: 'German A2', category: 'german' },
]

export type SelectionStatus = 'confirmed' | 'needs-review'

export interface SelectedSession {
  session: TimetableSession
  course: SelectedCourseDef
  status: SelectionStatus
  /** Why a human must look at it (empty when confirmed). */
  reviewReasons: string[]
}

export interface ExcludedSession {
  session: TimetableSession
  course: SelectedCourseDef
  reason: string
}

export interface SelectionResult {
  selected: SelectedSession[]
  excluded: ExcludedSession[]
}

export function selectSessions(sessions: readonly TimetableSession[], courses: readonly SelectedCourseDef[] = SELECTED_COURSES): SelectionResult {
  const selected: SelectedSession[] = []
  const excluded: ExcludedSession[] = []

  for (const session of sessions) {
    const course = courses.find((c) => c.code === session.courseCode) ?? courses.find((c) => session.jointWith.includes(c.code))
    if (!course) continue
    const reasons: string[] = []

    if (session.courseCode !== course.code) reasons.push(`joint card shared with ${session.courseCode}`)

    if (course.onlyGroup) {
      const wanted = course.onlyGroup
      if (session.groups.length === 1 && session.groups[0] !== wanted) {
        excluded.push({ session, course, reason: `Group ${session.groups[0]} is not the selected Group ${wanted}` })
        continue
      }
      if (session.groups.length === 0) reasons.push(`no group printed (expected Group ${wanted})`)
      else if (session.groups.length > 1) reasons.push(`card lists several groups (${session.groups.join(', ')})`)
      if (session.kind !== 'main' && session.kind !== 'tutorial') reasons.push(`unexpected session type "${session.typeText}"`)
    } else if (session.groups.length > 0) {
      reasons.push(`optional group printed (${session.groups.join(', ')}); attendance not assumed`)
    }
    if (session.variant) reasons.push(`sub-group/variant "${session.variant}" printed`)
    if (session.date === null) reasons.push('no usable date in the source')
    if (session.confidence === 'low') reasons.push('extraction flagged errors for this card')
    if (session.issues.some((i) => i.code === 'duplicate-candidate')) reasons.push('another card has the same identity')

    selected.push({ session, course, status: reasons.length ? 'needs-review' : 'confirmed', reviewReasons: reasons })
  }
  return { selected, excluded }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

export interface SessionClash {
  date: string
  a: SelectedSession
  b: SelectedSession
}

/** Strict overlap on the same date (touching ends do not clash), like src/utils/conflicts.ts. */
export function findSessionClashes(items: readonly SelectedSession[]): SessionClash[] {
  const out: SessionClash[] = []
  const dated = items.filter((i) => i.session.date !== null)
  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i]
      const b = dated[j]
      if (a.session.date !== b.session.date) continue
      if (minutes(a.session.startTime) < minutes(b.session.endTime) && minutes(b.session.startTime) < minutes(a.session.endTime)) {
        out.push({ date: a.session.date as string, a, b })
      }
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date))
}

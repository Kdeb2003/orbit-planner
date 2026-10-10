import { isValidDateKey, isValidTime } from '../../utils/time.ts'
import { NO_DATE_REASON, SELECTED_COURSES, selectSessions } from './selection.ts'
import type { SelectedCourseDef, SelectionStatus } from './selection.ts'
import type { PageLayout, SourceAnomaly, TimetableSession } from './types.ts'

/**
 * Review layer for the import preview (Phase 4A.2, checkpoint 1).
 *
 * Everything here is PURE and derived: the extracted `TimetableSession`s are never mutated. The user's
 * choices (courses, groups, exclusions, corrections) live in a small `ReviewState`; `buildReview` combines the
 * two into the list the UI shows. Nothing is persisted and nothing is written to a calendar.
 */

// ---------------------------------------------------------------------------------------------- courses

export interface DetectedCourse {
  code: string
  name: string
  category: 'university' | 'german'
  /** Sessions printed for this course (before any group filter). */
  sessionCount: number
  /** Single groups printed on this course's cards (e.g. ['A', 'B']). A picker is offered when there are 2+. */
  groups: string[]
  /** One of the user's default courses for this timetable. */
  recommended: boolean
}

export interface CourseChoice {
  code: string
  name: string
  category: 'university' | 'german'
  included: boolean
  /** Chosen group, or null = no group chosen (grouped sessions are then flagged for review, never assumed). */
  group: string | null
}

export function detectCourses(sessions: readonly TimetableSession[]): DetectedCourse[] {
  const byCode = new Map<string, TimetableSession[]>()
  for (const s of sessions) byCode.set(s.courseCode, [...(byCode.get(s.courseCode) ?? []), s])
  const out: DetectedCourse[] = []
  for (const [code, list] of byCode) {
    const def = SELECTED_COURSES.find((c) => c.code === code)
    const title = list.find((s) => s.courseTitle)?.courseTitle ?? null
    out.push({
      code,
      name: def?.displayName ?? title ?? code,
      category: def?.category ?? (list.some((s) => s.kind === 'language') ? 'german' : 'university'),
      sessionCount: list.length,
      groups: [...new Set(list.filter((s) => s.groups.length === 1).map((s) => s.groups[0]))].sort(),
      recommended: !!def,
    })
  }
  const rank = (c: DetectedCourse) => {
    const i = SELECTED_COURSES.findIndex((d) => d.code === c.code)
    return i === -1 ? SELECTED_COURSES.length : i
  }
  return out.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))
}

/** The user's usual courses ticked (AI Basic: Group B), everything else unticked but available. */
export function defaultChoices(detected: readonly DetectedCourse[]): CourseChoice[] {
  return detected.map((c) => {
    const def = SELECTED_COURSES.find((d) => d.code === c.code)
    const group = def?.onlyGroup && c.groups.includes(def.onlyGroup) ? def.onlyGroup : null
    return { code: c.code, name: c.name, category: c.category, included: c.recommended, group }
  })
}

export function choicesToDefs(choices: readonly CourseChoice[]): SelectedCourseDef[] {
  return choices
    .filter((c) => c.included)
    .map((c) => ({ code: c.code, displayName: c.name, category: c.category, ...(c.group ? { onlyGroup: c.group } : {}) }))
}

// ---------------------------------------------------------------------------------------------- state

export type EditableField = 'title' | 'date' | 'startTime' | 'endTime' | 'room'
export const EDITABLE_FIELDS: readonly EditableField[] = ['title', 'date', 'startTime', 'endTime', 'room']

/** The editable values of a session. `date` is '' while unknown. */
export interface SessionValues {
  title: string
  date: string
  startTime: string
  endTime: string
  room: string
}

export type SessionEdit = Partial<Record<EditableField, string>>

export interface ReviewState {
  choices: CourseChoice[]
  /** Item ids the user excluded. */
  excluded: string[]
  /** Only fields that differ from the extracted values are stored. */
  edits: Record<string, SessionEdit>
  /** Item ids whose "needs review" reasons the user has looked at and accepted. */
  reviewed: string[]
}

export function initialState(sessions: readonly TimetableSession[]): ReviewState {
  return { choices: defaultChoices(detectCourses(sessions)), excluded: [], edits: {}, reviewed: [] }
}

// ---------------------------------------------------------------------------------------------- values

const MAX_TITLE = 120
const MAX_ROOM = 120

export function defaultTitle(session: TimetableSession, course: SelectedCourseDef): string {
  return `${course.displayName}${session.kind === 'tutorial' ? ' — Tutorial' : ''}`
}

function defaultRoom(session: TimetableSession): string {
  if (!session.location) return ''
  return session.location.kind === 'online' ? 'Online' : session.location.raw
}

export function originalValues(session: TimetableSession, course: SelectedCourseDef): SessionValues {
  return { title: defaultTitle(session, course), date: session.date ?? '', startTime: session.startTime, endTime: session.endTime, room: defaultRoom(session) }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function weekdayName(date: string): string | null {
  if (!isValidDateKey(date)) return null
  const [y, m, d] = date.split('-').map(Number)
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

export type FieldErrors = Partial<Record<EditableField | 'identity', string>>

/** Validates one set of values on its own (format, ranges, order). Duplicate identity is checked separately. */
export function validateValues(v: SessionValues): FieldErrors {
  const errors: FieldErrors = {}
  if (v.title.trim() === '') errors.title = 'Enter a title.'
  else if (v.title.length > MAX_TITLE) errors.title = `Keep the title within ${MAX_TITLE} characters.`
  if (v.date === '') errors.date = 'A valid date is required.'
  else if (!isValidDateKey(v.date)) errors.date = 'This is not a real calendar date (use YYYY-MM-DD).'
  if (!isValidTime(v.startTime)) errors.startTime = 'Use a 24-hour time such as 09:00.'
  if (!isValidTime(v.endTime)) errors.endTime = 'Use a 24-hour time such as 10:30.'
  if (!errors.startTime && !errors.endTime && minutes(v.endTime) <= minutes(v.startTime)) errors.endTime = 'The end must be after the start.'
  if (v.room.length > MAX_ROOM) errors.room = `Keep the room within ${MAX_ROOM} characters.`
  return errors
}

function identityOf(session: TimetableSession, v: SessionValues): string {
  // same shape as sourceKey, but with the CURRENT date and times
  const tail = session.sourceKey.split('|').slice(4).join('|')
  return [v.date, `${v.startTime}-${v.endTime}`, session.courseCode, tail].join('|')
}

// ---------------------------------------------------------------------------------------------- review

export type ItemState = 'ready' | 'needs-review' | 'invalid' | 'excluded'

export interface ReviewItem {
  /** Position in the extraction; unique even when two cards share a sourceKey. */
  id: string
  session: TimetableSession
  course: SelectedCourseDef
  selectionStatus: SelectionStatus
  /** Why a human must look at it, minus reasons the user's own corrections resolved. */
  reasons: string[]
  original: SessionValues
  values: SessionValues
  editedFields: EditableField[]
  errors: FieldErrors
  warnings: string[]
  excluded: boolean
  reviewed: boolean
  state: ItemState
  /** Ids of the items this one overlaps. */
  clashesWith: string[]
}

export interface ReviewClash {
  id: string
  date: string
  a: ReviewItem
  b: ReviewItem
}

export interface ReviewSummary {
  /** Sessions of the chosen courses/groups (excluded ones included). */
  inScope: number
  selected: number
  manuallyExcluded: number
  /** Sessions of a chosen course dropped because they belong to another group. */
  groupExcluded: number
  needsAttention: number
  ready: number
  /** Sessions with at least one corrected value. */
  edited: number
  /** Corrected values across all sessions. */
  correctedFields: number
  clashes: number
  byCourse: { code: string; name: string; count: number }[]
  dateRange: { first: string; last: string } | null
}

export interface ReviewResult {
  items: ReviewItem[]
  clashes: ReviewClash[]
  summary: ReviewSummary
}

export function buildReview(sessions: readonly TimetableSession[], state: ReviewState): ReviewResult {
  const index = new Map<TimetableSession, string>(sessions.map((s, i) => [s, String(i)]))
  const { selected, excluded: groupExcluded } = selectSessions(sessions, choicesToDefs(state.choices))
  const excludedSet = new Set(state.excluded)
  const reviewedSet = new Set(state.reviewed)

  const items: ReviewItem[] = selected.map(({ session, course, status, reviewReasons }) => {
    const id = index.get(session) as string
    const original = originalValues(session, course)
    const edit = state.edits[id] ?? {}
    const values: SessionValues = { ...original, ...edit }
    const editedFields = EDITABLE_FIELDS.filter((f) => f in edit && edit[f] !== original[f])
    const errors = validateValues(values)
    const warnings: string[] = []
    const day = weekdayName(values.date)
    if (day && day !== session.weekday) warnings.push(`${values.date} is a ${day}, but the timetable prints ${session.weekday}.`)
    // A user-entered, valid date resolves "no usable date in the source"; every other reason stays until reviewed.
    const reasons = reviewReasons.filter((r) => !(r === NO_DATE_REASON && editedFields.includes('date') && !errors.date))
    const isExcluded = excludedSet.has(id)
    const reviewed = reviewedSet.has(id)
    return { id, session, course, selectionStatus: status, reasons, original, values, editedFields, errors, warnings, excluded: isExcluded, reviewed, state: 'ready', clashesWith: [] }
  })

  // identical sessions (same date, times, course and type) among the included ones
  const seen = new Map<string, ReviewItem[]>()
  for (const it of items) {
    if (it.excluded || it.errors.date) continue
    const key = identityOf(it.session, it.values)
    seen.set(key, [...(seen.get(key) ?? []), it])
  }
  for (const group of seen.values()) {
    if (group.length > 1) for (const it of group) it.errors.identity = 'Another included session has the same course, date, time and type. Exclude one of them or change a value.'
  }

  for (const it of items) {
    const blocking = Object.keys(it.errors).length > 0
    it.state = it.excluded ? 'excluded' : blocking ? 'invalid' : it.reasons.length > 0 && !it.reviewed ? 'needs-review' : 'ready'
  }

  const clashes = findClashes(items)
  for (const c of clashes) {
    c.a.clashesWith.push(c.b.id)
    c.b.clashesWith.push(c.a.id)
  }

  const live = items.filter((i) => !i.excluded)
  const courseCounts = new Map<string, { name: string; count: number }>()
  for (const it of live) courseCounts.set(it.course.code, { name: it.course.displayName, count: (courseCounts.get(it.course.code)?.count ?? 0) + 1 })
  const dates = live.map((i) => i.values.date).filter((d) => isValidDateKey(d)).sort()
  const summary: ReviewSummary = {
    inScope: items.length + groupExcluded.length,
    selected: live.length,
    manuallyExcluded: items.length - live.length,
    groupExcluded: groupExcluded.length,
    needsAttention: live.filter((i) => i.state === 'invalid' || i.state === 'needs-review').length,
    ready: live.filter((i) => i.state === 'ready').length,
    edited: items.filter((i) => i.editedFields.length > 0).length,
    correctedFields: items.reduce((n, i) => n + i.editedFields.length, 0),
    clashes: clashes.length,
    byCourse: [...courseCounts].map(([code, v]) => ({ code, ...v })),
    dateRange: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
  }
  return { items, clashes, summary }
}

/** Strict overlap on the same date between included sessions with usable dates and times (touching ends do not clash). */
export function findClashes(items: readonly ReviewItem[]): ReviewClash[] {
  const usable = items.filter((i) => !i.excluded && !i.errors.date && !i.errors.startTime && !i.errors.endTime)
  const out: ReviewClash[] = []
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]
      const b = usable[j]
      if (a.values.date !== b.values.date) continue
      if (minutes(a.values.startTime) < minutes(b.values.endTime) && minutes(b.values.startTime) < minutes(a.values.endTime)) {
        out.push({ id: `${a.id}~${b.id}`, date: a.values.date, a, b })
      }
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.a.values.startTime.localeCompare(y.a.values.startTime))
}

// ---------------------------------------------------------------------------------------------- state updates

/** Records `values` as the corrections for an item, storing only what differs from the extracted values. */
export function commitEdit(state: ReviewState, id: string, original: SessionValues, values: SessionValues): ReviewState {
  const diff: SessionEdit = {}
  for (const f of EDITABLE_FIELDS) if (values[f] !== original[f]) diff[f] = values[f]
  const edits = { ...state.edits }
  if (Object.keys(diff).length) edits[id] = diff
  else delete edits[id]
  return { ...state, edits }
}

export function resetEdit(state: ReviewState, id: string): ReviewState {
  const edits = { ...state.edits }
  delete edits[id]
  return { ...state, edits }
}

export function toggleExcluded(state: ReviewState, id: string, excluded: boolean): ReviewState {
  const rest = state.excluded.filter((x) => x !== id)
  return { ...state, excluded: excluded ? [...rest, id] : rest }
}

export function setReviewed(state: ReviewState, id: string, reviewed: boolean): ReviewState {
  const rest = state.reviewed.filter((x) => x !== id)
  return { ...state, reviewed: reviewed ? [...rest, id] : rest }
}

/** Another included item with the same identity as `values` would have (for the correction dialog). */
export function duplicateOf(items: readonly ReviewItem[], item: ReviewItem, values: SessionValues): ReviewItem | null {
  if (!isValidDateKey(values.date)) return null
  const key = identityOf(item.session, values)
  return items.find((o) => o.id !== item.id && !o.excluded && !o.errors.date && identityOf(o.session, o.values) === key) ?? null
}

// ---------------------------------------------------------------------------------------------- filters

export type StatusFilter = 'all' | 'ready' | 'needs-review' | 'invalid' | 'excluded' | 'edited' | 'clash'

export interface ReviewFilters {
  course: string
  week: string
  date: string
  status: StatusFilter
}

export const NO_FILTERS: ReviewFilters = { course: 'all', week: 'all', date: '', status: 'all' }

export function filterItems(items: readonly ReviewItem[], f: ReviewFilters): ReviewItem[] {
  return items.filter((i) => {
    if (f.course !== 'all' && i.course.code !== f.course) return false
    if (f.week !== 'all' && String(i.session.semesterWeek) !== f.week) return false
    if (f.date && i.values.date !== f.date) return false
    switch (f.status) {
      case 'all':
        return true
      case 'edited':
        return i.editedFields.length > 0
      case 'clash':
        return !i.excluded && i.clashesWith.length > 0
      default:
        return i.state === f.status
    }
  })
}

export const sortItems = (items: readonly ReviewItem[]): ReviewItem[] =>
  [...items].sort((a, b) => (a.values.date || '9999').localeCompare(b.values.date || '9999') || a.values.startTime.localeCompare(b.values.startTime) || a.course.code.localeCompare(b.course.code))

// ---------------------------------------------------------------------------------------------- source facts

export interface SourceFacts {
  /** e.g. "Winter Semester 2026/2027", or null when the title bar does not carry it. */
  semester: string | null
  /** The notice printed in the PDF (e.g. "preliminary as of ...") or null when none was found. */
  preliminaryNote: string | null
  weeks: number
  /** First and last printed date of any session in the PDF (selection-independent). */
  printedRange: { first: string; last: string } | null
}

export function describeSource(layouts: readonly PageLayout[], sessions: readonly TimetableSession[], titles: readonly string[]): SourceFacts {
  const note = layouts.flatMap((l) => l.texts).find((t) => /preliminary/i.test(t.str))
  const semester = titles.map((t) => /(Winter|Summer) Semester \d{4}\/\d{4}/.exec(t)?.[0]).find(Boolean) ?? null
  const dates = sessions.map((s) => s.date).filter((d): d is string => d !== null).sort()
  return {
    semester,
    preliminaryNote: note ? note.str.trim() : null,
    weeks: titles.length,
    printedRange: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
  }
}

export interface AnomalyGroup {
  code: string
  semesterWeeks: number[]
  /** Every distinct message of this kind (e.g. six undated weekdays of week 1). */
  messages: string[]
}

/** One entry per kind of anomaly, so six undated days of week 1 are one finding, not six. */
export function groupAnomalies(anomalies: readonly SourceAnomaly[]): AnomalyGroup[] {
  const map = new Map<string, AnomalyGroup>()
  for (const a of anomalies) {
    const g = map.get(a.code) ?? { code: a.code, semesterWeeks: [], messages: [] }
    if (!g.semesterWeeks.includes(a.semesterWeek)) g.semesterWeeks.push(a.semesterWeek)
    if (!g.messages.includes(a.message)) g.messages.push(a.message)
    map.set(a.code, g)
  }
  return [...map.values()]
}

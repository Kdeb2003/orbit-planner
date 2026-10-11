import { Archive, ArchiveRestore, CalendarRange, Loader2, MapPin, Pencil, Tag, Trash2, TriangleAlert } from 'lucide-react'
import type { CodeLevel, CourseCounts } from '../../planner/courseInsights'
import type { SharedCode } from '../../planner/courseOverlap'
import type { Course } from '../../types/planner'
import { COURSE_COLOR_CLASSES } from './courseColors'
import { COURSE_COLOR_NAMES } from '../../planner/courseForm'

interface CourseCardProps {
  course: Course
  /** Other courses that share this code and cannot be told apart by term dates (non-blocking information). */
  shared: SharedCode[]
  /** An action on THIS course is running. */
  busy: boolean
  highlighted: boolean
  /** How this course's code lines up with the saved calendar. Undefined while the calendar is not available. */
  matching?: { counts: CourseCounts; codeLevel?: CodeLevel; stale: boolean }
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}

const day = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
const label = (c: Course) => [c.name, c.termLabel].filter(Boolean).join(' · ')

const actionBtn =
  'inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line px-3 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50'

export function CourseCard({ course, shared, busy, highlighted, matching, onEdit, onArchive, onRestore, onDelete }: CourseCardProps) {
  const archived = course.archivedAt !== undefined
  const colors = COURSE_COLOR_CLASSES[course.color]
  return (
    <li
      id={`course-${course.id}`}
      tabIndex={-1}
      data-course-id={course.id}
      data-archived={archived}
      aria-busy={busy}
      className={`min-w-0 rounded-2xl border border-l-4 border-line ${colors.border} bg-surface p-4 shadow-lg shadow-black/20 ${archived ? 'border-dashed bg-surface/50' : ''} ${highlighted ? 'ring-2 ring-accent-soft' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={`break-words text-base font-semibold ${archived ? 'text-muted' : ''}`}>{course.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {course.code && (
              <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-medium text-white">
                <Tag size={12} aria-hidden /> <span className="sr-only">Code </span>
                {course.code}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <span className={`inline-block size-2.5 rounded-full ${colors.bg}`} aria-hidden />
              {COURSE_COLOR_NAMES[course.color]}
            </span>
          </div>
        </div>
        {archived && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
            <Archive size={12} aria-hidden /> Archived
          </span>
        )}
      </div>

      <dl className="mt-3 space-y-1.5 text-sm text-muted">
        {course.institution && (
          <div className="flex items-start gap-2">
            <MapPin size={14} className="mt-0.5 shrink-0" aria-hidden />
            <dt className="sr-only">Institution</dt>
            <dd className="min-w-0 break-words">{course.institution}</dd>
          </div>
        )}
        {(course.termLabel || (course.termStart && course.termEnd)) && (
          <div className="flex items-start gap-2">
            <CalendarRange size={14} className="mt-0.5 shrink-0" aria-hidden />
            <dt className="sr-only">Term</dt>
            <dd className="min-w-0 break-words">
              {course.termLabel}
              {course.termLabel && course.termStart && ' · '}
              {course.termStart && course.termEnd && (
                <>
                  <time dateTime={course.termStart}>{day(course.termStart)}</time> – <time dateTime={course.termEnd}>{day(course.termEnd)}</time>
                </>
              )}
            </dd>
          </div>
        )}
        {!course.termStart && course.code && <p className="pl-6 text-xs">No term dates set.</p>}
      </dl>
      {course.description && <p className="mt-2 whitespace-pre-line break-words text-sm text-muted">{course.description}</p>}
      {archived && course.archivedAt && (
        <p className="mt-2 text-xs text-muted">
          Archived on <time dateTime={course.archivedAt}>{day(course.archivedAt.slice(0, 10))}</time>. Timetable sessions with this code can still be matched.
        </p>
      )}

      <div data-testid="match-summary" className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-muted">
        {!course.code ? (
          <p>No course code, so timetable sessions cannot be matched to this course.</p>
        ) : !matching ? (
          <p>Matching with your calendar is not available right now.</p>
        ) : (
          <>
            <p>
              Timetable sessions: <strong className="text-white">{matching.counts.dated}</strong> matched by term dates · <strong className="text-white">{matching.counts.byCode}</strong> matched by code only
              {matching.stale && ' (based on data that may be out of date)'}
            </p>
            {matching.codeLevel && (matching.codeLevel.ambiguous > 0 || matching.codeLevel.outsideTerm > 0) && (
              <p data-testid="code-level-counts">
                For the code <strong className="text-white">{matching.codeLevel.code}</strong> as a whole
                {matching.codeLevel.courseIds.length > 1 ? ` (shared by ${matching.codeLevel.courseIds.length} courses)` : ''}:{' '}
                {[
                  matching.codeLevel.ambiguous > 0 && `${matching.codeLevel.ambiguous} ambiguous`,
                  matching.codeLevel.outsideTerm > 0 && `${matching.codeLevel.outsideTerm} outside every term`,
                ]
                  .filter(Boolean)
                  .join(', ')}{' '}
                — these are not assigned to any course.
              </p>
            )}
            {matching.counts.dated + matching.counts.byCode === 0 && !matching.codeLevel?.total && <p>No saved calendar sessions use this code.</p>}
          </>
        )}
      </div>

      {shared.length > 0 && (
        <div data-testid="shared-code-warning" className="mt-3 flex items-start gap-2 rounded-xl border border-work/40 bg-work/10 p-2.5 text-xs">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-work" aria-hidden />
          <p>
            Shares the code <strong>{course.code}</strong> with {shared.map((s) => label(s.course)).join(', ')} and the term dates {shared.some((s) => s.reason === 'missing') ? 'are missing or incomplete' : 'overlap'}. Matching timetable sessions may be ambiguous and stay unassigned.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={busy} className={actionBtn} aria-label={`Edit ${course.name}`}>
          <Pencil size={14} aria-hidden /> Edit
        </button>
        {archived ? (
          <button type="button" onClick={onRestore} disabled={busy} className={actionBtn} aria-label={`Restore ${course.name}`}>
            {busy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden /> : <ArchiveRestore size={14} aria-hidden />} Restore
          </button>
        ) : (
          <button type="button" onClick={onArchive} disabled={busy} className={actionBtn} aria-label={`Archive ${course.name}`}>
            <Archive size={14} aria-hidden /> Archive
          </button>
        )}
        <button type="button" onClick={onDelete} disabled={busy} className={`${actionBtn} text-deadline`} aria-label={`Delete ${course.name}`}>
          <Trash2 size={14} aria-hidden /> Delete
        </button>
      </div>
    </li>
  )
}

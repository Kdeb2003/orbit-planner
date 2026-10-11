import { Repeat, RotateCcw } from 'lucide-react'
import type { ScheduledItem } from '../types'
import { eventTimeLabel } from '../utils/events'

import type { DateKey } from '../utils/time'
import { categoryStyle } from './categories'
import { COURSE_COLOR_CLASSES } from './planner/courseColors'
import type { CourseAnnotation } from '../planner/useCourseAnnotator'

const SESSION_LABEL = { main: 'Main', tutorial: 'Tutorial', seminar: 'Seminar', practical: 'Practical', other: 'Other' } as const

interface EventItemProps {
  event: ScheduledItem
  day: DateKey
  state?: 'past' | 'live' | 'next'
  onSelect?: (event: ScheduledItem) => void
  /** For cancelled occurrences: bring the occurrence back. */
  onRestore?: (event: ScheduledItem) => void
  /** Read-only: the single course this session belongs to (never a guess; absent for ambiguous or unmatched sessions). */
  course?: CourseAnnotation
}

/** One event row; a button when `onSelect` is given. */
export function EventItem({ event, day, state = 'next', onSelect, onRestore, course }: EventItemProps) {
  const c = categoryStyle[event.category]
  const cancelled = !!event.cancelled
  const body = (
    <>
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${c.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={`flex items-center gap-1.5 text-sm font-medium ${cancelled ? 'line-through' : ''}`}>
          <span className="truncate">{event.title}</span>
          {event.seriesId && (
            <Repeat size={13} className="shrink-0 text-muted" aria-label="Repeating event" role="img" />
          )}
        </p>
        <p className="truncate text-xs text-muted">
          <span className="tabular-nums text-white/80">{eventTimeLabel(event, day, event.timeZone)}</span>
          {' · '}
          <span className={c.text}>{c.label}</span>
          {event.location ? ` · ${event.location}` : ''}
          {event.courseCode ? ` · ${event.courseCode}` : ''}
          {event.sessionType ? ` · ${SESSION_LABEL[event.sessionType]}` : ''}
          {event.groupLabel ? ` · ${event.groupLabel}` : ''}
          {cancelled && ' · Cancelled'}
          {!cancelled && event.modified && ' · Edited'}
          {event.dstAdjusted && ' · Shifted for DST'}
        </p>
        {course && (
          <p data-testid="course-annotation" data-course-id={course.courseId} className={`mt-1 flex items-center gap-1.5 text-xs text-muted ${course.archived ? 'italic' : ''}`}>
            <span className={`inline-block h-2.5 w-1 shrink-0 rounded-full ${COURSE_COLOR_CLASSES[course.color].bg}`} aria-hidden />
            <span className="truncate">
              <span className="sr-only">Course: </span>
              {course.name}
              {course.confidence === 'by-code' && ' · Matched by code'}
              {course.archived && ' · Archived course'}
            </span>
          </p>
        )}
      </div>
      {state === 'live' && !cancelled && <span className="self-start text-xs font-medium text-accent-soft">Now</span>}
    </>
  )
  const cls = `flex w-full gap-3 rounded-xl border p-3 text-left ${
    state === 'live' ? 'border-accent bg-accent/10' : 'border-line bg-surface-2/40'
  } ${state === 'past' || cancelled ? 'opacity-60' : ''}`

  if (cancelled) {
    return (
      <div className={`${cls} items-center`}>
        {body}
        {onRestore && (
          <button
            type="button"
            onClick={() => onRestore(event)}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 text-xs text-white hover:bg-surface-2"
          >
            <RotateCcw size={14} aria-hidden /> Restore
          </button>
        )}
      </div>
    )
  }
  if (!onSelect) return <div className={cls}>{body}</div>
  return (
    <button type="button" onClick={() => onSelect(event)} className={`${cls} min-h-12 hover:border-accent/60`}>
      {body}
    </button>
  )
}

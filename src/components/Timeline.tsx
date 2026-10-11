import type { ScheduledItem } from '../types'
import type { CourseAnnotation } from '../planner/useCourseAnnotator'
import type { DateKey } from '../utils/time'
import { EventItem } from './EventItem'

interface TimelineProps {
  events: ScheduledItem[]
  day: DateKey
  now: Date
  onSelect?: (event: ScheduledItem) => void
  courseOf?: (event: ScheduledItem) => CourseAnnotation | undefined
}

export function Timeline({ events, day, now, onSelect, courseOf }: TimelineProps) {
  const t = now.getTime()
  return (
    <ol className="space-y-3">
      {events.map((e) => {
        const state = t >= Date.parse(e.end) ? 'past' : t >= Date.parse(e.start) ? 'live' : 'next'
        return (
          <li key={e.id}>
            <EventItem event={e} day={day} state={state} onSelect={onSelect} course={courseOf?.(e)} />
          </li>
        )
      })}
    </ol>
  )
}

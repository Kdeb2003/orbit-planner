import { useEffect, useMemo, useState } from 'react'
import { useCalendar } from '../calendar/CalendarContext'
import type { ScheduledItem } from '../types'
import type { CourseColor } from '../types/planner'
import { usePlanner } from './PlannerContext'

/** The read-only note shown on a calendar row whose session belongs to exactly one course. */
export interface CourseAnnotation {
  courseId: string
  name: string
  color: CourseColor
  archived: boolean
  /** `by-code`: the course has no term dates, so the match rests on the code alone. */
  confidence: 'dated' | 'by-code'
}

/**
 * A function that annotates calendar items with their course, or `undefined` when there is nothing to show: the feature
 * is off, no planner session, courses not loaded yet, or the courses belong to a different account than the calendar.
 *
 * The matching code is imported on demand (only once courses actually exist for this user), so with the feature off it is
 * never loaded and the pages render exactly as before. Reads only the existing calendar and planner snapshots.
 */
export function useCourseAnnotator(): ((item: ScheduledItem) => CourseAnnotation | undefined) | undefined {
  const { snapshot } = usePlanner()
  const calendar = useCalendar()
  const [insights, setInsights] = useState<typeof import('./courseInsights') | null>(null)
  const wanted = !!snapshot && snapshot.status === 'ready'

  useEffect(() => {
    if (wanted && !insights) void import('./courseInsights').then(setInsights, () => undefined)
  }, [wanted, insights])

  const sameAccount = !!snapshot && calendar.mode === 'cloud' && calendar.userId === snapshot.userId
  const courses = snapshot?.courses
  return useMemo(() => {
    if (!wanted || !insights || !sameAccount || !courses || courses.length === 0) return undefined
    const byId = new Map(courses.map((c) => [c.id, c]))
    return (item) => {
      if (item.cancelled) return undefined
      const m = insights.sessionCourse(item, courses)
      const c = m && byId.get(m.courseId)
      return m && c ? { courseId: c.id, name: c.name, color: c.color, archived: m.archived, confidence: m.confidence } : undefined
    }
  }, [wanted, insights, sameAccount, courses])
}

// DEMONSTRATION DATA ONLY — not real data. Used by Study Planner and Insights
// until those pages are connected to real data. Never written to the calendar.
import type { StudyGoal } from '../types'

export const demoStudyGoals: StudyGoal[] = [
  { id: 'g1', subject: 'Demo Subject A', targetHours: 6, doneHours: 4 },
  { id: 'g2', subject: 'Demo Subject B', targetHours: 5, doneHours: 2 },
  { id: 'g3', subject: 'Demo Research Reading', targetHours: 4, doneHours: 1 },
  { id: 'g4', subject: 'Demo Language Course', targetHours: 3, doneHours: 3 },
]

export const demoWeekHours = [
  { day: 'Mon', hours: 5 },
  { day: 'Tue', hours: 7 },
  { day: 'Wed', hours: 4 },
  { day: 'Thu', hours: 6 },
  { day: 'Fri', hours: 3 },
  { day: 'Sat', hours: 2 },
  { day: 'Sun', hours: 1 },
]

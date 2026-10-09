// DEMONSTRATION DATA ONLY — not a real timetable.
import type { ScheduleEvent, StudyGoal } from '../types'

export const demoEvents: ScheduleEvent[] = [
  { id: 'd1', title: 'Demo Lecture: Subject A', category: 'class', startMin: 9 * 60, endMin: 10 * 60 + 30, location: 'Room 101' },
  { id: 'd2', title: 'Demo Study Block', category: 'study', startMin: 11 * 60, endMin: 12 * 60 + 30 },
  { id: 'd3', title: 'Demo Seminar: Subject B', category: 'class', startMin: 14 * 60, endMin: 15 * 60 + 30, location: 'Room 204' },
  { id: 'd4', title: 'Demo Part-time Shift', category: 'work', startMin: 16 * 60 + 30, endMin: 20 * 60 },
  { id: 'd5', title: 'Demo Language Practice', category: 'personal', startMin: 20 * 60 + 30, endMin: 21 * 60 + 15 },
]

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

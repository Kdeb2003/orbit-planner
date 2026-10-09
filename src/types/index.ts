export type EventCategory = 'class' | 'work' | 'study' | 'personal'

/** A scheduled activity. Times are minutes since midnight, Europe/Berlin. */
export interface ScheduleEvent {
  id: string
  title: string
  category: EventCategory
  startMin: number
  endMin: number
  location?: string
}

export interface StudyGoal {
  id: string
  subject: string
  targetHours: number
  doneHours: number
}

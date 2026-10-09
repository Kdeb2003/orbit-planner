import type { EventCategory } from '../types'

export const categoryStyle: Record<EventCategory, { label: string; dot: string; text: string }> = {
  class: { label: 'Class', dot: 'bg-classes', text: 'text-classes' },
  work: { label: 'Work', dot: 'bg-work', text: 'text-work' },
  study: { label: 'Study', dot: 'bg-study', text: 'text-study' },
  personal: { label: 'Personal', dot: 'bg-other', text: 'text-other' },
}

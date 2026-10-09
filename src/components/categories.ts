import type { EventCategory } from '../types'

// Class names are written out in full so Tailwind can detect them.
export const categoryStyle: Record<EventCategory, { label: string; dot: string; text: string }> = {
  university: { label: 'University', dot: 'bg-university', text: 'text-university' },
  work: { label: 'Work', dot: 'bg-work', text: 'text-work' },
  study: { label: 'Study', dot: 'bg-study', text: 'text-study' },
  german: { label: 'German', dot: 'bg-german', text: 'text-german' },
  research: { label: 'Research', dot: 'bg-research', text: 'text-research' },
  personal: { label: 'Personal', dot: 'bg-personal', text: 'text-personal' },
  deadline: { label: 'Deadline', dot: 'bg-deadline', text: 'text-deadline' },
}

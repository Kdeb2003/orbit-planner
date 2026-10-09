import { createContext, useContext } from 'react'
import type { ScheduledItem } from '../types'
import type { DateKey } from '../utils/time'

export interface EventEditorApi {
  /** Open the form to create an event, optionally pre-filled for `day`. */
  openNew: (day?: DateKey) => void
  openEdit: (event: ScheduledItem) => void
}

export const EventEditorContext = createContext<EventEditorApi | null>(null)

export function useEventEditor(): EventEditorApi {
  const ctx = useContext(EventEditorContext)
  if (!ctx) throw new Error('useEventEditor must be used inside EventEditorProvider')
  return ctx
}

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { CloudApi } from '../cloud/cloudApi'
import type { CalendarSnapshot, CalendarSource } from './types'

export interface CalendarContextValue {
  source: CalendarSource
  /** Cloud table access for the signed-in user (used by the explicit local-data import); null in local mode. */
  api: CloudApi | null
  userId: string | null
}

export const CalendarContext = createContext<CalendarContextValue | null>(null)

export function useCalendarContext(): CalendarContextValue {
  const ctx = useContext(CalendarContext)
  if (!ctx) throw new Error('useCalendar must be used inside CalendarProvider')
  return ctx
}

/** Current calendar data plus the (asynchronous) operations to change it. */
export function useCalendar(): CalendarSnapshot & { source: CalendarSource } {
  const { source } = useCalendarContext()
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  return { ...snapshot, source }
}

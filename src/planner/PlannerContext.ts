import { createContext, useContext, useSyncExternalStore } from 'react'
import type { PlannerSnapshot, PlannerSource } from './plannerSource'

export interface PlannerContextValue {
  /** The feature is switched on for this build. When false, `source` is always null and no planner request exists. */
  enabled: boolean
  /** The signed-in user's planner session; null while signed out, loading the session, or when disabled. */
  source: PlannerSource | null
}

export const PlannerContext = createContext<PlannerContextValue>({ enabled: false, source: null })

const noSubscribe = () => () => {}
const noSnapshot = (): PlannerSnapshot | null => null

/** Current planner data (null when there is no session) plus the (asynchronous) operations to change it. */
export function usePlanner(): { enabled: boolean; source: PlannerSource | null; snapshot: PlannerSnapshot | null } {
  const { enabled, source } = useContext(PlannerContext)
  const snapshot = useSyncExternalStore(source ? source.subscribe : noSubscribe, source ? source.getSnapshot : noSnapshot)
  return { enabled, source, snapshot }
}

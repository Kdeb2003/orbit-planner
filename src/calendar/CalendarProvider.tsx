import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { createSupabaseApi } from '../cloud/cloudApi'
import type { CloudApi } from '../cloud/cloudApi'
import { createSupabaseImportApi } from '../cloud/importApi'
import type { ImportApi } from '../cloud/importApi'
import { lazyPlannerApiFactory } from '../cloud/plannerApiLoader'
import type { PlannerApi } from '../cloud/plannerApi'
import { supabase } from '../lib/supabase'
import { isPlannerFeatureOn, PLANNER_COURSES_ENABLED } from '../planner/flag'
import { PlannerContext } from '../planner/PlannerContext'
import { createCalendarManager } from './calendarManager'
import { CalendarContext } from './CalendarContext'
import { createEmptySource, createLocalSource } from './localSource'
import { subscribeRealtime } from './realtime'

interface CalendarProviderProps {
  children: ReactNode
  /** Tests inject an in-memory API. Default: the real Supabase client (null when unconfigured). */
  createApi?: (userId: string) => CloudApi | null
  /** Tests inject an in-memory import backend. Default: the real Supabase client (null when unconfigured). */
  createImportApi?: () => ImportApi | null
  /**
   * Tests inject an in-memory courses API (this also switches the planner on for that provider). Default: the real
   * Supabase client, but ONLY when VITE_ENABLE_PLANNER_COURSES=true; otherwise no planner session exists.
   */
  createPlannerApi?: (userId: string) => PlannerApi | null | Promise<PlannerApi | null>
}

const localSource = createLocalSource()

const defaultCreateApi = (): CloudApi | null => (supabase ? createSupabaseApi(supabase) : null)

/**
 * Chooses where calendar data comes from:
 *  - Supabase not configured -> browser storage (local-only mode, unchanged behaviour)
 *  - signed in               -> that user's cloud data ONLY (never the shared local storage)
 *  - anything else           -> nothing (private data is never shown to a signed-out visitor)
 */
export function CalendarProvider({ children, createApi, createImportApi, createPlannerApi }: CalendarProviderProps) {
  const { state } = useAuth()
  const userId = state.status === 'signed-in' ? state.user.id : null
  const realtime = import.meta.env.VITE_ENABLE_REALTIME === 'true'

  const [manager] = useState(() =>
    createCalendarManager({
      createApi: createApi ?? defaultCreateApi,
      createPlannerApi: createPlannerApi ?? lazyPlannerApiFactory({ enabled: PLANNER_COURSES_ENABLED, client: supabase }),
      startRealtime: realtime && supabase ? (id, onChange) => subscribeRealtime(supabase!, id, onChange) : undefined,
    }),
  )
  const plannerEnabled = isPlannerFeatureOn(createPlannerApi)
  useEffect(() => {
    manager.setUser(userId)
    return () => manager.setUser(null)
  }, [manager, userId])

  const [importApi] = useState<ImportApi | null>(() => (createImportApi ? createImportApi() : supabase ? createSupabaseImportApi(supabase) : null))
  const session = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const unconfigured = state.status === 'unconfigured'

  const value = useMemo(() => {
    if (unconfigured) return { source: localSource, api: null, importApi: null, userId: null }
    // Guard: never expose a session that belongs to a different (previous) user.
    if (session && userId && session.userId === userId) return { source: session.source, api: session.api, importApi, userId }
    return { source: createEmptySource('loading', userId), api: null, importApi: null, userId }
  }, [unconfigured, session, userId, importApi])

  // Same guard as above: never expose the planner session of a different (previous) user; no planner in local mode.
  const planner = !unconfigured && session && userId && session.userId === userId ? session.planner : null
  const plannerValue = useMemo(() => ({ enabled: plannerEnabled, source: planner }), [plannerEnabled, planner])

  return (
    <CalendarContext.Provider value={value}>
      <PlannerContext.Provider value={plannerValue}>{children}</PlannerContext.Provider>
    </CalendarContext.Provider>
  )
}

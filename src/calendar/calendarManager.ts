import type { CloudApi } from '../cloud/cloudApi'
import type { PlannerApi } from '../cloud/plannerApi'
import type { PlannerSource } from '../planner/plannerSource'
import { startAutoRefresh } from './autoRefresh'
import { createCloudSource } from './cloudSource'
import type { CalendarSource } from './types'

export interface CloudSession {
  userId: string
  source: CalendarSource
  api: CloudApi
  /**
   * Courses for the same user. Null when the planner feature is off, and briefly after sign-in while its code is
   * loaded (the session object is then replaced by a copy that carries it). Same lifetime as the session.
   */
  planner: PlannerSource | null
}

export interface CalendarManager {
  getSnapshot(): CloudSession | null
  subscribe(listener: () => void): () => void
  /** Sign-in (or account switch) creates a fresh session; null (sign-out) disposes the current one and clears its data. */
  setUser(userId: string | null): void
}

export interface ManagerOptions {
  createApi: (userId: string) => CloudApi | null
  /** Optional extra change feed (Realtime). Must return an unsubscribe function. */
  startRealtime?: (userId: string, onChange: () => void) => () => void
  /**
   * Planner (courses) data for the same session. Omit (the default) when the feature is off: then the planner
   * implementation is never even loaded (it is a separate chunk, imported on demand) and nothing planner-related is
   * ever requested. May be asynchronous (the production factory loads its chunk on first use).
   */
  createPlannerApi?: (userId: string) => PlannerApi | null | Promise<PlannerApi | null>
  /**
   * Focus/online/poll refresh. Defaults to the browser implementation; tests pass a stub. It receives ONE refresh
   * target per session (the calendar alone, or calendar + planner), so there is a single set of listeners and one timer.
   */
  autoRefresh?: (target: Pick<CalendarSource, 'refresh'>) => () => void
}

/**
 * Owns the lifetime of the per-user cloud session. It lives outside React state so that
 * StrictMode's mount/unmount/mount cycle simply tears down and rebuilds the session,
 * and so that exactly one session exists at a time.
 */
export function createCalendarManager(options: ManagerOptions): CalendarManager {
  let current: CloudSession | null = null
  let teardown: (() => void) | null = null
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  /** Bumped whenever a session ends; a late planner load of an ended session compares it and drops itself. */
  let generation = 0

  function stop() {
    generation++
    teardown?.()
    teardown = null
    current?.source.dispose() // drops every private record from memory
    current?.planner?.dispose()
    current = null
  }

  return {
    getSnapshot: () => current,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    setUser(userId) {
      if (current?.userId === userId) return
      stop()
      if (userId) {
        const api = options.createApi(userId)
        if (api) {
          const source = createCloudSource(api, { userId })
          const gen = generation
          let attaching = false
          /**
           * Loads the planner code and creates its source for THIS session. Whatever happens while it loads (sign-out,
           * account switch), a result for an ended session is dropped, so a planner is never attached to a different user.
           * A failed load leaves the session calendar-only; the next refresh trigger tries again.
           */
          const attachPlanner = async () => {
            if (!options.createPlannerApi || attaching) return
            attaching = true
            try {
              const [plannerApi, { createPlannerSource }] = await Promise.all([
                Promise.resolve(options.createPlannerApi(userId)),
                import('../planner/plannerSource'),
              ])
              if (gen !== generation || !current || current.planner || !plannerApi) return
              const planner = createPlannerSource(plannerApi, { userId })
              current = { ...current, planner }
              emit()
              void planner.refresh()
            } catch {
              // chunk or factory failure: stay calendar-only
            } finally {
              attaching = false
            }
          }
          // ONE refresh target per session. Both sources de-duplicate their own reads and never reject, so a failing
          // planner cannot hold up the calendar. Without a planner option the calendar source itself is passed, as before.
          const target = options.createPlannerApi
            ? {
                refresh: async () => {
                  const planner = gen === generation ? current?.planner : null
                  if (!planner) void attachPlanner()
                  await Promise.all([source.refresh(), planner?.refresh()])
                },
              }
            : source
          const stopAuto = (options.autoRefresh ?? startAutoRefresh)(target)
          const stopRt = options.startRealtime?.(userId, () => void source.refresh())
          teardown = () => {
            stopAuto()
            stopRt?.()
          }
          current = { userId, source, api, planner: null }
          void source.refresh()
          void attachPlanner()
        }
      }
      emit()
    },
  }
}

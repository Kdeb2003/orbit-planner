import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlannerApi } from './plannerApi'

/**
 * The per-user API factory the session manager receives, or `undefined` when the feature is off or there is no
 * Supabase client. With the flag off NO request to the courses table can ever be built and the planner implementation
 * (`plannerApi`, mappers, `plannerSource`) is never loaded: it is imported on demand, so it stays out of the initial
 * bundle. This file must keep only type imports of the planner modules.
 */
export function lazyPlannerApiFactory(opts: {
  enabled: boolean
  client: SupabaseClient | null
}): ((userId: string) => Promise<PlannerApi>) | undefined {
  const { enabled, client } = opts
  if (!enabled || !client) return undefined
  let api: Promise<PlannerApi> | null = null
  return () => {
    api ??= import('./plannerApi').then(
      (m) => m.createSupabasePlannerApi(client),
      (err: unknown) => {
        api = null // a failed chunk load may be retried on the next refresh
        throw err
      },
    )
    return api
  }
}

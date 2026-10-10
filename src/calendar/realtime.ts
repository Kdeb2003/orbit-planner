import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * OPTIONAL accelerator (VITE_ENABLE_REALTIME=true). Whenever any of the user's rows change
 * the calendar is simply re-read, so Realtime can never put the app in a state that polling
 * would not. It needs the three tables in the `supabase_realtime` publication (Dashboard →
 * Database → Publications); RLS is applied to the change stream. Failures are ignored on purpose:
 * focus/online/poll refresh (autoRefresh.ts) remains the dependable path.
 */
export function subscribeRealtime(client: Pick<SupabaseClient, 'channel' | 'removeChannel'>, userId: string, onChange: () => void, debounceMs = 500): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bump = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }
  try {
    const channel = client
      .channel(`orbit-calendar-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `user_id=eq.${userId}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_series', filter: `user_id=eq.${userId}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'series_exceptions' }, bump)
      .subscribe()
    return () => {
      clearTimeout(timer)
      void client.removeChannel(channel)
    }
  } catch {
    return () => clearTimeout(timer)
  }
}

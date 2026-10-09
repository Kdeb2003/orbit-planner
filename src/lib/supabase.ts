import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseConfig } from './supabaseConfig'

/** Validated configuration from the build-time environment. */
export const supabaseConfig = getSupabaseConfig(import.meta.env)

/**
 * The single browser Supabase client, or null when not configured.
 *
 * - Only the publishable key is used. Data access is protected by Row Level Security.
 * - PKCE flow: auth callbacks arrive as `?code=…` (query string) rather than a
 *   `#access_token=…` fragment, which would collide with our HashRouter.
 * - The session is stored by supabase-js itself; ORBIT never stores tokens or passwords.
 */
export const supabase: SupabaseClient | null = supabaseConfig.configured
  ? createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

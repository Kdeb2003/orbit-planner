/** Raw Vite env values (all optional strings). */
export interface RawEnv {
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
  VITE_ENABLE_SIGNUP?: string
}

export type SupabaseConfig =
  | { configured: true; url: string; publishableKey: string; signupEnabled: boolean }
  | { configured: false; problems: string[]; signupEnabled: boolean }

/**
 * True for keys that must never reach a browser: new-style secret keys
 * (`sb_secret_…`) and legacy JWT keys whose role is `service_role`.
 */
export function isSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true
  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { role?: unknown }
    return payload.role === 'service_role'
  } catch {
    return false
  }
}

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return true
    // Plain http is only acceptable for a local Supabase stack / test server.
    return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)
  } catch {
    return false
  }
}

/**
 * Validates the build-time environment. Never throws; a bad or missing value
 * yields `configured: false` plus human-readable problems, so the app can show
 * setup instructions instead of connecting to an unknown project.
 */
export function getSupabaseConfig(env: RawEnv): SupabaseConfig {
  const url = (env.VITE_SUPABASE_URL ?? '').trim()
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim()
  // UI-only switch: hides the registration form. The real control is the Supabase dashboard.
  const signupEnabled = (env.VITE_ENABLE_SIGNUP ?? 'true').trim().toLowerCase() !== 'false'

  const problems: string[] = []
  if (!url) problems.push('VITE_SUPABASE_URL is not set.')
  else if (!isAllowedUrl(url)) problems.push('VITE_SUPABASE_URL must be a valid https:// URL (http:// only for localhost).')
  if (!key) problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is not set.')
  else if (isSecretKey(key)) {
    problems.push('VITE_SUPABASE_PUBLISHABLE_KEY looks like a SECRET / service-role key. Never put it in the frontend; use the publishable key.')
  }
  if (problems.length) return { configured: false, problems, signupEnabled }
  return { configured: true, url: url.replace(/\/+$/, ''), publishableKey: key, signupEnabled }
}

/**
 * URL helpers for Supabase Auth callbacks.
 *
 * ORBIT uses HashRouter (`/#/calendar`). Auth emails must therefore return to
 * the app's BASE URL with query parameters (`/?code=…`), never to a hash route.
 * With the PKCE flow supabase-js exchanges `?code=` itself and cleans the URL.
 */

/** Where Supabase should send the user after clicking an email link. */
export function authRedirectUrl(origin: string = window.location.origin, baseUrl: string = import.meta.env.BASE_URL): string {
  return new URL(baseUrl, origin).href
}

/**
 * Supabase reports failed email links (expired, already used, …) in the URL
 * fragment, e.g. `#error=access_denied&error_code=otp_expired&error_description=…`,
 * or as query parameters. Returns a user-facing message, or null.
 */
export function readAuthUrlError(search: string, hash: string): string | null {
  const fromHash = hash.startsWith('#/') ? '' : hash.replace(/^#/, '')
  for (const raw of [search.replace(/^\?/, ''), fromHash]) {
    if (!raw) continue
    const params = new URLSearchParams(raw)
    if (!params.has('error') && !params.has('error_code') && !params.has('error_description')) continue
    const code = params.get('error_code') ?? ''
    if (code === 'otp_expired') return 'That email link has expired or was already used. Request a new one.'
    if (code === 'access_denied' || params.get('error') === 'access_denied') {
      return 'That link is no longer valid. Request a new one, or sign in.'
    }
    return 'The email link could not be used. Try again, or sign in.'
  }
  return null
}

/** True if the current URL carries a fragment-style auth error that would confuse HashRouter. */
export function hasFragmentAuthError(hash: string): boolean {
  return !hash.startsWith('#/') && /(^|[#&])error(_code|_description)?=/.test(hash)
}

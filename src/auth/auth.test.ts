import { describe, expect, it } from 'vitest'
import { friendlyAuthError, validateEmail, validateNewPassword } from './authErrors'
import { createAuthController, createUnconfiguredController } from './authController'
import { authRedirectUrl, hasFragmentAuthError, readAuthUrlError } from './authUrls'
import { createFakeAuthClient, fakeSession } from './fakeAuthClient'
import { getSupabaseConfig, isSecretKey } from '../lib/supabaseConfig'

const opts = { redirectTo: 'https://example.test/orbit-planner/' }
const tick = () => new Promise((r) => setTimeout(r, 0))

function jwt(payload: object) {
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${enc({ alg: 'HS256' })}.${enc(payload)}.sig`
}

describe('Supabase configuration', () => {
  it('is unconfigured (with clear problems) when variables are missing', () => {
    const c = getSupabaseConfig({})
    expect(c.configured).toBe(false)
    if (!c.configured) expect(c.problems).toEqual(['VITE_SUPABASE_URL is not set.', 'VITE_SUPABASE_PUBLISHABLE_KEY is not set.'])
  })

  it('treats blank values as missing', () => {
    expect(getSupabaseConfig({ VITE_SUPABASE_URL: '  ', VITE_SUPABASE_PUBLISHABLE_KEY: '' }).configured).toBe(false)
  })

  it('accepts a valid https URL and publishable key and normalises the URL', () => {
    const c = getSupabaseConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc' })
    expect(c).toMatchObject({ configured: true, url: 'https://abc.supabase.co', publishableKey: 'sb_publishable_abc', signupEnabled: true })
  })

  it('rejects non-https URLs except localhost, and garbage', () => {
    const k = 'sb_publishable_x'
    expect(getSupabaseConfig({ VITE_SUPABASE_URL: 'http://evil.example', VITE_SUPABASE_PUBLISHABLE_KEY: k }).configured).toBe(false)
    expect(getSupabaseConfig({ VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_PUBLISHABLE_KEY: k }).configured).toBe(false)
    expect(getSupabaseConfig({ VITE_SUPABASE_URL: 'http://localhost:54321', VITE_SUPABASE_PUBLISHABLE_KEY: k }).configured).toBe(true)
  })

  it('refuses secret and service-role keys', () => {
    expect(isSecretKey('sb_secret_abc')).toBe(true)
    expect(isSecretKey(jwt({ role: 'service_role' }))).toBe(true)
    expect(isSecretKey(jwt({ role: 'anon' }))).toBe(false)
    expect(isSecretKey('sb_publishable_abc')).toBe(false)
    const c = getSupabaseConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' })
    expect(c.configured).toBe(false)
    if (!c.configured) expect(c.problems[0]).toMatch(/SECRET/)
  })

  it('registration UI flag defaults on and can be switched off', () => {
    expect(getSupabaseConfig({}).signupEnabled).toBe(true)
    expect(getSupabaseConfig({ VITE_ENABLE_SIGNUP: 'false' }).signupEnabled).toBe(false)
    expect(getSupabaseConfig({ VITE_ENABLE_SIGNUP: 'FALSE' }).signupEnabled).toBe(false)
  })
})

describe('auth URLs (HashRouter + PKCE)', () => {
  it('redirects emails to the site base URL, never to a hash route', () => {
    expect(authRedirectUrl('http://localhost:5173', '/')).toBe('http://localhost:5173/')
    expect(authRedirectUrl('https://kdeb2003.github.io', '/orbit-planner/')).toBe('https://kdeb2003.github.io/orbit-planner/')
    expect(authRedirectUrl('https://kdeb2003.github.io', '/orbit-planner/')).not.toContain('#')
  })

  it('reads fragment and query auth errors but ignores normal hash routes', () => {
    expect(readAuthUrlError('', '#/calendar')).toBeNull()
    expect(readAuthUrlError('', '')).toBeNull()
    expect(readAuthUrlError('', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid')).toMatch(/expired/)
    expect(readAuthUrlError('?error=access_denied&error_description=x', '#/')).toMatch(/no longer valid/)
    expect(readAuthUrlError('?error=server_error', '')).toMatch(/could not be used/)
  })

  it('detects a fragment-style error that HashRouter would misread', () => {
    expect(hasFragmentAuthError('#error=access_denied&error_code=otp_expired')).toBe(true)
    expect(hasFragmentAuthError('#/login')).toBe(false)
    expect(hasFragmentAuthError('')).toBe(false)
  })
})

describe('auth error handling', () => {
  it('maps Supabase error codes to safe messages', () => {
    expect(friendlyAuthError({ code: 'invalid_credentials' })).toBe('Incorrect email or password.')
    expect(friendlyAuthError({ message: 'Invalid login credentials' })).toBe('Incorrect email or password.')
    expect(friendlyAuthError({ code: 'email_not_confirmed' })).toMatch(/confirm your email/)
    expect(friendlyAuthError({ code: 'signup_disabled' })).toMatch(/closed/)
    expect(friendlyAuthError({ code: 'over_email_send_rate_limit' })).toMatch(/Too many/)
    expect(friendlyAuthError({ code: 'otp_expired' })).toMatch(/expired/)
    expect(friendlyAuthError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })).toMatch(/Can’t reach/)
  })

  it('never leaks raw internal error text for unknown errors', () => {
    expect(friendlyAuthError({ message: 'pq: relation "secret_table" does not exist' })).toBe('Something went wrong. Please try again.')
    expect(friendlyAuthError(undefined)).toBe('Something went wrong. Please try again.')
  })

  it('validates email and password input', () => {
    expect(validateEmail('')).toMatch(/Enter/)
    expect(validateEmail('nope')).toMatch(/valid/)
    expect(validateEmail(' a@b.co ')).toBeNull()
    expect(validateNewPassword('short', 'short')).toMatch(/at least 12/)
    expect(validateNewPassword('x'.repeat(11), 'x'.repeat(11))).toMatch(/at least 12/) // boundary: 11 rejected
    expect(validateNewPassword('x'.repeat(12), 'x'.repeat(12))).toBeNull() // 12 accepted
    expect(validateNewPassword('long-enough-1', 'different-1')).toMatch(/match/)
    expect(validateNewPassword('long-enough-1', 'long-enough-1')).toBeNull()
  })
})

describe('auth controller (mocked Supabase client)', () => {
  it('unconfigured controller reports local-only mode and refuses sign-in', async () => {
    const c = createUnconfiguredController()
    expect(c.getSnapshot()).toEqual({ status: 'unconfigured' })
    expect((await c.signIn('a@b.co', 'x')).ok).toBe(false)
  })

  it('starts loading, then signed-out when there is no session', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    expect(c.getSnapshot().status).toBe('loading')
    await tick()
    expect(c.getSnapshot()).toEqual({ status: 'signed-out' })
  })

  it('restores an existing session after a refresh', async () => {
    const f = createFakeAuthClient(fakeSession)
    const c = createAuthController(f.client, opts)
    await tick()
    expect(c.getSnapshot()).toEqual({ status: 'signed-in', user: { id: fakeSession.user.id, email: 'qa@example.test' } })
  })

  it('signs in, validates input first, and reports bad credentials', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    await tick()
    expect(await c.signIn('', 'x')).toEqual({ ok: false, message: 'Enter your email address.' })
    expect(await c.signIn('a@b.co', '')).toEqual({ ok: false, message: 'Enter your password.' })
    expect(f.calls.filter((x) => x.method === 'signIn')).toHaveLength(0) // invalid input never hits the network

    f.next.signIn = { error: { code: 'invalid_credentials', message: 'Invalid login credentials' } }
    expect(await c.signIn('a@b.co', 'wrong')).toEqual({ ok: false, message: 'Incorrect email or password.' })
    expect(c.getSnapshot().status).toBe('signed-out')

    f.next.signIn = { session: fakeSession, user: fakeSession.user }
    expect((await c.signIn(' a@b.co ', 'right-password')).ok).toBe(true)
    expect(c.getSnapshot().status).toBe('signed-in')
    expect(f.calls.find((x) => x.method === 'signIn')?.args[0]).toEqual({ email: 'a@b.co', password: 'wrong' }) // email trimmed
  })

  it('turns a network failure into a friendly error instead of throwing', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    f.next.signIn = { throws: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }) }
    expect(await c.signIn('a@b.co', 'pw')).toEqual({ ok: false, message: 'Can’t reach the sign-in service. Check your connection and try again.' })
  })

  it('signs out locally and clears the session', async () => {
    const f = createFakeAuthClient(fakeSession)
    const c = createAuthController(f.client, opts)
    await tick()
    await c.signOut()
    expect(c.getSnapshot()).toEqual({ status: 'signed-out' }) // no "session ended" notice for an intentional sign-out
    expect(f.calls.find((x) => x.method === 'signOut')?.args[0]).toEqual({ scope: 'local' })
  })

  it('shows a notice when the session ends on its own (expiry / revoked)', async () => {
    const f = createFakeAuthClient(fakeSession)
    const c = createAuthController(f.client, opts)
    await tick()
    f.emit('SIGNED_OUT', null)
    expect(c.getSnapshot()).toEqual({ status: 'signed-out', notice: 'Your session has ended. Please sign in again.' })
  })

  it('follows token refreshes and auth state changes from supabase-js', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    await tick()
    const seen: string[] = []
    c.subscribe(() => seen.push(c.getSnapshot().status))
    f.emit('SIGNED_IN', fakeSession)
    f.emit('TOKEN_REFRESHED', fakeSession)
    f.emit('SIGNED_OUT', null)
    expect(seen).toEqual(['signed-in', 'signed-in', 'signed-out'])
  })

  it('sign-up asks for email confirmation and uses the app redirect URL', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    expect(await c.signUp('a@b.co', 'short', 'short')).toMatchObject({ ok: false })
    expect(await c.signUp('a@b.co', 'long-enough-1', 'mismatch-1234')).toMatchObject({ ok: false, message: 'The two passwords do not match.' })
    const r = await c.signUp('a@b.co', 'long-enough-1', 'long-enough-1')
    expect(r).toMatchObject({ ok: true, needsConfirmation: true })
    expect(f.calls.find((x) => x.method === 'signUp')?.args[0]).toMatchObject({ options: { emailRedirectTo: opts.redirectTo } })
    expect(c.getSnapshot().status).not.toBe('signed-in') // not signed in until the email is confirmed
  })

  it('an already-registered address gets the same neutral message (no account enumeration)', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    f.next.signUp = { session: null, user: { id: 'x', email: 'a@b.co', identities: [] } }
    const r = await c.signUp('a@b.co', 'long-enough-1', 'long-enough-1')
    expect(r).toMatchObject({ ok: true, needsConfirmation: true })
  })

  it('closed registration surfaces a clear error', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    f.next.signUp = { error: { code: 'signup_disabled' } }
    expect(await c.signUp('a@b.co', 'long-enough-1', 'long-enough-1')).toEqual({ ok: false, message: 'New registrations are currently closed.' })
  })

  it('password reset: neutral success message and redirect to the app URL', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    const r = await c.requestPasswordReset('a@b.co')
    expect(r).toMatchObject({ ok: true })
    expect(f.calls.find((x) => x.method === 'reset')?.args).toEqual(['a@b.co', { redirectTo: opts.redirectTo }])
  })

  it('password recovery: recovery state is sticky until the password is updated', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    await tick()
    f.emit('SIGNED_IN', fakeSession)
    f.emit('PASSWORD_RECOVERY', fakeSession)
    expect(c.getSnapshot().status).toBe('recovery')
    f.emit('TOKEN_REFRESHED', fakeSession)
    expect(c.getSnapshot().status).toBe('recovery')
    expect(await c.updatePassword('short', 'short')).toMatchObject({ ok: false })
    expect((await c.updatePassword('new-password-1', 'new-password-1')).ok).toBe(true)
    expect(c.getSnapshot().status).toBe('signed-in')
  })

  it('keeps an expired-link notice for the sign-in page', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    c.setNotice('That email link has expired.')
    await tick() // INITIAL_SESSION (null) must not erase the notice
    expect(c.getSnapshot()).toEqual({ status: 'signed-out', notice: 'That email link has expired.' })
  })

  it('never reads or writes calendar storage', async () => {
    const touched: string[] = []
    const real = globalThis.localStorage
    const spy = {
      getItem: (k: string) => (touched.push(`get:${k}`), null),
      setItem: (k: string) => touched.push(`set:${k}`),
      removeItem: (k: string) => touched.push(`remove:${k}`),
      clear: () => touched.push('clear'),
    }
    Object.defineProperty(globalThis, 'localStorage', { value: spy, configurable: true })
    try {
      const f = createFakeAuthClient(null)
      const c = createAuthController(f.client, opts)
      await tick()
      await c.signIn('a@b.co', 'pw-123456789')
      await c.signOut()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true })
    }
    expect(touched).toEqual([])
  })
})

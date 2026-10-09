import type { AuthClientLike } from './authController'

type Listener = (event: string, session: unknown) => void
type Result = { error?: { code?: string; message?: string; name?: string; status?: number } | null; session?: unknown; user?: unknown; throws?: Error }

export const fakeUser = { id: '00000000-0000-4000-8000-000000000001', email: 'qa@example.test' }
export const fakeSession = { access_token: 'fake-access', refresh_token: 'fake-refresh', user: fakeUser }

/**
 * A scriptable stand-in for `supabase.auth`, used by unit and component tests.
 * No network, no real credentials. Set `next.*` to script the next response.
 */
export function createFakeAuthClient(initialSession: unknown = null) {
  let session: unknown = initialSession
  const listeners = new Set<Listener>()
  const calls: { method: string; args: unknown[] }[] = []
  const next: Record<'signIn' | 'signUp' | 'signOut' | 'reset' | 'update', Result> = {
    signIn: { session: fakeSession, user: fakeUser },
    signUp: { session: null, user: { ...fakeUser, identities: [{}] } },
    signOut: {},
    reset: {},
    update: { user: fakeUser },
  }
  const emit = (event: string, s: unknown) => listeners.forEach((l) => l(event, s))

  async function run(method: keyof typeof next, args: unknown[]) {
    calls.push({ method, args })
    const r = next[method]
    if (r.throws) throw r.throws
    return r
  }

  const client = {
    async getSession() {
      calls.push({ method: 'getSession', args: [] })
      return { data: { session }, error: null }
    },
    onAuthStateChange(cb: Listener) {
      listeners.add(cb)
      // Like supabase-js: report the initial session shortly after subscribing.
      queueMicrotask(() => cb('INITIAL_SESSION', session))
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }
    },
    async signInWithPassword(...args: unknown[]) {
      const r = await run('signIn', args)
      if (r.error) return { data: { session: null, user: null }, error: r.error }
      session = r.session
      emit('SIGNED_IN', session)
      return { data: { session: r.session, user: r.user }, error: null }
    },
    async signUp(...args: unknown[]) {
      const r = await run('signUp', args)
      if (r.error) return { data: { session: null, user: null }, error: r.error }
      return { data: { session: r.session ?? null, user: r.user }, error: null }
    },
    async signOut(...args: unknown[]) {
      await run('signOut', args)
      session = null
      emit('SIGNED_OUT', null)
      return { error: null }
    },
    async resetPasswordForEmail(...args: unknown[]) {
      const r = await run('reset', args)
      return { data: {}, error: r.error ?? null }
    },
    async updateUser(...args: unknown[]) {
      const r = await run('update', args)
      if (r.error) return { data: { user: null }, error: r.error }
      return { data: { user: r.user }, error: null }
    },
  }

  return {
    client: client as unknown as AuthClientLike,
    calls,
    next,
    /** Simulate events coming from supabase-js (token refresh failure, recovery link, …). */
    emit,
    setSession(s: unknown) {
      session = s
    },
  }
}

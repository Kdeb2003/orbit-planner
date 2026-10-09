import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyAuthError, MIN_PASSWORD_LENGTH, validateEmail, validateNewPassword } from './authErrors'

/** The slice of the Supabase client the auth layer uses (easy to fake in tests). */
export type AuthClientLike = Pick<
  SupabaseClient['auth'],
  'getSession' | 'onAuthStateChange' | 'signInWithPassword' | 'signUp' | 'signOut' | 'resetPasswordForEmail' | 'updateUser'
>

export interface AuthUser {
  id: string
  email: string
}

export type AuthState =
  /** Supabase is not configured: ORBIT runs in local-only mode. */
  | { status: 'unconfigured' }
  | { status: 'loading' }
  | { status: 'signed-out'; notice?: string }
  | { status: 'signed-in'; user: AuthUser }
  /** The user opened a password-recovery link and must choose a new password. */
  | { status: 'recovery'; user: AuthUser }

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string }

export interface AuthController {
  getSnapshot(): AuthState
  subscribe(listener: () => void): () => void
  signIn(email: string, password: string): Promise<ActionResult>
  /** `needsConfirmation` is true when the user must click the emailed link. */
  signUp(email: string, password: string, confirm: string): Promise<ActionResult & { needsConfirmation?: boolean }>
  signOut(): Promise<void>
  requestPasswordReset(email: string): Promise<ActionResult>
  updatePassword(password: string, confirm: string): Promise<ActionResult>
  /** Show a notice on the sign-in page (e.g. an expired email link). */
  setNotice(message: string): void
  dispose(): void
}

export interface AuthControllerOptions {
  /** Where email links should return to (see authUrls.authRedirectUrl). */
  redirectTo: string
}

const toUser = (u: { id: string; email?: string | null }): AuthUser => ({ id: u.id, email: u.email ?? '' })

export function createUnconfiguredController(): AuthController {
  const state: AuthState = { status: 'unconfigured' }
  const none = async (): Promise<ActionResult> => ({ ok: false, message: 'Sign-in is not configured.' })
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    signIn: none,
    signUp: none,
    signOut: async () => {},
    requestPasswordReset: none,
    updatePassword: none,
    setNotice: () => {},
    dispose: () => {},
  }
}

/**
 * Wraps the Supabase auth client in a small observable store.
 * It only talks to Supabase Auth; it never reads or writes ORBIT's calendar
 * data (`orbit.events.v1` / `orbit.series.v1`) and never stores credentials itself —
 * supabase-js persists the session.
 */
export function createAuthController(client: AuthClientLike, options: AuthControllerOptions): AuthController {
  let state: AuthState = { status: 'loading' }
  let explicitSignOut = false
  const listeners = new Set<() => void>()

  function set(next: AuthState) {
    state = next
    listeners.forEach((l) => l())
  }

  function applySession(event: string, session: { user: { id: string; email?: string | null } } | null) {
    if (event === 'PASSWORD_RECOVERY' && session) return set({ status: 'recovery', user: toUser(session.user) })
    if (!session) {
      if (event === 'SIGNED_OUT' && !explicitSignOut && state.status === 'signed-in') {
        return set({ status: 'signed-out', notice: 'Your session has ended. Please sign in again.' })
      }
      // Keep a pending notice (e.g. an expired-link message) while the initial check settles.
      if (state.status === 'signed-out' && state.notice && event !== 'SIGNED_OUT') return
      return set({ status: 'signed-out' })
    }
    explicitSignOut = false
    // A recovery session stays in "recovery" until the password is changed.
    if (state.status === 'recovery') return
    set({ status: 'signed-in', user: toUser(session.user) })
  }

  const { data } = client.onAuthStateChange((event, session) => {
    // Never call back into supabase-js from here (it can deadlock); just record state.
    applySession(event, session)
  })
  // Settles `loading` even if the initial-session event is delayed.
  client
    .getSession()
    .then(({ data: d }) => {
      if (state.status === 'loading') applySession('INITIAL_SESSION', d.session)
    })
    .catch(() => {
      if (state.status === 'loading') set({ status: 'signed-out' })
    })

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async signIn(email, password) {
      const emailError = validateEmail(email)
      if (emailError) return { ok: false, message: emailError }
      if (!password) return { ok: false, message: 'Enter your password.' }
      try {
        const { data: d, error } = await client.signInWithPassword({ email: email.trim(), password })
        if (error) return { ok: false, message: friendlyAuthError(error) }
        explicitSignOut = false
        if (d.session) applySession('SIGNED_IN', d.session)
        return { ok: true }
      } catch (err) {
        return { ok: false, message: friendlyAuthError(err) }
      }
    },

    async signUp(email, password, confirm) {
      const emailError = validateEmail(email)
      if (emailError) return { ok: false, message: emailError }
      const pwError = validateNewPassword(password, confirm)
      if (pwError) return { ok: false, message: pwError }
      try {
        const { data: d, error } = await client.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: options.redirectTo },
        })
        if (error) return { ok: false, message: friendlyAuthError(error) }
        if (d.session) {
          explicitSignOut = false
          applySession('SIGNED_IN', d.session)
          return { ok: true, needsConfirmation: false }
        }
        // Same message whether or not the address already exists (no account enumeration).
        return {
          ok: true,
          needsConfirmation: true,
          message: 'Check your inbox: if this address can be registered, we’ve sent a confirmation link.',
        }
      } catch (err) {
        return { ok: false, message: friendlyAuthError(err) }
      }
    },

    async signOut() {
      explicitSignOut = true
      try {
        // 'local': ends this browser's session only; other devices stay signed in.
        await client.signOut({ scope: 'local' })
      } catch {
        /* supabase-js clears the local session even if the request fails */
      }
      set({ status: 'signed-out' })
    },

    async requestPasswordReset(email) {
      const emailError = validateEmail(email)
      if (emailError) return { ok: false, message: emailError }
      try {
        const { error } = await client.resetPasswordForEmail(email.trim(), { redirectTo: options.redirectTo })
        if (error) return { ok: false, message: friendlyAuthError(error) }
        return { ok: true, message: 'If an account exists for this address, a reset link is on its way.' }
      } catch (err) {
        return { ok: false, message: friendlyAuthError(err) }
      }
    },

    async updatePassword(password, confirm) {
      const pwError = validateNewPassword(password, confirm)
      if (pwError) return { ok: false, message: pwError }
      try {
        const { data: d, error } = await client.updateUser({ password })
        if (error) return { ok: false, message: friendlyAuthError(error) }
        if (d.user) set({ status: 'signed-in', user: toUser(d.user) })
        return { ok: true, message: 'Password updated.' }
      } catch (err) {
        return { ok: false, message: friendlyAuthError(err) }
      }
    },

    setNotice(message) {
      if (state.status === 'loading' || state.status === 'signed-out') set({ status: 'signed-out', notice: message })
    },

    dispose() {
      data.subscription.unsubscribe()
      listeners.clear()
    },
  }
}

export { MIN_PASSWORD_LENGTH }

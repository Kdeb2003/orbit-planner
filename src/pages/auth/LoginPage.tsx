import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { AuthField, AuthMessage, AuthShell, BusyLabel } from './AuthShell'
import { authLinkClass, authPrimaryBtn } from './authStyles'

export function LoginPage() {
  const { state, controller, signupEnabled } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const notice = state.status === 'signed-out' ? state.notice : undefined

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const result = await controller.signIn(email, password)
    setBusy(false)
    // On success the auth state changes and the route guard navigates away.
    if (!result.ok) setError(result.message)
  }

  return (
    <AuthShell title="Sign in" subtitle="Welcome back to ORBIT.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {notice && <AuthMessage kind="info">{notice}</AuthMessage>}
        {error && <AuthMessage kind="error">{error}</AuthMessage>}
        <AuthField label="Email" id="login-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <AuthField label="Password" id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={busy} className={authPrimaryBtn}>
          <BusyLabel busy={busy} idle="Sign in" working="Signing in…" />
        </button>
      </form>
      <div className="mt-5 flex flex-wrap justify-between gap-2 text-sm text-muted">
        <Link to="/forgot-password" className={authLinkClass}>
          Forgot password?
        </Link>
        {signupEnabled && (
          <span>
            No account?{' '}
            <Link to="/register" className={authLinkClass}>
              Create one
            </Link>
          </span>
        )}
      </div>
    </AuthShell>
  )
}

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { MIN_PASSWORD_LENGTH } from '../../auth/authErrors'
import { useAuth } from '../../auth/AuthContext'
import { AuthField, AuthMessage, AuthShell, BusyLabel } from './AuthShell'
import { authLinkClass, authPrimaryBtn } from './authStyles'

export function RegisterPage() {
  const { controller, signupEnabled } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!signupEnabled) {
    return (
      <AuthShell title="Registration closed" subtitle="New accounts are not being accepted.">
        <Link to="/login" className={authLinkClass}>
          Back to sign in
        </Link>
      </AuthShell>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const result = await controller.signUp(email, password, confirm)
    setBusy(false)
    if (!result.ok) return setError(result.message)
    if (result.needsConfirmation) setSent(result.message ?? 'Check your inbox for a confirmation link.')
  }

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <AuthMessage kind="success">{sent}</AuthMessage>
        <p className="mt-4 text-sm text-muted">
          Open the link in the email, then sign in. If you don’t see it, check your spam folder.
        </p>
        <Link to="/login" className={`${authLinkClass} mt-4 inline-block text-sm`}>
          Go to sign in
        </Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Create account" subtitle="You’ll confirm your email address before signing in.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {error && <AuthMessage kind="error">{error}</AuthMessage>}
        <AuthField label="Email" id="reg-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <AuthField label={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`} id="reg-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <AuthField label="Confirm password" id="reg-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="submit" disabled={busy} className={authPrimaryBtn}>
          <BusyLabel busy={busy} idle="Create account" working="Creating account…" />
        </button>
      </form>
      <p className="mt-5 text-sm text-muted">
        Already registered?{' '}
        <Link to="/login" className={authLinkClass}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  )
}

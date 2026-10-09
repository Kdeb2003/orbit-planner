import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { AuthField, AuthMessage, AuthShell, BusyLabel } from './AuthShell'
import { authLinkClass, authPrimaryBtn } from './authStyles'

export function ForgotPasswordPage() {
  const { controller } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const result = await controller.requestPasswordReset(email)
    setBusy(false)
    if (result.ok) setDone(result.message ?? 'Check your inbox.')
    else setError(result.message)
  }

  return (
    <AuthShell title="Reset password" subtitle="We’ll email you a link to choose a new password.">
      {done ? (
        <AuthMessage kind="success">{done}</AuthMessage>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {error && <AuthMessage kind="error">{error}</AuthMessage>}
          <AuthField label="Email" id="forgot-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" disabled={busy} className={authPrimaryBtn}>
            <BusyLabel busy={busy} idle="Send reset link" working="Sending…" />
          </button>
        </form>
      )}
      <Link to="/login" className={`${authLinkClass} mt-5 inline-block text-sm`}>
        Back to sign in
      </Link>
    </AuthShell>
  )
}

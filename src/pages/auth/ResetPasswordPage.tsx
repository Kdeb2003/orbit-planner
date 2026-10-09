import { useState } from 'react'
import type { FormEvent } from 'react'
import { MIN_PASSWORD_LENGTH } from '../../auth/authErrors'
import { useAuth } from '../../auth/AuthContext'
import { AuthField, AuthMessage, AuthShell, BusyLabel } from './AuthShell'
import { authPrimaryBtn } from './authStyles'

/** Shown after the user opens a password-recovery email link. */
export function ResetPasswordPage() {
  const { controller } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const result = await controller.updatePassword(password, confirm)
    setBusy(false)
    // On success the state becomes signed-in and the app is shown.
    if (!result.ok) setError(result.message)
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Set a new password to finish recovering your account.">
      <form onSubmit={submit} noValidate className="space-y-4">
        {error && <AuthMessage kind="error">{error}</AuthMessage>}
        <AuthField label={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`} id="reset-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <AuthField label="Confirm new password" id="reset-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="submit" disabled={busy} className={authPrimaryBtn}>
          <BusyLabel busy={busy} idle="Update password" working="Updating…" />
        </button>
      </form>
    </AuthShell>
  )
}

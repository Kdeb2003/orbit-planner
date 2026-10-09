import { CloudOff, LogOut, User } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Card } from './ui/Card'

/** Account status and sign-out; honest about what is (not) stored in the cloud. */
export function AccountCard() {
  const { state, controller } = useAuth()
  const [busy, setBusy] = useState(false)

  if (state.status === 'unconfigured') {
    return (
      <Card title="Account">
        <p className="flex items-start gap-2 text-sm text-muted">
          <CloudOff size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <strong className="text-white">Local-only mode.</strong> Cloud sign-in isn’t configured, so your calendar lives only in this browser.
          </span>
        </p>
      </Card>
    )
  }
  if (state.status !== 'signed-in') return null

  return (
    <Card title="Account">
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm">
          <User size={16} className="text-muted" aria-hidden />
          <span className="min-w-0 break-all" data-testid="account-email">
            {state.user.email}
          </span>
        </p>
        <p className="text-xs text-muted">
          Cloud sync isn’t available yet: your events and schedules are still stored <strong className="text-white">only in this browser</strong> and are not backed up to your account.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await controller.signOut()
          }}
          className="flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm hover:bg-surface-2 disabled:opacity-60"
        >
          <LogOut size={16} aria-hidden /> {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </Card>
  )
}

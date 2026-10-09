import { Loader2, Orbit } from 'lucide-react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { authInputClass } from './authStyles'


/** Centered card used by every sign-in related screen. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-8">
      <main className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Orbit className="text-accent-soft" size={28} aria-hidden />
          <span className="text-xl font-semibold tracking-wide">ORBIT</span>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-lg shadow-black/20 sm:p-7">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </main>
    </div>
  )
}

export function AuthField({ label, id, ...props }: { label: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      <input id={id} className={authInputClass} {...props} />
    </div>
  )
}

export function AuthMessage({ kind, children }: { kind: 'error' | 'info' | 'success'; children: ReactNode }) {
  const styles = {
    error: 'border-deadline/50 bg-deadline/10',
    info: 'border-line bg-surface-2/60',
    success: 'border-personal/50 bg-personal/10',
  }[kind]
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-3 py-2 text-sm ${styles}`}>
      {children}
    </p>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center gap-2 text-sm text-muted">
      <Loader2 className="animate-spin" size={18} aria-hidden /> {label}
    </div>
  )
}

export function BusyLabel({ busy, idle, working }: { busy: boolean; idle: string; working: string }) {
  return busy ? (
    <>
      <Loader2 className="animate-spin" size={16} aria-hidden /> {working}
    </>
  ) : (
    <>{idle}</>
  )
}

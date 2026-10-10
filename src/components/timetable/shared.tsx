import type { ReactNode } from 'react'

export const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-base px-3 text-sm text-white [color-scheme:dark] placeholder:text-muted/70'
export const secondaryBtn = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line px-4 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50'
export const primaryBtn = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50'

type Tone = 'neutral' | 'warn' | 'bad' | 'good' | 'accent'
const tones: Record<Tone, string> = {
  neutral: 'border-line bg-surface-2 text-muted',
  warn: 'border-work/40 bg-work/10 text-work',
  bad: 'border-deadline/40 bg-deadline/10 text-deadline',
  good: 'border-personal/40 bg-personal/10 text-personal',
  accent: 'border-accent/40 bg-accent/10 text-accent-soft',
}

export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function Notice({ tone = 'neutral', title, children, role }: { tone?: Tone; title?: string; children: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div role={role} className={`rounded-xl border p-3 text-sm ${tones[tone]}`}>
      {title && <p className="font-semibold text-white">{title}</p>}
      <div className={title ? 'mt-1' : ''}>{children}</div>
    </div>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${tone === 'warn' ? 'text-work' : tone === 'bad' ? 'text-deadline' : 'text-white'}`}>{value}</dd>
    </div>
  )
}

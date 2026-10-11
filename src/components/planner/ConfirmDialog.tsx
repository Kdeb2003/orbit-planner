import { Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  pendingLabel: string
  /** Destructive action: the confirm button is styled as dangerous. */
  danger?: boolean
  pending: boolean
  /** Why the last attempt failed; the dialog stays open until the server confirmed. */
  error: string | null
  /** When set, the action is disabled and this explains why (the reviewed course changed). */
  blockedReason?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Modal confirmation. It never closes itself: the caller closes it only after the server confirmed the action.
 * Cancel gets the initial focus (the safe choice); Esc cancels unless a request is running.
 */
export function ConfirmDialog({ title, children, confirmLabel, pendingLabel, danger, pending, error, blockedReason, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) d.showModal()
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      onCancel={(e) => {
        e.preventDefault() // we close it ourselves, so a running request is never orphaned
        if (!pending) onCancel()
      }}
      onClose={() => {
        if (!pending) onCancel()
      }}
      className="m-auto w-[calc(100%-1rem)] max-w-md rounded-2xl border border-line bg-surface p-0 text-white shadow-2xl backdrop:bg-black/70"
    >
      <div className="space-y-4 p-4 sm:p-6">
        <h2 id="confirm-title" className="text-lg font-semibold">
          {title}
        </h2>
        <div id="confirm-body" className="space-y-2 text-sm text-muted">
          {children}
        </div>
        {blockedReason && (
          <p role="alert" data-testid="confirm-blocked" className="rounded-xl border border-work/40 bg-work/10 px-3 py-2 text-sm">
            {blockedReason}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2 text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" data-autofocus disabled={pending} onClick={onCancel} className="min-h-11 rounded-xl border border-line px-4 text-sm hover:bg-surface-2 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !!blockedReason}
            onClick={onConfirm}
            className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-5 text-sm font-medium text-white disabled:opacity-60 ${danger ? 'border border-deadline bg-deadline/20 hover:bg-deadline/30' : 'bg-accent hover:bg-accent/90'}`}
          >
            {pending && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />}
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}

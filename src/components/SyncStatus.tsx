import { Check, CloudOff, HardDrive, Loader2, TriangleAlert } from 'lucide-react'
import { useCalendar } from '../calendar/CalendarContext'

/**
 * Small, quiet indicator of where the calendar is stored and whether it is saved.
 * Local data is NEVER labelled as cloud-synchronised.
 */
export function SyncStatus() {
  const { mode, status, pendingWrites, offline, error, source } = useCalendar()
  const base = 'flex items-center gap-1.5 text-xs'

  if (mode === 'local') {
    return (
      <span className={`${base} text-muted`} data-testid="sync-status" data-state="local" title="Stored only in this browser">
        <HardDrive size={14} aria-hidden /> <span className="hidden sm:inline">Local only</span>
        <span className="sr-only sm:hidden">Local only</span>
      </span>
    )
  }
  if (mode === 'none' || status === 'loading') {
    return (
      <span className={`${base} text-muted`} data-testid="sync-status" data-state="loading" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden /> <span className="hidden sm:inline">Loading calendar…</span>
        <span className="sr-only sm:hidden">Loading calendar</span>
      </span>
    )
  }
  if (offline) {
    return (
      <button type="button" onClick={() => void source.refresh()} className={`${base} text-work`} data-testid="sync-status" data-state="offline">
        <CloudOff size={14} aria-hidden /> <span className="hidden sm:inline">Offline · Retry</span>
        <span className="sr-only sm:hidden">Offline, retry</span>
      </button>
    )
  }
  if (error || status === 'error') {
    return (
      <button type="button" onClick={() => void source.refresh()} className={`${base} text-deadline`} data-testid="sync-status" data-state="error">
        <TriangleAlert size={14} aria-hidden /> <span className="hidden sm:inline">Sync error · Retry</span>
        <span className="sr-only sm:hidden">Sync error, retry</span>
      </button>
    )
  }
  if (pendingWrites > 0) {
    return (
      <span className={`${base} text-muted`} data-testid="sync-status" data-state="saving" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden /> <span className="hidden sm:inline">Saving…</span>
        <span className="sr-only sm:hidden">Saving</span>
      </span>
    )
  }
  return (
    <span className={`${base} text-muted`} data-testid="sync-status" data-state="saved" title="Saved to your account">
      <Check size={14} className="text-personal" aria-hidden /> <span className="hidden sm:inline">Saved to cloud</span>
      <span className="sr-only sm:hidden">Saved to cloud</span>
    </span>
  )
}

/** Banner for the latest load/save failure (cloud mode). Routine successes show nothing. */
export function SyncErrorBanner() {
  const { mode, error, source, status, skippedInvalid } = useCalendar()
  if (mode !== 'cloud') return null
  if (error && status !== 'error') {
    return (
      <div role="alert" data-testid="sync-error" className="flex flex-wrap items-center gap-2 border-b border-deadline/50 bg-deadline/15 px-4 py-2 text-sm md:px-8">
        <span className="min-w-0 flex-1">
          <strong>Not synced.</strong> {error}
        </span>
        <button type="button" onClick={() => void source.refresh()} className="min-h-11 rounded-xl border border-line px-3 hover:bg-surface-2">
          Retry
        </button>
        <button type="button" onClick={() => source.dismissError()} className="min-h-11 rounded-xl px-3 text-muted hover:bg-surface-2">
          Dismiss
        </button>
      </div>
    )
  }
  if (skippedInvalid > 0) {
    return (
      <p role="status" className="border-b border-line bg-surface-2/50 px-4 py-1.5 text-xs text-muted md:px-8">
        {skippedInvalid} record(s) in your cloud calendar could not be read and are hidden.
      </p>
    )
  }
  return null
}

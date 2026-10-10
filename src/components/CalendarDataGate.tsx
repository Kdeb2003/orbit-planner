import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCalendar } from '../calendar/CalendarContext'
import { Card } from './ui/Card'

/**
 * Shows a loading or error card instead of calendar data until it is available, so an
 * empty-looking calendar is never mistaken for "no events" while data is still loading
 * or could not be loaded.
 */
export function CalendarDataGate({ children }: { children: ReactNode }) {
  const { status, error, source, mode } = useCalendar()
  if (status === 'loading') {
    return (
      <Card>
        <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="animate-spin" size={16} aria-hidden />
          {mode === 'cloud' ? 'Loading your calendar…' : 'Loading…'}
        </p>
      </Card>
    )
  }
  if (status === 'error') {
    return (
      <Card>
        <div role="alert" className="space-y-3 py-4 text-sm">
          <p>
            <strong>Couldn’t load your calendar.</strong> {error}
          </p>
          <button
            type="button"
            onClick={() => void source.refresh()}
            className="min-h-11 rounded-xl border border-line px-4 hover:bg-surface-2"
          >
            Try again
          </button>
        </div>
      </Card>
    )
  }
  return <>{children}</>
}

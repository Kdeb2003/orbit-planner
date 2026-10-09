import type { CalendarEvent } from '../types'
import { eventTimeLabel } from '../utils/events'
import type { DateKey } from '../utils/time'
import { categoryStyle } from './categories'

interface EventItemProps {
  event: CalendarEvent
  day: DateKey
  state?: 'past' | 'live' | 'next'
  onSelect?: (event: CalendarEvent) => void
}

/** One event row; a button when `onSelect` is given. */
export function EventItem({ event, day, state = 'next', onSelect }: EventItemProps) {
  const c = categoryStyle[event.category]
  const body = (
    <>
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${c.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{event.title}</p>
        <p className="truncate text-xs text-muted">
          <span className="tabular-nums text-white/80">{eventTimeLabel(event, day, event.timeZone)}</span>
          {' · '}
          <span className={c.text}>{c.label}</span>
          {event.location ? ` · ${event.location}` : ''}
        </p>
      </div>
      {state === 'live' && <span className="self-start text-xs font-medium text-accent-soft">Now</span>}
    </>
  )
  const cls = `flex w-full gap-3 rounded-xl border p-3 text-left ${
    state === 'live' ? 'border-accent bg-accent/10' : 'border-line bg-surface-2/40'
  } ${state === 'past' ? 'opacity-50' : ''}`

  if (!onSelect) return <div className={cls}>{body}</div>
  return (
    <button type="button" onClick={() => onSelect(event)} className={`${cls} min-h-12 hover:border-accent/60`}>
      {body}
    </button>
  )
}

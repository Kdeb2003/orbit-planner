import type { CalendarEvent } from '../types'
import type { DateKey } from '../utils/time'
import { EventItem } from './EventItem'

interface TimelineProps {
  events: CalendarEvent[]
  day: DateKey
  now: Date
  onSelect?: (event: CalendarEvent) => void
}

export function Timeline({ events, day, now, onSelect }: TimelineProps) {
  const t = now.getTime()
  return (
    <ol className="space-y-3">
      {events.map((e) => {
        const state = t >= Date.parse(e.end) ? 'past' : t >= Date.parse(e.start) ? 'live' : 'next'
        return (
          <li key={e.id}>
            <EventItem event={e} day={day} state={state} onSelect={onSelect} />
          </li>
        )
      })}
    </ol>
  )
}

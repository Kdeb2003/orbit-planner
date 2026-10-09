import type { ScheduleEvent } from '../types'
import { formatMinutes } from '../utils/time'
import { categoryStyle } from './categories'

export function Timeline({ events, nowMin }: { events: ScheduleEvent[]; nowMin: number }) {
  return (
    <ol className="space-y-3">
      {events.map((e) => {
        const state = nowMin >= e.endMin ? 'past' : nowMin >= e.startMin ? 'live' : 'next'
        const c = categoryStyle[e.category]
        return (
          <li
            key={e.id}
            className={`flex gap-3 rounded-xl border p-3 ${
              state === 'live' ? 'border-accent bg-accent/10' : 'border-line bg-surface-2/40'
            } ${state === 'past' ? 'opacity-50' : ''}`}
          >
            <div className="w-14 shrink-0 text-xs tabular-nums text-muted">
              <div className="text-sm text-white">{formatMinutes(e.startMin)}</div>
              {formatMinutes(e.endMin)}
            </div>
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${c.dot}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{e.title}</p>
              <p className="truncate text-xs text-muted">
                <span className={c.text}>{c.label}</span>
                {e.location ? ` · ${e.location}` : ''}
              </p>
            </div>
            {state === 'live' && <span className="self-start text-xs font-medium text-accent-soft">Now</span>}
          </li>
        )
      })}
    </ol>
  )
}

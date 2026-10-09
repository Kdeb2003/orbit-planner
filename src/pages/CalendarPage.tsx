import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { categoryStyle } from '../components/categories'
import { EventItem } from '../components/EventItem'
import { Card } from '../components/ui/Card'
import { useEventEditor } from '../hooks/useEventEditor'
import { useEvents } from '../hooks/useEvents'
import { useNow } from '../hooks/useNow'
import { useSeries } from '../hooks/useSeries'
import type { ScheduledItem } from '../types'
import { eventsOnDay } from '../utils/events'
import { expandItems } from '../utils/schedule'
import {
  addDays,
  addMonths,
  dateKey,
  formatDayLong,
  formatDayShort,
  formatKey,
  formatMonthTitle,
  formatWeekdayShort,
  isSameMonth,
  monthGrid,
  weekDays,
} from '../utils/time'

type View = 'month' | 'week'

const ghost =
  'flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line px-3 text-sm hover:bg-surface-2'

export function CalendarPage() {
  const now = useNow(60_000)
  const today = dateKey(now)
  const { events } = useEvents()
  const { series, setException, clearException } = useSeries()
  const editor = useEventEditor()
  const [selected, setSelected] = useState(() => dateKey(new Date()))
  const [view, setView] = useState<View>('month')

  const days = useMemo(() => (view === 'month' ? monthGrid(selected) : weekDays(selected)), [view, selected])
  // Occurrences are generated only for the days on screen. Cancelled ones are
  // kept (for the Restore action) but hidden from the month grid.
  const all = useMemo(
    () => expandItems(events, series, days[0], days[days.length - 1], { includeCancelled: true }),
    [events, series, days],
  )
  const byDay = useMemo(() => {
    const source = view === 'month' ? all.filter((i) => !i.cancelled) : all
    return new Map(days.map((d) => [d, eventsOnDay(source, d)]))
  }, [all, days, view])
  const selectedEvents = eventsOnDay(all, selected)

  function restore(item: ScheduledItem) {
    if (!item.seriesId || !item.originalDate) return
    const ex = series.find((s) => s.id === item.seriesId)?.exceptions.find((x) => x.originalDate === item.originalDate)
    if (ex?.override && Object.keys(ex.override).length) {
      setException(item.seriesId, { originalDate: item.originalDate, override: ex.override })
    } else clearException(item.seriesId, item.originalDate)
  }

  const step = (dir: 1 | -1) => setSelected(view === 'month' ? addMonths(selected, dir) : addDays(selected, 7 * dir))
  const title =
    view === 'month'
      ? formatMonthTitle(selected)
      : `${formatDayShort(days[0])} – ${formatDayShort(days[6])}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight" aria-live="polite">
          {title}
        </h1>
        <button
          type="button"
          onClick={() => editor.openNew(selected)}
          className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium hover:bg-accent/90"
        >
          <Plus size={18} aria-hidden /> Add event
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={ghost} onClick={() => step(-1)} aria-label={view === 'month' ? 'Previous month' : 'Previous week'}>
          <ChevronLeft size={18} aria-hidden />
        </button>
        <button type="button" className={ghost} onClick={() => step(1)} aria-label={view === 'month' ? 'Next month' : 'Next week'}>
          <ChevronRight size={18} aria-hidden />
        </button>
        <button type="button" className={ghost} onClick={() => setSelected(today)}>
          Today
        </button>
        <div role="group" aria-label="Calendar view" className="ml-auto flex overflow-hidden rounded-xl border border-line">
          {(['month', 'week'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`min-h-11 px-4 text-sm capitalize ${view === v ? 'bg-accent/25 text-white' : 'text-muted hover:bg-surface-2'}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === 'month' ? (
        <Card className="p-2 sm:p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
            {weekDays(selected).map((d) => (
              <div key={d} className="py-1">
                {formatWeekdayShort(d)}
              </div>
            ))}
            {days.map((d) => {
              const evs = byDay.get(d) ?? []
              const isToday = d === today
              const isSelected = d === selected
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setSelected(d)}
                  aria-pressed={isSelected}
                  data-date={d}
                  data-count={evs.length}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={`${formatDayLong(d)}, ${evs.length} ${evs.length === 1 ? 'event' : 'events'}`}
                  className={`flex min-h-14 min-w-0 flex-col items-stretch gap-1 rounded-lg border p-1 text-left sm:min-h-24 sm:p-1.5 ${
                    isSelected ? 'border-accent bg-accent/10' : 'border-line/60 bg-surface-2/30 hover:border-accent/50'
                  } ${isSameMonth(d, selected) ? 'text-white' : 'text-muted/60'}`}
                >
                  <span
                    className={`flex size-6 items-center justify-center self-start rounded-full text-xs ${
                      isToday ? 'bg-accent font-semibold text-white' : ''
                    }`}
                  >
                    {Number(d.slice(8))}
                  </span>
                  <span className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden>
                    {evs.slice(0, 4).map((e) => (
                      <span key={e.id} className={`size-1.5 rounded-full ${categoryStyle[e.category].dot}`} />
                    ))}
                  </span>
                  <span className="hidden min-w-0 flex-col gap-0.5 sm:flex" aria-hidden>
                    {evs.slice(0, 2).map((e) => (
                      <span key={e.id} className="flex items-center gap-1 truncate text-[11px] text-white/90">
                        <span className={`size-1.5 shrink-0 rounded-full ${categoryStyle[e.category].dot}`} />
                        <span className="truncate">{e.title}</span>
                      </span>
                    ))}
                    {evs.length > 2 && <span className="text-[11px] text-muted">+{evs.length - 2} more</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-7">
          {days.map((d) => {
            const evs = byDay.get(d) ?? []
            const isToday = d === today
            return (
              <section
                key={d}
                aria-label={formatDayLong(d)}
                className={`min-w-0 rounded-2xl border bg-surface p-3 ${d === selected ? 'border-accent' : 'border-line'}`}
              >
                <button
                  type="button"
                  onClick={() => setSelected(d)}
                  aria-current={isToday ? 'date' : undefined}
                  className="mb-3 flex min-h-9 w-full items-baseline gap-2 text-left"
                >
                  <span className={`text-sm font-semibold ${isToday ? 'text-accent-soft' : ''}`}>{formatKey(d, { weekday: 'short' })}</span>
                  <span className="text-xs text-muted">{formatKey(d, { day: 'numeric', month: 'short' })}</span>
                </button>
                {evs.length ? (
                  <ul className="space-y-2">
                    {evs.map((e) => (
                      <li key={e.id}>
                        <EventItem event={e} day={d} onSelect={editor.openEdit} onRestore={restore} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">No events</p>
                )}
              </section>
            )
          })}
        </div>
      )}

      {view === 'month' && (
        <Card
          title={formatDayLong(selected)}
          action={
            <button type="button" onClick={() => editor.openNew(selected)} className={ghost}>
              <Plus size={16} className="mr-1" aria-hidden /> Add
            </button>
          }
        >
          {selectedEvents.length ? (
            <ul className="space-y-2">
              {selectedEvents.map((e) => (
                <li key={e.id}>
                  <EventItem event={e} day={selected} onSelect={editor.openEdit} onRestore={restore} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No events on this day.</p>
          )}
        </Card>
      )}
    </div>
  )
}

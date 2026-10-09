import { BookOpen, Briefcase, CalendarPlus, GraduationCap, Upload } from 'lucide-react'
import { categoryStyle } from '../components/categories'
import { EventItem } from '../components/EventItem'
import { Timeline } from '../components/Timeline'
import { ActionButton } from '../components/ui/ActionButton'
import { Card } from '../components/ui/Card'
import { useEventEditor } from '../hooks/useEventEditor'
import { useEvents } from '../hooks/useEvents'
import { useNow } from '../hooks/useNow'
import type { EventCategory } from '../types'
import { currentEvent, eventsOnDay, nextEvent, summarizeDay } from '../utils/events'
import { dateKey, formatClock, formatDayShort, formatDuration, greeting, TIME_ZONE } from '../utils/time'

const summaries: { category: EventCategory; icon: typeof BookOpen }[] = [
  { category: 'university', icon: BookOpen },
  { category: 'work', icon: Briefcase },
  { category: 'study', icon: GraduationCap },
]

export function TodayPage() {
  const now = useNow(1000)
  const { events } = useEvents()
  const editor = useEventEditor()
  const today = dateKey(now)
  const todays = eventsOnDay(events, today)
  const current = currentEvent(events, now)
  const upcoming = nextEvent(events, now)
  const upcomingDay = upcoming ? dateKey(new Date(upcoming.start), upcoming.timeZone) : today

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting(now)}</h1>
          <p className="mt-1 text-sm text-muted">Here’s your day at a glance.</p>
        </div>
        <div className="text-right">
          <div className="text-4xl font-semibold tabular-nums tracking-tight" aria-label="Current time">
            {formatClock(now)}
          </div>
          <div className="text-xs text-muted">{TIME_ZONE}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summaries.map(({ category, icon: Icon }) => {
          const { count, minutes } = summarizeDay(todays, today, category)
          const c = categoryStyle[category]
          return (
            <Card key={category}>
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-surface-2 p-2.5">
                  <Icon size={18} className={c.text} aria-hidden />
                </div>
                <div>
                  <p className="text-xs text-muted">{c.label} today</p>
                  <p className="text-lg font-semibold">
                    {count} <span className="text-sm font-normal text-muted">· {formatDuration(minutes)}</span>
                  </p>
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Today’s timeline" className="lg:col-span-2">
          {todays.length ? (
            <Timeline events={todays} day={today} now={now} onSelect={editor.openEdit} />
          ) : (
            <div className="py-6 text-center">
              <p className="text-sm text-muted">
                {events.length ? 'Nothing scheduled for today.' : 'Your calendar is empty. Add your first event to get started.'}
              </p>
              <button
                type="button"
                onClick={() => editor.openNew(today)}
                className="mt-4 min-h-11 rounded-xl bg-accent px-5 text-sm font-medium hover:bg-accent/90"
              >
                Add event
              </button>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Happening now">
            {current ? (
              <EventItem event={current} day={today} state="live" onSelect={editor.openEdit} />
            ) : (
              <p className="text-sm text-muted">No event in progress.</p>
            )}
          </Card>

          <Card title="Up next">
            {upcoming ? (
              <div className="space-y-2">
                <EventItem event={upcoming} day={upcomingDay} onSelect={editor.openEdit} />
                {upcomingDay !== today && <p className="text-xs text-muted">{formatDayShort(upcomingDay)}</p>}
              </div>
            ) : (
              <p className="text-sm text-muted">No upcoming events.</p>
            )}
          </Card>

          <Card title="Quick actions">
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => editor.openNew(today)}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl bg-accent px-4 text-sm font-medium hover:bg-accent/90"
              >
                <CalendarPlus size={18} aria-hidden /> Add event
              </button>
              <ActionButton icon={Upload} label="Import schedule" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

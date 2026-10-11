import { BookOpen, Briefcase, CalendarPlus, GraduationCap, Upload } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDataGate } from '../components/CalendarDataGate'
import { categoryStyle } from '../components/categories'
import { EventItem } from '../components/EventItem'
import { Timeline } from '../components/Timeline'
import { Card } from '../components/ui/Card'
import { useEventEditor } from '../hooks/useEventEditor'
import { useCalendar } from '../calendar/CalendarContext'
import { useCourseAnnotator } from '../planner/useCourseAnnotator'
import { useNow } from '../hooks/useNow'
import type { EventCategory } from '../types'
import { currentEvent, eventsOnDay, nextEvent, summarizeDay } from '../utils/events'
import { expandItems } from '../utils/schedule'
import { addDays, dateKey, formatClock, formatDayShort, formatDuration, greeting, TIME_ZONE } from '../utils/time'

const summaries: { category: EventCategory; icon: typeof BookOpen }[] = [
  { category: 'university', icon: BookOpen },
  { category: 'work', icon: Briefcase },
  { category: 'study', icon: GraduationCap },
]

/** How far ahead "Up next" looks for repeating events. */
const LOOKAHEAD_DAYS = 120

export function TodayPage() {
  const now = useNow(1000)
  const { events, series } = useCalendar()
  const courseOf = useCourseAnnotator()
  const editor = useEventEditor()
  const today = dateKey(now)

  // Occurrences are generated only for the past week (long or overnight events) through the look-ahead window.
  const items = useMemo(
    () => expandItems(events, series, addDays(today, -7), addDays(today, LOOKAHEAD_DAYS)),
    [events, series, today],
  )
  const todays = eventsOnDay(items, today)
  const current = currentEvent(items, now)
  const upcoming = nextEvent(items, now)
  const upcomingDay = upcoming ? dateKey(new Date(upcoming.start), upcoming.timeZone) : today
  const hasAnything = events.length > 0 || series.length > 0

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

      <CalendarDataGate>
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
            <Timeline events={todays} day={today} now={now} onSelect={editor.openEdit} courseOf={courseOf} />
          ) : (
            <div className="py-6 text-center">
              <p className="text-sm text-muted">
                {hasAnything ? 'Nothing scheduled for today.' : 'Your calendar is empty. Add your first event to get started.'}
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
              <EventItem event={current} day={today} state="live" onSelect={editor.openEdit} course={courseOf?.(current)} />
            ) : (
              <p className="text-sm text-muted">No event in progress.</p>
            )}
          </Card>

          <Card title="Up next">
            {upcoming ? (
              <div className="space-y-2">
                <EventItem event={upcoming} day={upcomingDay} onSelect={editor.openEdit} course={courseOf?.(upcoming)} />
                {upcomingDay !== today && <p className="text-xs text-muted">{formatDayShort(upcomingDay)}</p>}
              </div>
            ) : (
              <p className="text-sm text-muted">No upcoming events in the next {Math.round(LOOKAHEAD_DAYS / 30)} months.</p>
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
              <Link
                to="/import-timetable"
                className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-line px-4 text-sm hover:bg-surface-2"
              >
                <Upload size={18} aria-hidden /> Import timetable (preview)
              </Link>
            </div>
          </Card>
        </div>
      </div>
      </CalendarDataGate>
    </div>
  )
}

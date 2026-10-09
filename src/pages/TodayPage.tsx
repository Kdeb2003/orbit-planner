import { BookOpen, Briefcase, CalendarPlus, GraduationCap, Upload } from 'lucide-react'
import { categoryStyle } from '../components/categories'
import { Timeline } from '../components/Timeline'
import { ActionButton } from '../components/ui/ActionButton'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { useNow } from '../hooks/useNow'
import { demoEvents } from '../mock/demo'
import type { EventCategory } from '../types'
import { formatClock, formatDuration, formatMinutes, greeting, minutesOfDay, TIME_ZONE } from '../utils/time'

const summaries: { category: EventCategory; icon: typeof BookOpen }[] = [
  { category: 'class', icon: BookOpen },
  { category: 'work', icon: Briefcase },
  { category: 'study', icon: GraduationCap },
]

export function TodayPage() {
  const now = useNow(1000)
  const nowMin = minutesOfDay(now)
  const upcoming = demoEvents.find((e) => e.startMin > nowMin)

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
          const items = demoEvents.filter((e) => e.category === category)
          const total = items.reduce((s, e) => s + e.endMin - e.startMin, 0)
          const c = categoryStyle[category]
          return (
            <Card key={category}>
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-surface-2 p-2.5">
                  <Icon size={18} className={c.text} aria-hidden />
                </div>
                <div>
                  <p className="text-xs text-muted">{c.label} (demo)</p>
                  <p className="text-lg font-semibold">
                    {items.length} <span className="text-sm font-normal text-muted">· {formatDuration(total)}</span>
                  </p>
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Today’s timeline" action={<Badge>Demo data</Badge>} className="lg:col-span-2">
          <Timeline events={demoEvents} nowMin={nowMin} />
        </Card>

        <div className="space-y-6">
          <Card title="Up next" action={<Badge>Demo data</Badge>}>
            {upcoming ? (
              <div>
                <p className="font-medium">{upcoming.title}</p>
                <p className="mt-1 text-sm text-muted">
                  {formatMinutes(upcoming.startMin)} · in {formatDuration(upcoming.startMin - nowMin)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">Nothing else scheduled today.</p>
            )}
          </Card>

          <Card title="Quick actions">
            <div className="space-y-2">
              <ActionButton icon={CalendarPlus} label="Add event" />
              <ActionButton icon={Upload} label="Import schedule" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

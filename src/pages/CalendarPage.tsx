import { CalendarPlus } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { ComingSoon } from '../components/ui/ComingSoon'
import { PageHeader } from '../components/ui/PageHeader'

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
// Static 5-week grid placeholder; not tied to the real current month.
const cells = Array.from({ length: 35 }, (_, i) => i + 1)

export function CalendarPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Calendar" subtitle="Month and week views of all your commitments." />
      <Card title="Month preview (static layout)" action={<Badge>Demo data</Badge>}>
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
          {days.map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
          {cells.map((n) => (
            <div
              key={n}
              className="flex aspect-square items-start justify-start rounded-lg border border-line/60 bg-surface-2/30 p-1.5 sm:p-2"
            >
              {n <= 31 ? n : ''}
            </div>
          ))}
        </div>
      </Card>
      <ComingSoon
        icon={CalendarPlus}
        title="Interactive calendar"
        description="Real month/week navigation, recurring timetables, and event creation will arrive in a later phase."
      />
    </div>
  )
}

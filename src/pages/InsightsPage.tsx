import { LineChart } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { ComingSoon } from '../components/ui/ComingSoon'
import { PageHeader } from '../components/ui/PageHeader'
import { demoWeekHours } from '../mock/demo'

const max = Math.max(...demoWeekHours.map((d) => d.hours))

export function InsightsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Insights" subtitle="See where your time goes." />
      <Card title="Study hours this week" action={<Badge>Demo data</Badge>}>
        <div
          className="flex h-40 items-end gap-2 sm:gap-4"
          role="img"
          aria-label="Bar chart of demonstration study hours per weekday"
        >
          {demoWeekHours.map((d) => (
            <div key={d.day} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
              <div className="w-full rounded-t-lg bg-accent/80" style={{ height: `${(d.hours / max) * 100}%` }} />
              <span className="text-xs text-muted">{d.day}</span>
            </div>
          ))}
        </div>
      </Card>
      <ComingSoon
        icon={LineChart}
        title="Real analytics"
        description="Trends and breakdowns will be computed from your actual schedule once data entry exists."
      />
    </div>
  )
}

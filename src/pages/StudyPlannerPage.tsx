import { Target } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { ComingSoon } from '../components/ui/ComingSoon'
import { PageHeader } from '../components/ui/PageHeader'
import { demoStudyGoals } from '../mock/demo'

export function StudyPlannerPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Study Planner" subtitle="Subject-wise weekly goals and study sessions." />
      <Card title="Weekly goals" action={<Badge>Demo data</Badge>}>
        <ul className="space-y-4">
          {demoStudyGoals.map((g) => {
            const pct = Math.min(100, Math.round((g.doneHours / g.targetHours) * 100))
            return (
              <li key={g.id}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span>{g.subject}</span>
                  <span className="tabular-nums text-muted">
                    {g.doneHours}/{g.targetHours} h
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={g.subject}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  className="h-2 overflow-hidden rounded-full bg-surface-2"
                >
                  <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      </Card>
      <ComingSoon
        icon={Target}
        title="Goal editing and session tracking"
        description="Create goals, schedule study sessions, and log time spent."
      />
    </div>
  )
}

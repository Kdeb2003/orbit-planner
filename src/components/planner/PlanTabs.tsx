import { NavLink } from 'react-router-dom'
import { Badge } from '../ui/Badge'

/**
 * Sections of the Plan area. Only Courses is functional in this increment; Tasks and Exams are not offered at all
 * (not even as disabled tabs) until they exist. The Study Planner demo keeps its own route and its "Demo data" label.
 */
export function PlanTabs() {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm transition-colors ${isActive ? 'bg-accent/20 text-white' : 'text-muted hover:bg-surface-2 hover:text-white'}`
  return (
    <nav aria-label="Plan sections" className="flex flex-wrap gap-1 border-b border-line pb-2">
      <NavLink to="/plan/courses" className={tab}>
        Courses
      </NavLink>
      <NavLink to="/study" className={tab}>
        Study planner <Badge>Demo data</Badge>
      </NavLink>
    </nav>
  )
}

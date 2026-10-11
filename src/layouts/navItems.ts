import { BarChart3, CalendarDays, ClipboardList, GraduationCap, LayoutDashboard, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Other path prefixes that belong to this entry (it stays highlighted there). */
  alsoActiveFor?: readonly string[]
}

export const navItems: readonly NavItem[] = [
  { to: '/', label: 'Today', icon: LayoutDashboard },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/study', label: 'Study Planner', icon: GraduationCap },
  { to: '/insights', label: 'Insights', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
]

/**
 * Navigation for a build with Courses on (Phase 4B, decision O-11): ONE "Plan" entry instead of separate Courses, Tasks
 * and Exams buttons, taking the Study Planner's slot so the five-slot mobile bar is unchanged. The Study Planner demo
 * stays reachable (tab inside Plan, and its own route). With Courses off this is exactly `navItems`.
 */
export function getNavItems(plannerOn: boolean): readonly NavItem[] {
  if (!plannerOn) return navItems
  return navItems.map((i) => (i.to === '/study' ? { to: '/plan', label: 'Plan', icon: ClipboardList, alsoActiveFor: ['/study'] } : i))
}

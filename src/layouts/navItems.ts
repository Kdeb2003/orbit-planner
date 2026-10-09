import { BarChart3, CalendarDays, GraduationCap, LayoutDashboard, Settings } from 'lucide-react'

export const navItems = [
  { to: '/', label: 'Today', icon: LayoutDashboard },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/study', label: 'Study Planner', icon: GraduationCap },
  { to: '/insights', label: 'Insights', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

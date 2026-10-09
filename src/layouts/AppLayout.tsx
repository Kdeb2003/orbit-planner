import { Orbit } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { EventEditorProvider } from '../components/EventEditorProvider'
import { useNow } from '../hooks/useNow'
import { useSaveError } from '../hooks/useSaveError'
import { formatDate } from '../utils/time'
import { navItems } from './navItems'

export function AppLayout() {
  const now = useNow(60_000)
  const saveError = useSaveError()

  return (
    <EventEditorProvider>
      <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-surface/60 p-4 md:flex">
          <div className="flex items-center gap-2 px-2 py-2">
            <Orbit className="text-accent-soft" size={24} aria-hidden />
            <span className="text-lg font-semibold tracking-wide">ORBIT</span>
          </div>
          <nav aria-label="Main" className="flex flex-col gap-1">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors ${
                    isActive ? 'bg-accent/20 text-white' : 'text-muted hover:bg-surface-2 hover:text-white'
                  }`
                }
              >
                <Icon size={18} aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-base/90 px-4 py-3 backdrop-blur md:px-8">
            <div className="flex items-center gap-2 md:hidden">
              <Orbit className="text-accent-soft" size={20} aria-hidden />
              <span className="font-semibold tracking-wide">ORBIT</span>
            </div>
            <span className="hidden text-sm font-medium md:block">ORBIT Planner</span>
            <time className="text-xs text-muted sm:text-sm" dateTime={now.toISOString()}>
              {formatDate(now)}
            </time>
          </header>

          {saveError && (
            <div role="alert" className="border-b border-deadline/50 bg-deadline/15 px-4 py-2 text-sm md:px-8">
              <strong>Not saved.</strong> {saveError}
            </div>
          )}
          <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-28 md:px-8 md:pb-10">
            <Outlet />
          </main>
        </div>

        {/* Mobile bottom navigation */}
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] ${
                  isActive ? 'text-accent-soft' : 'text-muted'
                }`
              }
            >
              <Icon size={20} aria-hidden />
              <span className="max-w-full truncate px-1">{label.replace(' Planner', '')}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </EventEditorProvider>
  )
}

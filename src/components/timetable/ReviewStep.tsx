import { ArrowLeft, ArrowRight, FilterX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NO_FILTERS, filterItems, sortItems } from '../../timetable/utn/review.ts'
import type { ReviewFilters, ReviewResult, StatusFilter } from '../../timetable/utn/review.ts'
import { Card } from '../ui/Card'
import { ClashList } from './ClashList'
import { SessionRow } from './SessionRow'
import { inputClass, primaryBtn, secondaryBtn } from './shared'
import { fullDate } from './labels'

export type ReviewTab = 'sessions' | 'clashes'

interface Props {
  result: ReviewResult
  filters: ReviewFilters
  onFilters: (f: ReviewFilters) => void
  tab: ReviewTab
  onTab: (t: ReviewTab) => void
  onEdit: (id: string) => void
  onToggleExcluded: (id: string, excluded: boolean) => void
  onToggleReviewed: (id: string, reviewed: boolean) => void
  onBack: () => void
  onContinue: () => void
}

const PAGE = 20
const STATUS_OPTIONS: [StatusFilter, string][] = [
  ['all', 'All'],
  ['needs-review', 'Needs extraction review'],
  ['invalid', 'Invalid data'],
  ['ready', 'Extraction verified'],
  ['edited', 'Edited'],
  ['clash', 'Clashing'],
  ['excluded', 'Excluded'],
]

export function ReviewStep({ result, filters, onFilters, tab, onTab, onEdit, onToggleExcluded, onToggleReviewed, onBack, onContinue }: Props) {
  const { items, clashes, summary } = result
  const [limit, setLimit] = useState(PAGE)
  // Where to scroll/focus once the other tab has rendered: a clash card or a session row.
  const target = useRef<{ kind: 'clash' | 'session'; id: string } | null>(null)
  const courses = useMemo(() => [...new Map(items.map((i) => [i.course.code, i.course.displayName])).entries()], [items])
  const weeks = useMemo(() => [...new Set(items.map((i) => i.session.semesterWeek))].sort((a, b) => a - b), [items])
  const shown = useMemo(() => sortItems(filterItems(items, filters)), [items, filters])
  const visible = shown.slice(0, limit)
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)

  useEffect(() => {
    const t = target.current
    if (!t) return
    const el = document.querySelector<HTMLElement>(t.kind === 'clash' ? `li[data-clash="${t.id}"]` : `li[data-session-id="${t.id}"]`)
    if (el) {
      el.scrollIntoView?.({ block: 'center' })
      el.focus({ preventScroll: true })
      target.current = null
    }
  }, [tab, shown])

  function showClash(itemId: string) {
    const clash = result.clashes.find((c) => c.a.id === itemId || c.b.id === itemId)
    if (!clash) return
    target.current = { kind: 'clash', id: clash.id }
    onTab('clashes')
  }

  function showSession(itemId: string) {
    const it = items.find((i) => i.id === itemId)
    if (!it) return
    onFilters({ ...NO_FILTERS, date: it.values.date })
    setLimit(PAGE)
    target.current = { kind: 'session', id: itemId }
    onTab('sessions')
  }

  const change = (patch: Partial<ReviewFilters>) => {
    setLimit(PAGE)
    onFilters({ ...filters, ...patch })
  }

  // group the visible slice by date for readable day headings
  const days: { date: string; rows: typeof visible }[] = []
  for (const it of visible) {
    const last = days[days.length - 1]
    if (last && last.date === it.values.date) last.rows.push(it)
    else days.push({ date: it.values.date, rows: [it] })
  }

  const tabBtn = (t: ReviewTab, label: string, n: number) => (
    <button
      type="button"
      role="tab"
      id={`tab-${t}`}
      aria-selected={tab === t}
      aria-controls={`panel-${t}`}
      onClick={() => onTab(t)}
      className={`min-h-11 flex-1 rounded-lg px-3 text-sm ${tab === t ? 'bg-accent/25 text-white' : 'text-muted hover:bg-surface-2'}`}
    >
      {label} <span className="tabular-nums" data-testid={`${t}-count`}>({n})</span>
    </button>
  )

  return (
    <Card title="3 · Review sessions">
      <div className="space-y-4">
        <div role="tablist" aria-label="Review views" className="flex gap-1 rounded-xl border border-line p-1">
          {tabBtn('sessions', 'Sessions', summary.selected)}
          {tabBtn('clashes', 'Clashes', clashes.length)}
        </div>

        {tab === 'clashes' ? (
          <div role="tabpanel" id="panel-clashes" aria-labelledby="tab-clashes">
            <ClashList clashes={clashes} onEdit={onEdit} onExclude={(id) => onToggleExcluded(id, true)} onShowSession={showSession} />
          </div>
        ) : (
          <div role="tabpanel" id="panel-sessions" aria-labelledby="tab-sessions" className="space-y-4">
            <p className="text-xs text-muted">
              <strong className="text-white">Extraction status</strong> says how reliably a session was read from the PDF. <strong className="text-white">Clash</strong> is a separate warning that two selected sessions overlap in time; a correctly read session can still clash.
            </p>
            <form className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Filter sessions" onSubmit={(e) => e.preventDefault()}>
              <label className="col-span-2 space-y-1 text-xs text-muted lg:col-span-1">
                Course
                <select className={inputClass} value={filters.course} onChange={(e) => change({ course: e.target.value })}>
                  <option value="all">All courses</option>
                  {courses.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                Semester week
                <select className={inputClass} value={filters.week} onChange={(e) => change({ week: e.target.value })}>
                  <option value="all">All weeks</option>
                  {weeks.map((w) => (
                    <option key={w} value={String(w)}>
                      Week {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted">
                Date
                <input type="date" className={inputClass} value={filters.date} onChange={(e) => change({ date: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs text-muted">
                Review status
                <select className={inputClass} value={filters.status} onChange={(e) => change({ status: e.target.value as StatusFilter })}>
                  {STATUS_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted" role="status" data-testid="shown-count" data-count={shown.length}>
                Showing {visible.length} of {shown.length} {shown.length === 1 ? 'session' : 'sessions'}
                {filtered ? ` (filtered from ${items.length})` : ''}
              </p>
              {filtered && (
                <button type="button" className={secondaryBtn} onClick={() => change({ ...NO_FILTERS })}>
                  <FilterX size={16} aria-hidden /> Clear filters
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <p className="rounded-xl border border-line p-4 text-sm text-muted" data-testid="empty-selection">
                No sessions match your course and group choices. Go back and tick at least one course.
              </p>
            ) : shown.length === 0 ? (
              <p className="rounded-xl border border-line p-4 text-sm text-muted" data-testid="empty-filter">
                No sessions match these filters. Clear a filter to see more.
              </p>
            ) : (
              <div className="space-y-4">
                {days.map((d) => (
                  <section key={d.date || 'none'} aria-label={d.date ? fullDate(d.date) : 'Sessions without a date'} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{d.date ? fullDate(d.date) : 'No usable date'}</h3>
                    <ul className="space-y-2">
                      {d.rows.map((it) => (
                        <SessionRow key={it.id} item={it} onEdit={onEdit} onToggleExcluded={onToggleExcluded} onToggleReviewed={onToggleReviewed} onShowClash={showClash} />
                      ))}
                    </ul>
                  </section>
                ))}
                {shown.length > visible.length && (
                  <button type="button" className={`${secondaryBtn} w-full`} onClick={() => setLimit(limit + PAGE)}>
                    Show {Math.min(PAGE, shown.length - visible.length)} more
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" className={secondaryBtn} onClick={onBack}>
            <ArrowLeft size={16} aria-hidden /> Courses
          </button>
          <button type="button" className={primaryBtn} onClick={onContinue}>
            Review summary <ArrowRight size={16} aria-hidden />
          </button>
        </div>
      </div>
    </Card>
  )
}

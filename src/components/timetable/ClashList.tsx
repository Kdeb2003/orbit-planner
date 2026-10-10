import { AlertTriangle } from 'lucide-react'
import type { ReviewClash, ReviewItem } from '../../timetable/utn/review.ts'
import { secondaryBtn } from './shared'
import { fullDate, groupLabel, pagesLabel, typeLabel } from './labels'

function Side({ item, onEdit, onExclude, onShowSession }: { item: ReviewItem; onEdit: (id: string) => void; onExclude: (id: string) => void; onShowSession: (id: string) => void }) {
  const group = groupLabel(item)
  return (
    <div className="min-w-0 space-y-1 rounded-xl border border-line bg-surface-2/40 p-3">
      <p className="text-sm tabular-nums font-medium">
        {item.values.startTime}–{item.values.endTime}
      </p>
      <p className="break-words text-sm font-semibold">{item.values.title}</p>
      <p className="break-words text-xs text-muted">
        {item.session.courseCode} · {typeLabel(item)}
        {group ? ` · ${group}` : ''}
      </p>
      <p className="break-words text-xs text-muted">{item.values.room || 'No room printed'}</p>
      <p className="text-xs text-muted">
        Week {item.session.semesterWeek} · PDF {pagesLabel(item)}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={secondaryBtn} onClick={() => onEdit(item.id)} aria-label={`Edit ${item.values.title} on ${item.values.date}`}>
          Edit
        </button>
        <button type="button" className={secondaryBtn} onClick={() => onShowSession(item.id)} aria-label={`Show ${item.values.title} on ${item.values.date} in the session list`}>
          Show in list
        </button>
        <button type="button" className={secondaryBtn} onClick={() => onExclude(item.id)} aria-label={`Exclude ${item.values.title} on ${item.values.date}`}>
          Exclude
        </button>
      </div>
    </div>
  )
}

/** Every overlapping pair between sessions that are still included, side by side. Clashes never remove a session. */
export function ClashList({ clashes, onEdit, onExclude, onShowSession }: { clashes: readonly ReviewClash[]; onEdit: (id: string) => void; onExclude: (id: string) => void; onShowSession: (id: string) => void }) {
  if (clashes.length === 0) {
    return <p className="rounded-xl border border-line p-4 text-sm text-muted">No overlapping sessions among the sessions you have included.</p>
  }
  const pairs = new Map<string, number>()
  for (const c of clashes) {
    const key = [c.a.course.displayName, c.b.course.displayName].sort().join(' × ')
    pairs.set(key, (pairs.get(key) ?? 0) + 1)
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Overlaps are warnings only: both sessions stay in your selection until you exclude or correct one. Nothing is excluded or changed automatically. Excluding a session recalculates this list.
      </p>
      <ul className="flex flex-wrap gap-2 text-xs" aria-label="Clashes by course pair">
        {[...pairs].map(([name, n]) => (
          <li key={name} className="rounded-full border border-deadline/40 bg-deadline/10 px-2 py-0.5 text-deadline">
            {name}: {n}
          </li>
        ))}
      </ul>
      <ul className="space-y-3" data-count={clashes.length}>
        {clashes.map((c) => (
          <li key={c.id} data-clash={c.id} tabIndex={-1} className="scroll-mt-20 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent border border-deadline/40 bg-deadline/5 p-3">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium">
              <AlertTriangle size={16} className="text-deadline" aria-hidden /> {fullDate(c.date)} · overlap
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Side item={c.a} onEdit={onEdit} onExclude={onExclude} onShowSession={onShowSession} />
              <Side item={c.b} onEdit={onEdit} onExclude={onExclude} onShowSession={onShowSession} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

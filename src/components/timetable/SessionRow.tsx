import { AlertTriangle, EyeOff, Pencil, RotateCcw } from 'lucide-react'
import type { ReviewItem } from '../../timetable/utn/review.ts'
import { Pill, secondaryBtn } from './shared'
import { dayLabel, groupLabel, pagesLabel, typeLabel } from './labels'

const STATE_PILL: Record<ReviewItem['state'], { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  ready: { text: 'Extraction verified', tone: 'good' },
  'needs-review': { text: 'Needs extraction review', tone: 'warn' },
  invalid: { text: 'Invalid data', tone: 'bad' },
  excluded: { text: 'Excluded', tone: 'neutral' },
}

const FIELD_NAMES = { title: 'title', date: 'date', startTime: 'start', endTime: 'end', room: 'room' } as const

interface Props {
  item: ReviewItem
  onEdit: (id: string) => void
  onToggleExcluded: (id: string, excluded: boolean) => void
  onToggleReviewed: (id: string, reviewed: boolean) => void
  /** Open the side-by-side comparison for this session's clash(es). */
  onShowClash: (id: string) => void
}

export function SessionRow({ item, onEdit, onToggleExcluded, onToggleReviewed, onShowClash }: Props) {
  const { session, values, original } = item
  const pill = STATE_PILL[item.state]
  const group = groupLabel(item)
  const label = `${values.title} on ${values.date || 'an unknown date'} at ${values.startTime}`
  const issues = Object.values(item.errors)

  return (
    <li
      data-session-id={item.id}
      data-state={item.state}
      data-course={item.course.code}
      data-date={values.date}
      tabIndex={-1}
      className={`scroll-mt-20 outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl border p-3 ${item.excluded ? 'border-line/60 bg-surface-2/20 opacity-70' : item.state === 'invalid' ? 'border-deadline/50 bg-deadline/5' : 'border-line bg-surface-2/40'}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="shrink-0 sm:w-40">
          <p className="text-sm font-medium">{dayLabel(values.date)}</p>
          <p className="text-sm tabular-nums text-muted">
            {values.startTime}–{values.endTime}
            <span className="ml-1 text-xs">Berlin</span>
          </p>
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <p className={`break-words text-sm font-semibold ${item.excluded ? 'line-through' : ''}`}>{values.title}</p>
          <p className="break-words text-xs text-muted">
            {session.courseCode} · {typeLabel(item)}
            {group ? ` · ${group}` : ''} · {values.room || 'No room printed'}
          </p>
          <p className="text-xs text-muted">
            Semester week {session.semesterWeek} · PDF {pagesLabel(item)}
            {session.spansMultipleSlots ? ` · ${session.source.length} slots merged` : ''}
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Pill tone={pill.tone} title="Describes how reliably this session was read from the PDF, not whether it overlaps another class.">
              {pill.text}
            </Pill>
            {item.clashesWith.length > 0 && !item.excluded && (
              <button
                type="button"
                data-testid="clash-link"
                onClick={() => onShowClash(item.id)}
                aria-label={`Clash: ${values.title} overlaps ${item.clashesWith.length} other ${item.clashesWith.length === 1 ? 'session' : 'sessions'}. Show comparison`}
                title="Scheduling overlap with another selected session. Open the comparison."
                className="inline-flex min-h-8 items-center gap-1 rounded-full border border-deadline/40 bg-deadline/10 px-2 py-0.5 text-xs font-medium text-deadline underline underline-offset-2 hover:bg-deadline/20"
              >
                <AlertTriangle size={12} aria-hidden /> Clash{item.clashesWith.length > 1 ? `es (${item.clashesWith.length})` : ''} · compare
              </button>
            )}
            {item.editedFields.length > 0 && <Pill tone="accent">Edited: {item.editedFields.map((f) => FIELD_NAMES[f]).join(', ')}</Pill>}
            {session.confidence !== 'high' && <Pill tone={session.confidence === 'low' ? 'bad' : 'warn'}>{session.confidence === 'low' ? 'Low' : 'Medium'} confidence</Pill>}
            {session.issues.some((i) => i.severity === 'warning') && <Pill tone="warn">Extraction warning</Pill>}
          </div>

          {item.editedFields.length > 0 && (
            <p className="text-xs text-muted" data-testid="extracted-values">
              Extracted: {original.date || 'no date'} {original.startTime}–{original.endTime} · {original.title}
              {original.room ? ` · ${original.room}` : ''}
            </p>
          )}
          {!item.excluded && item.reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-work">
              {item.reasons.map((r) => (
                <li key={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</li>
              ))}
            </ul>
          )}
          {!item.excluded && issues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-deadline" role="alert">
              {issues.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          {!item.excluded && item.warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-work">
              {item.warnings.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 sm:w-32 sm:flex-col">
          <button type="button" className={`${secondaryBtn} flex-1 sm:flex-none`} onClick={() => onEdit(item.id)} aria-label={`Edit ${label}`}>
            <Pencil size={15} aria-hidden /> Edit
          </button>
          <button type="button" className={`${secondaryBtn} flex-1 sm:flex-none`} onClick={() => onToggleExcluded(item.id, !item.excluded)} aria-label={`${item.excluded ? 'Include' : 'Exclude'} ${label}`}>
            {item.excluded ? <RotateCcw size={15} aria-hidden /> : <EyeOff size={15} aria-hidden />} {item.excluded ? 'Include' : 'Exclude'}
          </button>
          {item.state === 'needs-review' && (
            <button type="button" className={`${secondaryBtn} flex-1 sm:flex-none`} onClick={() => onToggleReviewed(item.id, true)} aria-label={`Mark ${label} as checked`}>
              Mark checked
            </button>
          )}
          {item.reviewed && item.reasons.length > 0 && !item.excluded && (
            <button type="button" className={`${secondaryBtn} flex-1 sm:flex-none`} onClick={() => onToggleReviewed(item.id, false)} aria-label={`Undo checked for ${label}`}>
              Undo checked
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

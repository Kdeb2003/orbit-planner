import { ArrowLeft, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { groupAnomalies } from '../../timetable/utn/review.ts'
import type { ReviewResult, SourceFacts, StatusFilter } from '../../timetable/utn/review.ts'
import type { SourceAnomaly } from '../../timetable/utn/types.ts'
import { Card } from '../ui/Card'
import { Notice, Stat, secondaryBtn } from './shared'
import { anomalyTitle, fullDate, weeksText } from './labels'

interface Props {
  result: ReviewResult
  facts: SourceFacts
  anomalies: readonly SourceAnomaly[]
  onShow: (status: StatusFilter, tab: 'sessions' | 'clashes') => void
  onBack: () => void
  /** When saving is enabled for this environment, the save workflow replaces the preview-only notice. */
  saveSlot?: ReactNode
}

export const PREVIEW_COMPLETE_TEXT = 'Preview complete. Saving these sessions to your calendar will be available after cloud import verification.'

export function SummaryStep({ result, facts, anomalies, onShow, onBack, saveSlot }: Props) {
  const { summary } = result
  const groups = groupAnomalies(anomalies)
  const link = 'text-accent-soft underline underline-offset-2'
  return (
    <Card title="4 · Review summary">
      <div className="space-y-5">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="summary-stats">
          <Stat label="Sessions selected" value={<span data-testid="stat-selected">{summary.selected}</span>} />
          <Stat label="Excluded by you" value={<span data-testid="stat-excluded">{summary.manuallyExcluded}</span>} />
          <Stat label="Other group (not attended)" value={<span data-testid="stat-group-excluded">{summary.groupExcluded}</span>} />
          <Stat label="Sessions needing extraction review" value={<span data-testid="stat-attention">{summary.needsAttention}</span>} tone={summary.needsAttention ? 'warn' : undefined} />
          <Stat label="Manual corrections" value={<span data-testid="stat-corrections">{summary.correctedFields}</span>} />
          <Stat label="Remaining clashes (overlaps)" value={<span data-testid="stat-clashes">{summary.clashes}</span>} tone={summary.clashes ? 'bad' : undefined} />
        </dl>

        <p className="text-xs text-muted" data-testid="summary-explainer">
          “Needing extraction review” counts sessions whose data from the PDF is uncertain or invalid. Clashes are a separate matter: two correctly read classes can overlap. Overlaps are warnings only and are never resolved or excluded automatically.
        </p>

        <div className="text-sm text-muted">
          {summary.dateRange ? (
            <p>
              Date range of selected sessions: {fullDate(summary.dateRange.first)} – {fullDate(summary.dateRange.last)}.
            </p>
          ) : (
            <p>No dated sessions are selected.</p>
          )}
          {facts.preliminaryNote && <p className="text-work">The source timetable is preliminary.</p>}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Sessions per course</h3>
          <ul className="grid gap-1 text-sm sm:grid-cols-2" data-testid="course-counts">
            {summary.byCourse.map((c) => (
              <li key={c.code} data-course={c.code} data-count={c.count} className="flex justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <span className="min-w-0 break-words">{c.name}</span>
                <span className="tabular-nums">{c.count}</span>
              </li>
            ))}
            {summary.byCourse.length === 0 && <li className="text-muted">No sessions selected.</li>}
          </ul>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {summary.needsAttention > 0 && (
            <button type="button" className={link} onClick={() => onShow('needs-review', 'sessions')}>
              Show sessions needing attention
            </button>
          )}
          {summary.edited > 0 && (
            <button type="button" className={link} onClick={() => onShow('edited', 'sessions')}>
              Show corrected sessions
            </button>
          )}
          {summary.clashes > 0 && (
            <button type="button" className={link} onClick={() => onShow('all', 'clashes')}>
              Show remaining clashes
            </button>
          )}
          {summary.manuallyExcluded > 0 && (
            <button type="button" className={link} onClick={() => onShow('excluded', 'sessions')}>
              Show excluded sessions
            </button>
          )}
        </div>

        {groups.length > 0 && (
          <Notice tone="warn" title={`${groups.length} source ${groups.length === 1 ? 'anomaly' : 'anomalies'} in the PDF`}>
            <ul className="list-disc space-y-1 pl-5">
              {groups.map((g) => (
                <li key={g.code}>
                  <strong>{anomalyTitle(g.code)}</strong> ({weeksText(g.semesterWeeks)}): {g.messages[0]}
                  {g.messages.length > 1 ? ` (+${g.messages.length - 1} similar)` : ''}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {saveSlot ? (
          <div className="rounded-xl border border-line p-3">{saveSlot}</div>
        ) : (
        <Notice tone="accent" role="status">
          <p className="flex items-start gap-2" data-testid="preview-complete">
            <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>{PREVIEW_COMPLETE_TEXT}</span>
          </p>
          <p className="mt-2 text-xs text-muted">Nothing has been saved: your calendar, your account and this browser’s storage are unchanged. Leaving this page discards the preview. The “Saved to cloud” indicator at the top of the app describes your existing calendar only; it does not mean this timetable was saved.</p>
        </Notice>
        )}

        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" className={secondaryBtn} onClick={onBack}>
            <ArrowLeft size={16} aria-hidden /> Back to sessions
          </button>
          <Link to="/calendar" className={secondaryBtn}>
            Back to calendar
          </Link>
        </div>
      </div>
    </Card>
  )
}

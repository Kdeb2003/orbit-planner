import { ArrowLeft, FileUp } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CorrectionDialog } from '../components/timetable/CorrectionDialog'
import { CoursesStep } from '../components/timetable/CoursesStep'
import { ReviewStep } from '../components/timetable/ReviewStep'
import type { ReviewTab } from '../components/timetable/ReviewStep'
import { Notice, secondaryBtn } from '../components/timetable/shared'
import { SourcePanel } from '../components/timetable/SourcePanel'
import { SummaryStep } from '../components/timetable/SummaryStep'
import { SaveCard } from '../components/timetableSave/SaveCard'
import { UploadStep } from '../components/timetable/UploadStep'
import type { UploadPhase } from '../components/timetable/UploadStep'
import { PageHeader } from '../components/ui/PageHeader'
import { TimetableLoadError, loadTimetable } from '../timetable/import/loadTimetable'
import { TIMETABLE_SAVE_ENABLED } from '../timetable/save/flag'
import type { TimetableExtraction } from '../timetable/utn/index'
import {
  NO_FILTERS, buildReview, commitEdit, describeSource, detectCourses, initialState, resetEdit, setReviewed, toggleExcluded,
} from '../timetable/utn/review'
import type { ReviewFilters, ReviewState, SessionValues, StatusFilter } from '../timetable/utn/review'

type Step = 'courses' | 'sessions' | 'summary'

interface Loaded {
  file: File
  fileName: string
  extraction: TimetableExtraction
}

const STEPS: [Step, string][] = [
  ['courses', 'Courses'],
  ['sessions', 'Sessions'],
  ['summary', 'Summary'],
]

/**
 * Import timetable — PREVIEW ONLY (Phase 4A.2, checkpoint 1).
 *
 * The PDF is parsed in this tab; the result and the user's review choices live in React state only. Nothing is
 * written to the calendar, the cloud, localStorage or sessionStorage, and leaving the page discards everything.
 */
export function ImportTimetablePage() {
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [state, setState] = useState<ReviewState | null>(null)
  const [step, setStep] = useState<Step>('courses')
  const [filters, setFilters] = useState<ReviewFilters>(NO_FILTERS)
  const [tab, setTab] = useState<ReviewTab>('sessions')
  const [editingId, setEditingId] = useState<string | null>(null)
  const latest = useRef(0)
  const top = useRef<HTMLDivElement>(null)

  const sessions = useMemo(() => loaded?.extraction.sessions ?? [], [loaded])
  const detected = useMemo(() => detectCourses(sessions), [sessions])
  const result = useMemo(() => (state ? buildReview(sessions, state) : null), [sessions, state])
  const selectedCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const it of result?.items ?? []) out[it.course.code] = (out[it.course.code] ?? 0) + 1
    return out
  }, [result])
  const facts = useMemo(
    () => (loaded ? describeSource(loaded.extraction.layouts, loaded.extraction.sessions, loaded.extraction.tables.map((t) => t.title)) : null),
    [loaded],
  )

  const go = (next: Step) => {
    setStep(next)
    top.current?.scrollIntoView?.({ block: 'start' })
  }

  async function onFile(file: File) {
    const run = ++latest.current
    setPhase({ kind: 'loading', progress: { stage: 'reading' } })
    try {
      const extraction = await loadTimetable(file, (progress) => {
        if (run === latest.current) setPhase({ kind: 'loading', progress })
      })
      if (run !== latest.current) return
      setLoaded({ file, fileName: file.name, extraction })
      setState(initialState(extraction.sessions))
      setFilters(NO_FILTERS)
      setTab('sessions')
      setReplacing(false)
      setPhase({ kind: 'idle' })
      go('courses')
    } catch (err) {
      if (run !== latest.current) return
      setPhase({ kind: 'error', error: err instanceof TimetableLoadError ? err : new TimetableLoadError('failed', 'The PDF could not be processed', 'Something went wrong while reading the file. Nothing was saved.') })
    }
  }

  const update = (fn: (s: ReviewState) => ReviewState) => setState((s) => (s ? fn(s) : s))
  const editing = result?.items.find((i) => i.id === editingId) ?? null
  const hasWork = !!state && (state.excluded.length > 0 || Object.keys(state.edits).length > 0 || state.reviewed.length > 0)
  const showUpload = !loaded || replacing

  function showSessions(status: StatusFilter, nextTab: ReviewTab) {
    setFilters({ ...NO_FILTERS, status })
    setTab(nextTab)
    go('sessions')
  }

  return (
    <div className="space-y-5">
      <div ref={top} className="space-y-3">
        <Link to="/calendar" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted hover:text-white">
          <ArrowLeft size={16} aria-hidden /> Calendar
        </Link>
        <PageHeader title="Import timetable" subtitle="Read your UTN semester timetable PDF and review what it contains." />
        {TIMETABLE_SAVE_ENABLED ? (
          <Notice tone="accent" title="Review, then save">
            Nothing is added to your calendar until you confirm on the last step. The PDF itself stays in this browser tab and is never uploaded; only the sessions you confirm are saved to your account.
          </Notice>
        ) : (
          <Notice tone="accent" title="Preview only">
            Nothing is added to your calendar. The PDF stays in this browser tab, and the sessions below are discarded when you leave this page. Saving to your calendar is a later step.
          </Notice>
        )}
      </div>

      {showUpload && <UploadStep phase={phase} onFile={onFile} />}
      {loaded && replacing && (
        <div className="flex flex-wrap items-center gap-3">
          {hasWork && <p className="text-sm text-work">Choosing another PDF will discard your exclusions and corrections.</p>}
          <button type="button" className={secondaryBtn} onClick={() => setReplacing(false)}>
            Keep the current timetable
          </button>
        </div>
      )}

      {loaded && !replacing && state && result && facts && (
        <>
          <nav aria-label="Import steps" className="flex flex-wrap items-center gap-2">
            <ol className="flex min-w-0 flex-1 gap-1 rounded-xl border border-line p-1">
              {STEPS.map(([key, label], i) => (
                <li key={key} className="flex-1">
                  <button
                    type="button"
                    aria-current={step === key ? 'step' : undefined}
                    onClick={() => go(key)}
                    className={`min-h-11 w-full whitespace-nowrap rounded-lg px-1 text-xs sm:px-2 sm:text-sm ${step === key ? 'bg-accent/25 text-white' : 'text-muted hover:bg-surface-2'}`}
                  >
                    {i + 2} · {label}
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" className={secondaryBtn} onClick={() => setReplacing(true)}>
              <FileUp size={16} aria-hidden /> Different PDF
            </button>
          </nav>

          {step === 'courses' && (
            <>
              <SourcePanel fileName={loaded.fileName} facts={facts} anomalies={loaded.extraction.anomalies} items={result.items} />
              <CoursesStep detected={detected} choices={state.choices} selectedCounts={selectedCounts} onChange={(choices) => update((s) => ({ ...s, choices }))} onContinue={() => go('sessions')} />
            </>
          )}
          {step === 'sessions' && (
            <ReviewStep
              result={result}
              filters={filters}
              onFilters={setFilters}
              tab={tab}
              onTab={setTab}
              onEdit={setEditingId}
              onToggleExcluded={(id, excluded) => update((s) => toggleExcluded(s, id, excluded))}
              onToggleReviewed={(id, reviewed) => update((s) => setReviewed(s, id, reviewed))}
              onBack={() => go('courses')}
              onContinue={() => go('summary')}
            />
          )}
          {step === 'summary' && <SummaryStep result={result} facts={facts} anomalies={loaded.extraction.anomalies} onShow={showSessions} onBack={() => go('sessions')} saveSlot={TIMETABLE_SAVE_ENABLED ? <SaveCard file={loaded.file} result={result} facts={facts} choices={state.choices} /> : undefined} />}
        </>
      )}

      {editing && (
        <CorrectionDialog
          key={editing.id}
          item={editing}
          items={result?.items ?? []}
          onSave={(values: SessionValues) => update((s) => commitEdit(s, editing.id, editing.original, values))}
          onReset={() => update((s) => resetEdit(s, editing.id))}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}

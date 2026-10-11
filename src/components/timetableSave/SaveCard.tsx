import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCalendarContext } from '../../calendar/CalendarContext'
import { sha256Hex } from '../../timetable/provenance/importItems.ts'
import { checkAvailability, executeSave, planSave } from '../../timetable/save/saveImport.ts'
import type { SaveInput, SavePlan, SaveProgress, SaveResult } from '../../timetable/save/saveImport.ts'
import type { CourseChoice, ReviewResult, SourceFacts } from '../../timetable/utn/review.ts'
import { mapImportError } from '../../cloud/importApi'
import { Notice, Stat, primaryBtn, secondaryBtn } from '../timetable/shared'

interface Props {
  file: File
  result: ReviewResult
  facts: SourceFacts
  choices: readonly CourseChoice[]
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'confirm'; plan: SavePlan }
  | { kind: 'saving'; progress: SaveProgress }
  | { kind: 'done'; result: SaveResult }
  | { kind: 'error'; message: string }

const STAGE_TEXT: Record<SaveProgress['stage'], string> = {
  planning: 'Checking your calendar…',
  preparing: 'Preparing the import…',
  saving: 'Saving sessions',
  finishing: 'Finishing…',
  verifying: 'Reading your calendar back to verify…',
}

/**
 * Confirm & Save to Calendar. Rendered only when the build enables it (see timetable/save/flag.ts). It probes the
 * backend first, shows exactly what a save would do, and writes only after an explicit confirmation, through the
 * provenance RPC. "Saved" is shown only after the server verified the batch and the data was read back.
 */
export function SaveCard({ file, result, facts, choices }: Props) {
  const { api, importApi, userId, source } = useCalendarContext()
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const run = useRef(0)
  const sha = useRef<{ file: File; hash: string } | null>(null)
  const invalidateRuns = () => {
    run.current++
  }
  const ready = !!importApi && !!api && !!userId

  useEffect(() => {
    if (!ready) return
    let live = true
    void checkAvailability(importApi!).then((r) => {
      if (live) setPhase(r.ok ? { kind: 'idle' } : { kind: 'unavailable', reason: r.reason })
    })
    return () => {
      live = false
      invalidateRuns() // a result arriving after unmount must not update state
    }
  }, [ready, importApi])

  if (!ready) {
    return (
      <Notice tone="warn" title="Sign in to save" role="status">
        <span data-testid="save-needs-account">Saving to your calendar needs a signed-in cloud account. Nothing has been saved.</span>
      </Notice>
    )
  }

  async function buildInput(): Promise<SaveInput> {
    if (!sha.current || sha.current.file !== file) sha.current = { file, hash: await sha256Hex(new Uint8Array(await file.arrayBuffer())) }
    return {
      userId: userId!,
      reviewItems: result.items,
      sha256: sha.current.hash,
      label: facts.semester ? `UTN timetable - ${facts.semester}`.slice(0, 120) : 'UTN timetable',
      publishedOn: null,
      selection: choices.filter((c) => c.included).map((c) => `${c.code}:${c.group ?? ''}`).slice(0, 100),
      clashes: result.summary.clashes,
    }
  }

  async function review() {
    const id = ++run.current
    setPhase({ kind: 'planning' })
    try {
      const plan = await planSave({ cloud: api!, imports: importApi! }, await buildInput())
      if (id === run.current) setPhase({ kind: 'confirm', plan })
    } catch (err) {
      if (id === run.current) setPhase({ kind: 'error', message: mapImportError(err).message })
    }
  }

  async function save() {
    const id = ++run.current
    setPhase({ kind: 'saving', progress: { stage: 'planning', done: 0, total: 1 } })
    let input: SaveInput
    try {
      input = await buildInput()
    } catch {
      setPhase({ kind: 'error', message: 'The PDF could not be read again. Nothing was saved.' })
      return
    }
    const res = await executeSave({ cloud: api!, imports: importApi! }, input, (progress) => {
      if (id === run.current) setPhase({ kind: 'saving', progress })
    })
    if (res.kind !== 'blocked' && res.kind !== 'nothing-to-do') void source.refresh() // show whatever was really saved
    if (id === run.current) setPhase({ kind: 'done', result: res })
  }

  const busy = phase.kind === 'planning' || phase.kind === 'saving' || phase.kind === 'checking'

  return (
    <div className="space-y-3" data-testid="save-card" data-phase={phase.kind}>
      <h3 className="text-sm font-semibold">Save to your calendar</h3>

      {phase.kind === 'checking' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Checking that saving is available…
        </p>
      )}

      {phase.kind === 'unavailable' && (
        <Notice tone="warn" title="Saving is not available here" role="status">
          <span data-testid="save-unavailable">{phase.reason} The preview above still works; nothing was saved.</span>
        </Notice>
      )}

      {(phase.kind === 'idle' || phase.kind === 'error') && (
        <div className="space-y-2">
          {phase.kind === 'error' && (
            <Notice tone="bad" role="alert">
              <span data-testid="save-error">{phase.message}</span>
            </Notice>
          )}
          <p className="text-sm text-muted">Nothing is saved until you confirm. First ORBIT checks what is already in your calendar.</p>
          <button type="button" className={secondaryBtn} onClick={() => void review()} data-testid="save-plan-btn">
            Review what will be saved
          </button>
        </div>
      )}

      {phase.kind === 'planning' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted" data-testid="save-planning">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Checking your calendar…
        </p>
      )}

      {phase.kind === 'confirm' && <ConfirmPanel plan={phase.plan} onConfirm={() => void save()} onCancel={() => setPhase({ kind: 'idle' })} onRecheck={() => void review()} />}

      {phase.kind === 'saving' && (
        <div role="status" className="space-y-2" data-testid="save-progress" data-stage={phase.progress.stage}>
          <p className="flex items-center gap-2 text-sm">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            {STAGE_TEXT[phase.progress.stage]}
            {phase.progress.stage === 'saving' && ` (${phase.progress.done} of ${phase.progress.total})`}
          </p>
          <progress className="h-2 w-full" max={Math.max(phase.progress.total, 1)} value={phase.progress.stage === 'saving' ? phase.progress.done : undefined} aria-label="Saving progress" />
          <p className="text-xs text-muted">Keep this page open. If it stops, you can retry; sessions that were already saved are not saved twice.</p>
        </div>
      )}

      {phase.kind === 'done' && <ResultPanel result={phase.result} busy={busy} onRetry={() => void save()} onRecheck={() => void review()} />}
    </div>
  )
}

function ConfirmPanel({ plan, onConfirm, onCancel, onRecheck }: { plan: SavePlan; onConfirm: () => void; onCancel: () => void; onRecheck: () => void }) {
  const c = plan.counts
  const resumeNote = plan.resume ? `An earlier save of this file was interrupted. Confirming continues it and sends only the ${c.toCreate} missing session${c.toCreate === 1 ? '' : 's'}.` : null
  const nothing = c.toCreate === 0 && !plan.resume
  return (
    <div className="space-y-3" data-testid="save-confirm" data-to-create={c.toCreate} data-already={c.alreadyImported} data-skipped={c.skipped} data-clashes={c.clashes}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sessions to create" value={<span data-testid="save-count-create">{c.toCreate}</span>} />
        <Stat label="Already in your calendar" value={<span data-testid="save-count-already">{c.alreadyImported}</span>} />
        <Stat label="Skipped (excluded or needing review)" value={<span data-testid="save-count-skipped">{c.skipped}</span>} tone={c.skipped ? 'warn' : undefined} />
        <Stat label="Overlapping sessions" value={<span data-testid="save-count-clashes">{c.clashes}</span>} tone={c.clashes ? 'warn' : undefined} />
      </dl>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        {c.clashes > 0 && <li>Overlaps are saved as separate events; they are warnings, not blockers.</li>}
        {c.userEdited > 0 && <li>{c.userEdited} imported event{c.userEdited === 1 ? ' was' : 's were'} edited by you earlier; they are kept as you left them.</li>}
        {c.notRecreated > 0 && <li>{c.notRecreated} session{c.notRecreated === 1 ? '' : 's'} will not be created: an event you deleted after importing, or an event id that already belongs to another event.</li>}
        {c.differences > 0 && <li>{c.differences} difference{c.differences === 1 ? '' : 's'} from an earlier import (changed or no longer printed) are not applied; no existing event is changed or deleted.</li>}
        <li>Only the sessions you selected are saved. Existing and manually created events are never changed.</li>
      </ul>
      {resumeNote && <Notice tone="accent" role="status"><span data-testid="save-resume">{resumeNote}</span></Notice>}
      {plan.activeElsewhere && (
        <Notice tone="warn" role="status">
          <span data-testid="save-active-elsewhere">Another import of this timetable started a few minutes ago (another tab or device). Wait for it to finish, then check again.</span>
        </Notice>
      )}
      {nothing && !plan.activeElsewhere && (
        <Notice tone="good" role="status">
          <span data-testid="save-nothing-new">Nothing new to save: everything selected is already in your calendar (or is not importable). No events will be created.</span>
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        {!nothing && !plan.activeElsewhere && (
          <button type="button" className={primaryBtn} onClick={onConfirm} data-testid="save-confirm-btn">
            Confirm &amp; Save to Calendar
          </button>
        )}
        {plan.activeElsewhere && (
          <button type="button" className={secondaryBtn} onClick={onRecheck}>
            Check again
          </button>
        )}
        <button type="button" className={secondaryBtn} onClick={onCancel}>
          {nothing ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}

function ResultPanel({ result, busy, onRetry, onRecheck }: { result: SaveResult; busy: boolean; onRetry: () => void; onRecheck: () => void }) {
  switch (result.kind) {
    case 'verified':
      return (
        <Notice tone="good" role="status">
          <div data-testid="save-result" data-kind="verified" data-created={result.created} className="space-y-2">
            <p className="flex items-center gap-2 font-semibold text-white">
              <CheckCircle2 size={16} aria-hidden /> Saved and verified
            </p>
            <p>
              {result.created} session{result.created === 1 ? '' : 's'} saved to your calendar and read back from your account{result.alreadyImported ? `; ${result.alreadyImported} were already there` : ''}.
            </p>
            <Link to="/calendar" className={secondaryBtn}>
              Open calendar
            </Link>
          </div>
        </Notice>
      )
    case 'nothing-to-do':
      return (
        <Notice tone="good" role="status">
          <p data-testid="save-result" data-kind="nothing-to-do">
            Nothing new to save{result.alreadyImported ? `: ${result.alreadyImported} session${result.alreadyImported === 1 ? ' is' : 's are'} already in your calendar` : ''}. No events were created.
          </p>
        </Notice>
      )
    case 'partial':
      return (
        <Notice tone="warn" role="alert">
          <div data-testid="save-result" data-kind="partial" className="space-y-2">
            <p className="font-semibold text-white">Partly saved</p>
            <p>
              {result.created} of {result.planned} planned sessions were saved. The rest were saved by another device meanwhile or could not be created. This import is labelled partial, not complete. Check again to see what is still missing.
            </p>
            <button type="button" className={secondaryBtn} onClick={onRecheck}>
              Check again
            </button>
          </div>
        </Notice>
      )
    case 'unverified':
      return (
        <Notice tone="bad" role="alert">
          <div data-testid="save-result" data-kind="unverified" className="space-y-2">
            <p className="font-semibold text-white">Saved, but not verified</p>
            <p>The saved data could not be confirmed against what you reviewed, so it is not reported as correct.</p>
            <ul className="list-disc pl-5 text-xs">{result.problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        </Notice>
      )
    case 'blocked':
      return (
        <Notice tone="warn" role="status">
          <div data-testid="save-result" data-kind="blocked" className="space-y-2">
            <p>{result.message}</p>
            <button type="button" className={secondaryBtn} onClick={onRecheck}>
              Check again
            </button>
          </div>
        </Notice>
      )
    case 'failed':
      return (
        <Notice tone="bad" role="alert">
          <div data-testid="save-result" data-kind="failed" data-created={result.created} className="space-y-2">
            <p className="font-semibold text-white">Not fully saved</p>
            <p>{result.message}</p>
            <p className="text-xs">{result.created > 0 ? `${result.created} session${result.created === 1 ? ' was' : 's were'} saved before it stopped. ` : ''}Retrying sends only the sessions that are still missing, so nothing is saved twice.</p>
            {result.errorKind !== 'unavailable' && (
              <button type="button" className={primaryBtn} onClick={onRetry} disabled={busy} data-testid="save-retry-btn">
                <RotateCcw size={16} aria-hidden /> Retry saving
              </button>
            )}
          </div>
        </Notice>
      )
  }
}

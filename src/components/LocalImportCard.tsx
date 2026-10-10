import { Download, Loader2, Upload } from 'lucide-react'
import { useState } from 'react'
import { useCalendar, useCalendarContext } from '../calendar/CalendarContext'
import { rowToEvent, rowToSeries } from '../cloud/mappers'
import { browserStorage, eventStore } from '../storage/eventStore'
import { seriesStore } from '../storage/seriesStore'
import { backupFilename, buildBackup, countRaw, readLocalRaw } from '../migration/localData'
import { readImportRecord } from '../migration/importRecord'
import { buildImportPlan } from '../migration/importPlan'
import type { ImportPlan } from '../migration/importPlan'
import { runImport } from '../migration/runImport'
import type { ImportOutcome, ImportProgress } from '../migration/runImport'
import { Card } from './ui/Card'

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const btn = 'flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Explicit, opt-in import of the calendar saved in THIS browser into the signed-in cloud account.
 * Nothing is uploaded until the user has (1) seen a preview and (2) confirmed. Local data is never
 * modified or deleted by this component.
 */
export function LocalImportCard() {
  const { mode, source } = useCalendar()
  const { api, userId } = useCalendarContext()
  const [backedUp, setBackedUp] = useState(false)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  const raw = readLocalRaw(browserStorage())
  const counts = countRaw(raw)
  const previous = userId ? readImportRecord(browserStorage(), userId) : null

  if (mode !== 'cloud' || !api || !userId) return null

  const nothingLocal = counts.events === 0 && counts.series === 0 && !counts.unreadable

  function backup() {
    const now = new Date()
    download(backupFilename(now), buildBackup(readLocalRaw(browserStorage()), now))
    setBackedUp(true)
  }

  async function preview() {
    setBusy('preview')
    setError(null)
    setOutcome(null)
    setConfirmed(false)
    try {
      // Fresh read of the cloud so the preview reflects what is really there now.
      const [e, s, x] = await Promise.all([api!.loadEvents(), api!.loadSeries(), api!.loadExceptions()])
      setPlan(
        await buildImportPlan({
          userId: userId!,
          events: eventStore.getSnapshot(),
          series: seriesStore.getSnapshot(),
          cloudEvents: e.map(rowToEvent),
          cloudSeries: s.map((r) => rowToSeries(r, x)),
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read your cloud calendar.')
    }
    setBusy(null)
  }

  async function upload() {
    if (!plan) return
    setBusy('import')
    setError(null)
    const result = await runImport(plan, api!, { onProgress: setProgress, recordStorage: browserStorage() })
    setOutcome(result)
    setBusy(null)
    setProgress(null)
    await source.refresh()
    if (result.ok) setPlan(null)
  }

  const unreadableLocal = counts.events + counts.series - (eventStore.getSnapshot().length + seriesStore.getSnapshot().length)

  return (
    <Card title="Import events saved in this browser">
      <div className="space-y-4 text-sm" data-testid="local-import">
        {nothingLocal ? (
          <p className="text-muted">Nothing is saved in this browser, so there is nothing to import.</p>
        ) : (
          <>
            <p>
              This browser holds <strong>{counts.events}</strong> event(s) and <strong>{counts.series}</strong> repeating series
              ({counts.exceptions} exception(s)) from before you signed in. They are <strong>not</strong> in your cloud calendar. Importing is optional,
              copies them to your account, and <strong>never changes or deletes</strong> the data in this browser.
            </p>
            {unreadableLocal > 0 || counts.unreadable ? (
              <p className="text-work">Some stored records can’t be read by ORBIT. They are kept in the backup file but cannot be imported.</p>
            ) : null}

            <ol className="list-decimal space-y-3 pl-5">
              <li>
                <p className="mb-2">Save a backup file of the original data.</p>
                <button type="button" onClick={backup} className={btn}>
                  <Download size={16} aria-hidden /> Download backup (JSON)
                </button>
                {backedUp && <p className="mt-1 text-xs text-personal">Backup downloaded.</p>}
              </li>
              <li>
                <p className="mb-2">Preview what would be uploaded (nothing is sent yet).</p>
                <button type="button" onClick={preview} disabled={busy !== null} className={btn}>
                  {busy === 'preview' && <Loader2 size={16} className="animate-spin" aria-hidden />} Preview import
                </button>
              </li>
            </ol>

            {error && (
              <p role="alert" className="rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2">
                {error}
              </p>
            )}

            {plan && (
              <div className="space-y-3 rounded-xl border border-line p-3" data-testid="import-preview">
                <ul className="space-y-1">
                  <li>
                    Events: <strong>{plan.counts.events.new}</strong> to upload, {plan.counts.events['exists-same']} already in the cloud,{' '}
                    {plan.counts.events.conflict} conflicting, {plan.counts.events.invalid} invalid
                  </li>
                  <li>
                    Repeating series: <strong>{plan.counts.series.new}</strong> to upload, {plan.counts.series['exists-same']} already in the cloud,{' '}
                    {plan.counts.series.conflict} conflicting, {plan.counts.series.invalid} invalid
                  </li>
                  <li>
                    Exceptions: <strong>{plan.counts.exceptions.new}</strong> to upload, {plan.counts.exceptions['exists-same']} already in the cloud
                    {plan.counts.exceptions.orphaned > 0 && `, ${plan.counts.exceptions.orphaned} no longer match their schedule (kept as they are)`}
                  </li>
                </ul>
                {[...plan.events.filter((e) => e.status === 'invalid' || e.status === 'conflict').map((e) => `Event “${e.event.title}”: ${e.status === 'conflict' ? 'a different version already exists in the cloud (not overwritten)' : e.problems.join('; ')}`),
                  ...plan.series.filter((s) => s.status === 'invalid' || s.status === 'conflict').map((s) => `Series “${s.series.title}”: ${s.status === 'conflict' ? 'a different version already exists in the cloud (not overwritten)' : s.problems.join('; ')}`)]
                  .slice(0, 20)
                  .map((m) => (
                    <p key={m} className="text-xs text-work">
                      Skipped: {m}
                    </p>
                  ))}
                {plan.toUpload === 0 ? (
                  <p className="text-muted">Nothing new to upload.</p>
                ) : (
                  <>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1 size-5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                      <span>I understand this adds {plan.toUpload} item(s) to my cloud calendar and that my data in this browser stays untouched.</span>
                    </label>
                    <button type="button" onClick={upload} disabled={!backedUp || !confirmed || busy !== null} className={btn}>
                      {busy === 'import' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Upload size={16} aria-hidden />} Upload to my account
                    </button>
                    {!backedUp && <p className="text-xs text-muted">Download the backup first to enable the upload.</p>}
                  </>
                )}
              </div>
            )}

            {busy === 'import' && progress && (
              <p role="status">
                {progress.phase === 'verifying' ? 'Verifying the upload…' : `Uploading ${progress.phase}: ${progress.done} / ${progress.total}`}
              </p>
            )}

            {outcome?.ok && (
              <p role="status" data-testid="import-result" className="rounded-xl border border-personal/50 bg-personal/10 px-3 py-2">
                Imported and verified: {outcome.uploaded.events} event(s), {outcome.uploaded.series} series, {outcome.uploaded.exceptions} exception(s).
                {outcome.status === 'verified-with-skips' && ' Some items were skipped (see the preview); they remain in your backup.'} Your browser data was not changed.
              </p>
            )}
            {outcome && !outcome.ok && (
              <div role="alert" data-testid="import-result" className="space-y-2 rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2">
                <p>
                  Import {outcome.stage === 'upload' ? 'stopped' : 'could not be verified'}: {outcome.error} Nothing was changed in this browser. It is safe to run the import again; items already uploaded are not duplicated.
                </p>
                <button type="button" onClick={preview} className={btn}>
                  Preview again
                </button>
              </div>
            )}
          </>
        )}
        {previous && (
          <p className="text-xs text-muted" data-testid="import-record">
            Last import: {previous.status.replace(/-/g, ' ')}
            {previous.verifiedAt ? ` (verified ${previous.verifiedAt.slice(0, 10)})` : ''}.
          </p>
        )}
      </div>
    </Card>
  )
}

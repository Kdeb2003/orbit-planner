import type { CloudApi } from '../cloud/cloudApi'
import { mapCloudError } from '../cloud/errors'
import { eventPatch, exceptionToWrite, rowToEvent, rowToSeries, seriesPatch } from '../cloud/mappers'
import type { StorageLike } from '../storage/collection'
import { writeImportRecord } from './importRecord'
import type { ImportRecord } from './importRecord'
import type { ImportPlan } from './importPlan'

export interface ImportProgress {
  phase: 'events' | 'series' | 'exceptions' | 'verifying'
  done: number
  total: number
}

export type ImportOutcome =
  | { ok: true; status: 'verified' | 'verified-with-skips'; uploaded: { events: number; series: number; exceptions: number } }
  | { ok: false; stage: 'upload' | 'verify'; error: string; uploaded: { events: number; series: number; exceptions: number }; mismatches?: string[] }

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
const norm = (v: unknown) => JSON.stringify(v)

/**
 * Reads the cloud back and checks that every record the plan says should now exist (new or already
 * identical) is present with identical content. Returns human-readable mismatches (empty = verified).
 */
export async function verifyImport(plan: ImportPlan, api: CloudApi): Promise<string[]> {
  const [eventRows, seriesRows, exceptionRows] = await Promise.all([api.loadEvents(), api.loadSeries(), api.loadExceptions()])
  const events = new Map(eventRows.map((r) => [r.id, rowToEvent(r)]))
  const series = new Map(seriesRows.map((r) => [r.id, rowToSeries(r, exceptionRows)]))
  const problems: string[] = []

  for (const e of plan.events) {
    if (e.status !== 'new' && e.status !== 'exists-same') continue
    const there = events.get(e.cloudId)
    if (!there) problems.push(`event "${e.event.title}" is missing in the cloud`)
    else if (norm(eventPatch(there)) !== norm(eventPatch(e.event))) problems.push(`event "${e.event.title}" differs in the cloud`)
  }
  for (const s of plan.series) {
    if (s.status !== 'new' && s.status !== 'exists-same') continue
    const there = series.get(s.cloudId)
    if (!there) {
      problems.push(`series "${s.series.title}" is missing in the cloud`)
      continue
    }
    if (norm(seriesPatch(there)) !== norm(seriesPatch(s.series))) problems.push(`series "${s.series.title}" differs in the cloud`)
    for (const x of s.exceptions) {
      if (x.status !== 'new' && x.status !== 'exists-same') continue
      const ex = there.exceptions.find((y) => y.originalDate === x.exception.originalDate)
      if (!ex) problems.push(`exception ${x.exception.originalDate} of "${s.series.title}" is missing in the cloud`)
      else if (norm(exceptionToWrite(s.cloudId, ex)) !== norm(exceptionToWrite(s.cloudId, x.exception))) {
        problems.push(`exception ${x.exception.originalDate} of "${s.series.title}" differs in the cloud`)
      }
    }
  }
  return problems
}

/**
 * Uploads what the plan marked "new", then verifies. Designed to be repeated safely:
 *  - inserts are ON CONFLICT DO NOTHING keyed by id, so nothing is ever overwritten or duplicated;
 *  - ids are deterministic, so a re-run addresses exactly the same rows;
 *  - series are uploaded BEFORE their exceptions; if the run stops in between, running again
 *    imports only the missing exceptions (the series is then "exists-same");
 *  - local storage is never read-modified: this function receives plain data and only writes
 *    a progress marker under its own key.
 * "verified" is recorded only after the cloud has been read back and compared.
 */
export async function runImport(
  plan: ImportPlan,
  api: CloudApi,
  options: { chunkSize?: number; onProgress?: (p: ImportProgress) => void; recordStorage?: StorageLike | null; now?: () => Date } = {},
): Promise<ImportOutcome> {
  const chunkSize = options.chunkSize ?? 50
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const uploaded = { events: 0, series: 0, exceptions: 0 }
  const save = (r: Partial<ImportRecord> & Pick<ImportRecord, 'status'>) =>
    writeImportRecord(options.recordStorage ?? null, plan.userId, {
      startedAt,
      updatedAt: now().toISOString(),
      idMap: plan.idMap,
      uploaded: { ...uploaded },
      ...r,
    })

  save({ status: 'in-progress' }) // the id mapping is durable BEFORE the first upload

  const eventRows = plan.events.filter((e) => e.status === 'new').map((e) => e.row!)
  const seriesRows = plan.series.filter((s) => s.status === 'new').map((s) => s.row!)
  const exceptionRows = plan.series.flatMap((s) => s.exceptions.filter((x) => x.status === 'new').map((x) => x.row!))

  try {
    let done = 0
    for (const part of chunks(eventRows, chunkSize)) {
      uploaded.events += await api.insertEventsIgnoreDuplicates(part)
      options.onProgress?.({ phase: 'events', done: (done += part.length), total: eventRows.length })
    }
    done = 0
    for (const part of chunks(seriesRows, chunkSize)) {
      uploaded.series += await api.insertSeriesIgnoreDuplicates(part)
      options.onProgress?.({ phase: 'series', done: (done += part.length), total: seriesRows.length })
    }
    done = 0
    for (const part of chunks(exceptionRows, chunkSize)) {
      uploaded.exceptions += await api.insertExceptionsIgnoreDuplicates(part)
      options.onProgress?.({ phase: 'exceptions', done: (done += part.length), total: exceptionRows.length })
    }
  } catch (err) {
    const error = mapCloudError(err).message
    save({ status: 'failed', error })
    return { ok: false, stage: 'upload', error, uploaded }
  }

  options.onProgress?.({ phase: 'verifying', done: 0, total: 1 })
  let mismatches: string[]
  try {
    mismatches = await verifyImport(plan, api)
  } catch (err) {
    const error = mapCloudError(err).message
    save({ status: 'verification-failed', error })
    return { ok: false, stage: 'verify', error, uploaded }
  }
  if (mismatches.length) {
    const error = `${mismatches.length} item(s) could not be verified in the cloud.`
    save({ status: 'verification-failed', error })
    return { ok: false, stage: 'verify', error, uploaded, mismatches }
  }
  const status = plan.hasSkips ? 'verified-with-skips' : 'verified'
  save({ status, verifiedAt: now().toISOString() })
  return { ok: true, status, uploaded }
}

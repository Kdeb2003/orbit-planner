import { cloudIdFor } from '../cloud/ids'
import {
  eventPatch,
  eventToWrite,
  exceptionToWrite,
  isOrphaned,
  seriesPatch,
  seriesToWrite,
  validateEventForCloud,
  validateExceptionForCloud,
  validateSeriesForCloud,
} from '../cloud/mappers'
import type { EventWrite, ExceptionWrite, SeriesWrite } from '../cloud/types'
import type { CalendarEvent, RecurringSeries, SeriesException } from '../types'

export type EntryStatus =
  /** Will be uploaded. */
  | 'new'
  /** Already in the cloud with identical content: nothing to do (this is what makes a repeated import safe). */
  | 'exists-same'
  /** The id exists in the cloud with DIFFERENT content: skipped, the cloud copy is never overwritten. */
  | 'conflict'
  /** Cannot be stored (violates a cloud rule): skipped; stays in the local backup. */
  | 'invalid'
  /** Not uploaded because its series was skipped. */
  | 'skipped'

export interface PlannedEvent {
  legacyId: string
  cloudId: string
  remapped: boolean
  event: CalendarEvent
  status: EntryStatus
  problems: string[]
  row?: EventWrite
}

export interface PlannedException {
  exception: SeriesException
  status: EntryStatus
  problems: string[]
  /** Date no longer matches the schedule. Still imported unchanged (never silently dropped). */
  orphaned: boolean
  row?: ExceptionWrite
}

export interface PlannedSeries {
  legacyId: string
  cloudId: string
  remapped: boolean
  series: RecurringSeries
  status: EntryStatus
  problems: string[]
  row?: SeriesWrite
  exceptions: PlannedException[]
}

export interface ImportPlan {
  userId: string
  events: PlannedEvent[]
  series: PlannedSeries[]
  /** legacy id -> cloud id for every record (durable, deterministic: recomputed identically on every run). */
  idMap: Record<string, string>
  counts: {
    events: Record<EntryStatus, number>
    series: Record<EntryStatus, number>
    exceptions: Record<EntryStatus, number> & { orphaned: number }
  }
  /** Rows that would be uploaded. */
  toUpload: number
  /** Anything not importable (invalid / conflict / skipped): the migration can only be "verified with skips". */
  hasSkips: boolean
}

const zero = (): Record<EntryStatus, number> => ({ new: 0, 'exists-same': 0, conflict: 0, invalid: 0, skipped: 0 })
const norm = (v: unknown) => JSON.stringify(v)

export interface PlanInput {
  userId: string
  events: readonly CalendarEvent[]
  series: readonly RecurringSeries[]
  cloudEvents: readonly CalendarEvent[]
  cloudSeries: readonly RecurringSeries[]
}

/**
 * Pure analysis, no network and no writes: decides what an import WOULD do.
 * Compares by content, so re-running after a partial or complete import converges
 * to "exists-same" instead of creating duplicates.
 */
export async function buildImportPlan(input: PlanInput): Promise<ImportPlan> {
  const { userId } = input
  const cloudEvents = new Map(input.cloudEvents.map((e) => [e.id, e]))
  const cloudSeries = new Map(input.cloudSeries.map((s) => [s.id, s]))
  const idMap: Record<string, string> = {}
  const seenEvent = new Set<string>()
  const seenSeries = new Set<string>()

  const events: PlannedEvent[] = []
  for (const e of input.events) {
    const cloudId = await cloudIdFor(userId, 'event', e.id)
    idMap[e.id] = cloudId
    const problems = validateEventForCloud(e)
    if (seenEvent.has(cloudId)) problems.push('duplicate id in local data')
    seenEvent.add(cloudId)
    const planned: PlannedEvent = { legacyId: e.id, cloudId, remapped: cloudId !== e.id, event: e, status: 'new', problems }
    if (problems.length) planned.status = 'invalid'
    else {
      const existing = cloudEvents.get(cloudId)
      planned.row = eventToWrite(e, cloudId, e.createdAt)
      if (existing) planned.status = norm(eventPatch(e)) === norm(eventPatch(existing)) ? 'exists-same' : 'conflict'
    }
    events.push(planned)
  }

  const series: PlannedSeries[] = []
  for (const s of input.series) {
    const cloudId = await cloudIdFor(userId, 'series', s.id)
    idMap[s.id] = cloudId
    const problems = validateSeriesForCloud(s).filter((m) => !/^\d{4}-\d{2}-\d{2}: /.test(m)) // exception problems are reported per exception
    if (seenSeries.has(cloudId)) problems.push('duplicate id in local data')
    seenSeries.add(cloudId)
    const planned: PlannedSeries = { legacyId: s.id, cloudId, remapped: cloudId !== s.id, series: s, status: 'new', problems, exceptions: [] }
    const existing = cloudSeries.get(cloudId)
    if (problems.length) planned.status = 'invalid'
    else {
      planned.row = seriesToWrite(s, cloudId, s.createdAt)
      if (existing) planned.status = norm(seriesPatch(s)) === norm(seriesPatch(existing)) ? 'exists-same' : 'conflict'
    }

    const existingEx = new Map((existing?.exceptions ?? []).map((x) => [x.originalDate, x]))
    for (const ex of s.exceptions) {
      const exProblems = validateExceptionForCloud(ex)
      const pe: PlannedException = { exception: ex, status: 'new', problems: exProblems, orphaned: isOrphaned(s, ex) }
      if (planned.status === 'invalid' || planned.status === 'conflict') pe.status = 'skipped'
      else if (exProblems.length) pe.status = 'invalid'
      else {
        pe.row = exceptionToWrite(cloudId, ex)
        const there = existingEx.get(ex.originalDate)
        if (there) pe.status = norm(exceptionToWrite(cloudId, ex)) === norm(exceptionToWrite(cloudId, there)) ? 'exists-same' : 'conflict'
      }
      planned.exceptions.push(pe)
    }
    series.push(planned)
  }

  const counts: ImportPlan['counts'] = { events: zero(), series: zero(), exceptions: { ...zero(), orphaned: 0 } }
  for (const e of events) counts.events[e.status]++
  for (const s of series) {
    counts.series[s.status]++
    for (const x of s.exceptions) {
      counts.exceptions[x.status]++
      if (x.orphaned) counts.exceptions.orphaned++
    }
  }
  const toUpload = counts.events.new + counts.series.new + counts.exceptions.new
  const skipKinds: EntryStatus[] = ['invalid', 'conflict', 'skipped']
  const hasSkips = [counts.events, counts.series, counts.exceptions].some((c) => skipKinds.some((k) => c[k] > 0))
  return { userId, events, series, idMap, counts, toUpload, hasSkips }
}

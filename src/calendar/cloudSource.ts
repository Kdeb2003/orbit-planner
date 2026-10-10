import type { CloudApi } from '../cloud/cloudApi'
import { mapCloudError } from '../cloud/errors'
import {
  eventPatch,
  eventToWrite,
  exceptionToWrite,
  rowToEvent,
  rowToException,
  rowToSeries,
  seriesPatch,
  seriesToWrite,
  validateEventForCloud,
  validateExceptionForCloud,
  validateSeriesForCloud,
} from '../cloud/mappers'
import { CloudError } from '../cloud/types'
import type { EventRow } from '../cloud/types'
import { isCalendarEvent } from '../storage/eventStore'
import { sanitizeSeries } from '../storage/seriesStore'
import type { CalendarEvent, EventInput, RecurringSeries, SeriesException, SeriesInput } from '../types'
import type { CalendarSnapshot, CalendarSource, OpResult } from './types'

export interface CloudSourceOptions {
  userId: string
  /** Give up on a request after this long (the outcome is then unknown, so we re-read the truth). */
  timeoutMs?: number
  now?: () => number
  newId?: () => string
  isOnline?: () => boolean
}

const OK: OpResult = { ok: true }

/**
 * Cloud data source for ONE signed-in user. A new instance is created per user and
 * disposed on sign-out/account switch, so one account's data can never be shown to
 * another and late responses from a disposed instance are ignored.
 *
 * Consistency rules
 *  - Pessimistic writes: the visible data changes only from a server-confirmed row, never
 *    from a guess, so there is nothing to roll back and `ok: true` always means saved.
 *  - Writes are serialised (one at a time, in order).
 *  - Every refresh result is checked: a read that started before a write finished is
 *    discarded and repeated, so a stale snapshot can never overwrite newer data.
 *  - Events and series use optimistic concurrency on `updated_at` (a stale edit is rejected,
 *    nothing is overwritten). Exceptions are last-writer-wins per occurrence.
 */
export function createCloudSource(api: CloudApi, options: CloudSourceOptions): CalendarSource {
  const userId = options.userId
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  const isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const timeoutMs = options.timeoutMs ?? 20_000

  let disposed = false
  const listeners = new Set<() => void>()
  let snap: CalendarSnapshot = {
    mode: 'cloud',
    userId,
    status: 'loading',
    events: [],
    series: [],
    error: null,
    offline: false,
    pendingWrites: 0,
    lastSyncedAt: null,
    skippedInvalid: 0,
  }

  function set(patch: Partial<CalendarSnapshot>) {
    if (disposed) return
    snap = { ...snap, ...patch }
    listeners.forEach((l) => l())
  }

  // ---- reading -----------------------------------------------------------

  let loadSeq = 0 // identifies the newest read
  let writesDone = 0 // number of successful writes so far
  let inFlight: Promise<void> | null = null
  let rerun = false

  async function readAll() {
    const [events, series, exceptions] = await Promise.all([api.loadEvents(), api.loadSeries(), api.loadExceptions()])
    return { events, series, exceptions }
  }

  function build(raw: Awaited<ReturnType<typeof readAll>>) {
    let skipped = 0
    const events: CalendarEvent[] = []
    for (const row of raw.events) {
      const e = rowToEvent(row)
      if (isCalendarEvent(e)) events.push(e)
      else skipped++
    }
    const series: RecurringSeries[] = []
    for (const row of raw.series) {
      const s = sanitizeSeries(rowToSeries(row, raw.exceptions))
      if (s) {
        series.push(s.item)
        if (s.lossy) skipped++
      } else skipped++
    }
    return { events, series, skipped }
  }

  async function loadOnce(): Promise<void> {
    const seq = ++loadSeq
    const writesAtStart = writesDone
    try {
      const raw = await readAll()
      if (disposed || seq !== loadSeq) return // a newer read superseded this one
      if (writesDone !== writesAtStart || snap.pendingWrites > 0) {
        rerun = true // stale: a write completed after this read started
        return
      }
      const { events, series, skipped } = build(raw)
      set({ status: 'ready', events, series, skippedInvalid: skipped, error: null, offline: false, lastSyncedAt: now() })
    } catch (err) {
      if (disposed || seq !== loadSeq) return
      const e = mapCloudError(err)
      const offline = e.kind === 'network' || !isOnline()
      set({
        status: snap.lastSyncedAt === null ? 'error' : 'ready', // keep showing the last good data
        error: offline ? 'Offline or unreachable. Showing the last synced data.' : e.message,
        offline,
      })
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (inFlight) {
      rerun = true
      return inFlight
    }
    inFlight = (async () => {
      do {
        rerun = false
        await loadOnce()
      } while (rerun && !disposed && snap.pendingWrites === 0)
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  // ---- writing -----------------------------------------------------------

  let queue: Promise<unknown> = Promise.resolve()

  function timeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new CloudError('network', 'The server did not answer in time. Your change may not have been saved; the calendar is being re-read.', 'timeout')), timeoutMs)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  /** Runs `op` after earlier writes finish. Converts every failure into `{ok:false}`; never throws. */
  function write(op: () => Promise<void>, refreshOnFailure = false): Promise<OpResult> {
    if (disposed) return Promise.resolve({ ok: false, error: 'You were signed out.', kind: 'auth' })
    set({ pendingWrites: snap.pendingWrites + 1 })
    const run = queue.then(async (): Promise<OpResult> => {
      if (disposed) return { ok: false, error: 'You were signed out.', kind: 'auth' }
      try {
        await timeout(op())
        writesDone++
        set({ pendingWrites: snap.pendingWrites - 1, error: null, offline: false, lastSyncedAt: now() })
        void refresh() // converge with the server (picks up other devices' changes too)
        return OK
      } catch (err) {
        const e = mapCloudError(err)
        const conflictLike = e.kind === 'conflict' || e.code === 'timeout' || refreshOnFailure
        set({ pendingWrites: snap.pendingWrites - 1, error: e.message, offline: e.kind === 'network' })
        if (conflictLike) void refresh()
        return { ok: false, error: e.message, kind: e.kind }
      }
    })
    queue = run
    return run
  }

  const invalid = (problems: string[]): OpResult => ({
    ok: false,
    error: `Can’t save: ${problems[0]}.`,
    kind: 'validation',
  })
  const staleMsg = 'This changed on another device, so your edit was not saved. The latest version has been loaded.'
  const conflict = (): CloudError => new CloudError('conflict', staleMsg, 'stale')

  const findEvent = (id: string) => snap.events.find((e) => e.id === id)
  const findSeries = (id: string) => snap.series.find((s) => s.id === id)

  // Cache patches use ONLY server-returned rows.
  function putEvent(row: EventRow) {
    const e = rowToEvent(row)
    set({ events: [...snap.events.filter((x) => x.id !== e.id), e] })
  }
  function putSeries(s: RecurringSeries) {
    set({ series: [...snap.series.filter((x) => x.id !== s.id), s] })
  }

  return {
    mode: 'cloud',
    userId,
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },

    createEvent(input: EventInput, id = newId()) {
      const problems = validateEventForCloud(input)
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        const row = await api.insertEvent(eventToWrite(input, id))
        if (row) return putEvent(row)
        // The id already exists: an earlier attempt of this same save did reach the server.
        const existing = (await api.loadEvents()).find((r) => r.id === id)
        if (!existing) throw new CloudError('unknown', 'The server did not confirm the save.')
        putEvent(existing)
      })
    },
    updateEvent(id, input) {
      const problems = validateEventForCloud(input)
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        const current = findEvent(id)
        if (!current) throw conflict()
        const row = await api.updateEvent(id, eventPatch(input), current.updatedAt)
        if (!row) throw conflict()
        putEvent(row)
      })
    },
    removeEvent(id) {
      return write(async () => {
        const current = findEvent(id)
        if (!current) throw conflict()
        if (!(await api.deleteEvent(id, current.updatedAt))) throw conflict()
        set({ events: snap.events.filter((e) => e.id !== id) })
      })
    },

    createSeries(input: SeriesInput, id = newId()) {
      const problems = validateSeriesForCloud(input)
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        const row = await api.insertSeries(seriesToWrite(input, id))
        if (!row) {
          const existing = (await api.loadSeries()).find((r) => r.id === id)
          if (!existing) throw new CloudError('unknown', 'The server did not confirm the save.')
          return putSeries(rowToSeries(existing, []))
        }
        putSeries(rowToSeries(row, []))
      })
    },
    updateSeries(id, input, kept) {
      const problems = validateSeriesForCloud({ ...input, exceptions: kept })
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        const current = findSeries(id)
        if (!current) throw conflict()
        // 1. update the schedule (conditional on the version we last saw)
        const row = await api.updateSeries(id, seriesPatch(input), current.updatedAt)
        if (!row) throw conflict()
        // 2. only then remove exceptions the user agreed to drop. If this half fails the series is saved
        //    and the leftover exceptions are merely orphaned (kept, harmless), never lost silently.
        const keep = new Set(kept.map((k) => k.originalDate))
        const drop = current.exceptions.filter((x) => !keep.has(x.originalDate))
        const remaining: SeriesException[] = current.exceptions.filter((x) => keep.has(x.originalDate))
        let failed = 0
        for (const ex of drop) {
          try {
            await api.deleteException(id, ex.originalDate)
          } catch {
            failed++
            remaining.push(ex)
          }
        }
        putSeries({ ...rowToSeries(row, []), exceptions: remaining.sort((x, y) => x.originalDate.localeCompare(y.originalDate)) })
        if (failed) throw new CloudError('unknown', `The series was saved, but ${failed} outdated exception(s) could not be removed. Try saving again.`, 'partial')
      }, true)
    },
    removeSeries(id) {
      return write(async () => {
        const current = findSeries(id)
        if (!current) throw conflict()
        if (!(await api.deleteSeries(id, current.updatedAt))) throw conflict()
        set({ series: snap.series.filter((s) => s.id !== id) })
      })
    },

    setException(seriesId, ex) {
      const problems = validateExceptionForCloud(ex)
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        if (!findSeries(seriesId)) throw conflict()
        const saved = rowToException(await api.upsertException(exceptionToWrite(seriesId, ex)))
        const s = findSeries(seriesId)
        if (s) putSeries({ ...s, exceptions: [...s.exceptions.filter((x) => x.originalDate !== saved.originalDate), saved].sort((a, b) => a.originalDate.localeCompare(b.originalDate)) })
      })
    },
    clearException(seriesId, originalDate) {
      return write(async () => {
        if (!findSeries(seriesId)) throw conflict()
        await api.deleteException(seriesId, originalDate)
        const s = findSeries(seriesId)
        if (s) putSeries({ ...s, exceptions: s.exceptions.filter((x) => x.originalDate !== originalDate) })
      })
    },

    refresh,
    dismissError() {
      set({ error: null })
    },
    dispose() {
      disposed = true
      listeners.clear()
      snap = { ...snap, events: [], series: [], status: 'loading', error: null }
    },
  }
}

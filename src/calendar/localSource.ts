import { eventStore } from '../storage/eventStore'
import { seriesStore } from '../storage/seriesStore'
import type { EventStore } from '../storage/eventStore'
import type { SeriesStore } from '../storage/seriesStore'
import type { CalendarSnapshot, CalendarSource, OpResult } from './types'

const OK: OpResult = { ok: true }

/**
 * Local-only mode (Supabase not configured): the Phase 2 browser stores behind the
 * async CalendarSource interface. Writes are synchronous underneath, so they resolve
 * immediately; storage failures are still reported by the stores' own save-status banner.
 */
export function createLocalSource(events: EventStore = eventStore, series: SeriesStore = seriesStore): CalendarSource {
  let cache: CalendarSnapshot | null = null
  let lastEvents: unknown
  let lastSeries: unknown

  const snapshot = (): CalendarSnapshot => {
    const e = events.getSnapshot()
    const s = series.getSnapshot()
    if (!cache || e !== lastEvents || s !== lastSeries) {
      lastEvents = e
      lastSeries = s
      cache = {
        mode: 'local',
        userId: null,
        status: 'ready',
        events: e,
        series: s,
        error: null,
        offline: false,
        pendingWrites: 0,
        lastSyncedAt: null,
        skippedInvalid: 0,
      }
    }
    return cache
  }

  const missing = (what: string): OpResult => ({ ok: false, error: `${what} no longer exists.`, kind: 'conflict' })

  return {
    mode: 'local',
    userId: null,
    getSnapshot: snapshot,
    subscribe(listener) {
      const a = events.subscribe(listener)
      const b = series.subscribe(listener)
      return () => {
        a()
        b()
      }
    },
    async createEvent(input) {
      events.create(input)
      return OK
    },
    async updateEvent(id, input) {
      return events.update(id, input) ? OK : missing('This event')
    },
    async removeEvent(id) {
      return events.remove(id) ? OK : missing('This event')
    },
    async createSeries(input) {
      series.create(input)
      return OK
    },
    async updateSeries(id, input, kept) {
      return series.update(id, input, kept) ? OK : missing('This series')
    },
    async removeSeries(id) {
      return series.remove(id) ? OK : missing('This series')
    },
    async setException(seriesId, exception) {
      return series.setException(seriesId, exception) ? OK : missing('This series')
    },
    async clearException(seriesId, originalDate) {
      return series.clearException(seriesId, originalDate) ? OK : missing('This series')
    },
    async refresh() {
      events.reload()
      series.reload()
    },
    dismissError() {},
    dispose() {},
  }
}

/** The source used when nobody may see calendar data (e.g. before sign-in). Holds nothing and writes nothing. */
export function createEmptySource(status: CalendarSnapshot['status'] = 'loading', userId: string | null = null): CalendarSource {
  const snap: CalendarSnapshot = {
    mode: 'none',
    userId,
    status,
    events: [],
    series: [],
    error: null,
    offline: false,
    pendingWrites: 0,
    lastSyncedAt: null,
    skippedInvalid: 0,
  }
  const refuse = async (): Promise<OpResult> => ({ ok: false, error: 'Your calendar is not loaded yet.', kind: 'auth' })
  return {
    mode: 'none',
    userId,
    getSnapshot: () => snap,
    subscribe: () => () => {},
    createEvent: refuse,
    updateEvent: refuse,
    removeEvent: refuse,
    createSeries: refuse,
    updateSeries: refuse,
    removeSeries: refuse,
    setException: refuse,
    clearException: refuse,
    async refresh() {},
    dismissError() {},
    dispose() {},
  }
}

import type { CloudErrorKind } from '../cloud/types'
import type { CalendarEvent, EventInput, RecurringSeries, SeriesException, SeriesInput } from '../types'

export type CalendarMode = 'local' | 'cloud' | 'none'

export interface CalendarSnapshot {
  /** 'local' = this browser's storage only; 'cloud' = the signed-in user's account; 'none' = no data source. */
  mode: CalendarMode
  /** Owner of the data in a cloud snapshot. Never set for local data. */
  userId: string | null
  status: 'loading' | 'ready' | 'error'
  events: readonly CalendarEvent[]
  series: readonly RecurringSeries[]
  /** Last failure (load or write), shown until dismissed or the next success. */
  error: string | null
  offline: boolean
  pendingWrites: number
  lastSyncedAt: number | null
  /** Cloud rows that failed local validation and were not shown. */
  skippedInvalid: number
}

export type OpResult = { ok: true } | { ok: false; error: string; kind: CloudErrorKind }

/**
 * What the UI talks to. Both local (browser storage) and cloud (Supabase) data sources
 * implement it, so views and the editor are written once. All mutations are asynchronous
 * and resolve ONLY after the data is actually saved (no optimistic updates): `ok: false`
 * always means "not saved".
 */
export interface CalendarSource {
  readonly mode: CalendarMode
  readonly userId: string | null
  getSnapshot(): CalendarSnapshot
  subscribe(listener: () => void): () => void

  /** `id` lets the caller keep one stable id across retries, making a retried create idempotent. */
  createEvent(input: EventInput, id?: string): Promise<OpResult>
  updateEvent(id: string, input: EventInput): Promise<OpResult>
  removeEvent(id: string): Promise<OpResult>

  createSeries(input: SeriesInput, id?: string): Promise<OpResult>
  /** `keptExceptions` is the complete list of exceptions that should remain; the others are removed. */
  updateSeries(id: string, input: SeriesInput, keptExceptions: SeriesException[]): Promise<OpResult>
  removeSeries(id: string): Promise<OpResult>

  setException(seriesId: string, exception: SeriesException): Promise<OpResult>
  clearException(seriesId: string, originalDate: string): Promise<OpResult>

  /** Re-read from the source of truth. Cheap to call repeatedly (de-duplicated). */
  refresh(): Promise<void>
  dismissError(): void
  dispose(): void
}

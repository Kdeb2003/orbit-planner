import type { SupabaseClient } from '@supabase/supabase-js'
import { mapCloudError } from './errors'
import type { EventPatch, EventRow, EventWrite, ExceptionRow, ExceptionWrite, SeriesPatch, SeriesRow, SeriesWrite } from './types'

/**
 * The narrow set of table operations ORBIT needs. Everything above this line
 * (cloud source, import) is tested against in-memory fakes; this file is the only
 * code that builds PostgREST requests.
 *
 * Contract:
 *  - every method throws a CloudError on failure (nothing is swallowed);
 *  - `update*`/`delete*` are CONDITIONAL on the row's current `updated_at` (optimistic
 *    concurrency): they return null/false when the row changed or vanished;
 *  - `insert*` is idempotent per id (ON CONFLICT DO NOTHING) and returns null when the
 *    id already existed, so a retried request can never create a duplicate.
 */
export interface CloudApi {
  loadEvents(): Promise<EventRow[]>
  loadSeries(): Promise<SeriesRow[]>
  loadExceptions(): Promise<ExceptionRow[]>

  insertEvent(row: EventWrite): Promise<EventRow | null>
  updateEvent(id: string, patch: EventPatch, expectedUpdatedAt: string): Promise<EventRow | null>
  deleteEvent(id: string, expectedUpdatedAt: string): Promise<boolean>

  insertSeries(row: SeriesWrite): Promise<SeriesRow | null>
  updateSeries(id: string, patch: SeriesPatch, expectedUpdatedAt: string): Promise<SeriesRow | null>
  deleteSeries(id: string, expectedUpdatedAt: string): Promise<boolean>

  /** Create or replace the exception for (series_id, original_date). */
  upsertException(row: ExceptionWrite): Promise<ExceptionRow>
  deleteException(seriesId: string, originalDate: string): Promise<void>

  /** Bulk, never-overwrite inserts used by the explicit import. Return how many rows were actually inserted. */
  insertEventsIgnoreDuplicates(rows: EventWrite[]): Promise<number>
  insertSeriesIgnoreDuplicates(rows: SeriesWrite[]): Promise<number>
  insertExceptionsIgnoreDuplicates(rows: ExceptionWrite[]): Promise<number>
}

const PAGE = 1000

export function createSupabaseApi(client: SupabaseClient): CloudApi {
  async function unwrap<T>(p: PromiseLike<{ data: T | null; error: unknown; status: number }>): Promise<T> {
    let res
    try {
      res = await p
    } catch (err) {
      throw mapCloudError(err, 0)
    }
    if (res.error) throw mapCloudError(res.error, res.status)
    return (res.data ?? []) as T
  }

  /** PostgREST caps responses (1000 rows by default): read every page. */
  async function loadAll<T>(table: string, order: string[]): Promise<T[]> {
    const out: T[] = []
    for (let from = 0; ; from += PAGE) {
      let q = client.from(table).select('*')
      for (const col of order) q = q.order(col, { ascending: true })
      const rows = await unwrap<T[]>(q.range(from, from + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  const insertOne = async <T>(table: string, row: object, onConflict: string): Promise<T | null> => {
    const rows = await unwrap<T[]>(client.from(table).upsert(row, { onConflict, ignoreDuplicates: true }).select())
    return rows[0] ?? null
  }

  const insertMany = async (table: string, rows: object[], onConflict: string): Promise<number> => {
    if (rows.length === 0) return 0
    const inserted = await unwrap<unknown[]>(client.from(table).upsert(rows, { onConflict, ignoreDuplicates: true }).select())
    return inserted.length
  }

  const conditionalUpdate = async <T>(table: string, id: string, patch: object, expected: string): Promise<T | null> => {
    const rows = await unwrap<T[]>(client.from(table).update(patch).eq('id', id).eq('updated_at', expected).select())
    return rows[0] ?? null
  }

  const conditionalDelete = async (table: string, id: string, expected: string): Promise<boolean> => {
    const rows = await unwrap<unknown[]>(client.from(table).delete().eq('id', id).eq('updated_at', expected).select())
    return rows.length > 0
  }

  return {
    loadEvents: () => loadAll<EventRow>('events', ['starts_at', 'id']),
    loadSeries: () => loadAll<SeriesRow>('recurring_series', ['start_date', 'id']),
    loadExceptions: () => loadAll<ExceptionRow>('series_exceptions', ['series_id', 'original_date']),

    insertEvent: (row) => insertOne<EventRow>('events', row, 'id'),
    updateEvent: (id, patch, expected) => conditionalUpdate<EventRow>('events', id, patch, expected),
    deleteEvent: (id, expected) => conditionalDelete('events', id, expected),

    insertSeries: (row) => insertOne<SeriesRow>('recurring_series', row, 'id'),
    updateSeries: (id, patch, expected) => conditionalUpdate<SeriesRow>('recurring_series', id, patch, expected),
    deleteSeries: (id, expected) => conditionalDelete('recurring_series', id, expected),

    async upsertException(row) {
      const rows = await unwrap<ExceptionRow[]>(client.from('series_exceptions').upsert(row, { onConflict: 'series_id,original_date' }).select())
      if (!rows[0]) throw mapCloudError({ message: 'empty response' }, 500)
      return rows[0]
    },
    async deleteException(seriesId, originalDate) {
      await unwrap(client.from('series_exceptions').delete().eq('series_id', seriesId).eq('original_date', originalDate))
    },

    insertEventsIgnoreDuplicates: (rows) => insertMany('events', rows, 'id'),
    insertSeriesIgnoreDuplicates: (rows) => insertMany('recurring_series', rows, 'id'),
    insertExceptionsIgnoreDuplicates: (rows) => insertMany('series_exceptions', rows, 'series_id,original_date'),
  }
}

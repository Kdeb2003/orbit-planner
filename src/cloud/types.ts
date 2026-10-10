import type { OccurrenceOverride } from '../types'

// Row shapes of the three Supabase tables (see supabase/README.md). Timestamps are
// kept as the raw strings PostgREST returns: `updated_at` doubles as the optimistic
// concurrency token, so it must round-trip byte for byte.

export interface EventRow {
  id: string
  user_id?: string
  title: string
  category: string
  starts_at: string
  ends_at: string
  time_zone: string
  location: string | null
  description: string | null
  course_code: string | null
  session_type: string | null
  group_label: string | null
  created_at: string
  updated_at: string
}
/** Columns the client may send on INSERT (user_id, updated_at come from the server). */
export type EventWrite = Omit<EventRow, 'user_id' | 'created_at' | 'updated_at'> & { created_at?: string }
/** Columns the client may send on UPDATE (identity and timestamps are never sent). */
export type EventPatch = Omit<EventWrite, 'id' | 'created_at'>

export interface SeriesRow {
  id: string
  user_id?: string
  title: string
  category: string
  time_zone: string
  location: string | null
  description: string | null
  course_code: string | null
  session_type: string | null
  group_label: string | null
  frequency: string
  weekdays: number[]
  start_date: string
  until_date: string
  start_time: string
  end_time: string
  end_day_offset: number
  created_at: string
  updated_at: string
}
export type SeriesWrite = Omit<SeriesRow, 'user_id' | 'created_at' | 'updated_at'> & { created_at?: string }
export type SeriesPatch = Omit<SeriesWrite, 'id' | 'created_at'>

export interface ExceptionRow {
  series_id: string
  original_date: string
  cancelled: boolean
  override: OccurrenceOverride | null
  created_at: string
  updated_at: string
}
export type ExceptionWrite = Pick<ExceptionRow, 'series_id' | 'original_date' | 'cancelled' | 'override'> & { created_at?: string }

export type CloudErrorKind = 'network' | 'auth' | 'permission' | 'conflict' | 'validation' | 'unknown'

/** Every failure of a cloud operation is reported as one of these; nothing is swallowed. */
export class CloudError extends Error {
  kind: CloudErrorKind
  code?: string
  constructor(kind: CloudErrorKind, message: string, code?: string) {
    super(message)
    this.name = 'CloudError'
    this.kind = kind
    this.code = code
  }
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string; kind: CloudErrorKind }

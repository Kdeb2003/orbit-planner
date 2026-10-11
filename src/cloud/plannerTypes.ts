// Row shapes of the planner tables (supabase/migrations/20261020120000_courses.sql). Timestamps are kept as the
// raw strings PostgREST returns: `updated_at` doubles as the optimistic-concurrency token and must round-trip
// byte for byte. The generated key columns (code_key, institution_key, term_key) are never selected or sent.

export interface CourseRow {
  id: string
  user_id: string
  name: string
  code: string | null
  institution: string | null
  term_label: string | null
  term_start: string | null
  term_end: string | null
  description: string | null
  color: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** Columns the client may send on INSERT (user_id and timestamps come from the server; archive state starts empty). */
export type CourseWrite = Pick<
  CourseRow,
  'id' | 'name' | 'code' | 'institution' | 'term_label' | 'term_start' | 'term_end' | 'description' | 'color'
>
/** Columns the client may send on a general UPDATE (identity, archive state and timestamps are never sent). */
export type CoursePatch = Omit<CourseWrite, 'id'>

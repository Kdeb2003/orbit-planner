import type { SupabaseClient } from '@supabase/supabase-js'
import { mapCloudError } from './errors'
import { COURSE_COLUMNS } from './plannerMappers'
import type { CoursePatch, CourseRow, CourseWrite } from './plannerTypes'
import { CloudError } from './types'

/**
 * The narrow set of planner table operations (courses). This file is the only code that builds PostgREST requests
 * for the planner tables; everything above it is tested against `FakePlanner`.
 *
 * Contract (same as `CloudApi`):
 *  - every method throws a CloudError on failure (nothing is swallowed);
 *  - security is Row Level Security: the browser never supplies a user id, and a row of another user is simply
 *    invisible (it reads as "not found");
 *  - `update*`/`delete*` are CONDITIONAL on the row's current `updated_at` (optimistic concurrency): they return
 *    null/false when the row changed or vanished, and never overwrite newer data;
 *  - `insertCourse` is idempotent per id (ON CONFLICT (id) DO NOTHING) and returns null when the id already exists,
 *    so a retried request can never create a duplicate row. The caller must then verify the existing row with
 *    `getCourse` instead of assuming success;
 *  - a second course with the same normalised code, institution and term label is rejected with a CloudError
 *    whose `code` is 'duplicate_course' (distinct from a stale write, which is a null/false result).
 */
export interface PlannerApi {
  /** Every course of the signed-in user (all pages). */
  loadCourses(): Promise<CourseRow[]>
  /** One course by id, or null when it does not exist (or is not visible to this user). */
  getCourse(id: string): Promise<CourseRow | null>
  insertCourse(row: CourseWrite): Promise<CourseRow | null>
  updateCourse(id: string, patch: CoursePatch, expectedUpdatedAt: string): Promise<CourseRow | null>
  /** Sets archived_at (an ISO instant). Touches nothing else. */
  archiveCourse(id: string, archivedAt: string, expectedUpdatedAt: string): Promise<CourseRow | null>
  /** Clears archived_at. Touches nothing else. */
  restoreCourse(id: string, expectedUpdatedAt: string): Promise<CourseRow | null>
  deleteCourse(id: string, expectedUpdatedAt: string): Promise<boolean>
}

/** PostgREST caps responses (1000 rows by default): read every page. */
const DEFAULT_PAGE = 1000

/** Name of the unique index on (user_id, code_key, institution_key, term_key); it appears in the 23505 message. */
export const COURSE_DUPLICATE_CONSTRAINT = 'courses_user_code_institution_term_key'

interface PostgrestLike {
  code?: string
  message?: string
  details?: string
}

/** Like `mapCloudError`, plus the planner-specific cases (duplicate course, tables not installed). */
export function mapPlannerError(error: unknown, status = 0): CloudError {
  if (error instanceof CloudError) return error
  const e = (error ?? {}) as PostgrestLike
  const text = `${e.message ?? ''} ${e.details ?? ''}`
  if (e.code === '23505' && text.includes(COURSE_DUPLICATE_CONSTRAINT)) {
    return new CloudError('conflict', 'A course with this code, institution and term already exists.', 'duplicate_course')
  }
  if (e.code === 'PGRST205' || e.code === '42P01' || status === 404) {
    return new CloudError('unknown', 'Courses are not available on this server yet.', 'planner_unavailable')
  }
  return mapCloudError(error, status)
}

export function createSupabasePlannerApi(client: SupabaseClient, options: { pageSize?: number } = {}): PlannerApi {
  const pageSize = options.pageSize ?? DEFAULT_PAGE

  async function unwrap<T>(p: PromiseLike<{ data: T | null; error: unknown; status: number }>): Promise<T> {
    let res
    try {
      res = await p
    } catch (err) {
      throw mapPlannerError(err, 0)
    }
    if (res.error) throw mapPlannerError(res.error, res.status)
    return (res.data ?? []) as T
  }

  const conditionalUpdate = async (id: string, patch: object, expected: string): Promise<CourseRow | null> => {
    const rows = await unwrap<CourseRow[]>(
      client.from('courses').update(patch).eq('id', id).eq('updated_at', expected).select(COURSE_COLUMNS),
    )
    return rows[0] ?? null
  }

  return {
    async loadCourses() {
      // Stable order (created_at, then id) so that offset paging is deterministic; ids are de-duplicated in case a
      // row moved between pages while paging (the next refresh would repair a skipped row).
      const byId = new Map<string, CourseRow>()
      for (let from = 0; ; from += pageSize) {
        const rows = await unwrap<CourseRow[]>(
          client
            .from('courses')
            .select(COURSE_COLUMNS)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1),
        )
        for (const r of rows) byId.set(r.id, r)
        if (rows.length < pageSize) return [...byId.values()]
      }
    },

    async getCourse(id) {
      const rows = await unwrap<CourseRow[]>(client.from('courses').select(COURSE_COLUMNS).eq('id', id).limit(1))
      return rows[0] ?? null
    },

    async insertCourse(row) {
      const rows = await unwrap<CourseRow[]>(
        client.from('courses').upsert(row, { onConflict: 'id', ignoreDuplicates: true }).select(COURSE_COLUMNS),
      )
      return rows[0] ?? null
    },

    updateCourse: (id, patch, expected) => conditionalUpdate(id, patch, expected),
    archiveCourse: (id, archivedAt, expected) => conditionalUpdate(id, { archived_at: archivedAt }, expected),
    restoreCourse: (id, expected) => conditionalUpdate(id, { archived_at: null }, expected),

    async deleteCourse(id, expected) {
      const rows = await unwrap<unknown[]>(
        client.from('courses').delete().eq('id', id).eq('updated_at', expected).select('id'),
      )
      return rows.length > 0
    },
  }
}

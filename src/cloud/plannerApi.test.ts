import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { COURSE_DUPLICATE_CONSTRAINT, createSupabasePlannerApi, mapPlannerError } from './plannerApi'
import { COURSE_COLUMNS, courseToWrite } from './plannerMappers'
import type { CourseRow } from './plannerTypes'
import { CloudError } from './types'

const ID = 'c0c0c0c0-0000-4000-8000-000000000001'
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

type Reply = { data?: unknown; error?: unknown; status?: number } | Error
interface Recorded {
  table: string
  steps: [string, unknown[]][]
}

/**
 * A recording stand-in for supabase-js' PostgREST builder (no network). Every `from(...)` chain is recorded and
 * resolves with the next scripted reply.
 */
function mockClient(replies: Reply[]) {
  const requests: Recorded[] = []
  let froms = 0
  const client = {
    from(table: string) {
      froms++
      const rec: Recorded = { table, steps: [] }
      requests.push(rec)
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'range', 'eq', 'limit', 'upsert', 'update', 'delete']) {
        builder[m] = (...args: unknown[]) => {
          rec.steps.push([m, args])
          return builder
        }
      }
      builder.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
        const r = replies.shift() ?? { data: [] }
        if (r instanceof Error) return Promise.reject(r).then(ok, bad)
        return Promise.resolve({ data: null, error: null, status: 200, ...r }).then(ok, bad)
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, requests, froms: () => froms }
}

const row = (over: Partial<CourseRow> = {}): CourseRow => ({
  id: ID,
  user_id: USER,
  name: 'Linear Algebra',
  code: 'MATH 101',
  institution: null,
  term_label: null,
  term_start: null,
  term_end: null,
  description: null,
  color: 'c1',
  archived_at: null,
  created_at: '2026-10-01T09:00:00.123456+00:00',
  updated_at: '2026-10-02T09:00:00.654321+00:00',
  ...over,
})
const step = (r: Recorded, name: string) => r.steps.filter(([n]) => n === name).map(([, a]) => a)

describe('loadCourses', () => {
  it('reads the explicit column list in a stable order, one page when the result is short', async () => {
    const { client, requests } = mockClient([{ data: [row()] }])
    const rows = await createSupabasePlannerApi(client).loadCourses()
    expect(rows).toEqual([row()])
    expect(requests).toHaveLength(1)
    expect(requests[0].table).toBe('courses')
    expect(step(requests[0], 'select')).toEqual([[COURSE_COLUMNS]])
    expect(step(requests[0], 'order')).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]])
    expect(step(requests[0], 'range')).toEqual([[0, 999]])
  })

  it('reads every page until a short one and de-duplicates ids that moved between pages', async () => {
    const mk = (n: number) => row({ id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}` })
    const { client, requests } = mockClient([
      { data: [mk(1), mk(2)] },
      { data: [mk(2), mk(3)] }, // mk(2) repeated: a row shifted onto the next page
      { data: [mk(4)] },
    ])
    const rows = await createSupabasePlannerApi(client, { pageSize: 2 }).loadCourses()
    expect(rows.map((r) => r.id.slice(-1))).toEqual(['1', '2', '3', '4'])
    expect(requests.map((r) => step(r, 'range')[0])).toEqual([[0, 1], [2, 3], [4, 5]])
  })

  it('treats an exactly full last page as "maybe more" and asks once more', async () => {
    const mk = (n: number) => row({ id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}` })
    const { client, requests } = mockClient([{ data: [mk(1), mk(2)] }, { data: [] }])
    expect(await createSupabasePlannerApi(client, { pageSize: 2 }).loadCourses()).toHaveLength(2)
    expect(requests).toHaveLength(2)
  })

  it('an empty table is a successful empty result', async () => {
    const { client } = mockClient([{ data: null }])
    expect(await createSupabasePlannerApi(client).loadCourses()).toEqual([])
  })

  it('a failing later page fails the whole load (no silently partial list)', async () => {
    const { client } = mockClient([{ data: Array.from({ length: 2 }, (_, i) => row({ id: `c0c0c0c0-0000-4000-8000-00000000000${i}` })) }, { error: { message: 'boom' }, status: 500 }])
    await expect(createSupabasePlannerApi(client, { pageSize: 2 }).loadCourses()).rejects.toBeInstanceOf(CloudError)
  })
})

describe('insertCourse', () => {
  it('upserts with ON CONFLICT (id) DO NOTHING and returns the created row', async () => {
    const { client, requests } = mockClient([{ data: [row()], status: 201 }])
    const write = courseToWrite({ name: 'Linear Algebra', code: 'MATH 101', color: 'c1' }, ID)
    expect(await createSupabasePlannerApi(client).insertCourse(write)).toEqual(row())
    expect(requests[0].table).toBe('courses')
    expect(step(requests[0], 'upsert')).toEqual([[write, { onConflict: 'id', ignoreDuplicates: true }]])
    expect(step(requests[0], 'select')).toEqual([[COURSE_COLUMNS]])
  })

  it('never sends a user id, timestamps, archive state or key columns', async () => {
    const { client, requests } = mockClient([{ data: [row()] }])
    await createSupabasePlannerApi(client).insertCourse(courseToWrite({ name: 'A', color: 'c1' }, ID))
    const sent = step(requests[0], 'upsert')[0][0] as Record<string, unknown>
    for (const k of ['user_id', 'created_at', 'updated_at', 'archived_at', 'code_key', 'institution_key', 'term_key']) expect(k in sent, k).toBe(false)
  })

  it('returns null (not success) when the id already exists, so the caller has to verify', async () => {
    const { client } = mockClient([{ data: [], status: 201 }])
    expect(await createSupabasePlannerApi(client).insertCourse(courseToWrite({ name: 'A', color: 'c1' }, ID))).toBeNull()
  })

  it('maps a unique-index violation on the normalised code to "duplicate_course"', async () => {
    const { client } = mockClient([
      { error: { code: '23505', message: `duplicate key value violates unique constraint "${COURSE_DUPLICATE_CONSTRAINT}"`, details: 'Key (user_id, code_key, institution_key, term_key)=(…) already exists.' }, status: 409 },
    ])
    const err = await createSupabasePlannerApi(client).insertCourse(courseToWrite({ name: 'A', code: 'x', color: 'c1' }, ID)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CloudError)
    expect(err).toMatchObject({ kind: 'conflict', code: 'duplicate_course' })
  })
})

describe('conditional writes', () => {
  it('update: sends only the patch and is conditional on id AND the raw updated_at', async () => {
    const { client, requests } = mockClient([{ data: [row({ name: 'New' })] }])
    const patch = { name: 'New', code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c2' }
    const out = await createSupabasePlannerApi(client).updateCourse(ID, patch, '2026-10-02T09:00:00.654321+00:00')
    expect(out?.name).toBe('New')
    expect(step(requests[0], 'update')).toEqual([[patch]])
    expect(step(requests[0], 'eq')).toEqual([['id', ID], ['updated_at', '2026-10-02T09:00:00.654321+00:00']])
    expect(step(requests[0], 'select')).toEqual([[COURSE_COLUMNS]])
  })

  it('a stale update (no row matched) returns null and is not an error', async () => {
    const { client } = mockClient([{ data: [] }])
    expect(await createSupabasePlannerApi(client).updateCourse(ID, { name: 'X', code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c1' }, 'old')).toBeNull()
  })

  it('archive sets only archived_at; restore clears only archived_at; both are conditional', async () => {
    const { client, requests } = mockClient([{ data: [row({ archived_at: '2026-10-05T00:00:00+00:00' })] }, { data: [row()] }])
    const api = createSupabasePlannerApi(client)
    await api.archiveCourse(ID, '2026-10-05T00:00:00.000Z', 'v1')
    await api.restoreCourse(ID, 'v2')
    expect(step(requests[0], 'update')).toEqual([[{ archived_at: '2026-10-05T00:00:00.000Z' }]])
    expect(step(requests[1], 'update')).toEqual([[{ archived_at: null }]])
    expect(step(requests[0], 'eq')).toEqual([['id', ID], ['updated_at', 'v1']])
    expect(step(requests[1], 'eq')).toEqual([['id', ID], ['updated_at', 'v2']])
  })

  it('delete is conditional on id and updated_at; true only when a row was removed', async () => {
    const { client, requests } = mockClient([{ data: [{ id: ID }] }, { data: [] }])
    const api = createSupabasePlannerApi(client)
    expect(await api.deleteCourse(ID, 'v1')).toBe(true)
    expect(await api.deleteCourse(ID, 'v0')).toBe(false)
    expect(step(requests[0], 'delete')).toHaveLength(1)
    expect(step(requests[0], 'eq')).toEqual([['id', ID], ['updated_at', 'v1']])
  })

  it('getCourse reads one row by id and returns null when it is absent or not visible', async () => {
    const { client, requests } = mockClient([{ data: [row()] }, { data: [] }])
    const api = createSupabasePlannerApi(client)
    expect(await api.getCourse(ID)).toEqual(row())
    expect(await api.getCourse('c0c0c0c0-0000-4000-8000-0000000000ff')).toBeNull()
    expect(step(requests[0], 'eq')).toEqual([['id', ID]])
  })
})

describe('error mapping', () => {
  it('maps network failures, expired sessions, permission and validation errors', () => {
    expect(mapPlannerError(new TypeError('Failed to fetch'), 0)).toMatchObject({ kind: 'network' })
    expect(mapPlannerError({ code: 'PGRST301', message: 'JWT expired' }, 401)).toMatchObject({ kind: 'auth' })
    expect(mapPlannerError({ code: '42501', message: 'permission denied for table courses' }, 403)).toMatchObject({ kind: 'permission' })
    expect(mapPlannerError({ code: '23514', message: 'new row violates check constraint' }, 400)).toMatchObject({ kind: 'validation' })
  })

  it('tells a duplicate course apart from any other unique violation', () => {
    expect(mapPlannerError({ code: '23505', message: `... "${COURSE_DUPLICATE_CONSTRAINT}"` }, 409)).toMatchObject({ kind: 'conflict', code: 'duplicate_course' })
    const other = mapPlannerError({ code: '23505', message: 'duplicate key value violates unique constraint "courses_pkey"' }, 409)
    expect(other).toMatchObject({ kind: 'conflict' })
    expect(other.code).not.toBe('duplicate_course')
  })

  it('reports a missing table (migration not applied) without a calendar-specific message and never leaks request details', () => {
    const e = mapPlannerError({ code: 'PGRST205', message: "Could not find the table 'public.courses' in the schema cache" }, 404)
    expect(e).toMatchObject({ kind: 'unknown', code: 'planner_unavailable' })
    expect(e.message).not.toMatch(/calendar|public\.courses|http/i)
  })

  it('passes CloudErrors through unchanged', () => {
    const e = new CloudError('auth', 'x', 'y')
    expect(mapPlannerError(e)).toBe(e)
  })

  it('a thrown (rejected) request becomes a network CloudError', async () => {
    const { client } = mockClient([new TypeError('Failed to fetch')])
    await expect(createSupabasePlannerApi(client).loadCourses()).rejects.toMatchObject({ kind: 'network' })
  })
})

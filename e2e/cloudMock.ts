import type { Route } from '@playwright/test'

/**
 * In-memory imitation of the Supabase REST API (PostgREST) for the three ORBIT tables, used by the
 * browser tests. The REAL supabase-js client talks to it over HTTP, so request shapes (filters,
 * Prefer headers, on_conflict, pagination) are exercised for real. What it does NOT prove: Supabase
 * itself, real RLS or real PostgreSQL constraints (those are covered by the PGlite SQL tests and the
 * manual live checks). It emulates: per-user row visibility (RLS), server-assigned updated_at,
 * ON CONFLICT handling, uuid validation, cascade delete, and a few CHECK constraints.
 */
type Row = Record<string, unknown>
const TABLES = ['events', 'recurring_series', 'series_exceptions', 'courses'] as const
type Table = (typeof TABLES)[number]
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class MockCloudDb {
  tables: Record<Table, Row[]> = { events: [], recurring_series: [], series_exceptions: [], courses: [] }
  /** Every REST request seen: "METHOD table user". */
  log: string[] = []
  offline = false
  /** When set, write requests (POST/PATCH/DELETE) fail with this PostgREST error. */
  failWrites: { status: number; code: string; message: string; tables?: string[] } | null = null
  /** Delay (ms) applied to every response, to observe "saving" states. */
  delayMs = 0
  /** Courses table is only served when enabled; otherwise it answers like a database that lacks it (PGRST205). */
  coursesInstalled = true
  private clock = 0

  private stamp() {
    this.clock++
    return `2026-10-09T12:00:00.${String(this.clock).padStart(6, '0')}+00:00`
  }

  seed(table: Table, user: string, row: Row) {
    this.tables[table].push({ ...row, ...(table !== 'series_exceptions' ? { user_id: user } : {}), created_at: this.stamp(), updated_at: this.stamp() })
  }

  rowsOf(table: Table, user: string): Row[] {
    return this.visible(table, user)
  }

  private visible(table: Table, user: string): Row[] {
    if (table !== 'series_exceptions') return this.tables[table].filter((r) => r.user_id === user)
    const mine = new Set(this.tables.recurring_series.filter((s) => s.user_id === user).map((s) => s.id))
    return this.tables.series_exceptions.filter((x) => mine.has(x.series_id))
  }

  private static userOf(authorization: string | undefined): string | null {
    const token = (authorization ?? '').replace(/^Bearer /i, '')
    if (!token.endsWith('.mock-signature')) return null // the publishable key alone = anonymous
    try {
      return (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub?: string }).sub ?? null
    } catch {
      return null
    }
  }

  /** Unique index (user_id, code_key, institution_key, term_key) with rule N approximated by trim + collapse + ASCII upper-casing. */
  private duplicateCourse(user: string, row: Row): boolean {
    const key = (v: unknown) => String(v ?? '').replace(/[ \t\r\n\f\v\u00a0]+/g, ' ').trim().replace(/[a-z]/g, (c) => c.toUpperCase())
    if (row.code === null || row.code === undefined) return false
    return this.tables.courses.some(
      (r) => r.user_id === user && r.id !== row.id && r.code != null && key(r.code) === key(row.code) && key(r.institution) === key(row.institution) && key(r.term_label) === key(row.term_label),
    )
  }

  async handle(route: Route): Promise<void> {
    const req = route.request()
    const url = new URL(req.url())
    const table = url.pathname.split('/').pop() as Table
    const method = req.method()
    const reply = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) })
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.offline) return route.abort('connectionrefused')
    if (method === 'OPTIONS') return route.fulfill({ status: 204 })

    const user = MockCloudDb.userOf(req.headers()['authorization'])
    this.log.push(`${method} ${table} ${user ?? 'anon'}`)
    if (!TABLES.includes(table) || (table === 'courses' && !this.coursesInstalled)) return reply(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` })
    if (!user) return reply(401, { code: '42501', message: `permission denied for table ${table}` }) // anon has no privileges
    const isWrite = method !== 'GET' && method !== 'HEAD'
    if (isWrite && this.failWrites && (!this.failWrites.tables || this.failWrites.tables.includes(table))) return reply(this.failWrites.status, { code: this.failWrites.code, message: this.failWrites.message })

    const params = url.searchParams
    const filters = [...params.entries()].filter(([k, v]) => !RESERVED.has(k) && v.startsWith('eq.')).map(([k, v]) => [k, v.slice(3)] as const)
    const matches = (r: Row) => filters.every(([k, v]) => String(r[k]) === v)
    const prefer = req.headers()['prefer'] ?? ''
    const wantsRows = prefer.includes('return=representation')

    if (method === 'GET') {
      let rows = this.visible(table, user).filter(matches)
      const order = params.get('order')
      if (order) {
        const cols = order.split(',').map((o) => o.split('.')[0])
        rows = [...rows].sort((a, b) => {
          for (const c of cols) {
            const d = String(a[c]).localeCompare(String(b[c]))
            if (d) return d
          }
          return 0
        })
      }
      const offset = Number(params.get('offset') ?? 0)
      const limit = params.get('limit') ? Number(params.get('limit')) : undefined
      return reply(200, rows.slice(offset, limit === undefined ? undefined : offset + limit))
    }

    if (method === 'POST') {
      const body = req.postDataJSON() as Row | Row[]
      const incoming = Array.isArray(body) ? body : [body]
      const conflictCols = (params.get('on_conflict') ?? (table === 'series_exceptions' ? 'series_id,original_date' : 'id')).split(',')
      const ignore = prefer.includes('ignore-duplicates')
      const merge = prefer.includes('merge-duplicates')
      const out: Row[] = []
      for (const raw of incoming) {
        const row: Row = { ...raw }
        if (table !== 'series_exceptions') {
          row.user_id = user // DEFAULT auth.uid(); RLS WITH CHECK rejects other owners
          if (raw.user_id && raw.user_id !== user) return reply(403, { code: '42501', message: 'new row violates row-level security policy' })
          if (typeof row.id !== 'string' || !UUID.test(row.id)) return reply(400, { code: '22P02', message: `invalid input syntax for type uuid: "${String(row.id)}"` })
          if (table === 'courses') {
            if (typeof row.name !== 'string' || row.name.trim().length < 1 || row.name.length > 120) return reply(400, { code: '23514', message: 'violates check constraint (name)' })
            if (this.duplicateCourse(user, row)) return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint "courses_user_code_institution_term_key"', details: 'Key (user_id, code_key, institution_key, term_key) already exists.' })
          } else if (typeof row.title !== 'string' || row.title.trim().length < 1 || row.title.length > 120) return reply(400, { code: '23514', message: 'violates check constraint (title)' })
        } else {
          if (typeof row.series_id !== 'string' || !UUID.test(row.series_id)) return reply(400, { code: '22P02', message: 'invalid input syntax for type uuid' })
          const owned = this.tables.recurring_series.some((s) => s.id === row.series_id && s.user_id === user)
          if (!owned) return reply(403, { code: '42501', message: 'new row violates row-level security policy for table "series_exceptions"' })
          if (!row.cancelled && (!row.override || Object.keys(row.override as object).length === 0)) return reply(400, { code: '23514', message: 'violates check constraint "exception_has_effect"' })
        }
        const existing = this.tables[table].find((r) => conflictCols.every((c) => r[c] === row[c]))
        if (existing) {
          if (ignore) continue
          if (merge) {
            Object.assign(existing, row, { updated_at: this.stamp(), created_at: existing.created_at })
            out.push(existing)
            continue
          }
          return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint' })
        }
        // column defaults of the real table (PostgREST returns every selected column, NULL included)
        const defaults: Row = table === 'courses' ? { code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c1', archived_at: null } : {}
        const full: Row = { ...defaults, ...row, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() }
        this.tables[table].push(full)
        out.push(full)
      }
      return wantsRows ? reply(201, out) : reply(201, undefined)
    }

    if (method === 'PATCH') {
      const patch = req.postDataJSON() as Row
      const rows = this.visible(table, user).filter(matches)
      if (table === 'courses') {
        for (const r of rows) if (this.duplicateCourse(user, { ...r, ...patch })) return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint "courses_user_code_institution_term_key"' })
      }
      for (const r of rows) Object.assign(r, patch, { updated_at: this.stamp() }) // trigger: server sets updated_at, ignores id/user_id changes
      return wantsRows ? reply(200, rows) : reply(204, undefined)
    }

    if (method === 'DELETE') {
      const rows = this.visible(table, user).filter(matches)
      this.tables[table] = this.tables[table].filter((r) => !rows.includes(r))
      if (table === 'recurring_series') {
        const gone = new Set(rows.map((r) => r.id))
        this.tables.series_exceptions = this.tables.series_exceptions.filter((x) => !gone.has(x.series_id)) // ON DELETE CASCADE
      }
      return wantsRows ? reply(200, rows) : reply(204, undefined)
    }
    return reply(405, { message: 'method not allowed' })
  }
}

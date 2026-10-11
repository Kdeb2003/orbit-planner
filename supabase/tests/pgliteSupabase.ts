// A minimal supabase-js look-alike over PGlite, used ONLY to run scripts/hostedCoursesCore.mjs against the REAL migration SQL
// offline. It implements just the query-builder calls the Courses verification uses and runs each statement as the
// `anon` / `authenticated` role with `request.jwt.claim.sub` set, so row level security, column privileges, triggers and
// constraints are the real ones. It is NOT PostgREST: request parsing, JWTs and error envelopes are only approximated.
import type { PGlite } from '@electric-sql/pglite'

export interface Res {
  data: unknown
  error: { code: string; message: string; details?: string } | null
  status: number
}

type Op = 'select' | 'insert' | 'upsert' | 'update' | 'delete'

export interface Statement {
  role: string
  sql: string
}

export interface World {
  db: PGlite
  log: Statement[]
  /** Tail of a promise chain: statements run one at a time because the role/claim are connection state. */
  lock: Promise<unknown>
}

export const newWorld = (db: PGlite): World => ({ db, log: [], lock: Promise.resolve() })

const ident = /^[a-z_][a-z0-9_]*$/

export function makeClient(world: World, role: 'anon' | 'authenticated', userId: string | null) {
  async function exec(sql: string, params: unknown[]): Promise<Res> {
    const run = async (): Promise<Res> => {
      const { db } = world
      await db.exec(`set role ${role}`)
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ''])
      world.log.push({ role: `${role}:${userId ?? '-'}`, sql })
      try {
        const res = await db.query<{ r: unknown }>(sql, params)
        return { data: res.rows.map((x) => x.r), error: null, status: 200 }
      } catch (e) {
        const x = e as { code?: string; message?: string; detail?: string }
        if (x.code === '42P01') return { data: null, error: { code: 'PGRST205', message: "Could not find the table in the schema cache" }, status: 404 }
        return { data: null, error: { code: x.code ?? 'unknown', message: x.message ?? '', details: x.detail }, status: 400 }
      } finally {
        await db.exec('reset role')
        await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
      }
    }
    const next = world.lock.then(run, run)
    world.lock = next
    return next
  }

  function from(table: string) {
    if (!ident.test(table)) throw new Error('bad table')
    let op: Op = 'select'
    let cols = '*'
    let values: Record<string, unknown> = {}
    let ignore = false
    let lim: number | null = null
    let single = false
    const filters: { col: string; kind: 'eq' | 'like' | 'in'; v: unknown }[] = []

    const build = (): { sql: string; params: unknown[] } => {
      const params: unknown[] = []
      const p = (v: unknown) => {
        params.push(v)
        return `$${params.length}`
      }
      const where = filters.length
        ? ` where ${filters
            .map((f) => {
              if (!ident.test(f.col)) throw new Error('bad column')
              if (f.kind === 'eq') return `${f.col} = ${p(f.v)}`
              if (f.kind === 'like') return `${f.col} like ${p(f.v)}`
              return `${f.col}::text = any(${p(f.v)}::text[])`
            })
            .join(' and ')}`
        : ''
      const ret = /^[a-z_,*\s]+$/.test(cols) ? cols : '*'
      // Without .select() PostgREST sends return=minimal: no RETURNING, so no SELECT policy is evaluated for the written rows.
      const wrap = (inner: string) => (wantReturn ? `with x as (${inner} returning ${ret}) select row_to_json(x) as r from x` : `with x as (${inner}) select null::json as r where false`)
      if (op === 'select') return { sql: `select row_to_json(t) as r from (select ${ret} from public.${table}${where}${lim !== null ? ` limit ${lim}` : ''}) t`, params }
      if (op === 'insert' || op === 'upsert') {
        const keys = Object.keys(values)
        if (!keys.every((k) => ident.test(k))) throw new Error('bad column')
        return { sql: wrap(`insert into public.${table} (${keys.join(',')}) values (${keys.map((k) => p(values[k])).join(',')})${ignore ? ' on conflict (id) do nothing' : ''}`), params }
      }
      if (op === 'update') {
        const keys = Object.keys(values)
        if (!keys.every((k) => ident.test(k))) throw new Error('bad column')
        return { sql: wrap(`update public.${table} set ${keys.map((k) => `${k} = ${p(values[k])}`).join(', ')}${where}`), params }
      }
      return { sql: wrap(`delete from public.${table}${where}`), params }
    }

    const finish = async (): Promise<Res> => {
      let q
      try {
        q = build()
      } catch (e) {
        return { data: null, error: { code: 'PGRST100', message: (e as Error).message }, status: 400 }
      }
      const res = await exec(q.sql, q.params)
      if (res.error) return res
      const rows = res.data as unknown[]
      if (single) {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'expected one row' }, status: 406 }
        return { data: rows[0], error: null, status: 200 }
      }
      return { data: (op === 'select' || wantReturn) ? rows : null, error: null, status: 200 }
    }
    let wantReturn = false

    const q = {
      select(c = '*') {
        cols = c.replace(/\s/g, '')
        if (op !== 'select') wantReturn = true
        return q
      },
      insert(row: Record<string, unknown>) {
        op = 'insert'
        values = row
        return q
      },
      upsert(row: Record<string, unknown>, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
        op = 'upsert'
        values = row
        ignore = !!o.ignoreDuplicates && (o.onConflict ?? 'id') === 'id'
        return q
      },
      update(patch: Record<string, unknown>) {
        op = 'update'
        values = patch
        return q
      },
      delete() {
        op = 'delete'
        return q
      },
      eq(col: string, v: unknown) {
        filters.push({ col, kind: 'eq', v })
        return q
      },
      like(col: string, v: unknown) {
        filters.push({ col, kind: 'like', v })
        return q
      },
      in(col: string, v: unknown[]) {
        filters.push({ col, kind: 'in', v })
        return q
      },
      limit(n: number) {
        lim = n
        return q
      },
      order() {
        return q
      },
      single() {
        single = true
        return q
      },
      then<T>(resolve: (r: Res) => T, reject?: (e: unknown) => T) {
        return finish().then(resolve, reject)
      },
    }
    return q
  }

  return { from, auth: { signOut: async () => ({ error: null }) } }
}

export type TestClient = ReturnType<typeof makeClient>

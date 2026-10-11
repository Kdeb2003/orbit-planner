// Offline test of the hosted Courses verification (scripts/hostedCoursesCore.mjs). The REAL check logic runs against the REAL
// courses migration in PGlite (simulated Supabase roles/auth), through a small supabase-js look-alike (pgliteSupabase.ts).
// It proves that the checks pass on the reviewed schema and FAIL when the schema is weakened, a write fails, cleanup fails,
// a record is left behind or the run crashes. It does NOT verify the hosted project: PostgREST, JWT handling and the hosted
// database version are not simulated, and nothing here contacts a hosted service.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED, runCoursesCheck, safeCode } from '../../scripts/hostedCoursesCore.mjs'
import { makeClient, newWorld } from './pgliteSupabase'
import type { Res, TestClient, World } from './pgliteSupabase'

// Each test builds a fresh in-memory PostgreSQL and runs ~60 statements through it: slow on a loaded machine, so only THIS file gets a long timeout.
vi.setConfig({ testTimeout: 60_000 })

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const migrationsDir = join(__dirname, '..', 'migrations')
const files = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()

const opened: PGlite[] = []
afterEach(async () => {
  while (opened.length) await opened.pop()!.close()
})

async function freshWorld(mutate?: string): Promise<World> {
  const db = new PGlite()
  opened.push(db)
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    insert into auth.users values ('${ALICE}'), ('${BOB}');
  `)
  for (const f of files) await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  await db.exec(`set timezone = 'UTC'`)
  if (mutate) await db.exec(mutate) // a deliberately WEAKENED schema, to prove the checks notice
  return newWorld(db)
}

const sessions = (w: World) => ({
  A: { c: makeClient(w, 'authenticated', ALICE), id: ALICE },
  B: { c: makeClient(w, 'authenticated', BOB), id: BOB },
  anon: makeClient(w, 'anon', null),
})
interface Out {
  exit: number
  results: { id: string; ok: boolean }[]
  crashed: boolean
  lines: string[]
}
async function run(w: World, tweak?: (s: ReturnType<typeof sessions>) => ReturnType<typeof sessions>): Promise<Out> {
  const lines: string[] = []
  const s = tweak ? tweak(sessions(w)) : sessions(w)
  const r = await runCoursesCheck({ ...s, run: 'ab12cd34', log: (l: string) => lines.push(l) })
  return { ...r, lines }
}
const failedIds = (o: Out) => o.results.filter((r) => !r.ok).map((r) => r.id)
const courseRows = async (w: World) => (await w.db.query<{ n: number }>(`select count(*)::int as n from public.courses`)).rows[0].n

describe('hosted Courses check on the reviewed migration (PGlite)', () => {
  it('passes every required check, records each exactly once and leaves nothing behind', async () => {
    const w = await freshWorld()
    const o = await run(w)
    expect(failedIds(o)).toEqual([])
    expect(o.exit).toBe(0)
    expect(o.crashed).toBe(false)
    const ids = o.results.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...REQUIRED].sort()) // REQUIRED is exactly what a complete run records
    expect(await courseRows(w)).toBe(0) // cleanup verified from outside the script too
  })

  it('does not touch the calendar or provenance tables', async () => {
    const w = await freshWorld()
    await run(w)
    const touched = new Set(w.log.map((l) => /(?:from|into|update)\s+public\.(\w+)/i.exec(l.sql)?.[1]).filter(Boolean))
    expect([...touched]).toEqual(['courses'])
  })

  it('the checks use B and anonymous sessions only through the authenticated/anon roles (never a privileged one)', async () => {
    const w = await freshWorld()
    await run(w)
    expect(new Set(w.log.map((l) => l.role.split(':')[0]))).toEqual(new Set(['authenticated', 'anon']))
  })
})

describe('weakened schemas make the run FAIL (the checks are not vacuous)', () => {
  const cases: [string, string, string[]][] = [
    ['B may read every course (select policy open)', `drop policy courses_select_own on public.courses; create policy courses_select_own on public.courses for select to authenticated using (true);`, ['b-cannot-read-by-id', 'b-cannot-list', 'a-cannot-see-b']],
    ['B may update every course (select and update policies open: UPDATE also needs SELECT)', `drop policy courses_select_own on public.courses; create policy courses_select_own on public.courses for select to authenticated using (true); drop policy courses_update_own on public.courses; create policy courses_update_own on public.courses for update to authenticated using (true) with check (true);`, ['a-unchanged-after-b']],
    ['B may delete every course (select and delete policies open)', `drop policy courses_select_own on public.courses; create policy courses_select_own on public.courses for select to authenticated using (true); drop policy courses_delete_own on public.courses; create policy courses_delete_own on public.courses for delete to authenticated using (true);`, ['a-unchanged-after-b']],
    ['B may insert rows for A (insert policy and user_id grant open)', `drop policy courses_insert_own on public.courses; create policy courses_insert_own on public.courses for insert to authenticated with check (true); grant insert (user_id) on public.courses to authenticated;`, ['b-cannot-insert-as-a', 'a-cannot-set-user-id']],
    ['anonymous may read and write (grants and policies open)', `grant select, insert, update, delete on public.courses to anon; create policy anon_all on public.courses for all to anon using (true) with check (true);`, ['anon-cannot-read']],
    ['ownership can be reassigned (protection trigger gone, user_id grant open)', `drop trigger courses_protect on public.courses; grant update (user_id, created_at, updated_at) on public.courses to authenticated;`, ['immutable-user-id', 'immutable-created-at', 'immutable-updated-at']],
    ['the term-length rule is missing', `alter table public.courses drop constraint courses_term_max_span;`, ['invalid-long-term']],
    ['the name length rule is missing', `alter table public.courses drop constraint courses_name_check;`, ['invalid-long-name', 'invalid-blank-name']],
    ['the unique key is missing', `drop index public.courses_user_code_institution_term_key;`, ['unique-duplicate-rejected', 'unique-variant-rejected', 'unique-update-rejected']],
    ['the key function does not normalise', `create or replace function orbit_private.orbit_normalise_key(t text) returns text language sql immutable set search_path = '' as $$ select t $$;`, ['a-generated-keys']],
  ]
  for (const [name, sql, expected] of cases) {
    it(`${name}: FAIL (exit 1) and cleanup still verifies`, async () => {
      const w = await freshWorld(sql)
      const o = await run(w)
      expect(o.exit).toBe(1)
      for (const id of expected) expect(failedIds(o), id).toContain(id)
      expect(await courseRows(w)).toBe(0) // even a weakened schema is cleaned up (the sweep runs in each owner's space)
    })
  }
})

describe('operational failures', () => {
  it('a missing courses table FAILS, makes no write and reports it', async () => {
    const w = await freshWorld(`drop table public.courses;`)
    const o = await run(w)
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toEqual(['courses-table-exists'])
    expect(w.log.some((l) => /insert|update|delete/i.test(l.sql))).toBe(false)
  })

  it('missing table privileges (grants removed) FAIL', async () => {
    const w = await freshWorld(`revoke all on public.courses from authenticated;`)
    const o = await run(w)
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toContain('a-create')
  })

  it.each([1, 16])('a partial write failure (insert number %i) FAILS the run, and what was created is still cleaned up', async (failAt) => {
    const w = await freshWorld()
    const o = await run(w, (s) => {
      let inserts = 0
      const real = s.A.c.from
      s.A.c = { ...s.A.c, from: (t: string) => {
        const q = real(t)
        const ins = q.insert.bind(q)
        q.insert = (row: Record<string, unknown>) => {
          inserts++
          return inserts === failAt ? (failing() as never) : ins(row)
        }
        return q
      } } as TestClient
      return s
    })
    expect(o.exit).toBe(1)
    expect(failedIds(o).length).toBeGreaterThan(0)
    expect(await courseRows(w)).toBe(0)
  })

  it('a cleanup that errors FAILS the run', async () => {
    const w = await freshWorld()
    const o = await run(w, (s) => {
      const real = s.A.c.from
      s.A.c = { ...s.A.c, from: (t: string) => {
        const q = real(t)
        q.delete = () => failing('42501') as never
        return q
      } } as TestClient
      return s
    })
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toContain('cleanup-A')
    expect(failedIds(o)).not.toContain('cleanup-B') // each account is cleaned up independently
  })

  it('a record that silently cannot be removed is reported as a leftover and FAILS', async () => {
    const w = await freshWorld()
    const o = await run(w, (s) => {
      const real = s.B.c.from
      s.B.c = { ...s.B.c, from: (t: string) => {
        const q = real(t)
        q.delete = () => silentOk() as never // reports success, deletes nothing
        return q
      } } as TestClient
      return s
    })
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toContain('cleanup-B')
    expect(failedIds(o)).toContain('cleanup-independent')
    expect(o.lines.join('\n')).toMatch(/run-created record\(s\) remain/)
    expect(await courseRows(w)).toBeGreaterThan(0) // the leftover really exists, and the run said so
  })

  it('a client that throws mid-run: crash is reported, cleanup still runs, the missing checks FAIL, no detail is printed', async () => {
    const w = await freshWorld()
    let n = 0
    const o = await run(w, (s) => {
      const real = s.B.c.from
      s.B.c = { ...s.B.c, from: (t: string) => {
        if (++n === 3) throw new Error('boom SECRET-TOKEN-123')
        return real(t)
      } } as TestClient
      return s
    })
    expect(o.crashed).toBe(true)
    expect(o.exit).toBe(1)
    expect(o.lines.join('\n')).not.toContain('SECRET-TOKEN-123')
    expect(failedIds(o)).toContain('b-create-own') // required, never reached: not a silent skip
    expect(failedIds(o).some((id) => id.startsWith('anon-'))).toBe(true)
    expect(await courseRows(w)).toBe(0) // cleanup ran after the crash
  })

  it('server error text never reaches the output (codes only)', async () => {
    const w = await freshWorld()
    const o = await run(w, (s) => {
      const real = s.A.c.from
      s.A.c = { ...s.A.c, from: (t: string) => {
        const q = real(t)
        const ins = q.insert.bind(q)
        q.insert = (row: Record<string, unknown>) => (row.name === 'x' ? (failing('XX000', 'LEAK-ME password=hunter2') as never) : ins(row))
        return q
      } } as TestClient
      return s
    })
    expect(o.lines.join('\n')).not.toMatch(/LEAK-ME|hunter2/)
  })

  it('an unreadable verification FAILS cleanup (nothing is assumed)', async () => {
    const w = await freshWorld()
    const o = await run(w, (s) => {
      const real = s.A.c.from
      let after = false
      s.A.c = { ...s.A.c, from: (t: string) => {
        const q = real(t)
        const del = q.delete.bind(q)
        q.delete = () => {
          after = true
          return del()
        }
        const sel = q.select.bind(q)
        q.select = (c?: string) => (after ? (failing('PGRST000') as never) : sel(c))
        return q
      } } as TestClient
      return s
    })
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toContain('cleanup-A')
  })
})

describe('confidential text never reaches the output', () => {
  const SECRETS = /hunter2|SECRET|LEAK|sk_live|eyJ|https?:\/\//i
  const quiet = (o: Out) => expect(o.lines.join('\n')).not.toMatch(SECRETS)
  const wrapA = (w: World, patch: (q: ReturnType<TestClient['from']>) => void) =>
    run(w, (s) => {
      const real = s.A.c.from
      s.A.c = { ...s.A.c, from: (t: string) => {
        const q = real(t)
        patch(q)
        return q
      } } as TestClient
      return s
    })

  it('an error without a code and with a password in its message prints only a generic identifier', async () => {
    const w = await freshWorld()
    const o = await wrapA(w, (q) => {
      const ins = q.insert.bind(q)
      q.insert = (row: Record<string, unknown>) => (String(row.name).endsWith('_main') ? (raw({ message: 'LEAK password=hunter2', details: 'SECRET detail', hint: 'SECRET hint' }) as never) : ins(row))
    })
    expect(o.exit).toBe(1)
    quiet(o)
    expect(o.lines.join('\n')).toMatch(/E_UNKNOWN/)
  })

  it('a malformed or secret-looking code is never printed', async () => {
    const w = await freshWorld()
    const o = await wrapA(w, (q) => {
      const ins = q.insert.bind(q)
      q.insert = (row: Record<string, unknown>) => (String(row.name).endsWith('_main') ? (raw({ code: 'sk_live_SECRET123', message: 'LEAK' }) as never) : ins(row))
    })
    quiet(o)
    expect(o.lines.join('\n')).toMatch(/E_UNKNOWN/)
    expect(safeCode({ code: '42501' })).toBe('42501')
    expect(safeCode({ code: 'PGRST205' })).toBe('PGRST205')
    for (const bad of [{ message: 'hunter2' }, { code: 'sk_live_SECRET123' }, { code: 'a'.repeat(200) }, { code: 42501 }, { code: 'eyJhbGciOi' }, null, undefined, 'hunter2']) expect(safeCode(bad)).toBe('E_UNKNOWN')
  })

  it('a thrown object whose name looks like a secret is not reported by cleanup', async () => {
    const w = await freshWorld()
    const o = await wrapA(w, (q) => {
      q.delete = () => {
        const e = new Error('LEAK message')
        e.name = 'SECRET-NAME-hunter2'
        throw e
      }
    })
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toContain('cleanup-A')
    quiet(o)
    expect(o.lines.join('\n')).toMatch(/threw an exception/)
  })

  it('a failed cleanup without an error code prints only a generic identifier', async () => {
    const w = await freshWorld()
    const o = await wrapA(w, (q) => {
      q.delete = () => raw({ message: 'LEAK password=hunter2' }) as never
    })
    expect(failedIds(o)).toContain('cleanup-A')
    quiet(o)
    expect(o.lines.join('\n')).toMatch(/delete course [0-9a-f-]{36}: E_UNKNOWN/)
  })
})

describe('an anonymous insert that is not rejected', () => {
  const weakened = `grant insert on public.courses to anon; grant usage on schema orbit_private to anon; grant execute on function orbit_private.orbit_normalise_key(text) to anon; create policy anon_ins on public.courses for insert to anon with check (true); alter table public.courses alter column user_id drop not null;`

  it('FAILS, reports the unresolved row by id, and never runs an unscoped delete', async () => {
    const w = await freshWorld(weakened)
    const o = await run(w)
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toEqual(expect.arrayContaining(['anon-cannot-insert', 'cleanup-anon-insert']))
    expect(o.lines.join('\n')).toMatch(/owner unknown.*remove id [0-9a-f-]{36} manually/)
    expect(await courseRows(w)).toBe(1) // the ownerless row really exists, and the run did not pretend otherwise
    const deletes = w.log.filter((l) => /^\s*with x as \(delete/i.test(l.sql))
    expect(deletes.length).toBeGreaterThan(0)
    for (const d of deletes) expect(d.sql).toMatch(/ where /)
  })

  it('when the unexpectedly created row is visible to an account it is removed by id, but the run still FAILS', async () => {
    const w = await freshWorld(`${weakened} alter table public.courses alter column user_id set default '${ALICE}';`)
    const o = await run(w)
    expect(o.exit).toBe(1)
    expect(failedIds(o)).toContain('anon-cannot-insert')
    expect(failedIds(o)).toContain('cleanup-anon-insert')
    expect(await courseRows(w)).toBe(0) // A's own-space cleanup (by tracked id) removed it
  })

  it('a properly configured table rejects it: no unresolved check is recorded', async () => {
    const o = await run(await freshWorld())
    expect(o.results.map((r) => r.id)).not.toContain('cleanup-anon-insert')
  })
})

// --- tiny fake results ------------------------------------------------------------------------------------------------
function thenable(res: Res) {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'like', 'in', 'limit', 'order', 'single']) q[m] = () => q
  q.then = (resolve: (r: Res) => unknown) => Promise.resolve(res).then(resolve)
  return q
}
const failing = (code = '42501', message = 'denied') => thenable({ data: null, error: { code, message }, status: 400 })
const raw = (error: Record<string, unknown>) => thenable({ data: null, error, status: 400 } as unknown as Res)
const silentOk = () => thenable({ data: [], error: null, status: 200 })

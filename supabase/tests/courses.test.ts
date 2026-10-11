// Offline verification of the courses migration (supabase/migrations/20261020120000_courses.sql) and its rollback.
// Runs the REAL SQL in an in-memory PostgreSQL (PGlite) with a simulated Supabase `auth` schema and roles
// (same simulation as migrations.test.ts). NOTHING here touches a hosted project.
//
// Limitations: PGlite is PostgreSQL 18 and `auth.uid()` is our shim; PostgREST/JWT handling is not simulated.
// The same SQL was also run inside a rolled-back transaction on the local Supabase stack (PostgreSQL 17); see docs.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import vectors from '../../src/planner/__fixtures__/normalisation-vectors.json'
import { normaliseKey } from '../../src/planner/normalise'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const C1 = 'c0c0c0c0-0000-4000-8000-000000000001'
const C2 = 'c0c0c0c0-0000-4000-8000-000000000002'
const migrationsDir = join(__dirname, '..', 'migrations')
const COURSES_FILE = '20261020120000_courses.sql'
const MIGRATION = readFileSync(join(migrationsDir, COURSES_FILE), 'utf8')
const ROLLBACK = readFileSync(join(__dirname, '..', 'recovery', '20261020120000_courses.rollback.sql'), 'utf8')
const otherFiles = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql') && n !== COURSES_FILE).sort()

/** A fresh simulated Supabase database; `withCourses` applies the courses migration last. */
async function newDb(withCourses = true): Promise<PGlite> {
  const d = new PGlite()
  await d.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Supabase grants broad default privileges on new public objects; the migration's explicit REVOKE/GRANT is under test.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    insert into auth.users values ('${ALICE}'), ('${BOB}');
  `)
  for (const f of otherFiles) await d.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  if (withCourses) await d.exec(MIGRATION)
  return d
}

let db: PGlite

async function as<T>(user: string | null, fn: () => Promise<T>, d: PGlite = db): Promise<T> {
  await d.exec(`set role ${user === null ? 'anon' : 'authenticated'}`)
  await d.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ''])
  try {
    return await fn()
  } finally {
    await d.exec('reset role')
    await d.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

async function err(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p
    return null
  } catch (e) {
    const x = e as { code?: string; message?: string }
    return { code: x.code ?? 'unknown', message: x.message ?? '' }
  }
}
const code = async (p: Promise<unknown>) => (await err(p))?.code ?? null

/** INSERT as the signed-in user (user_id from the server default); values are raw SQL literals. */
const add = (cols: Record<string, string>) =>
  `insert into public.courses (${Object.keys(cols).join(', ')}) values (${Object.values(cols).join(', ')})`
const asAlice = <T>(fn: () => Promise<T>) => as(ALICE, fn)
const count = async (d: PGlite = db, where = 'true') =>
  Number((await d.query<{ n: number }>(`select count(*)::int as n from public.courses where ${where}`)).rows[0].n)

beforeAll(async () => {
  db = await newDb()
})
afterAll(async () => {
  await db.close()
})

describe('courses migration: structure and access control', () => {
  it('applies after every existing migration; RLS on; exactly four owner-only policies for authenticated', async () => {
    const t = await db.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = 'public.courses'::regclass`)
    expect(t.rows[0].relrowsecurity).toBe(true)
    const p = await db.query<{ cmd: string; roles: string; qual: string | null; with_check: string | null }>(
      `select cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'courses'`,
    )
    expect(p.rows.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    expect(p.rows.every((r) => r.roles === '{authenticated}')).toBe(true)
    for (const r of p.rows) expect(`${r.qual ?? ''}${r.with_check ?? ''}`).toContain('auth.uid()')
  })

  it('anon and PUBLIC have no privileges at all; authenticated has no ALL / TRUNCATE / REFERENCES / TRIGGER', async () => {
    const g = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'courses'`,
    )
    expect(g.rows.filter((r) => r.grantee === 'anon' || r.grantee === 'PUBLIC')).toEqual([])
    expect(g.rows.filter((r) => r.grantee === 'authenticated').map((r) => r.privilege_type).sort()).toEqual(['DELETE', 'SELECT'])
    for (const col of ['id', 'user_id', 'name', 'code', 'code_key', 'created_at', 'updated_at']) {
      const r = await db.query<{ a: boolean; c: boolean }>(
        `select has_column_privilege('anon', 'public.courses', '${col}', 'select') as a, has_column_privilege('anon', 'public.courses', '${col}', 'insert') as c`,
      )
      expect(r.rows[0], col).toEqual({ a: false, c: false })
    }
  })

  it('authenticated may insert/update only the intended columns (never user_id, timestamps, keys)', async () => {
    const q = async (col: string, op: string) =>
      (await db.query<{ ok: boolean }>(`select has_column_privilege('authenticated', 'public.courses', '${col}', '${op}') as ok`)).rows[0].ok
    for (const col of ['name', 'code', 'institution', 'term_label', 'term_start', 'term_end', 'description', 'color', 'archived_at']) {
      expect(await q(col, 'insert'), `insert ${col}`).toBe(true)
      expect(await q(col, 'update'), `update ${col}`).toBe(true)
    }
    expect(await q('id', 'insert')).toBe(true) // idempotent create with a client UUID
    for (const col of ['id', 'user_id', 'created_at', 'updated_at', 'code_key', 'institution_key', 'term_key']) {
      expect(await q(col, 'update'), `update ${col}`).toBe(false)
    }
    for (const col of ['user_id', 'created_at', 'updated_at', 'code_key', 'institution_key', 'term_key']) {
      expect(await q(col, 'insert'), `insert ${col}`).toBe(false)
    }
  })

  it('no SECURITY DEFINER function anywhere; helpers are not callable as RPC and not by anon', async () => {
    const sd = await db.query<{ n: number }>(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','orbit_private') and p.prosecdef`)
    expect(sd.rows[0].n).toBe(0)
    expect(MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase()).not.toContain('security definer')
    const inPublic = await db.query(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (proname like '%normalise%' or proname like '%protect_owned%')`)
    expect(inPublic.rows).toEqual([])
    for (const f of ['orbit_private.orbit_normalise_key(text)', 'orbit_private.orbit_protect_owned_row()']) {
      for (const role of ['public', 'anon']) {
        expect((await db.query<{ ok: boolean }>(`select has_function_privilege('${role}', '${f}', 'execute') as ok`)).rows[0].ok, `${role} ${f}`).toBe(false)
      }
    }
    expect((await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', 'orbit_private.orbit_protect_owned_row()', 'execute') as ok`)).rows[0].ok).toBe(false)
    expect((await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', 'orbit_private.orbit_normalise_key(text)', 'execute') as ok`)).rows[0].ok).toBe(true)
    expect(await as(null, () => code(db.query(`select orbit_private.orbit_normalise_key('x')`)))).toBe('42501')
  })

  it('the generic protect function is not tied to table names', async () => {
    const src = (await db.query<{ s: string }>(`select prosrc as s from pg_proc where proname = 'orbit_protect_owned_row'`)).rows[0].s
    expect(src).not.toMatch(/tg_table_name/)
  })

  it('the existing calendar and provenance schema is byte-for-byte unchanged by the migration', async () => {
    const fingerprint = async (d: PGlite) => {
      const tables = `('events','recurring_series','series_exceptions','event_imports','event_import_links')`
      const q = async (sql: string) => (await d.query(sql)).rows
      return {
        columns: await q(`select table_name, column_name, data_type, is_nullable, column_default, generation_expression from information_schema.columns where table_schema = 'public' and table_name in ${tables} order by 1, 2`),
        constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in ('events','recurring_series','series_exceptions','event_imports','event_import_links') order by 1, 2`),
        indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ${tables} order by 1, 2`),
        policies: await q(`select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename in ${tables} order by 1, 2`),
        grants: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ${tables} order by 1, 2, 3`),
        colGrants: await q(`select table_name, column_name, grantee, privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name in ${tables} and grantee in ('anon','authenticated','PUBLIC') order by 1, 2, 3, 4`),
        triggers: await q(`select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal and tgrelid::regclass::text in ${tables} order by 1, 2`),
        functions: await q(`select n.nspname, p.proname, md5(p.prosrc) as h, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','orbit_private') and p.proname not in ('orbit_normalise_key','orbit_protect_owned_row') order by 1, 2`),
        rls: await q(`select relname, relrowsecurity from pg_class where relname in ${tables} order by 1`),
      }
    }
    const without = await newDb(false)
    expect(await fingerprint(db)).toEqual(await fingerprint(without))
    await without.close()
  })
})

describe('normalisation rule N: SQL equals the golden vectors and the TypeScript twin', () => {
  const sql = async (v: string | null) =>
    (await db.query<{ k: string | null }>(`select orbit_private.orbit_normalise_key($1) as k`, [v])).rows[0].k

  it('has vectors to run', () => expect(vectors.vectors.length).toBeGreaterThanOrEqual(10))

  for (const v of vectors.vectors) {
    it(`function: ${v.name}`, async () => {
      expect(await sql(v.input)).toBe(v.key)
      expect(normaliseKey(v.input)).toBe(v.key)
    })
  }

  it('NULL stays NULL', async () => expect(await sql(null)).toBeNull())

  it('the generated key columns (code_key, institution_key, term_key) use the same rule', async () => {
    for (const v of vectors.vectors) {
      if (v.key === '') continue
      const id = C2
      await asAlice(() =>
        db.query(`insert into public.courses (id, name, code, institution, term_label) values ($1, 'V', $2, $2, $2)`, [id, v.input]),
      )
      const r = await db.query<{ code_key: string; institution_key: string; term_key: string; code: string }>(`select code, code_key, institution_key, term_key from public.courses where id = $1`, [id])
      expect(r.rows[0].code, v.name).toBe(v.input) // the original text is stored unchanged
      expect(r.rows[0].code_key, v.name).toBe(v.key)
      expect(r.rows[0].institution_key, v.name).toBe(v.key)
      expect(r.rows[0].term_key, v.name).toBe(v.key)
      await db.exec(`delete from public.courses where id = '${C2}'`)
    }
  })

  it('blank institution / term label / missing values give the empty key; no code gives a NULL code_key', async () => {
    await asAlice(() => db.query(`insert into public.courses (id, name, institution, term_label) values ($1, 'B', ' \u00a0\t', null)`, [C1]))
    const r = await db.query<{ code_key: string | null; institution_key: string; term_key: string }>(`select code_key, institution_key, term_key from public.courses where id = $1`, [C1])
    expect(r.rows[0]).toEqual({ code_key: null, institution_key: '', term_key: '' })
    await db.exec(`delete from public.courses where id = '${C1}'`)
  })

  it('extra edge strings agree between SQL and TypeScript', async () => {
    const extra = ['a\u0085b', '​x', '  y', 'İstanbul', 'é x', '😀  a', 'a\u00a0\u00a0b', '\u00a0', 'ǅungla', 'x y', 'ABC def', 'ñandú  1', '\v\f x \f\v', 'a\u0000b'.replace('\u0000', '')]
    for (const s of extra) expect(await sql(s), JSON.stringify(s)).toBe(normaliseKey(s))
  })
})

describe('courses: create, read, edit, archive, delete as the owner', () => {
  it('full lifecycle with server-maintained identity and timestamps', async () => {
    await asAlice(() =>
      db.query(`insert into public.courses (id, name, code, institution, term_label, term_start, term_end, description, color) values ($1, 'Algorithms', 'inf 101', 'Uni A', 'WS 26/27', '2026-10-01', '2027-02-28', 'notes', 'c3')`, [C1]),
    )
    const a = (await asAlice(() => db.query<Record<string, unknown>>(`select * from public.courses where id = $1`, [C1]))).rows[0]
    expect(a.user_id).toBe(ALICE) // server default, never supplied
    expect(a.code_key).toBe('INF 101')
    expect(a.archived_at).toBeNull()
    expect(a.color).toBe('c3')

    await asAlice(() => db.query(`update public.courses set name = 'Algorithms II', description = null where id = $1`, [C1]))
    const b = (await asAlice(() => db.query<Record<string, unknown>>(`select * from public.courses where id = $1`, [C1]))).rows[0]
    expect(b.name).toBe('Algorithms II')
    expect(b.created_at).toEqual(a.created_at)
    expect((b.updated_at as Date).getTime()).toBeGreaterThan((a.updated_at as Date).getTime())

    await asAlice(() => db.query(`update public.courses set archived_at = now() where id = $1`, [C1])) // archive: nothing deleted
    expect((await asAlice(() => db.query(`select 1 from public.courses where id = $1 and archived_at is not null`, [C1]))).rows).toHaveLength(1)
    await asAlice(() => db.query(`update public.courses set archived_at = null where id = $1`, [C1])) // restore

    expect(await asAlice(() => code(db.query(`delete from public.courses where id = $1`, [C1])))).toBeNull()
    expect(await count(db, `id = '${C1}'`)).toBe(0)
  })

  it('create with a client-supplied id is idempotent-safe: the same id twice is a primary-key error', async () => {
    await asAlice(() => db.query(`insert into public.courses (id, name) values ($1, 'One')`, [C1]))
    expect(await asAlice(() => code(db.query(`insert into public.courses (id, name) values ($1, 'One')`, [C1])))).toBe('23505')
    await asAlice(() => db.query(`insert into public.courses (id, name) values ($1, 'One') on conflict (id) do nothing`, [C1]))
    expect(await count(db, `id = '${C1}'`)).toBe(1)
    await db.exec(`delete from public.courses`)
  })
})

describe('courses: constraints', () => {
  const ok = (cols: Record<string, string>) => asAlice(() => code(db.exec(add({ name: `'N'`, ...cols }))))
  const reset = () => db.exec(`delete from public.courses`)

  it('name: required, 1–120 after trimming', async () => {
    expect(await ok({ name: `''` })).toBe('23514')
    expect(await ok({ name: `'   '` })).toBe('23514')
    expect(await ok({ name: `null` })).toBe('23502')
    expect(await ok({ name: `'${'x'.repeat(121)}'` })).toBe('23514')
    expect(await ok({ name: `'${'x'.repeat(120)}'` })).toBeNull()
    await reset()
  })

  it('name cannot be whitespace only: tab, NBSP, U+2003 and mixtures are rejected on INSERT and UPDATE (matches JavaScript trim())', async () => {
    const blanks = [`E'\t'`, `E'\n\r'`, `E'\u00a0'`, `E'\u2003'`, `E' \t\u00a0\u2003 '`, `E'\u3000'`, `E'\ufeff'`, `E'\u1680\u2028\u2029\u202f\u205f'`]
    for (const b of blanks) expect(await ok({ name: b }), `insert ${b}`).toBe('23514')
    await asAlice(() => db.exec(add({ id: `'${C1}'`, name: `'Real'` })))
    for (const b of blanks) {
      expect(await asAlice(() => code(db.exec(`update public.courses set name = ${b} where id = '${C1}'`))), `update ${b}`).toBe('23514')
    }
    expect((await db.query<{ name: string }>(`select name from public.courses where id = '${C1}'`)).rows[0].name).toBe('Real')
    // every JavaScript trim() whitespace character agrees with the database
    for (const cp of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
      expect(String.fromCodePoint(cp).trim(), cp.toString(16)).toBe('')
      expect(await asAlice(() => code(db.query(`update public.courses set name = $1 where id = '${C1}'`, [String.fromCodePoint(cp).repeat(3)]))), cp.toString(16)).toBe('23514')
    }
    await reset()
  })

  it('legitimate names stay valid: letters, internal whitespace, surrounding whitespace, non-ASCII, 120 characters', async () => {
    for (const n of [`'Algorithms'`, `'Mathe  für   Informatiker'`, `E'  Lin Alg\u00a0I  '`, `'ß'`, `'日本語'`, `'.'`, `E'a\u2003'`]) expect(await ok({ name: n }), n).toBeNull()
    expect(await ok({ name: `'${'é'.repeat(120)}'` })).toBeNull()
    expect(await ok({ name: `'${'é'.repeat(121)}'` })).toBe('23514')
    expect(await ok({ name: `'  ${'x'.repeat(120)}  '` })).toBeNull() // the limit applies to the trimmed text, as in the client
    await reset()
  })

  it('code ≤ 30 and never blank; institution ≤ 120; term label ≤ 40; description ≤ 2000', async () => {
    expect(await ok({ code: `'${'x'.repeat(31)}'` })).toBe('23514')
    expect(await ok({ code: `'${'x'.repeat(30)}'` })).toBeNull()
    for (const blank of [`''`, `'   '`, `E'\\t\\n'`, `E' \\u00a0 '`]) expect(await ok({ code: blank }), blank).toBe('23514') // blank code = no code = must be NULL
    expect(await ok({ institution: `'${'x'.repeat(121)}'` })).toBe('23514')
    expect(await ok({ term_label: `'${'x'.repeat(41)}'` })).toBe('23514')
    expect(await ok({ description: `'${'x'.repeat(2001)}'` })).toBe('23514')
    expect(await ok({ institution: `'${'x'.repeat(120)}'`, term_label: `'${'x'.repeat(40)}'`, description: `'${'x'.repeat(2000)}'` })).toBeNull()
    await reset()
  })

  it('colour is one of c1…c8', async () => {
    for (const bad of [`'c0'`, `'c9'`, `'#ff0000'`, `'red'`, `''`, `'C1'`]) expect(await ok({ color: bad }), bad).toBe('23514')
    expect(await ok({ color: 'null' })).toBe('23502')
    for (let n = 1; n <= 8; n++) expect(await ok({ color: `'c${n}'` }), `c${n}`).toBeNull()
    await reset()
  })

  it('term dates: both or neither, ordered, real dates, span ≤ 400 days', async () => {
    expect(await ok({ term_start: `'2026-10-01'` })).toBe('23514')
    expect(await ok({ term_end: `'2026-10-01'` })).toBe('23514')
    expect(await ok({ term_start: `'2026-10-02'`, term_end: `'2026-10-01'` })).toBe('23514')
    expect(await ok({ term_start: `'2026-02-30'`, term_end: `'2026-03-30'` })).toBe('22008')
    expect(await ok({ term_start: `'2026-10-01'`, term_end: `'2026-10-01'` })).toBeNull() // one day is fine
    expect(await ok({ term_start: `'2026-01-01'`, term_end: `'2027-02-05'` })).toBeNull() // exactly 400 days
    expect(await ok({ term_start: `'2026-01-01'`, term_end: `'2027-02-06'` })).toBe('23514') // 401 days
    expect(await ok({})).toBeNull() // no term at all
    await reset()
  })

  it('updates are checked too (term pairing, span, blank code, colour)', async () => {
    await asAlice(() => db.exec(add({ id: `'${C1}'`, name: `'U'`, code: `'X'`, term_start: `'2026-10-01'`, term_end: `'2027-02-28'` })))
    const upd = (set: string) => asAlice(() => code(db.exec(`update public.courses set ${set} where id = '${C1}'`)))
    expect(await upd(`term_end = null`)).toBe('23514')
    expect(await upd(`term_end = '2026-09-30'`)).toBe('23514')
    expect(await upd(`term_end = '2027-12-31'`)).toBe('23514')
    expect(await upd(`code = '  '`)).toBe('23514')
    expect(await upd(`color = 'c9'`)).toBe('23514')
    expect(await upd(`term_start = null, term_end = null`)).toBeNull()
    expect(await upd(`code = null`)).toBeNull() // a course may lose its code
    await reset()
  })
})

describe('courses: uniqueness on the normalised key', () => {
  const ins = (user: string, cols: Record<string, string>) => as(user, () => code(db.exec(add({ name: `'N'`, ...cols }))))
  const reset = () => db.exec(`delete from public.courses`)

  it('the same normalised (code, institution, term label) cannot exist twice, however it is typed', async () => {
    expect(await ins(ALICE, { code: `'inf 101'`, institution: `'Uni P'`, term_label: `'WS 26'` })).toBeNull()
    expect(await ins(ALICE, { code: `' INF  101 '`, institution: `'uni  p'`, term_label: `'ws 26'` })).toBe('23505')
    expect(await ins(ALICE, { code: `E'INF\\u00a0101'`, institution: `E'UNI\\tP'`, term_label: `'WS 26'` })).toBe('23505')
    await reset()
  })

  it('absent and blank institution / term label are the same key (no code-twins through NULL vs empty)', async () => {
    expect(await ins(ALICE, { code: `'X'` })).toBeNull()
    expect(await ins(ALICE, { code: `'x'`, institution: `'  '` })).toBe('23505')
    expect(await ins(ALICE, { code: `'x'`, term_label: `E'\\u00a0'` })).toBe('23505')
    await reset()
  })

  it('same code is allowed with a different institution or a different term label', async () => {
    expect(await ins(ALICE, { code: `'X'`, institution: `'P'`, term_label: `'WS'` })).toBeNull()
    expect(await ins(ALICE, { code: `'X'`, institution: `'Q'`, term_label: `'WS'` })).toBeNull()
    expect(await ins(ALICE, { code: `'X'`, institution: `'P'`, term_label: `'SS'` })).toBeNull()
    expect(await ins(ALICE, { code: `'X'`, institution: `'P'`, term_label: `'WS'` })).toBe('23505')
    await reset()
  })

  it('non-ASCII letters keep their case: "ä" and "Ä" are different keys (rule N does not case-fold)', async () => {
    expect(await ins(ALICE, { code: `'ä 1'` })).toBeNull()
    expect(await ins(ALICE, { code: `'Ä 1'` })).toBeNull()
    expect(await ins(ALICE, { code: `'Ä 1'` })).toBe('23505')
    await reset()
  })

  it('courses without a code are never unique-constrained; archived courses still hold their key; users are independent', async () => {
    expect(await ins(ALICE, { name: `'Same'` })).toBeNull()
    expect(await ins(ALICE, { name: `'Same'` })).toBeNull()
    expect(await ins(ALICE, { code: `'Z'`, archived_at: `now()` })).toBeNull()
    expect(await ins(ALICE, { code: `'z'` })).toBe('23505')
    expect(await ins(BOB, { code: `'Z'` })).toBeNull()
    await reset()
  })

  it('an update that would collide is rejected', async () => {
    await as(ALICE, () => db.exec(add({ id: `'${C1}'`, name: `'A'`, code: `'A'` })))
    await as(ALICE, () => db.exec(add({ id: `'${C2}'`, name: `'B'`, code: `'B'` })))
    expect(await as(ALICE, () => code(db.exec(`update public.courses set code = ' a ' where id = '${C2}'`)))).toBe('23505')
    await reset()
  })
})

describe('courses: identity, ownership and timestamps cannot be forged', () => {
  async function seeded() {
    await as(ALICE, () => db.exec(add({ id: `'${C1}'`, name: `'Mine'` })))
  }
  const reset = () => db.exec(`delete from public.courses`)

  it('a signed-in user cannot set id, user_id, created_at or updated_at on update (no column privilege)', async () => {
    await seeded()
    for (const set of [`id = '${C2}'`, `user_id = '${BOB}'`, `created_at = now() - interval '1 year'`, `updated_at = now() - interval '1 year'`, `code_key = 'FORGED'`]) {
      // 42501 = no column privilege; 428C9 = a generated column can never be assigned. Either way nothing is written.
      expect(['42501', '428C9']).toContain(await as(ALICE, () => code(db.exec(`update public.courses set ${set} where id = '${C1}'`))))
    }
    await reset()
  })

  it('even the table owner cannot change id, user_id or created_at (trigger); updated_at is always the server\'s', async () => {
    await seeded()
    const before = (await db.query<{ created_at: Date; updated_at: Date }>(`select created_at, updated_at from public.courses where id = '${C1}'`)).rows[0]
    for (const [set, text] of [
      [`id = '${C2}'`, 'id is immutable'],
      [`user_id = '${BOB}'`, 'user_id is immutable'],
      [`created_at = created_at - interval '1 day'`, 'created_at is immutable'],
    ]) {
      const e = await err(db.exec(`update public.courses set ${set} where id = '${C1}'`))
      expect(e?.code, set).toBe('42501')
      expect(e?.message, set).toContain(text)
    }
    await db.exec(`update public.courses set name = 'Renamed', updated_at = '2000-01-01T00:00:00Z' where id = '${C1}'`)
    const after = (await db.query<{ created_at: Date; updated_at: Date; user_id: string; name: string }>(`select created_at, updated_at, user_id, name from public.courses where id = '${C1}'`)).rows[0]
    expect(after.name).toBe('Renamed')
    expect(after.user_id).toBe(ALICE)
    expect(after.created_at).toEqual(before.created_at)
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime()) // the forged 2000-01-01 was replaced
    await reset()
  })

  it('inserts get server timestamps even when the owner supplies others', async () => {
    await db.exec(`insert into public.courses (id, user_id, name, created_at, updated_at) values ('${C1}', '${ALICE}', 'Old', '2001-01-01T00:00:00Z', '2001-01-01T00:00:00Z')`)
    const r = (await db.query<{ created_at: Date; updated_at: Date }>(`select created_at, updated_at from public.courses where id = '${C1}'`)).rows[0]
    expect(r.created_at.getFullYear()).toBeGreaterThan(2020)
    expect(r.updated_at.getFullYear()).toBeGreaterThan(2020)
    await reset()
  })

  it('forging another user\'s ownership on insert is rejected (no user_id privilege)', async () => {
    expect(await as(ALICE, () => code(db.exec(add({ user_id: `'${BOB}'`, name: `'Forged'` }))))).toBe('42501')
    expect(await as(ALICE, () => code(db.exec(add({ user_id: `'${ALICE}'`, name: `'Self-set'` }))))).toBe('42501') // not even for yourself
    expect(await count()).toBe(0)
  })

  it('…and the RLS policy rejects it independently of the column grants', async () => {
    const d = await newDb()
    await d.exec(`grant insert (user_id), update (user_id) on public.courses to authenticated`) // simulate a future mistaken over-grant
    const e = await as(ALICE, () => err(d.exec(add({ user_id: `'${BOB}'`, name: `'Forged'` }))), d)
    expect(e?.code).toBe('42501')
    expect(e?.message).toContain('row-level security')
    await as(ALICE, () => d.exec(add({ id: `'${C1}'`, name: `'Mine'` })), d)
    // moving a row to another owner: the policy (and the protect trigger) refuse it
    expect(await as(ALICE, () => code(d.exec(`update public.courses set user_id = '${BOB}' where id = '${C1}'`)), d)).toBe('42501')
    expect(await count(d, `user_id = '${ALICE}'`)).toBe(1)
    await d.close()
  })

  it('the composite key (id, user_id) exists for later same-owner foreign keys', async () => {
    const r = await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'courses_id_user_key'`)
    expect(r.rows[0].def).toBe('UNIQUE (id, user_id)')
  })
})

describe('courses: isolation between users and from anonymous visitors', () => {
  it('Bob cannot read, update or delete Alice\'s courses; Alice sees only hers', async () => {
    await as(ALICE, () => db.exec(add({ id: `'${C1}'`, name: `'Alice course'`, code: `'A'` })))
    await as(BOB, () => db.exec(add({ id: `'${C2}'`, name: `'Bob course'`, code: `'A'` })))
    expect((await as(BOB, () => db.query(`select * from public.courses`))).rows.map((r) => (r as { name: string }).name)).toEqual(['Bob course'])
    expect((await as(BOB, () => db.query(`select * from public.courses where id = '${C1}'`))).rows).toEqual([])
    const upd = await as(BOB, () => db.query(`update public.courses set name = 'pwned' where id = '${C1}'`))
    expect(upd.affectedRows).toBe(0)
    const del = await as(BOB, () => db.query(`delete from public.courses where id = '${C1}'`))
    expect(del.affectedRows).toBe(0)
    expect((await as(ALICE, () => db.query(`select name from public.courses`))).rows).toEqual([{ name: 'Alice course' }])
    expect((await db.query<{ name: string }>(`select name from public.courses where id = '${C1}'`)).rows[0].name).toBe('Alice course')
    // Bob cannot reassign his own row to Alice either
    expect(await as(BOB, () => code(db.exec(`update public.courses set user_id = '${ALICE}' where id = '${C2}'`)))).toBe('42501')
    await db.exec(`delete from public.courses`)
  })

  it('anonymous visitors are denied every operation', async () => {
    await as(ALICE, () => db.exec(add({ id: `'${C1}'`, name: `'Alice course'` })))
    expect(await as(null, () => code(db.query(`select * from public.courses`)))).toBe('42501')
    expect(await as(null, () => code(db.exec(add({ name: `'anon'` }))))).toBe('42501')
    expect(await as(null, () => code(db.exec(`update public.courses set name = 'x'`)))).toBe('42501')
    expect(await as(null, () => code(db.exec(`delete from public.courses`)))).toBe('42501')
    expect(await count()).toBe(1)
    await db.exec(`delete from public.courses`)
  })

  it('fails closed: with no policies, even fully re-granted privileges expose nothing', async () => {
    const d = await newDb()
    await d.exec(`insert into public.courses (id, user_id, name) values ('${C1}', '${ALICE}', 'Hidden')`)
    await d.exec(`drop policy courses_select_own on public.courses; drop policy courses_update_own on public.courses; drop policy courses_delete_own on public.courses; drop policy courses_insert_own on public.courses;
                  grant all on public.courses to anon, authenticated`)
    expect((await as(ALICE, () => d.query(`select * from public.courses`), d)).rows).toEqual([])
    expect((await as(null, () => d.query(`select * from public.courses`), d)).rows).toEqual([])
    expect(await as(ALICE, () => code(d.exec(`insert into public.courses (name) values ('x')`)), d)).toBe('42501')
    await d.close()
  })

  it('deleting a user removes their courses; other users are untouched', async () => {
    await as(ALICE, () => db.exec(add({ name: `'A'` })))
    await as(BOB, () => db.exec(add({ name: `'B'` })))
    await db.exec(`delete from auth.users where id = '${BOB}'`)
    expect(await count(db, `user_id = '${BOB}'`)).toBe(0)
    expect(await count(db, `user_id = '${ALICE}'`)).toBe(1)
    await db.exec(`insert into auth.users values ('${BOB}')`)
    await db.exec(`delete from public.courses`)
  })
})

describe('rollback (supabase/recovery/20261020120000_courses.rollback.sql)', () => {
  const eventsRow = `insert into public.events (id, user_id, title, category, starts_at, ends_at) values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000099', '${ALICE}', 'Keep me', 'work', '2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z')`
  const publicTables = async (d: PGlite) =>
    (await d.query<{ relname: string }>(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname`)).rows.map((r) => r.relname)
  const objects = (d: PGlite) => d.query(`select proname from pg_proc where proname in ('orbit_normalise_key','orbit_protect_owned_row')`)

  it('empty table: runs without confirmation, removes only the courses objects, keeps calendar data, can be re-applied', async () => {
    const d = await newDb()
    await d.exec(eventsRow)
    const policiesBefore = (await d.query<{ n: number }>(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename <> 'courses'`)).rows[0].n
    await d.exec(ROLLBACK)
    expect(await publicTables(d)).toEqual(['event_import_links', 'event_imports', 'events', 'recurring_series', 'series_exceptions'])
    expect((await objects(d)).rows).toEqual([])
    expect((await d.query(`select title from public.events`)).rows).toEqual([{ title: 'Keep me' }])
    expect((await d.query<{ n: number }>(`select count(*)::int as n from pg_policies where schemaname = 'public'`)).rows[0].n).toBe(policiesBefore)
    await d.exec(MIGRATION) // the same database accepts the migration again
    expect(await publicTables(d)).toContain('courses')
    await d.close()
  })

  it('a database where the migration was never applied: the rollback is a harmless no-op', async () => {
    const d = await newDb(false)
    await d.exec(ROLLBACK)
    expect(await publicTables(d)).not.toContain('courses')
    await d.close()
  })

  it('with course rows: refuses (55000) without confirmation and drops nothing', async () => {
    const d = await newDb()
    await d.exec(eventsRow)
    await d.exec(`insert into public.courses (id, user_id, name) values ('${C1}', '${ALICE}', 'Real course')`)
    expect((await err(d.exec(ROLLBACK)))?.code).toBe('55000')
    await d.exec('rollback') // the file opened its own transaction
    expect(await count(d)).toBe(1)
    expect((await d.query(`select to_regclass('public.courses') as t`)).rows[0]).not.toEqual({ t: null })
    expect((await objects(d)).rows).toHaveLength(2)
    expect((await d.query(`select count(*)::int as n from public.events`)).rows[0]).toEqual({ n: 1 })
    // a wrong confirmation value does not count
    expect((await err(d.exec(`begin; select set_config('orbit.confirm_drop_courses', 'true', true);\n${ROLLBACK}`)))?.code).toBe('55000')
    await d.exec('rollback')
    expect(await count(d)).toBe(1)
    await d.close()
  })

  it('with confirmation (transaction-local) it drops only the courses objects; the confirmation does not outlive the transaction', async () => {
    expect(ROLLBACK).toMatch(/set_config\('orbit\.confirm_drop_courses', 'yes', true\)/)
    expect(ROLLBACK).not.toMatch(/set_config\('orbit\.confirm_drop_courses', 'yes', false\)/)
    expect(ROLLBACK).toMatch(/--\s*select set_config\('orbit\.confirm_drop_courses'/) // shipped commented out
    const d = await newDb()
    await d.exec(eventsRow)
    await d.exec(`insert into public.courses (id, user_id, name) values ('${C1}', '${ALICE}', 'Real course')`)
    expect(await code(d.exec(`begin; select set_config('orbit.confirm_drop_courses', 'yes', true);\n${ROLLBACK}`))).toBeNull()
    expect((await d.query(`select to_regclass('public.courses') as t`)).rows[0]).toEqual({ t: null })
    expect((await objects(d)).rows).toEqual([])
    expect((await d.query(`select title from public.events`)).rows).toEqual([{ title: 'Keep me' }])
    expect((await d.query<{ v: string | null }>(`select nullif(current_setting('orbit.confirm_drop_courses', true), '') as v`)).rows[0].v).toBeNull()
    await d.close()
  })

  it('refuses to run as an ordinary signed-in role (RLS would hide the rows from the emptiness check)', async () => {
    const d = await newDb()
    await d.exec(`insert into public.courses (id, user_id, name) values ('${C1}', '${ALICE}', 'Real course')`)
    // authenticated may not even create the script's objects, but the guard must fire first or the drop must fail: nothing is dropped either way
    await d.exec('set role authenticated')
    const e = await err(d.exec(ROLLBACK))
    await d.exec('rollback')
    await d.exec('reset role')
    expect(e).not.toBeNull()
    expect(await count(d)).toBe(1)
    await d.close()
  })

  it('never cascades: a later table that references courses blocks the rollback and nothing is dropped', async () => {
    const d = await newDb()
    await d.exec(`create table public.tasks_probe (id uuid primary key default gen_random_uuid(), user_id uuid not null, course_id uuid, foreign key (course_id, user_id) references public.courses (id, user_id) on delete restrict)`)
    expect((await err(d.exec(ROLLBACK)))?.code).toBe('2BP01')
    await d.exec('rollback')
    expect(await publicTables(d)).toContain('courses')
    expect((await objects(d)).rows).toHaveLength(2)
    await d.close()
  })

  it('lives in supabase/recovery, never in migrations, and touches nothing outside the courses objects', () => {
    expect(readdirSync(migrationsDir).some((n) => /rollback/i.test(n))).toBe(false)
    const body = ROLLBACK.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    const drops = [...body.matchAll(/drop\s+(table|function|policy|trigger|schema|index)\s+(if exists\s+)?([^\s;(]+)/gi)].map((m) => m[3])
    expect(drops).toEqual(['public.courses', 'orbit_private.orbit_protect_owned_row', 'orbit_private.orbit_normalise_key'])
    expect(body).not.toMatch(/cascade/i)
  })
})

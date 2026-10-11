// Offline verification that the Courses CLIENT (src/cloud/plannerApi.ts, plannerMappers.ts) and the courses SQL agree.
// Each test runs the SQL that the PostgREST request shape of the client translates to, as the `authenticated` role with
// row level security on, in an in-memory PostgreSQL (PGlite) with the simulated Supabase schema used by courses.test.ts.
// NOTHING here touches a hosted project or the local Docker stack.
//
// Limitations: PostgREST and supabase-js themselves are not run (the request SHAPES are covered by
// src/cloud/plannerApi.test.ts against a recording mock); `auth.uid()` is our shim; PGlite is PostgreSQL 18.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COURSE_DUPLICATE_CONSTRAINT, mapPlannerError } from '../../src/cloud/plannerApi'
import { COURSE_COLUMNS, coursePatch, courseProblems, courseToWrite, rowToCourse } from '../../src/cloud/plannerMappers'
import type { CourseRow, CourseWrite } from '../../src/cloud/plannerTypes'
import type { CourseInput } from '../../src/types/planner'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const id = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`
const migrationsDir = join(__dirname, '..', 'migrations')
const COURSES_FILE = '20261020120000_courses.sql'
const otherFiles = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql') && n !== COURSES_FILE).sort()

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
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
  for (const f of otherFiles) await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
  await db.exec(readFileSync(join(migrationsDir, COURSES_FILE), 'utf8'))
  await db.exec(`set timezone = 'UTC'`) // hosted Supabase renders timestamps in UTC ("+00:00"), which is what the client keeps raw
})
afterAll(async () => {
  await db.close()
})

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec('set role authenticated')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}
async function fail(p: Promise<unknown>): Promise<{ code: string; message: string; detail?: string }> {
  try {
    await p
  } catch (e) {
    const x = e as { code?: string; message?: string; detail?: string }
    return { code: x.code ?? 'unknown', message: x.message ?? '', detail: x.detail }
  }
  throw new Error('expected the statement to fail')
}

// ---- the SQL each client request translates to --------------------------------------------------------------------
const returning = COURSE_COLUMNS // what the client selects; timestamps/dates are rendered like PostgREST (JSON)

/** supabase-js upsert(row, {onConflict:'id', ignoreDuplicates:true}).select(cols)  =>  ON CONFLICT (id) DO NOTHING RETURNING */
async function insertCourse(w: CourseWrite): Promise<CourseRow | null> {
  const cols = Object.keys(w) as (keyof CourseWrite)[]
  const res = await db.query<{ r: CourseRow }>(
    `with ins as (insert into public.courses (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
       on conflict (id) do nothing returning ${returning})
     select row_to_json(ins) as r from ins`,
    cols.map((c) => w[c]),
  )
  return res.rows[0]?.r ?? null
}
/** .update(patch).eq('id', id).eq('updated_at', expected).select(cols) */
async function updateCourse(idv: string, patch: Record<string, unknown>, expected: string): Promise<CourseRow | null> {
  const cols = Object.keys(patch)
  const res = await db.query<{ r: CourseRow }>(
    `with up as (update public.courses set ${cols.map((c, i) => `${c} = $${i + 3}`).join(',')}
       where id = $1 and updated_at = $2::timestamptz returning ${returning})
     select row_to_json(up) as r from up`,
    [idv, expected, ...cols.map((c) => patch[c])],
  )
  return res.rows[0]?.r ?? null
}
/** .delete().eq('id', id).eq('updated_at', expected).select('id') */
async function deleteCourse(idv: string, expected: string): Promise<boolean> {
  const res = await db.query(`delete from public.courses where id = $1 and updated_at = $2::timestamptz returning id`, [idv, expected])
  return res.rows.length > 0
}
/** .select(cols).order('created_at').order('id').range(from, to) */
async function page(from: number, size: number): Promise<CourseRow[]> {
  const res = await db.query<{ r: CourseRow }>(
    `select row_to_json(t) as r from (select ${returning} from public.courses order by created_at, id limit ${size} offset ${from}) t`,
  )
  return res.rows.map((x) => x.r)
}
const get = async (idv: string) => (await db.query<{ r: CourseRow }>(`select row_to_json(t) as r from (select ${returning} from public.courses where id = $1 limit 1) t`, [idv])).rows[0]?.r ?? null

const algebra: CourseInput = { name: ' Linear Algebra ', code: ' MATH 101 ', institution: 'Example University', termLabel: 'WS 26/27', termStart: '2026-10-12', termEnd: '2027-02-12', description: 'Synthetic', color: 'c3' }

describe('create (insert ... on conflict (id) do nothing)', () => {
  it('stores exactly what the mapper writes; the server sets owner and timestamps; the row maps back to a Course', async () => {
    const row = await as(ALICE, () => insertCourse(courseToWrite(algebra, id(1))))
    expect(row).toMatchObject({ id: id(1), user_id: ALICE, name: 'Linear Algebra', code: 'MATH 101', institution: 'Example University', term_label: 'WS 26/27', term_start: '2026-10-12', term_end: '2027-02-12', color: 'c3', archived_at: null })
    expect(row!.created_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/)
    expect(row!.updated_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/)
    const course = rowToCourse(row!)
    expect(course).toMatchObject({ id: id(1), userId: ALICE, name: 'Linear Algebra', code: 'MATH 101', termStart: '2026-10-12', updatedAt: row!.updated_at })
  })

  it('blank optionals are stored as NULL and read back as absent', async () => {
    const row = await as(ALICE, () => insertCourse(courseToWrite({ name: 'Bare', code: '', institution: ' ', color: 'c1' }, id(2))))
    expect(row).toMatchObject({ code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null })
    expect(rowToCourse(row!)).not.toHaveProperty('code')
  })

  it('a repeated insert of the same id inserts nothing (idempotent) and does not change the stored row', async () => {
    const first = await as(ALICE, () => insertCourse(courseToWrite({ name: 'Idempotent', code: 'IDEM 1', color: 'c1' }, id(3))))
    const again = await as(ALICE, () => insertCourse(courseToWrite({ name: 'Different name', code: 'IDEM 2', color: 'c1' }, id(3))))
    expect(first).not.toBeNull()
    expect(again).toBeNull()
    expect((await as(ALICE, () => get(id(3))))).toEqual(first) // the caller then reads it back and compares the content
  })

  it('an id that exists for ANOTHER user inserts nothing and reveals nothing', async () => {
    await as(BOB, () => insertCourse(courseToWrite({ name: 'Bobs private course', code: 'BOB 1', color: 'c1' }, id(4))))
    const attempt = await as(ALICE, () => insertCourse(courseToWrite({ name: 'Alice tries', code: 'ALI 1', color: 'c1' }, id(4))))
    expect(attempt).toBeNull()
    expect(await as(ALICE, () => get(id(4)))).toBeNull() // the verifying read finds nothing -> "not confirmed"
    expect((await as(BOB, () => get(id(4))))!.name).toBe('Bobs private course')
  })

  it('a duplicate normalised code is a unique violation the client classifies as "duplicate_course"', async () => {
    await as(ALICE, () => insertCourse(courseToWrite({ name: 'First', code: 'inf 101', institution: 'Uni', termLabel: 'WS', color: 'c1' }, id(5))))
    const e = await fail(as(ALICE, () => insertCourse(courseToWrite({ name: 'Second', code: ' INF   101', institution: 'uni', termLabel: 'ws', color: 'c1' }, id(6)))))
    expect(e.code).toBe('23505')
    expect(e.message).toContain(COURSE_DUPLICATE_CONSTRAINT)
    // the shape PostgREST puts in its JSON error body
    expect(mapPlannerError({ code: e.code, message: e.message, details: e.detail }, 409)).toMatchObject({ kind: 'conflict', code: 'duplicate_course' })
  })

  it('the same code in another term, another institution, or another user is allowed', async () => {
    expect(await as(ALICE, () => insertCourse(courseToWrite({ name: 'Other term', code: 'inf 101', institution: 'Uni', termLabel: 'SS', color: 'c1' }, id(7))))).not.toBeNull()
    expect(await as(ALICE, () => insertCourse(courseToWrite({ name: 'Other uni', code: 'inf 101', institution: 'Elsewhere', termLabel: 'WS', color: 'c1' }, id(8))))).not.toBeNull()
    expect(await as(BOB, () => insertCourse(courseToWrite({ name: 'Bobs', code: 'inf 101', institution: 'Uni', termLabel: 'WS', color: 'c1' }, id(9))))).not.toBeNull()
  })

  it('a primary-key clash is NOT a duplicate course (it is swallowed by DO NOTHING, never reported as 23505)', async () => {
    const again = await as(ALICE, () => insertCourse(courseToWrite({ name: 'Same id', code: 'INF 101', institution: 'Uni', termLabel: 'WS', color: 'c1' }, id(5))))
    expect(again).toBeNull()
  })
})

describe('update / archive / restore / delete are conditional on the raw updated_at', () => {
  it('the raw updated_at returned by the server matches the row byte for byte (microsecond precision)', async () => {
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'Precise', code: 'PREC 1', color: 'c1' }, id(10)))))!
    const patched = await as(ALICE, () => updateCourse(id(10), coursePatch({ name: 'Precise 2', code: 'PREC 1', color: 'c1' }), row.updated_at))
    expect(patched).not.toBeNull()
    expect(patched!.name).toBe('Precise 2')
    expect(patched!.updated_at).not.toBe(row.updated_at) // new version token
    expect(patched!.created_at).toBe(row.created_at) // immutable
  })

  it('a stale update changes nothing and returns no row', async () => {
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'Stale', code: 'STALE 1', color: 'c1' }, id(11)))))!
    const phone = await as(ALICE, () => updateCourse(id(11), coursePatch({ name: 'Edited on phone', code: 'STALE 1', color: 'c1' }), row.updated_at))
    expect(phone).not.toBeNull()
    const laptop = await as(ALICE, () => updateCourse(id(11), coursePatch({ name: 'Edited on laptop', code: 'STALE 1', color: 'c1' }), row.updated_at))
    expect(laptop).toBeNull()
    expect((await as(ALICE, () => get(id(11))))!.name).toBe('Edited on phone')
  })

  it('a stale request is distinguishable from a duplicate: the duplicate raises, the stale one returns nothing', async () => {
    const a = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'A', code: 'DUPA 1', color: 'c1' }, id(12)))))!
    await as(ALICE, () => insertCourse(courseToWrite({ name: 'B', code: 'DUPB 1', color: 'c1' }, id(13))))
    const e = await fail(as(ALICE, () => updateCourse(id(12), coursePatch({ name: 'A', code: 'dupb  1', color: 'c1' }), a.updated_at)))
    expect(mapPlannerError({ code: e.code, message: e.message, details: e.detail }, 409).code).toBe('duplicate_course')
    expect(await as(ALICE, () => updateCourse(id(12), coursePatch({ name: 'A2', code: 'DUPA 1', color: 'c1' }), '2000-01-01T00:00:00+00:00'))).toBeNull()
  })

  it('a general update never changes the archive state; archive/restore touch only archived_at', async () => {
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'Archivable', code: 'ARC 1', description: 'keep me', color: 'c4' }, id(14)))))!
    const archived = (await as(ALICE, () => updateCourse(id(14), { archived_at: '2026-10-05T10:00:00.000Z' }, row.updated_at)))!
    expect(archived.archived_at).toBe('2026-10-05T10:00:00+00:00')
    expect(archived).toMatchObject({ name: 'Archivable', description: 'keep me', color: 'c4' })
    expect(rowToCourse(archived)!.archivedAt).toBe('2026-10-05T10:00:00+00:00')
    const edited = (await as(ALICE, () => updateCourse(id(14), coursePatch({ name: 'Archivable 2', code: 'ARC 1', description: 'keep me', color: 'c4' }), archived.updated_at)))!
    expect(edited.archived_at).toBe('2026-10-05T10:00:00+00:00')
    const restored = (await as(ALICE, () => updateCourse(id(14), { archived_at: null }, edited.updated_at)))!
    expect(restored).toMatchObject({ archived_at: null, name: 'Archivable 2' })
  })

  it('an update that clears optional fields writes NULL (every key is sent)', async () => {
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ ...algebra, code: 'CLR 1' }, id(15)))))!
    const cleared = (await as(ALICE, () => updateCourse(id(15), coursePatch({ name: 'Cleared', color: 'c1' }), row.updated_at)))!
    expect(cleared).toMatchObject({ code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null })
  })

  it('delete removes the row only with the current version token', async () => {
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'Doomed', code: 'DEL 1', color: 'c1' }, id(16)))))!
    const bumped = (await as(ALICE, () => updateCourse(id(16), { description: 'changed elsewhere' }, row.updated_at)))!
    expect(await as(ALICE, () => deleteCourse(id(16), row.updated_at))).toBe(false)
    expect(await as(ALICE, () => get(id(16)))).not.toBeNull()
    expect(await as(ALICE, () => deleteCourse(id(16), bumped.updated_at))).toBe(true)
    expect(await as(ALICE, () => get(id(16)))).toBeNull()
  })
})

describe('row level security and column privileges, from the client\'s point of view', () => {
  it('another user cannot read, update, archive or delete a course (they read as "not found")', async () => {
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'Alice only', code: 'RLS 1', color: 'c1' }, id(20)))))!
    expect(await as(BOB, () => get(id(20)))).toBeNull()
    expect(await as(BOB, () => updateCourse(id(20), { name: 'Hacked' }, row.updated_at))).toBeNull()
    expect(await as(BOB, () => updateCourse(id(20), { archived_at: '2026-10-05T10:00:00Z' }, row.updated_at))).toBeNull()
    expect(await as(BOB, () => deleteCourse(id(20), row.updated_at))).toBe(false)
    expect((await as(ALICE, () => get(id(20))))).toEqual(row)
  })

  it('a full load returns only the caller\'s rows', async () => {
    const mine = await as(ALICE, async () => (await db.query<{ user_id: string }>('select user_id from public.courses')).rows)
    expect(mine.length).toBeGreaterThan(5)
    expect(new Set(mine.map((r) => r.user_id))).toEqual(new Set([ALICE]))
  })

  it('client-controlled owner, timestamps, generated keys and id changes are refused by the database (the mapper never sends them)', async () => {
    const cols = (n: number) => `(id, name, ${n === 1 ? 'user_id' : n === 2 ? 'code_key' : 'archived_at, created_at'})`
    expect((await fail(as(ALICE, () => db.query(`insert into public.courses ${cols(1)} values ($1, 'x', $2)`, [id(21), BOB])))).code).toBe('42501')
    expect(['42501', '428C9']).toContain((await fail(as(ALICE, () => db.query(`insert into public.courses ${cols(2)} values ($1, 'x', 'K')`, [id(22)])))).code) // generated column
    expect((await fail(as(ALICE, () => db.query(`insert into public.courses (id, name, updated_at) values ($1, 'x', now())`, [id(23)])))).code).toBe('42501')
    const row = (await as(ALICE, () => insertCourse(courseToWrite({ name: 'Mine', code: 'OWN 1', color: 'c1' }, id(24)))))!
    expect((await fail(as(ALICE, () => updateCourse(id(24), { user_id: BOB }, row.updated_at)))).code).toBe('42501')
    expect((await fail(as(ALICE, () => updateCourse(id(24), { id: id(99) }, row.updated_at)))).code).toBe('42501')
  })
})

describe('pagination (order by created_at, id; range)', () => {
  it('pages through 25 rows that share one created_at without gaps or repeats', async () => {
    await as(BOB, () =>
      db.query(`insert into public.courses (id, name) select ('c0c0c0c0-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 'Bulk ' || g from generate_series(1, 25) g`),
    ) // one statement => identical created_at for all rows: the id tie-break is what keeps paging stable
    const seen: string[] = []
    for (let from = 0; ; from += 10) {
      const rows = await as(BOB, () => page(from, 10))
      seen.push(...rows.map((r) => r.id))
      if (rows.length < 10) break
    }
    const bulk = seen.filter((x) => Number(x.slice(-12)) > 1000)
    expect(bulk).toHaveLength(25)
    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('client validation agrees with the CHECK constraints', () => {
  const base: CourseInput = { name: 'Parity', color: 'c1' }
  const long = (n: number) => 'a'.repeat(n)
  const cases: [string, CourseInput][] = [
    ['name 120', { ...base, name: long(120) }],
    ['name 121', { ...base, name: long(121) }],
    ['blank name', { ...base, name: '   ' }],
    ['code 30', { ...base, code: long(30) }],
    ['code 31', { ...base, code: long(31) }],
    ['whitespace-only code', { ...base, code: '   ' }],
    ['institution 120', { ...base, institution: long(120) }],
    ['institution 121', { ...base, institution: long(121) }],
    ['term label 40', { ...base, termLabel: long(40) }],
    ['term label 41', { ...base, termLabel: long(41) }],
    ['description 2000', { ...base, description: long(2000) }],
    ['description 2001', { ...base, description: long(2001) }],
    ['term of exactly 400 days', { ...base, termStart: '2026-01-01', termEnd: '2027-02-05' }],
    ['term of 401 days', { ...base, termStart: '2026-01-01', termEnd: '2027-02-06' }],
    ['term end before start', { ...base, termStart: '2026-10-12', termEnd: '2026-10-11' }],
    ['one-day term', { ...base, termStart: '2026-10-12', termEnd: '2026-10-12' }],
    ['only a start date', { ...base, termStart: '2026-10-12' }],
    ['only an end date', { ...base, termEnd: '2026-10-12' }],
    ['unknown colour', { ...base, color: 'c9' as never }],
    ['last colour', { ...base, color: 'c8' }],
  ]
  let n = 100
  for (const [label, input] of cases) {
    it(label, async () => {
      const clientRejects = courseProblems(input).length > 0
      const write = courseToWrite(input, id(n++)) // the mapper is applied even to invalid input, to see what the DB says
      const outcome = await as(ALICE, () => insertCourse(write)).then(() => 'accepted', () => 'rejected')
      expect(outcome, `${label}: client ${clientRejects ? 'rejects' : 'accepts'}`).toBe(clientRejects ? 'rejected' : 'accepted')
    })
  }
})

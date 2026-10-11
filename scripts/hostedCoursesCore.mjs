// Logic of scripts/hosted-courses-check.mjs, split out so that it can be run offline against a fake client or a PGlite-backed
// adapter (tests/planner/hosted-courses-check.test.ts, supabase/tests/courses-hosted-check.test.ts).
// Nothing here reads the environment, creates a client, signs in or exits the process.
import { randomUUID } from 'node:crypto'
import { exitCode } from './hostedCheckCore.mjs'

export const CONFIRM = 'I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-COURSES-TO-THE-HOSTED-PROJECT'
export const DUPLICATE_CONSTRAINT = 'courses_user_code_institution_term_key'

/** Every check a complete run must record. A required check that did not run is a FAIL (never a silent skip). */
export const REQUIRED = [
  'courses-table-exists',
  'accounts-differ',
  'a-create',
  'a-generated-keys',
  'a-server-fields',
  'a-read-own',
  'a-cannot-set-user-id',
  'a-cannot-set-timestamps-on-insert',
  'b-cannot-read-by-id',
  'b-cannot-list',
  'b-cannot-update',
  'b-cannot-archive',
  'b-cannot-delete',
  'b-cannot-insert-as-a',
  'b-cannot-take-a-id',
  'b-cannot-take-a-id-upsert',
  'a-unchanged-after-b',
  'b-create-own',
  'b-control-same-edit',
  'a-cannot-see-b',
  'a-update',
  'a-update-timestamps',
  'a-stale-update-rejected',
  'a-archive',
  'a-restore',
  'immutable-id',
  'immutable-user-id',
  'immutable-created-at',
  'immutable-updated-at',
  'immutable-code-key',
  'immutable-unchanged',
  'invalid-blank-name',
  'invalid-long-name',
  'invalid-long-code',
  'invalid-blank-code',
  'invalid-long-institution',
  'invalid-long-term-label',
  'invalid-long-description',
  'invalid-color',
  'invalid-unpaired-term',
  'invalid-reversed-term',
  'invalid-long-term',
  'invalid-date-text',
  'invalid-update-rejected',
  'valid-boundary-accepted',
  'unique-duplicate-rejected',
  'unique-variant-rejected',
  'unique-different-term-allowed',
  'unique-no-code-allowed',
  'unique-update-rejected',
  'anon-cannot-read',
  'anon-cannot-insert',
  'anon-cannot-update',
  'anon-cannot-delete',
  'anon-unchanged',
  'a-delete',
  'cleanup-A',
  'cleanup-B',
  'cleanup-independent',
]

// --- configuration guards (the same rules as scripts/hosted-two-user-rls-check.mjs) ------------------------------------
export function looksPrivileged(key) {
  if (/^sb_secret_/i.test(key) || /service[_-]?role/i.test(key)) return true
  const part = key.split('.')[1]
  if (!part) return false
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString()).role === 'service_role'
  } catch {
    return false
  }
}

/** { ok: true } or { ok: false, message }. Messages never contain a value of the environment. */
export function validateConfig(env) {
  const get = (k) => env[k] ?? ''
  if (get('ORBIT_COURSES_CHECK_CONFIRM') !== CONFIRM) return { ok: false, message: "set ORBIT_COURSES_CHECK_CONFIRM to the confirmation phrase in the header of this script (requires the owner's approval)." }
  for (const k of ['ORBIT_SUPABASE_URL', 'ORBIT_SUPABASE_PUBLISHABLE_KEY', 'ORBIT_USER_A_EMAIL', 'ORBIT_USER_A_PASSWORD', 'ORBIT_USER_B_EMAIL', 'ORBIT_USER_B_PASSWORD']) {
    if (!get(k)) return { ok: false, message: `${k} is not set` }
  }
  if (get('ORBIT_USER_A_EMAIL').toLowerCase() === get('ORBIT_USER_B_EMAIL').toLowerCase()) return { ok: false, message: 'the two accounts must be different' }
  const url = get('ORBIT_SUPABASE_URL')
  if (!/^https:\/\/[^/\s@]+/i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)) return { ok: false, message: 'ORBIT_SUPABASE_URL must be https (or a local stack).' }
  if (looksPrivileged(get('ORBIT_SUPABASE_PUBLISHABLE_KEY'))) return { ok: false, message: 'that looks like a secret / service-role key. Use the public publishable key only.' }
  return { ok: true }
}

export const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, '$1***$2')

/**
 * The ONLY way an error reaches the output: a short ordinary code (a PostgreSQL SQLSTATE such as 42501 / 23505 or a PostgREST
 * code such as PGRST205) or the generic identifier E_UNKNOWN. Messages, details, hints, URLs, tokens and any other text a
 * server or an exception supplies are never used, even when the code is missing or malformed.
 */
export const safeCode = (e) => {
  const c = e && typeof e === 'object' ? e.code : undefined
  return typeof c === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(c) ? c : 'E_UNKNOWN'
}

// --- helpers -------------------------------------------------------------------------------------------------------------
const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : [])
/** A read/update/delete that must NOT succeed: an error, or (RLS-filtered statements) zero rows. */
const denied = (res) => !!res?.error || (Array.isArray(res?.data) && res.data.length === 0)
const errCode = (res) => (res?.error ? safeCode(res.error) : Array.isArray(res?.data) ? `${res.data.length} rows` : 'ok')
/** For comparison only (is this the duplicate-key constraint?): never printed. */
const errText = (res) => String(res?.error?.message ?? '') + ' ' + String(res?.error?.details ?? '')

/** A normal GET: 404 / PGRST205 / 42P01 = the table does not exist. Any other error (e.g. a missing grant) means "exists". */
export async function coursesTableExists(c) {
  const { error, status } = await c.from('courses').select('id').limit(1)
  if (!error) return true
  return !(status === 404 || error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message ?? ''))
}

/**
 * Removes what ONE account created and VERIFIES that nothing is left. Never throws.
 * Only by tracked id or by this run's escaped name marker, inside the account's own RLS space.
 */
export async function cleanupCourses({ c, ids, nameLike }) {
  const problems = []
  const step = async (what, fn) => {
    try {
      const r = await fn()
      if (r?.error) problems.push(`${what}: ${safeCode(r.error)}`)
      return r
    } catch (e) {
      problems.push(`${what}: threw an exception`) // neither its text nor its name is reported: either could carry request details
      return null
    }
  }
  const countOf = async (what, fn) => {
    const r = await step(what, fn)
    if (!r || r.error || !Array.isArray(r.data)) {
      if (r && !r.error) problems.push(`${what}: no result`)
      return 0
    }
    return r.data.length
  }
  for (const id of ids) await step(`delete course ${id}`, () => c.from('courses').delete().eq('id', id))
  await step('sweep courses by marker', () => c.from('courses').delete().like('name', nameLike))
  let remaining = 0
  remaining += await countOf('verify courses by marker', () => c.from('courses').select('id').like('name', nameLike))
  if (ids.length) remaining += await countOf('verify tracked courses', () => c.from('courses').select('id').in('id', ids))
  if (remaining > 0) problems.push(`${remaining} run-created record(s) remain`)
  return { ok: problems.length === 0, remaining, problems }
}

/**
 * Runs the whole Courses verification with two signed-in sessions and an anonymous client.
 *   A, B   { c: supabase-like client, id: user id }
 *   anon   a client without a session
 * Returns { exit, results, crashed }; `exit` is 0 only if every required check passed and cleanup verified nothing is left.
 */
export async function runCoursesCheck({ A, B, anon, run = randomUUID().slice(0, 8), log = console.log }) {
  const RUN = run.toUpperCase()
  const MARK = `ORBIT_RLS_CHECK_${run}`
  const NAME_LIKE = `${MARK.replace(/[\\_%]/g, (ch) => `\\${ch}`)}%` // '_' and '%' are LIKE wildcards: escape them
  const results = []
  const check = (id, name, ok, detail = '') => {
    results.push({ id, name, ok: ok === true })
    log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }
  const created = { A: [], B: [] }
  const track = (who, id) => created[who].push(id)
  const nm = (s) => `${MARK}_${s}`
  let crashed = false
  let wrote = false
  let tableMissing = false
  let anonInsertOk = false
  const unresolved = [] // ids of rows whose owner is unknown (never deleted with an unscoped statement)

  const newId = (who) => {
    const id = randomUUID()
    track(who, id) // tracked BEFORE the request: a row a failing check creates by mistake is still cleaned up
    return id
  }
  const get = async (who, id) => rowsOf(await who.c.from('courses').select('*').eq('id', id))[0]
  const valid = (s, extra = {}) => ({ name: nm(s), code: `rls-${run}  ${s}`, color: 'c1', ...extra })

  try {
    if (!(await coursesTableExists(A.c))) {
      tableMissing = true
      check('courses-table-exists', 'the courses table exists on the server', false, 'missing: is the migration applied?')
      throw new Error('stop')
    }
    check('courses-table-exists', 'the courses table exists on the server', true)
    check('accounts-differ', 'the two accounts are different users', A.id !== B.id)

    // ===== A: create and read their own course ===================================================================
    wrote = true
    const a1 = newId('A')
    const ins = await A.c
      .from('courses')
      .insert({ id: a1, ...valid('main', { code: `rls-${run}  main`, institution: ' Inst One ', term_label: 'WS 2030', term_start: '2030-10-01', term_end: '2031-02-28', description: 'synthetic', color: 'c2' }) })
      .select()
      .single()
    const row1 = ins.data
    check('a-create', 'A can create their own synthetic course', !ins.error && row1?.id === a1 && row1?.user_id === A.id, errCode(ins))
    check('a-generated-keys', 'the normalised keys are generated by the server (rule N)', row1?.code_key === `RLS-${RUN} MAIN` && row1?.institution_key === 'INST ONE' && row1?.term_key === 'WS 2030', `${row1?.code_key ?? '-'}`)
    check('a-server-fields', 'user_id, timestamps and archive state are set by the server', row1?.user_id === A.id && !!row1?.created_at && !!row1?.updated_at && row1?.archived_at === null && !Number.isNaN(Date.parse(row1?.created_at)))
    const read = await get(A, a1)
    check('a-read-own', 'A can read their own course back', read?.id === a1 && read?.name === nm('main'))
    const supplyUser = await A.c.from('courses').insert({ id: newId('A'), ...valid('uid'), user_id: A.id }).select()
    check('a-cannot-set-user-id', 'a client cannot supply user_id, not even their own', !!supplyUser.error, errCode(supplyUser))
    const supplyStamp = await A.c.from('courses').insert({ id: newId('A'), ...valid('stamp'), created_at: '2001-01-01T00:00:00Z', updated_at: '2001-01-01T00:00:00Z' }).select()
    check('a-cannot-set-timestamps-on-insert', 'a client cannot set created_at / updated_at', !!supplyStamp.error, errCode(supplyStamp))

    // ===== B against A's course ===================================================================================
    check('b-cannot-read-by-id', "B cannot read A's course by id", denied(await B.c.from('courses').select('id').eq('id', a1)))
    check('b-cannot-list', "B cannot find A's course by listing or by marker", denied(await B.c.from('courses').select('id').like('name', NAME_LIKE)))
    const validPatch = { name: nm('edited'), color: 'c3' } // a VALID edit: the same patch is accepted for the owner below
    // Each write is tried twice: asking for the row back (an RLS-filtered statement errors or returns nothing) and WITHOUT asking
    // (return=minimal: the response alone cannot tell success from a filtered statement, so the unchanged-row check below decides).
    check('b-cannot-update', "B cannot update A's course (a valid edit, denied or zero rows)", denied(await B.c.from('courses').update(validPatch).eq('id', a1).select()))
    await B.c.from('courses').update(validPatch).eq('id', a1)
    check('b-cannot-archive', "B cannot archive A's course", denied(await B.c.from('courses').update({ archived_at: new Date().toISOString() }).eq('id', a1).select()))
    await B.c.from('courses').update({ archived_at: new Date().toISOString() }).eq('id', a1)
    check('b-cannot-delete', "B cannot delete A's course", denied(await B.c.from('courses').delete().eq('id', a1).select('id')))
    await B.c.from('courses').delete().eq('id', a1)
    const forgedId = newId('B')
    track('A', forgedId) // were it to be created, it would belong to A
    const forge = await B.c.from('courses').insert({ id: forgedId, ...valid('forged'), user_id: A.id }).select()
    const forgedId2 = newId('B')
    track('A', forgedId2)
    const forge2 = await B.c.from('courses').insert({ id: forgedId2, ...valid('forged2'), user_id: A.id })
    check('b-cannot-insert-as-a', 'B cannot create a course attributed to A', !!forge.error && (!!forge2.error || (await get(A, forgedId2)) === undefined), errCode(forge))
    const take = await B.c.from('courses').insert({ id: a1, ...valid('take') }).select()
    check('b-cannot-take-a-id', "B cannot reuse A's course id for their own course", !!take.error, errCode(take))
    const takeUp = await B.c.from('courses').upsert({ id: a1, ...valid('take2') }, { onConflict: 'id', ignoreDuplicates: true }).select()
    check('b-cannot-take-a-id-upsert', "an idempotent create by B with A's id returns nothing and creates nothing for B", rowsOf(takeUp).length === 0 && (await B.c.from('courses').select('id').eq('id', a1)).data?.length === 0, errCode(takeUp))
    const after = await get(A, a1)
    check('a-unchanged-after-b', "A's course is byte-for-byte unchanged after B's attempts", !!after && JSON.stringify(after) === JSON.stringify(row1))

    // ===== positive controls for B ===============================================================================
    const b1 = newId('B')
    const bIns = await B.c.from('courses').insert({ id: b1, ...valid('bown', { code: `rls-${run}  main`, institution: 'Inst One', term_label: 'WS 2030' }) }).select().single()
    check('b-create-own', 'B can create their own course (even with the same code, institution and term as A: uniqueness is per user)', !bIns.error && bIns.data?.user_id === B.id, errCode(bIns))
    const bUp = await B.c.from('courses').update(validPatch).eq('id', b1).select()
    check('b-control-same-edit', 'control: the identical edit IS accepted for its owner (so the denials above are about ownership)', !bUp.error && bUp.data?.length === 1 && bUp.data[0].name === nm('edited'), errCode(bUp))
    check('a-cannot-see-b', "A cannot read B's course", denied(await A.c.from('courses').select('id').eq('id', b1)))

    // ===== A: update, archive, restore, stale write ===============================================================
    const upd = await A.c.from('courses').update(validPatch).eq('id', a1).eq('updated_at', row1?.updated_at).select()
    const row2 = upd.data?.[0]
    check('a-update', 'A can update their own course (conditional on the version they read)', !upd.error && row2?.name === nm('edited') && row2?.color === 'c3', errCode(upd))
    check('a-update-timestamps', 'updated_at moves forward on update; created_at, id and user_id stay', !!row2 && row2.updated_at !== row1?.updated_at && Date.parse(row2.updated_at) >= Date.parse(row1?.updated_at) && row2.created_at === row1?.created_at && row2.user_id === A.id)
    const stale = await A.c.from('courses').update({ name: nm('lost') }).eq('id', a1).eq('updated_at', row1?.updated_at).select()
    check('a-stale-update-rejected', 'a write based on an old version changes nothing (zero rows)', !stale.error && rowsOf(stale).length === 0 && (await get(A, a1))?.name === nm('edited'), errCode(stale))
    const arch = await A.c.from('courses').update({ archived_at: '2031-03-01T00:00:00Z' }).eq('id', a1).eq('updated_at', row2?.updated_at).select()
    check('a-archive', 'A can archive their course', !arch.error && !!arch.data?.[0]?.archived_at, errCode(arch))
    const rest = await A.c.from('courses').update({ archived_at: null }).eq('id', a1).eq('updated_at', arch.data?.[0]?.updated_at).select()
    check('a-restore', 'A can restore it', !rest.error && rest.data?.[0]?.archived_at === null, errCode(rest))
    const row3 = (await get(A, a1)) ?? {}

    // ===== immutable fields =======================================================================================
    const imm = async (_label, patch) => A.c.from('courses').update(patch).eq('id', a1).select()
    check('immutable-id', 'id cannot be changed', !!(await imm('id', { id: randomUUID() })).error)
    check('immutable-user-id', 'user_id cannot be reassigned (not to B, not to A)', !!(await imm('u', { user_id: B.id })).error && !!(await imm('u2', { user_id: A.id })).error)
    check('immutable-created-at', 'created_at cannot be changed', !!(await imm('c', { created_at: '2001-01-01T00:00:00Z' })).error)
    check('immutable-updated-at', 'updated_at cannot be set by the client', !!(await imm('t', { updated_at: '2001-01-01T00:00:00Z' })).error)
    check('immutable-code-key', 'the generated key columns cannot be written', !!(await imm('k', { code_key: 'FORGED' })).error && !!(await imm('k2', { institution_key: 'FORGED' })).error)
    const row4 = await get(A, a1)
    check('immutable-unchanged', 'the row is unchanged after every rejected change', !!row4 && JSON.stringify(row4) === JSON.stringify(row3))

    // ===== invalid data is rejected (an ERROR, not "zero rows") ====================================================
    const bad = async (id, name, extra) => {
      const rid = newId('A')
      const r = await A.c.from('courses').insert({ id: rid, ...valid(id.replace(/^invalid-/, '')), ...extra }).select()
      check(id, name, !!r.error, errCode(r))
    }
    await bad('invalid-blank-name', 'a blank name is rejected', { name: '   ' })
    await bad('invalid-long-name', 'a name over 120 characters is rejected', { name: `${MARK}_${'n'.repeat(121)}` })
    await bad('invalid-long-code', 'a code over 30 characters is rejected', { code: 'c'.repeat(31) })
    await bad('invalid-blank-code', 'a whitespace-only code is rejected', { code: '   ' })
    await bad('invalid-long-institution', 'an institution over 120 characters is rejected', { institution: 'i'.repeat(121) })
    await bad('invalid-long-term-label', 'a term label over 40 characters is rejected', { term_label: 't'.repeat(41) })
    await bad('invalid-long-description', 'a description over 2000 characters is rejected', { description: 'd'.repeat(2001) })
    await bad('invalid-color', 'an unknown colour is rejected', { color: 'c9' })
    await bad('invalid-unpaired-term', 'a term with only a start date is rejected', { term_start: '2030-10-01' })
    await bad('invalid-reversed-term', 'a term that ends before it starts is rejected', { term_start: '2030-10-02', term_end: '2030-10-01' })
    await bad('invalid-long-term', 'a term longer than 400 days is rejected', { term_start: '2030-01-01', term_end: '2031-02-06' })
    await bad('invalid-date-text', 'a date that is not a date is rejected', { term_start: 'not-a-date', term_end: '2030-10-01' })
    const badUpd = await A.c.from('courses').update({ term_start: '2030-10-02', term_end: '2030-10-01' }).eq('id', a1).select()
    check('invalid-update-rejected', 'an invalid update is rejected and leaves the row unchanged', !!badUpd.error && JSON.stringify(await get(A, a1)) === JSON.stringify(row3), errCode(badUpd))
    const edge = newId('A')
    const okEdge = await A.c.from('courses').insert({ id: edge, ...valid('edge', { code: 'r'.repeat(30), term_start: '2030-01-01', term_end: '2031-02-05', name: `${MARK}_${'e'.repeat(80)}` }) }).select()
    check('valid-boundary-accepted', 'control: a 400-day term and a 30-character code ARE accepted (rejections are about validity)', !okEdge.error && rowsOf(okEdge).length === 1, errCode(okEdge))

    // ===== normalised uniqueness ==================================================================================
    const dup = await A.c.from('courses').insert({ id: newId('A'), ...valid('dup', { code: `RLS-${RUN} MAIN`, institution: 'inst  ONE', term_label: ' ws 2030 ' }) }).select()
    check('unique-duplicate-rejected', 'the same code, institution and term label is rejected as a duplicate', dup.error?.code === '23505' && errText(dup).includes(DUPLICATE_CONSTRAINT), errCode(dup))
    const dup2 = await A.c.from('courses').insert({ id: newId('A'), ...valid('dup2', { code: `rls-${run}\t\tmain`, institution: 'INST ONE', term_label: 'ws  2030' }) }).select()
    check('unique-variant-rejected', 'case and whitespace variants are the same key (rule N)', dup2.error?.code === '23505', errCode(dup2))
    const dt = await A.c.from('courses').insert({ id: newId('A'), ...valid('term2', { code: `rls-${run}  main`, institution: 'Inst One', term_label: 'SS 2031' }) }).select()
    check('unique-different-term-allowed', 'control: another term label is a different course', !dt.error && rowsOf(dt).length === 1, errCode(dt))
    const nc1 = await A.c.from('courses').insert({ id: newId('A'), name: nm('nocode1'), color: 'c1' }).select()
    const nc2 = await A.c.from('courses').insert({ id: newId('A'), name: nm('nocode2'), color: 'c1' }).select()
    check('unique-no-code-allowed', 'control: courses without a code never collide', !nc1.error && !nc2.error, `${errCode(nc1)}/${errCode(nc2)}`)
    const upDup = await A.c.from('courses').update({ term_label: 'SS 2031' }).eq('id', a1).select()
    check('unique-update-rejected', 'an update that would create a duplicate is rejected and changes nothing', upDup.error?.code === '23505' && JSON.stringify(await get(A, a1)) === JSON.stringify(row3), errCode(upDup))

    // ===== anonymous ==============================================================================================
    check('anon-cannot-read', 'anonymous visitors cannot read courses', denied(await anon.from('courses').select('*').limit(1)))
    // The id is tracked BEFORE the request. If the insert is not clearly rejected (it succeeded or the outcome is unknown) the row has
    // no known owner: A and B can only remove it if it happens to be in their own space, so it is also reported as unresolved below.
    const anonId = randomUUID()
    track('A', anonId)
    track('B', anonId)
    const anonIns = await anon.from('courses').insert({ id: anonId, name: nm('anon'), color: 'c1' })
    anonInsertOk = !anonIns.error
    if (anonInsertOk) unresolved.push(anonId)
    check('anon-cannot-insert', 'anonymous visitors cannot create courses', !anonInsertOk, errCode(anonIns))
    check('anon-cannot-update', "anonymous visitors cannot update A's course", denied(await anon.from('courses').update({ name: nm('anon') }).eq('id', a1).select()))
    check('anon-cannot-delete', "anonymous visitors cannot delete A's course", denied(await anon.from('courses').delete().eq('id', a1).select('id')))
    check('anon-unchanged', "A's course is unchanged after the anonymous attempts", JSON.stringify(await get(A, a1)) === JSON.stringify(row3))

    // ===== A deletes (conditional on the version) ================================================================
    const del = await A.c.from('courses').delete().eq('id', a1).eq('updated_at', row3.updated_at).select('id')
    check('a-delete', 'A can delete their own course, and it is gone', !del.error && rowsOf(del).length === 1 && (await get(A, a1)) === undefined, errCode(del))
  } catch {
    if (!tableMissing) {
      crashed = true
      log('ERROR: the run stopped unexpectedly; details are not printed')
    }
  } finally {
    // each account is cleaned up independently: a failure (or exception) for one never skips the other
    if (wrote) {
      const outcomes = {}
      for (const [who, acc] of [['A', A], ['B', B]]) {
        let o
        try {
          o = await cleanupCourses({ c: acc.c, ids: created[who], nameLike: NAME_LIKE })
        } catch {
          o = { ok: false, remaining: -1, problems: ['cleanup threw an exception'] }
        }
        outcomes[who] = o
        check(`cleanup-${who}`, `cleanup ${who}: every run-created course is removed and verified gone`, o.ok, o.ok ? '0 left' : `${o.remaining} left; ${o.problems.join(' | ')}`)
      }
      // a second, separate read of both spaces, independent of the cleanup bookkeeping
      let left = 0
      let readable = true
      for (const acc of [A, B]) {
        try {
          const r = await acc.c.from('courses').select('id').like('name', NAME_LIKE)
          if (r.error || !Array.isArray(r.data)) readable = false
          else left += r.data.length
        } catch {
          readable = false
        }
      }
      if (unresolved.length > 0) {
        // Each account only ever deletes by id inside its own RLS space (done above). A row with no owner (or a foreign one) cannot be
        // removed or even seen by A or B, so the run does not pretend: it fails and names the id for manual removal by the owner.
        let seen = 0
        for (const acc of [A, B]) {
          try {
            const r = await acc.c.from('courses').select('id').in('id', unresolved)
            seen += Array.isArray(r.data) ? r.data.length : 0
          } catch {
            seen += 0
          }
        }
        check('cleanup-anon-insert', 'a course created anonymously was removed and verified gone', false, `${seen > 0 ? 'still visible' : 'owner unknown, cannot be verified or removed by A or B'}; remove id ${unresolved.join(', ')} manually`)
      }
      check('cleanup-independent', 'an independent read of both accounts finds no synthetic course', readable && left === 0, readable ? `${left} found` : 'could not verify')
    }
    for (const who of [A, B]) {
      try {
        await who.c.auth.signOut()
      } catch {
        /* sessions are not persisted */
      }
    }
  }

  // A required check that did not run (crash, early stop) is a FAIL, never a silent skip.
  if (!tableMissing) {
    for (const id of REQUIRED) {
      if (!results.some((r) => r.id === id)) {
        results.push({ id, name: id, ok: false })
        log(`FAIL  ${id}  (required but did not run)`)
      }
    }
  }
  const failed = results.filter((r) => r.ok === false)
  log(`\n${results.filter((r) => r.ok).length} passed, ${failed.length} failed${crashed ? ', run crashed' : ''}`)
  return { exit: exitCode({ results, crashed, require: true }), results, crashed }
}

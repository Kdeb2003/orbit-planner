// Hosted two-account RLS and provenance-integrity check with DISPOSABLE SYNTHETIC rows. NOT RUN by anyone yet.
//
// Run it only after the user has (1) created a second test account in the Supabase dashboard and (2) approved the
// run. Procedure and expected results: docs/proposals/hosted-two-user-rls-verification.md.
//
// Safety properties (reviewed; see the review notes in that document)
//   * Uses ONLY the public (publishable/anon) key and normal email+password sign-ins. RLS applies to every request.
//     It refuses a service-role / secret key, a non-https URL (except a local stack) and identical accounts.
//   * Credentials come from environment variables only; they are never printed, logged or written to a file. Emails
//     are masked in output. Sessions are not persisted and are signed out at the end.
//   * Creates only rows marked with this run's id ("ORBIT_RLS_CHECK_<run>", source slug "rls-check-<run>") in each
//     account's OWN space. Cleanup deletes exactly the rows this run created (ids are tracked, including rows a
//     failing check might have created by mistake) and runs also after a failure or an exception.
//   * Provenance history is removed through the supported function orbit_forget_import_history() with the run's own
//     slug, which can touch nothing else. Direct deletion of provenance is (correctly) not possible.
//   * Needs the explicit confirmation variable below, so it cannot run by accident (e.g. from CI).
//   * Does not enable sign-ups, change any setting, or use a service-role key.
//
// Environment (all required):
//   ORBIT_RLS_CHECK_CONFIRM=I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-ROWS-TO-THE-HOSTED-PROJECT
//   ORBIT_SUPABASE_URL, ORBIT_SUPABASE_PUBLISHABLE_KEY
//   ORBIT_USER_A_EMAIL, ORBIT_USER_A_PASSWORD, ORBIT_USER_B_EMAIL, ORBIT_USER_B_PASSWORD
// Flags: --dry-run             validates the configuration and stops before any request.
//        --require-provenance  POST-MIGRATION mode: the provenance tables and both RPCs MUST exist. If they are missing
//                              (or only partly there) the run FAILS instead of skipping those checks. Use it for the
//                              verification after the migration; a run without it is only valid before the migration.
//
// Exit code: 0 only if every check passed AND cleanup verified that no run-created record remains.
//            1 = a failed check, a crash, a cleanup problem or leftovers (or, with --require-provenance, a skipped check).
//            2 = refused to start (configuration or missing confirmation).
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { cleanupUser, exitCode, provenanceDecision, rpcMissing } from './hostedCheckCore.mjs'

const CONFIRM = 'I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-ROWS-TO-THE-HOSTED-PROJECT'
const env = (k) => process.env[k] ?? ''
const dry = process.argv.includes('--dry-run')
const requireProvenance = process.argv.includes('--require-provenance')

function fail(msg) {
  console.error(`REFUSED: ${msg}`)
  process.exit(2)
}

if (env('ORBIT_RLS_CHECK_CONFIRM') !== CONFIRM) fail("set ORBIT_RLS_CHECK_CONFIRM to the confirmation phrase in the header of this script (requires the user's approval).")
for (const k of ['ORBIT_SUPABASE_URL', 'ORBIT_SUPABASE_PUBLISHABLE_KEY', 'ORBIT_USER_A_EMAIL', 'ORBIT_USER_A_PASSWORD', 'ORBIT_USER_B_EMAIL', 'ORBIT_USER_B_PASSWORD']) {
  if (!env(k)) fail(`${k} is not set`)
}
if (env('ORBIT_USER_A_EMAIL').toLowerCase() === env('ORBIT_USER_B_EMAIL').toLowerCase()) fail('the two accounts must be different')
// https, or plain http ONLY for a local stack: the host must END at the optional port (so http://localhost.evil.example is refused)
if (!/^https:\/\/[^/\s@]+/i.test(env('ORBIT_SUPABASE_URL')) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(env('ORBIT_SUPABASE_URL'))) fail('ORBIT_SUPABASE_URL must be https (or a local stack).')

function looksPrivileged(key) {
  if (/^sb_secret_/i.test(key) || /service[_-]?role/i.test(key)) return true
  const part = key.split('.')[1]
  if (!part) return false
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString()).role === 'service_role'
  } catch {
    return false
  }
}
if (looksPrivileged(env('ORBIT_SUPABASE_PUBLISHABLE_KEY'))) fail('that looks like a secret / service-role key. Use the public publishable key only.')

if (dry) {
  console.log(`Configuration is valid (${requireProvenance ? 'post-migration mode: provenance required' : 'pre-migration mode: provenance checks are skipped if absent'}). --dry-run: no request was made.`)
  process.exit(0)
}

const url = env('ORBIT_SUPABASE_URL')
const key = env('ORBIT_SUPABASE_PUBLISHABLE_KEY')
const RUN = randomUUID().slice(0, 8)
const TITLE = `ORBIT_RLS_CHECK_${RUN}`
const TITLE_LIKE = `${TITLE.replace(/[\\_%]/g, (c) => `\\${c}`)}%` // '_' and '%' are LIKE wildcards: escape them
const SLUG = `rls-check-${RUN}`
const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
const mask = (e) => e.replace(/^(.).*(@.*)$/, '$1***$2')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const skipped = (name, why) => {
  if (requireProvenance) return check(name, false, `required but skipped: ${why}`) // never a silent pass after the migration
  results.push({ name, ok: null })
  console.log(`SKIP  ${name}  (${why})`)
}
/** A write/read that must NOT succeed: an error, or (for filtered statements) zero rows. */
const denied = (res) => !!res.error || (Array.isArray(res.data) && res.data.length === 0)
const code = (res) => res.error?.code ?? (Array.isArray(res.data) ? `${res.data.length} rows` : 'ok')

const start = '2030-01-15T10:00:00.000Z'
const end = '2030-01-15T11:00:00.000Z'
const eventRow = (extra = {}) => ({ title: TITLE, category: 'personal', starts_at: start, ends_at: end, ...extra })
const snapshot = { title: TITLE, category: 'personal', starts_at: start, ends_at: end, time_zone: 'Europe/Berlin', location: null, description: null, course_code: null, session_type: null, group_label: null }
const rpcItem = (n) => ({ source_key: `${SLUG}|${n}`, event_id: randomUUID(), source: { synthetic: true }, event: { ...snapshot, title: `${TITLE}_${n}` } })
const batchRow = (planned, sha = 'c') => ({ source_slug: SLUG, source_label: TITLE, source_sha256: sha.repeat(64), planned_count: planned })

const created = { A: { events: [], series: [] }, B: { events: [], series: [] } }
const track = (who, kind, id) => id && created[who][kind].push(id)

// A normal GET (a HEAD error has no body, so its code could not be recognised). 404 / PGRST205 / 42P01 = table missing.
async function exists(c, table) {
  const { error, status } = await c.from(table).select('id').limit(1)
  if (!error) return true
  return !(status === 404 || error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message ?? ''))
}

async function signIn(label, email, password) {
  const c = client()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error || !data.user) fail(`could not sign in ${label} (${mask(email)}): ${error?.message ?? 'no user'}`)
  return { c, id: data.user.id }
}

/** Cleans up one account and turns the outcome into a CHECK: a problem or a leftover FAILS the run. Never throws. */
async function cleanup(label, who, provenance) {
  let outcome
  try {
    outcome = await cleanupUser({ c: who.c, tracked: created[label], titleLike: TITLE_LIKE, slug: SLUG, provenance })
  } catch {
    outcome = { ok: false, remaining: -1, problems: ['cleanup threw an exception'] }
  }
  check(`cleanup ${label}: every run-created record is removed and verified gone`, outcome.ok, outcome.ok ? '0 left' : `${outcome.remaining} left; ${outcome.problems.join(' | ')}`)
}

const A = await signIn('A', env('ORBIT_USER_A_EMAIL'), env('ORBIT_USER_A_PASSWORD'))
const B = await signIn('B', env('ORBIT_USER_B_EMAIL'), env('ORBIT_USER_B_PASSWORD'))
const anon = client()
let crashed = false
let provenanceActive = false // set once the provenance tables/RPCs were found; cleanup then also forgets this run's history

try {
  check('accounts are different users', A.id !== B.id)

  // ============ existing tables: events, recurring_series, series_exceptions ====================================
  const evA = randomUUID()
  const ins = await A.c.from('events').insert(eventRow({ id: evA })).select().single()
  check('A can create their own synthetic event', !ins.error && ins.data?.user_id === A.id, ins.error?.message)
  track('A', 'events', evA)

  check("B cannot read A's event", denied(await B.c.from('events').select('id').eq('id', evA)))
  check("B cannot update A's event", denied(await B.c.from('events').update({ title: `${TITLE}_HACKED` }).eq('id', evA).select()))
  check("B cannot delete A's event", denied(await B.c.from('events').delete().eq('id', evA).select()))
  const forgedId = randomUUID()
  track('A', 'events', forgedId) // tracked in case a failing policy lets the forged row in
  const forge = await B.c.from('events').insert(eventRow({ id: forgedId, user_id: A.id }))
  check('B cannot create an event attributed to A', !!forge.error, forge.error?.code)
  check("A's event is untouched after B's attempts", (await A.c.from('events').select('title').eq('id', evA).single()).data?.title === TITLE)

  const serA = randomUUID()
  const sIns = await A.c.from('recurring_series').insert({ id: serA, title: TITLE, category: 'personal', weekdays: [0], start_date: '2030-01-14', until_date: '2030-02-14', start_time: '10:00', end_time: '11:00' }).select().single()
  check('A can create their own synthetic series', !sIns.error, sIns.error?.message)
  track('A', 'series', serA)
  const exIns = await A.c.from('series_exceptions').insert({ series_id: serA, original_date: '2030-01-21', cancelled: true })
  check('A can add an exception to their series', !exIns.error, exIns.error?.message)
  check("B cannot read A's series", denied(await B.c.from('recurring_series').select('id').eq('id', serA)))
  check("B cannot read A's exceptions", denied(await B.c.from('series_exceptions').select('series_id').eq('series_id', serA)))
  check("B cannot update A's series", denied(await B.c.from('recurring_series').update({ title: `${TITLE}_HACKED` }).eq('id', serA).select()))
  check("B cannot delete A's series", denied(await B.c.from('recurring_series').delete().eq('id', serA).select()))
  // A VALID modification (the same patch is accepted for the owner, see the control below), so a rejection can only be about ownership
  const validPatch = { cancelled: true, override: { title: `${TITLE}_EDITED` } }
  check("B cannot change A's exception (a valid edit, denied or zero rows)", denied(await B.c.from('series_exceptions').update(validPatch).eq('series_id', serA).eq('original_date', '2030-01-21').select()))
  const exA = await A.c.from('series_exceptions').select('cancelled, override').eq('series_id', serA).eq('original_date', '2030-01-21').single()
  check("A's exception is unchanged after B's edit attempt", exA.data?.cancelled === true && exA.data?.override === null, exA.error?.message)
  await A.c.from('series_exceptions').insert({ series_id: serA, original_date: '2030-01-22', cancelled: true })
  const control = await A.c.from('series_exceptions').update(validPatch).eq('series_id', serA).eq('original_date', '2030-01-22').select()
  check('control: the same edit IS accepted for the owner (so the denial above is about ownership, not validity)', !control.error && control.data?.length === 1 && control.data[0].override?.title === `${TITLE}_EDITED`, control.error?.message)
  check("B cannot delete A's exception", denied(await B.c.from('series_exceptions').delete().eq('series_id', serA).select()))
  const exForge = await B.c.from('series_exceptions').insert({ series_id: serA, original_date: '2030-01-28', cancelled: true })
  check("B cannot attach an exception to A's series", !!exForge.error, exForge.error?.code)
  // The series now has TWO exceptions (the original and the owner-control one), so the original is addressed by its full key
  // (series_id AND original_date). A query by series_id alone + .single() would error on two rows and falsely FAIL.
  const serAfter = await A.c.from('recurring_series').select('title, weekdays, start_date, until_date, start_time, end_time').eq('id', serA).single()
  check("A's series is unchanged after B's attempts", serAfter.data?.title === TITLE && JSON.stringify(serAfter.data?.weekdays) === '[0]' && serAfter.data?.start_date === '2030-01-14' && serAfter.data?.until_date === '2030-02-14' && String(serAfter.data?.start_time).startsWith('10:00') && String(serAfter.data?.end_time).startsWith('11:00'), serAfter.error?.code)
  const exOrig = await A.c.from('series_exceptions').select('cancelled, override').eq('series_id', serA).eq('original_date', '2030-01-21').single()
  check("A's original exception (2030-01-21) is unchanged: still cancelled, no override", exOrig.data?.cancelled === true && exOrig.data?.override === null, exOrig.error?.code)
  const exAll = await A.c.from('series_exceptions').select('original_date').eq('series_id', serA)
  check("A's series still has exactly its two own exceptions (nothing added by B)", !exAll.error && JSON.stringify((exAll.data ?? []).map((r) => r.original_date).sort()) === '["2030-01-21","2030-01-22"]', exAll.error?.code)

  for (const table of ['events', 'recurring_series', 'series_exceptions']) {
    const r = await anon.from(table).select('*').limit(1)
    check(`anonymous visitors cannot read ${table}`, !!r.error || r.data.length === 0, code(r))
  }
  check('anonymous visitors cannot create events', !!(await anon.from('events').insert(eventRow({ id: randomUUID() }))).error)
  check('anonymous visitors cannot create series', !!(await anon.from('recurring_series').insert({ id: randomUUID(), title: TITLE, category: 'personal', weekdays: [0], start_date: '2030-01-14', until_date: '2030-01-20', start_time: '10:00', end_time: '11:00' })).error)

  // ============ import provenance (only once the approved migration has been applied) ===========================
  // Probing the RPCs is safe: a bad slug / an empty list is rejected (22023) before anything is read or written.
  const tables = (await exists(A.c, 'event_imports')) && (await exists(A.c, 'event_import_links'))
  const rpcs = !rpcMissing(await A.c.rpc('orbit_forget_import_history', { p_slug: 'NOT A VALID SLUG' })) && !rpcMissing(await A.c.rpc('orbit_import_sessions', { p_batch: randomUUID(), p_items: [] }))
  const decision = provenanceDecision({ tables, rpcs, require: requireProvenance })
  if (decision.action === 'skip') skipped('import provenance isolation and integrity', decision.reason)
  else if (decision.action === 'fail') check('import provenance deployment is complete', false, decision.reason)
  else {
    provenanceActive = true
    // ---- same user: the happy path works --------------------------------------------------------------------
    const bA = await A.c.from('event_imports').insert(batchRow(2)).select().single()
    check('A can create an import batch (status starts in_progress)', !bA.error && bA.data?.status === 'in_progress', bA.error?.message)
    const batchA = bA.data?.id
    const i1 = rpcItem(1)
    const r1 = await A.c.rpc('orbit_import_sessions', { p_batch: batchA, p_items: [i1] })
    track('A', 'events', r1.data?.[0]?.event_id)
    check('A can import a synthetic session through the RPC', !r1.error && r1.data?.[0]?.outcome === 'created', r1.error?.message)
    const again = await A.c.rpc('orbit_import_sessions', { p_batch: batchA, p_items: [i1] })
    check('repeating the same import creates nothing', !again.error && again.data?.[0]?.outcome === 'already-linked')

    // ---- event-id collisions: an id that already belongs to a calendar event is never adopted or changed ----------
    const bTaken = await A.c.from('event_imports').insert(batchRow(2, '1')).select().single()
    const takenOwn = { ...rpcItem(7), event_id: evA }
    const rTaken = await A.c.rpc('orbit_import_sessions', { p_batch: bTaken.data?.id, p_items: [takenOwn] })
    check("an event id already used by A's own manual event is reported as taken, never adopted", !rTaken.error && rTaken.data?.[0]?.outcome === 'event-id-taken', rTaken.error?.message)
    check("...and A's manual event is unchanged", (await A.c.from('events').select('title').eq('id', evA).single()).data?.title === TITLE)
    const rForeign = await B.c.rpc('orbit_import_sessions', { p_batch: (await B.c.from('event_imports').insert(batchRow(1, '2')).select().single()).data?.id, p_items: [{ ...rpcItem(9), event_id: evA }] })
    check("an event id belonging to ANOTHER user is reported as taken and A's event is unchanged", !rForeign.error && rForeign.data?.[0]?.outcome === 'event-id-taken' && (await A.c.from('events').select('title').eq('id', evA).single()).data?.title === TITLE, rForeign.error?.message)
    const malformed = [['an empty item list', []], ['a non-array payload', { not: 'an array' }], ['an item without a source', [{ ...rpcItem(10), source: undefined }]], ['an item without an event', [{ ...rpcItem(11), event: undefined }]], ['a non-UUID event id', [{ ...rpcItem(12), event_id: 'nope' }]], ['duplicate keys in one request', [rpcItem(13), rpcItem(13)]]]
    for (const [what, payload] of malformed) {
      const r = await A.c.rpc('orbit_import_sessions', { p_batch: bTaken.data?.id, p_items: payload })
      check(`the import RPC rejects ${what}`, !!r.error, r.error?.code)
    }
    check('rejected requests wrote nothing', ((await A.c.from('event_import_links').select('id').eq('batch_id', bTaken.data?.id)).data ?? []).length === 0)

    // ---- same user: provenance cannot be rewritten through the table API --------------------------------------
    const direct = await A.c.from('event_import_links').insert({ batch_id: batchA, source_slug: SLUG, source_key: `${SLUG}|forged`, event_id: evA, imported_snapshot: snapshot, source_snapshot: {} })
    check('A cannot insert a link directly (links come only from the RPC)', !!direct.error, direct.error?.code)
    for (const [what, patch] of [['source_key', { source_key: 'rewritten' }], ['imported_snapshot', { imported_snapshot: { ...snapshot, title: 'x' } }], ['event_id (re-point)', { event_id: evA }], ['event_id (forged tombstone)', { event_id: null }], ['batch_id', { batch_id: randomUUID() }], ['source_snapshot', { source_snapshot: { forged: true } }]]) {
      const r = await A.c.from('event_import_links').update(patch).eq('source_key', i1.source_key).select()
      check(`A cannot rewrite a link's ${what}`, !!r.error, r.error?.code)
    }
    check('A cannot delete a link directly', denied(await A.c.from('event_import_links').delete().eq('source_key', i1.source_key).select()))
    const stillThere = await A.c.from('event_import_links').select('event_id, source_key').eq('source_key', i1.source_key).single()
    check("the link is unchanged after A's attempts", stillThere.data?.event_id === r1.data?.[0]?.event_id)
    for (const [what, patch] of [['planned_count', { planned_count: 1 }], ['written_at', { written_at: new Date().toISOString() }], ['source_sha256', { source_sha256: 'd'.repeat(64) }]]) {
      const r = await A.c.from('event_imports').update(patch).eq('id', batchA).select()
      check(`A cannot rewrite a batch's ${what}`, !!r.error, r.error?.code)
    }
    check('A cannot declare an incomplete import written', !!(await A.c.from('event_imports').update({ status: 'written' }).eq('id', batchA).select()).error)
    check('A cannot declare an incomplete import verified', !!(await A.c.from('event_imports').update({ status: 'verified' }).eq('id', batchA).select()).error)
    const partial = await A.c.from('event_imports').update({ status: 'written_partial' }).eq('id', batchA).select()
    check('A can label an incomplete import as partial', !partial.error && partial.data?.[0]?.status === 'written_partial', partial.error?.message)
    const late = await A.c.rpc('orbit_import_sessions', { p_batch: batchA, p_items: [rpcItem(2)] })
    check('a finished batch accepts no more sessions', !!late.error, late.error?.code)
    check('a written batch cannot be deleted directly', denied(await A.c.from('event_imports').delete().eq('id', batchA).select()))
    const retire = await A.c.from('event_import_links').update({ retired_at: new Date().toISOString(), retired_reason: 'dismissed' }).eq('source_key', i1.source_key).select()
    check('A can dismiss (retire) a session', !retire.error && retire.data?.length === 1, retire.error?.message)

    // a complete batch earns written, then verified
    const bA2 = await A.c.from('event_imports').insert(batchRow(1, 'e')).select().single()
    const i3 = rpcItem(3)
    const r3 = await A.c.rpc('orbit_import_sessions', { p_batch: bA2.data?.id, p_items: [i3] })
    track('A', 'events', r3.data?.[0]?.event_id)
    const exceed = await A.c.rpc('orbit_import_sessions', { p_batch: bA2.data?.id, p_items: [rpcItem(4)] })
    check('a batch cannot receive more sessions than planned', !!exceed.error, exceed.error?.code)
    const w = await A.c.from('event_imports').update({ status: 'written' }).eq('id', bA2.data?.id).select()
    check('a complete batch can become written', !w.error && w.data?.[0]?.status === 'written' && !!w.data?.[0]?.written_at, w.error?.message)
    const v = await A.c.from('event_imports').update({ status: 'verified' }).eq('id', bA2.data?.id).select()
    check('a written batch whose events are unchanged can become verified', !v.error && v.data?.[0]?.status === 'verified', v.error?.message)
    check('a verified batch cannot be reopened', !!(await A.c.from('event_imports').update({ status: 'in_progress' }).eq('id', bA2.data?.id).select()).error)

    // ---- two users ------------------------------------------------------------------------------------------
    const bB = await B.c.from('event_imports').insert({ ...batchRow(1, 'f') }).select().single()
    check('B can create their own batch (same slug text, separate space)', !bB.error, bB.error?.message)
    check("B cannot read A's batches", denied(await B.c.from('event_imports').select('id').eq('id', batchA)))
    check("B cannot read A's links", denied(await B.c.from('event_import_links').select('id').eq('source_key', i1.source_key)))
    check("B cannot update A's batch", denied(await B.c.from('event_imports').update({ status: 'abandoned' }).eq('id', batchA).select()))
    check("B cannot update A's link", denied(await B.c.from('event_import_links').update({ retired_at: new Date().toISOString(), retired_reason: 'dismissed' }).eq('source_key', i1.source_key).select()))
    check("B cannot delete A's batch or links", denied(await B.c.from('event_imports').delete().eq('id', batchA).select()) && denied(await B.c.from('event_import_links').delete().eq('source_key', i1.source_key).select()))
    const rpcB = await B.c.rpc('orbit_import_sessions', { p_batch: batchA, p_items: [rpcItem(5)] })
    check("B cannot run the import RPC on A's batch", !!rpcB.error, rpcB.error?.code)
    check("B cannot link their import to A's event", !!(await B.c.from('event_import_links').insert({ batch_id: bB.data?.id, source_slug: SLUG, source_key: `${SLUG}|x2`, event_id: evA, imported_snapshot: snapshot, source_snapshot: {} })).error)
    const forgetB = await B.c.rpc('orbit_forget_import_history', { p_slug: SLUG })
    check("B's forget affects only B's own history (A's link survives)", !forgetB.error && forgetB.data?.links_deleted === 0 && (await A.c.from('event_import_links').select('id').eq('source_key', i1.source_key)).data?.length === 1, forgetB.error?.message)
    // B's own forget removed B's batch; A's data must be intact
    check("A's provenance is intact after B's attempts", (await A.c.from('event_import_links').select('id').eq('source_slug', SLUG)).data?.length === 2)
    check("B's own batch is gone after B's forget, A's batches are not", ((await B.c.from('event_imports').select('id')).data ?? []).length === 0 && ((await A.c.from('event_imports').select('id').eq('source_slug', SLUG)).data ?? []).length >= 3)

    // ---- anonymous ------------------------------------------------------------------------------------------
    for (const table of ['event_imports', 'event_import_links']) {
      const r = await anon.from(table).select('*').limit(1)
      check(`anonymous visitors cannot read ${table}`, !!r.error || r.data.length === 0, code(r))
    }
    check('anonymous visitors cannot call the import RPC', !!(await anon.rpc('orbit_import_sessions', { p_batch: randomUUID(), p_items: [rpcItem(6)] })).error)
    check('anonymous visitors cannot call the forget RPC', !!(await anon.rpc('orbit_forget_import_history', { p_slug: SLUG })).error)

    // ---- supported deletion ---------------------------------------------------------------------------------
    const forgetA = await A.c.rpc('orbit_forget_import_history', { p_slug: SLUG })
    check('A can forget their own history through the supported function (events are kept)', !forgetA.error && forgetA.data?.links_deleted === 2 && (await A.c.from('events').select('id').eq('id', evA)).data?.length === 1, forgetA.error?.message)
  }
} catch (err) {
  crashed = true
  console.error(`ERROR: the run stopped unexpectedly (${err instanceof Error ? err.name : 'unknown error'}); details are not printed`)
} finally {
  // each account is cleaned up independently: a failure (or exception) for one never skips the other
  await cleanup('A', A, provenanceActive)
  await cleanup('B', B, provenanceActive)
  for (const who of [A, B]) {
    try {
      await who.c.auth.signOut()
    } catch {
      /* sessions are not persisted; nothing to keep */
    }
  }
}

const failed = results.filter((r) => r.ok === false)
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.ok === null).length} skipped${crashed ? ', run crashed' : ''}`)
if (!requireProvenance && results.some((r) => r.ok === null)) console.log('NOTE: the provenance checks were SKIPPED. This run does NOT verify them; after the migration run again with --require-provenance.')
process.exit(exitCode({ results, crashed, require: requireProvenance }))

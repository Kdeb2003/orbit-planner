// The hosted two-account check (scripts/hosted-two-user-rls-check.mjs) must refuse to run unless it is safe to run.
// These tests execute the REAL script as a child process with only the guard inputs set. Every case must stop BEFORE
// any request is made (exit code 2, or 0 for --dry-run); no network, no Supabase project and no credentials involved.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = resolve('scripts/hosted-two-user-rls-check.mjs')
const PHRASE = 'I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-ROWS-TO-THE-HOSTED-PROJECT'
const good = {
  ORBIT_RLS_CHECK_CONFIRM: PHRASE,
  ORBIT_SUPABASE_URL: 'https://example.invalid',
  ORBIT_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_not_a_real_key',
  ORBIT_USER_A_EMAIL: 'a@example.invalid',
  ORBIT_USER_A_PASSWORD: 'placeholder-a',
  ORBIT_USER_B_EMAIL: 'b@example.invalid',
  ORBIT_USER_B_PASSWORD: 'placeholder-b',
}

function run(over: Record<string, string | undefined>, args: string[] = ['--dry-run']) {
  // A clean environment: nothing from the developer's shell (e.g. real ORBIT_* variables) can leak into the test.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
  for (const [k, v] of Object.entries({ ...good, ...over })) if (v !== undefined) env[k] = v
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 20_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('hosted two-user check: refusal guards (the script is executed, no request is made)', () => {
  it('accepts a complete, valid configuration in --dry-run and says no request was made', () => {
    const r = run({})
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no request was made/)
  })

  it('refuses without the explicit confirmation phrase, and with a wrong one', () => {
    expect(run({ ORBIT_RLS_CHECK_CONFIRM: undefined }).code).toBe(2)
    expect(run({ ORBIT_RLS_CHECK_CONFIRM: 'yes' }).code).toBe(2)
  })

  it('refuses when any required variable is missing', () => {
    for (const k of ['ORBIT_SUPABASE_URL', 'ORBIT_SUPABASE_PUBLISHABLE_KEY', 'ORBIT_USER_A_EMAIL', 'ORBIT_USER_A_PASSWORD', 'ORBIT_USER_B_EMAIL', 'ORBIT_USER_B_PASSWORD']) {
      expect(run({ [k]: undefined }).code, k).toBe(2)
    }
  })

  it('refuses a secret / service-role key (new-style key, and a JWT whose role is service_role)', () => {
    expect(run({ ORBIT_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnop' }).code).toBe(2)
    const jwt = ['e30', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'sig'].join('.')
    expect(run({ ORBIT_SUPABASE_PUBLISHABLE_KEY: jwt }).code).toBe(2)
    expect(run({ ORBIT_SUPABASE_PUBLISHABLE_KEY: 'eyJ.service_role.x' }).code).toBe(2)
  })

  it('refuses a non-https URL, including look-alike local hosts (credentials must never go over plain http to a stranger)', () => {
    expect(run({ ORBIT_SUPABASE_URL: 'http://example.invalid' }).code).toBe(2)
    expect(run({ ORBIT_SUPABASE_URL: 'http://localhost.evil.example' }).code).toBe(2)
    expect(run({ ORBIT_SUPABASE_URL: 'http://127.0.0.1.evil.example:54321' }).code).toBe(2)
    expect(run({ ORBIT_SUPABASE_URL: 'ftp://example.invalid' }).code).toBe(2)
    expect(run({ ORBIT_SUPABASE_URL: 'http://localhost:54321' }).code).toBe(0) // a local stack is allowed
    expect(run({ ORBIT_SUPABASE_URL: 'http://127.0.0.1:54321/' }).code).toBe(0)
  })

  it('refuses two identical accounts (case-insensitive)', () => {
    expect(run({ ORBIT_USER_B_EMAIL: 'A@EXAMPLE.INVALID' }).code).toBe(2)
  })

  it('never echoes passwords or the key in its output', () => {
    for (const over of [{}, { ORBIT_RLS_CHECK_CONFIRM: 'no' }, { ORBIT_SUPABASE_URL: 'http://example.invalid' }]) {
      const out = run(over).out
      expect(out).not.toContain('placeholder-a')
      expect(out).not.toContain('placeholder-b')
      expect(out).not.toContain('sb_publishable_not_a_real_key')
    }
  })
})

describe('hosted two-user check: static properties of the script', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '')

  it('uses no privileged client: only the publishable key and email/password sign-in', () => {
    // the words service_role / sb_secret appear only inside the REFUSAL guard; no variable or call supplies such a key
    expect(code).not.toMatch(/env\('[A-Z_]*(SERVICE|SECRET)[A-Z_]*'\)|process\.env\.[A-Z_]*(SERVICE|SECRET)|auth\.admin/i)
    expect(code).toMatch(/const key = env\('ORBIT_SUPABASE_PUBLISHABLE_KEY'\)/)
    expect(code).toMatch(/createClient\(url, key,/)
    expect(code).toMatch(/signInWithPassword/)
    expect(code).toMatch(/persistSession: false/)
  })

  it('does not print credentials and does not write files', () => {
    expect(code).not.toMatch(/console\.\w+\([^)]*(PASSWORD|PUBLISHABLE_KEY)/)
    expect(code).not.toMatch(/writeFile|appendFile|createWriteStream|localStorage/)
  })

  it('deletes only by tracked id or by this run\'s escaped marker, never with an unscoped delete', () => {
    const deletes = [...code.matchAll(/\.delete\(\)([^\n]*)/g)].map((m) => m[1])
    expect(deletes.length).toBeGreaterThan(0)
    // events/series deletions in cleanup: by .eq('id', …) or .like('title', TITLE_LIKE); the checks use .eq(...)
    for (const d of deletes) expect(d, d).toMatch(/\.eq\(|\.like\('title', TITLE_LIKE\)/)
    expect(code).toMatch(/TITLE\.replace\(\/\[\\\\_%\]\/g/) // LIKE wildcards in the marker are escaped
  })

  it('probes table existence with a normal GET (a HEAD error carries no code) and treats 404 as "missing"', () => {
    expect(code).not.toMatch(/head:\s*true/)
    expect(code).toMatch(/status === 404/)
  })

  it('cleanup runs in a finally block and uses the supported forget function for provenance', () => {
    expect(code).toMatch(/finally\s*\{[\s\S]*cleanup\('A'[\s\S]*cleanup\('B'/)
    expect(code).toMatch(/rpc\('orbit_forget_import_history', \{ p_slug: SLUG \}\)/)
  })

  it('covers every table and both RPCs for two users and anonymous visitors', () => {
    for (const t of ['events', 'recurring_series', 'series_exceptions', 'event_imports', 'event_import_links']) expect(code, t).toContain(t)
    for (const f of ['orbit_import_sessions', 'orbit_forget_import_history']) expect(code, f).toContain(f)
    expect(code).toMatch(/anon\.rpc\('orbit_import_sessions'/)
    expect(code).toMatch(/anon\.rpc\('orbit_forget_import_history'/)
    expect(code).toMatch(/B\.c\.rpc\('orbit_import_sessions'/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Cleanup, provenance mode and exit code (scripts/hostedCheckCore.mjs), driven with FAKE clients. No network.
// ---------------------------------------------------------------------------------------------------------------
import { cleanupUser, exitCode, provenanceDecision, rpcMissing, safeError } from '../../scripts/hostedCheckCore.mjs'

type Row = { id: string; title: string }
interface FakeOpts {
  events?: Row[]
  series?: Row[]
  batches?: number
  links?: number
  /** delete of this table returns an error */
  deleteError?: string[]
  /** delete silently affects nothing for these ids (a row that cannot be removed) */
  sticky?: string[]
  /** reads of this table return an error */
  readError?: string[]
  /** the client throws for this table or rpc */
  throwOn?: string[]
  forgetError?: boolean
}

function fake(o: FakeOpts = {}) {
  const t: Record<string, Row[]> = { events: [...(o.events ?? [])], recurring_series: [...(o.series ?? [])] }
  const calls: string[] = []
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const likeRe = (p: string) => {
    let re = '^'
    for (let i = 0; i < p.length; i++) {
      const ch = p[i]
      if (ch === '\\') re += esc(p[++i] ?? '')
      else if (ch === '%') re += '.*'
      else if (ch === '_') re += '.'
      else re += esc(ch)
    }
    return new RegExp(`${re}$`, 's')
  }
  const from = (table: string) => {
    if (o.throwOn?.includes(table)) throw new Error('boom with a secret-looking detail')
    let op: 'select' | 'delete' = 'select'
    const f: Array<(r: Row) => boolean> = []
    const q = {
      delete: () => {
        op = 'delete'
        return q
      },
      select: () => {
        op = 'select'
        return q
      },
      eq: (c: string, v: string) => {
        f.push((r) => (r as unknown as Record<string, string>)[c] === v)
        return q
      },
      like: (_c: string, p: string) => {
        f.push((r) => likeRe(p).test(r.title))
        return q
      },
      in: (_c: string, v: string[]) => {
        f.push((r) => v.includes(r.id))
        return q
      },
      then: (resolve: (v: unknown) => void) => {
        if (table === 'event_imports' || table === 'event_import_links') {
          const n = table === 'event_imports' ? (o.batches ?? 0) : (o.links ?? 0)
          return resolve(o.readError?.includes(table) ? { data: null, error: { code: 'X1' } } : { data: Array.from({ length: n }, () => ({ id: 'x' })), error: null })
        }
        const rows = t[table]
        const hit = rows.filter((r) => f.every((fn) => fn(r)))
        if (op === 'delete') {
          calls.push(`delete ${table}`)
          if (o.deleteError?.includes(table)) return resolve({ data: null, error: { code: '42501', message: 'denied' } })
          t[table] = rows.filter((r) => !hit.includes(r) || o.sticky?.includes(r.id))
          return resolve({ data: null, error: null })
        }
        if (o.readError?.includes(table)) return resolve({ data: null, error: { code: 'PGRST000', message: 'down' } })
        return resolve({ data: hit.map((r) => ({ id: r.id })), error: null })
      },
    }
    return q
  }
  const rpc = async (name: string) => {
    calls.push(`rpc ${name}`)
    if (o.throwOn?.includes(name)) throw new Error('rpc exploded')
    return o.forgetError ? { data: null, error: { code: 'P0001', message: 'x' } } : { data: {}, error: null }
  }
  return { c: { from, rpc }, t, calls }
}

const MARK = 'ORBIT_RLS_CHECK_ab12cd34'
const LIKE = `${MARK.replace(/[\\_%]/g, (c) => `\\${c}`)}%`
const base = { titleLike: LIKE, slug: 'rls-check-ab12cd34', provenance: false }
const ids = { events: ['e1', 'e2'], series: ['s1'] }
const mine = (): FakeOpts => ({ events: [{ id: 'e1', title: MARK }, { id: 'e2', title: `${MARK}_1` }], series: [{ id: 's1', title: MARK }] })

describe('hosted check: cleanup failures make the run FAIL', () => {
  it('passes only when every tracked and marked record is gone and verified', async () => {
    const f = fake({ ...mine(), events: [...mine().events!, { id: 'stray', title: `${MARK}_forged` }, { id: 'other', title: 'a real event' }] })
    const r = await cleanupUser({ c: f.c, tracked: ids, ...base })
    expect(r).toMatchObject({ ok: true, remaining: 0, problems: [] })
    expect(f.t.events.map((x) => x.id)).toEqual(['other']) // the marker sweep removed the stray row, and ONLY run rows
  })

  it('FAILS when a tracked record cannot be deleted (error) and when it silently stays (zero rows affected)', async () => {
    const denied = await cleanupUser({ c: fake({ ...mine(), deleteError: ['events'] }).c, tracked: ids, ...base })
    expect(denied.ok).toBe(false)
    expect(denied.problems.join()).toMatch(/delete event e1: 42501/)
    expect(denied.remaining).toBeGreaterThan(0)
    const sticky = await cleanupUser({ c: fake({ ...mine(), sticky: ['e2'] }).c, tracked: ids, ...base })
    expect(sticky.ok).toBe(false)
    expect(sticky.problems.join()).toMatch(/run-created record\(s\) remain/)
  })

  it('FAILS when the scoped sweeps or the verification reads fail (an unreadable table is not "empty")', async () => {
    const r = await cleanupUser({ c: fake({ ...mine(), readError: ['events'] }).c, tracked: ids, ...base })
    expect(r.ok).toBe(false)
    expect(r.problems.join()).toMatch(/verify events by marker: PGRST000/)
    const sweep = await cleanupUser({ c: fake({ ...mine(), deleteError: ['recurring_series'] }).c, tracked: ids, ...base })
    expect(sweep.ok).toBe(false)
    expect(sweep.problems.join()).toMatch(/sweep series by marker/)
  })

  it('FAILS, never throws, and keeps going when the client throws; the message carries no exception text', async () => {
    const f = fake({ ...mine(), throwOn: ['recurring_series'] })
    const r = await cleanupUser({ c: f.c, tracked: ids, ...base })
    expect(r.ok).toBe(false)
    expect(f.calls).toContain('delete events') // the events were still cleaned although the series step blew up
    expect(JSON.stringify(r)).not.toMatch(/secret-looking/)
    const forget = await cleanupUser({ c: fake({ ...mine(), throwOn: ['orbit_forget_import_history'] }).c, tracked: ids, ...base, provenance: true })
    expect(forget.ok).toBe(false)
    expect(forget.problems.join()).toMatch(/forget import history: threw/)
  })

  it('with provenance active it forgets the run history FIRST and fails on leftover batches or links', async () => {
    const f = fake({ ...mine() })
    await cleanupUser({ c: f.c, tracked: ids, ...base, provenance: true })
    expect(f.calls[0]).toBe('rpc orbit_forget_import_history')
    const left = await cleanupUser({ c: fake({ ...mine(), batches: 1, links: 2 }).c, tracked: ids, ...base, provenance: true })
    expect(left.ok).toBe(false)
    expect(left.remaining).toBe(3)
    const err = await cleanupUser({ c: fake({ ...mine(), forgetError: true }).c, tracked: ids, ...base, provenance: true })
    expect(err.problems.join()).toMatch(/forget import history: P0001/)
    const off = fake({ ...mine() })
    await cleanupUser({ c: off.c, tracked: ids, ...base })
    expect(off.calls.some((c) => c.startsWith('rpc'))).toBe(false) // provenance absent: no RPC, no provenance reads
  })

  it('the marker pattern escapes LIKE wildcards: look-alike titles of other records are not swept', async () => {
    const f = fake({ events: [{ id: 'lookalike', title: 'ORBITxRLSxCHECKxab12cd34' }, { id: 'e1', title: MARK }] })
    await cleanupUser({ c: f.c, tracked: { events: ['e1'], series: [] }, ...base })
    expect(f.t.events.map((x) => x.id)).toEqual(['lookalike'])
  })

  it('error text is reduced to a code or a short message (nothing else can leak)', () => {
    expect(safeError({ code: '42501', message: 'row contains secrets' })).toBe('42501')
    expect(safeError({ message: 'x'.repeat(500) })).toHaveLength(80)
    expect(safeError(undefined)).toBe('error')
  })
})

describe('hosted check: provenance mode and exit code', () => {
  it('pre-migration: provenance absent is a SKIP; with --require-provenance it is a FAIL, never a silent pass', () => {
    expect(provenanceDecision({ tables: false, rpcs: false, require: false }).action).toBe('skip')
    expect(provenanceDecision({ tables: false, rpcs: false, require: true }).action).toBe('fail')
    expect(provenanceDecision({ tables: true, rpcs: true, require: true }).action).toBe('run')
    expect(provenanceDecision({ tables: true, rpcs: true, require: false }).action).toBe('run')
  })

  it('a half-deployed provenance feature fails in every mode (tables without RPCs, or RPCs without tables)', () => {
    for (const require of [false, true]) {
      expect(provenanceDecision({ tables: true, rpcs: false, require }).action).toBe('fail')
      expect(provenanceDecision({ tables: false, rpcs: true, require }).action).toBe('fail')
    }
  })

  it('recognises a missing RPC (404 / PGRST202) but not a validation error from an existing one', () => {
    expect(rpcMissing({ status: 404, error: { code: 'PGRST202', message: 'x' } })).toBe(true)
    expect(rpcMissing({ status: 404, error: { message: 'Could not find the function public.x' } })).toBe(true)
    expect(rpcMissing({ status: 400, error: { code: '22023', message: 'invalid source slug' } })).toBe(false)
    expect(rpcMissing({ status: 200, data: {} })).toBe(false)
  })

  it('exit code: 0 only when nothing failed or crashed; a skip fails only in require mode; a failed cleanup check fails', () => {
    const pass = { name: 'a', ok: true }
    expect(exitCode({ results: [pass], crashed: false, require: false })).toBe(0)
    expect(exitCode({ results: [pass, { name: 's', ok: null }], crashed: false, require: false })).toBe(0)
    expect(exitCode({ results: [pass, { name: 's', ok: null }], crashed: false, require: true })).toBe(1)
    expect(exitCode({ results: [pass, { name: 'cleanup A', ok: false }], crashed: false, require: false })).toBe(1)
    expect(exitCode({ results: [pass], crashed: true, require: false })).toBe(1)
  })

  it('the script accepts --require-provenance in --dry-run and names the mode; the mode never relaxes the guards', () => {
    const r = run({}, ['--dry-run', '--require-provenance'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/provenance required/)
    expect(run({ ORBIT_RLS_CHECK_CONFIRM: undefined }, ['--dry-run', '--require-provenance']).code).toBe(2)
    expect(run({}, ['--dry-run']).out).toMatch(/pre-migration mode/)
  })
})

describe('hosted check: wiring of the script (static)', () => {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  it('every cleanup becomes a check, runs for both users independently, and the exit code comes from exitCode()', () => {
    expect(src).toMatch(/check\(`cleanup \$\{label\}:[^`]*`, outcome\.ok/)
    expect(src).toMatch(/await cleanup\('A', A, provenanceActive\)\s*\n\s*await cleanup\('B', B, provenanceActive\)/)
    expect(src).toMatch(/catch \{\s*outcome = \{ ok: false/s) // a throwing cleanup is a failed check, never an unhandled rejection
    expect(src).toMatch(/process\.exit\(exitCode\(\{ results, crashed, require: requireProvenance \}\)\)/)
    expect(src).not.toMatch(/process\.exit\(failed\.length/)
  })

  it('in require mode a skipped check is turned into a failure, and the provenance decision uses tables AND rpcs', () => {
    expect(src).toMatch(/if \(requireProvenance\) return check\(name, false/)
    expect(src).toMatch(/provenanceDecision\(\{ tables, rpcs, require: requireProvenance \}\)/)
    expect(src).toMatch(/exists\(A\.c, 'event_imports'\)\) && \(await exists\(A\.c, 'event_import_links'\)/)
    expect(src).toMatch(/orbit_import_sessions', \{ p_batch: randomUUID\(\), p_items: \[\] \}/) // probe is rejected before any write
  })

  it('the unchanged-owner assertions address the original exception by series_id AND original_date (two exceptions must not cause a false FAIL)', () => {
    expect(src).not.toMatch(/from\('series_exceptions'\)\.select\('cancelled'\)\.eq\('series_id', serA\)\.single\(\)/)
    expect(src).toMatch(/select\('cancelled, override'\)\.eq\('series_id', serA\)\.eq\('original_date', '2030-01-21'\)\.single\(\)/)
    expect(src).toMatch(/exactly its two own exceptions/)
    // every .single() on series_exceptions is keyed by the full primary key
    for (const m of src.matchAll(/from\('series_exceptions'\)[^\n]*?\.single\(\)/g)) expect(m[0], m[0]).toMatch(/original_date/)
  })

  it('the foreign-user exception test uses a VALID edit with an override, targets the exact occurrence, has an owner control and an unchanged-owner check', () => {
    expect(src).toMatch(/validPatch = \{ cancelled: true, override: \{ title:/)
    expect(src).toMatch(/B\.c\.from\('series_exceptions'\)\.update\(validPatch\)\.eq\('series_id', serA\)\.eq\('original_date', '2030-01-21'\)/)
    expect(src).toMatch(/control: the same edit IS accepted for the owner/)
    expect(src).toMatch(/unchanged after B's edit attempt/)
    expect(src).not.toMatch(/update\(\{ cancelled: false \}\)/)
  })
})

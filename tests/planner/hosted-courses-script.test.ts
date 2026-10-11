// The hosted Courses check (scripts/hosted-courses-check.mjs) must refuse to run unless it is safe to run. These tests execute
// the REAL script as a child process; every refusal stops BEFORE any request. No hosted project, credentials or secrets.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONFIRM, REQUIRED, maskEmail, safeCode, validateConfig } from '../../scripts/hostedCoursesCore.mjs'

const SCRIPT = resolve('scripts/hosted-courses-check.mjs')
const PRELOAD = pathToFileURL(resolve('tests/planner/noNetworkPreload.mjs')).href
const CALENDAR_PHRASE = 'I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-ROWS-TO-THE-HOSTED-PROJECT'
const good: Record<string, string> = {
  ORBIT_COURSES_CHECK_CONFIRM: CONFIRM,
  ORBIT_SUPABASE_URL: 'https://example.invalid',
  ORBIT_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_not_a_real_key',
  ORBIT_USER_A_EMAIL: 'a@example.invalid',
  ORBIT_USER_A_PASSWORD: 'placeholder-a',
  ORBIT_USER_B_EMAIL: 'b@example.invalid',
  ORBIT_USER_B_PASSWORD: 'placeholder-b',
}

function run(over: Record<string, string | undefined>, args: string[] = ['--dry-run'], noNetwork = true) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } // nothing from the developer's shell
  for (const [k, v] of Object.entries({ ...good, ...over })) if (v !== undefined) env[k] = v
  const node = noNetwork ? ['--import', PRELOAD] : []
  const r = spawnSync(process.execPath, [...node, SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('hosted Courses check: refusal guards (no request is made)', () => {
  it('a valid configuration passes --dry-run, which is truly offline (a connection attempt would exit 99)', () => {
    const r = run({})
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no request was made/)
    expect(r.out).not.toContain('NETWORK-ATTEMPT')
  })

  it('the offline guard itself works (a real request under the same preload is stopped)', () => {
    const r = spawnSync(process.execPath, ['--import', PRELOAD, '-e', "fetch('http://127.0.0.1:9')"], { encoding: 'utf8', timeout: 20_000 })
    expect(r.status).toBe(99)
  })

  it('refuses without the confirmation phrase, with a wrong one and with the calendar check phrase', () => {
    expect(run({ ORBIT_COURSES_CHECK_CONFIRM: undefined }).code).toBe(2)
    expect(run({ ORBIT_COURSES_CHECK_CONFIRM: 'yes' }).code).toBe(2)
    expect(run({ ORBIT_COURSES_CHECK_CONFIRM: CALENDAR_PHRASE }).code).toBe(2)
    expect(run({ ORBIT_COURSES_CHECK_CONFIRM: undefined, ORBIT_RLS_CHECK_CONFIRM: CALENDAR_PHRASE }).code).toBe(2)
    expect(run({ ORBIT_COURSES_CHECK_CONFIRM: undefined }, []).code).toBe(2) // also without --dry-run: refused, nothing sent
  })

  it('refuses when any required variable is missing', () => {
    for (const k of ['ORBIT_SUPABASE_URL', 'ORBIT_SUPABASE_PUBLISHABLE_KEY', 'ORBIT_USER_A_EMAIL', 'ORBIT_USER_A_PASSWORD', 'ORBIT_USER_B_EMAIL', 'ORBIT_USER_B_PASSWORD']) {
      expect(run({ [k]: undefined }).code, k).toBe(2)
    }
  })

  it('refuses a secret / service-role key in every form, and never prints it', () => {
    const jwt = ['e30', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'sig'].join('.')
    for (const k of ['sb_secret_abcdefghijklmnop', jwt, 'eyJ.service_role.x']) {
      const r = run({ ORBIT_SUPABASE_PUBLISHABLE_KEY: k })
      expect(r.code).toBe(2)
      expect(r.out).not.toContain(k)
    }
  })

  it('refuses a non-https URL, including look-alike local hosts; allows a local stack', () => {
    for (const u of ['http://example.invalid', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example:54321', 'ftp://example.invalid']) expect(run({ ORBIT_SUPABASE_URL: u }).code, u).toBe(2)
    expect(run({ ORBIT_SUPABASE_URL: 'http://localhost:54321' }).code).toBe(0)
    expect(run({ ORBIT_SUPABASE_URL: 'http://127.0.0.1:54321/' }).code).toBe(0)
  })

  it('refuses two identical accounts (case-insensitive)', () => {
    expect(run({ ORBIT_USER_B_EMAIL: 'A@EXAMPLE.INVALID' }).code).toBe(2)
  })

  it('an authentication failure stops the run (exit 2) before any write and prints no credential', () => {
    // the only request is the sign-in, sent to a closed LOCAL port: nothing leaves this machine
    const r = run({ ORBIT_SUPABASE_URL: 'http://127.0.0.1:9' }, [], false)
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/could not sign in A/)
    for (const secret of ['placeholder-a', 'placeholder-b', 'sb_publishable_not_a_real_key', 'a@example.invalid']) expect(r.out).not.toContain(secret)
  })

  it('a sign-in rejected WITHOUT an error code prints only a generic identifier, never the server text', async () => {
    // a throw-away loopback server answers every request with a code-less error whose text looks like a secret
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'LEAK-ME password=hunter2 token=eyJhbGciOiJIUzI1NiJ9', hint: 'SECRET-HINT' }))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const port = (server.address() as { port: number }).port
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...good, ORBIT_SUPABASE_URL: `http://127.0.0.1:${port}` }
    const child = spawn(process.execPath, [SCRIPT], { env })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const code = await new Promise<number | null>((done) => child.on('close', done))
    await new Promise((done) => server.close(done))
    expect(code).toBe(2)
    expect(out).toMatch(/could not sign in A.*E_UNKNOWN/)
    for (const secret of ['LEAK-ME', 'hunter2', 'eyJhbGci', 'SECRET-HINT', 'placeholder-a', 'a@example.invalid']) expect(out).not.toContain(secret)
  })

  it('safeCode only passes SQLSTATE-like and PostgREST codes', () => {
    expect(safeCode({ code: '23505', message: 'x' })).toBe('23505')
    expect(safeCode({ code: 'PGRST205' })).toBe('PGRST205')
    for (const bad of [{ message: 'password=hunter2' }, { code: 'sk_live_SECRET' }, { code: 'x'.repeat(100) }, {}, null]) expect(safeCode(bad)).toBe('E_UNKNOWN')
  })

  it('never echoes passwords or the key in any refusal', () => {
    for (const over of [{}, { ORBIT_COURSES_CHECK_CONFIRM: 'no' }, { ORBIT_SUPABASE_URL: 'http://example.invalid' }, { ORBIT_USER_B_EMAIL: 'a@example.invalid' }]) {
      const out = run(over).out
      for (const secret of ['placeholder-a', 'placeholder-b', 'sb_publishable_not_a_real_key']) expect(out).not.toContain(secret)
    }
  })

  it('validateConfig names a problem without ever returning a value of the environment', () => {
    expect(validateConfig({})).toMatchObject({ ok: false })
    const bad = validateConfig({ ...good, ORBIT_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_topsecretvalue' })
    expect(bad).toMatchObject({ ok: false })
    expect(JSON.stringify(bad)).not.toContain('topsecretvalue')
    expect(maskEmail('someone@example.invalid')).toBe('s***@example.invalid')
  })
})

describe('hosted Courses check: static properties of the scripts', () => {
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '')
  const entry = strip(readFileSync(SCRIPT, 'utf8'))
  const core = strip(readFileSync(resolve('scripts/hostedCoursesCore.mjs'), 'utf8'))

  it('uses only the publishable key and password sign-in; no privileged client, no files, no printed credentials', () => {
    for (const src of [entry, core]) {
      expect(src).not.toMatch(/env\('[A-Z_]*(SERVICE|SECRET)[A-Z_]*'\)|process\.env\.[A-Z_]*(SERVICE|SECRET)|auth\.admin/i)
      expect(src).not.toMatch(/writeFile|appendFile|createWriteStream|localStorage/)
      expect(src).not.toMatch(/console\.\w+\([^)]*(PASSWORD|PUBLISHABLE_KEY)/)
    }
    expect(entry).toMatch(/const key = env\('ORBIT_SUPABASE_PUBLISHABLE_KEY'\)/)
    expect(entry).toMatch(/signInWithPassword/)
    expect(entry).toMatch(/persistSession: false/)
  })

  it('creates no client before the guards and the dry-run exit (supabase-js is imported dynamically afterwards)', () => {
    expect(entry).not.toMatch(/^import .*@supabase\/supabase-js/m)
    expect(entry.indexOf('validateConfig(process.env)')).toBeGreaterThan(-1)
    expect(entry.indexOf('validateConfig(process.env)')).toBeLessThan(entry.indexOf('--dry-run'))
    expect(entry.indexOf('--dry-run')).toBeLessThan(entry.indexOf("import('@supabase/supabase-js')"))
  })

  it('only ever deletes by id or by this run marker, and only from the courses table', () => {
    const deletes = [...core.matchAll(/\.delete\(\)([^\n]*)/g)].map((m) => m[1])
    expect(deletes.length).toBeGreaterThan(0)
    for (const d of deletes) expect(d, d).toMatch(/\.eq\('id'|\.like\('name', nameLike\)/)
    expect(core).toMatch(/MARK\.replace\(\/\[\\\\_%\]\/g/)
    const tables = new Set([...core.matchAll(/\.from\('(\w+)'\)/g)].map((m) => m[1]))
    expect([...tables]).toEqual(['courses'])
  })

  it('cleanup runs in a finally block for both accounts and its failure fails the run', () => {
    expect(core).toMatch(/finally\s*\{[\s\S]*cleanupCourses[\s\S]*cleanup-\$\{who\}/)
    expect(core).toMatch(/exitCode\(\{ results, crashed, require: true \}\)/)
  })

  it('has no skip mode and lists every required check once', () => {
    expect(core).not.toMatch(/skipped\(|ok: null|--require-/)
    expect(new Set(REQUIRED).size).toBe(REQUIRED.length)
    for (const id of REQUIRED) expect(core, id).toContain(`'${id}'`)
  })

  it('has its own error formatter: it does not use the shared one that can fall back to a message', () => {
    for (const src of [entry, core]) expect(src).not.toMatch(/\bsafeError\b/)
    expect(core).not.toMatch(/\$\{[^}]*\.(message|details|hint|name)\b/)
  })

  it('is separate from the calendar/provenance script', () => {
    expect(entry).not.toMatch(/hosted-two-user-rls-check/)
    expect(core).not.toMatch(/event_imports|recurring_series|series_exceptions|from\('events'\)/)
  })
})

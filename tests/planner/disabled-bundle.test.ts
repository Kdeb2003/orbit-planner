// ACCEPTANCE L-8: with the planner feature OFF, the planner implementation must not be part of what the browser loads
// at start-up. This builds the real production bundle (flag off) into a temporary folder and inspects it.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Strings that only exist in the planner data layer (API, mappers, source).
// (data layer + the Courses page/dialogs)
const MARKERS = ['duplicate_course', 'planner_unavailable', 'courses_user_code_institution_term_key', 'term_start', 'unconfirmed', 'No courses yet', 'Courses need an ORBIT account', 'Keep my entries', 'Suggest from my calendar', 'outside-term']

let out = ''
const assets = () => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'))
const read = (f: string) => readFileSync(join(out, 'assets', f), 'utf8')

/** Chunks needed before anything runs: the entry script plus everything it imports STATICALLY (not `import(...)`). */
function startupChunks(): string[] {
  const html = readFileSync(join(out, 'index.html'), 'utf8')
  const queue = [...html.matchAll(/(?:src|href)="[^"]*?assets\/([^"/]+\.js)"/g)].map((m) => m[1])
  const seen = new Set<string>()
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const m of read(f).matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) queue.push(m[1])
  }
  return [...seen]
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'orbit-bundle-'))
  const saved = process.env.VITE_ENABLE_PLANNER_COURSES
  process.env.VITE_ENABLE_PLANNER_COURSES = 'false'
  try {
    await build({
      root: resolve('.'),
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true, reportCompressedSize: false },
    })
  } finally {
    if (saved === undefined) delete process.env.VITE_ENABLE_PLANNER_COURSES
    else process.env.VITE_ENABLE_PLANNER_COURSES = saved
  }
}, 240_000)

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true })
})

describe('production bundle with VITE_ENABLE_PLANNER_COURSES=false', () => {
  it('the start-up chunks contain no planner data-layer code', () => {
    const startup = startupChunks()
    expect(startup.length).toBeGreaterThanOrEqual(1)
    for (const f of startup) {
      for (const m of MARKERS) expect(read(f).includes(m), `${f} contains "${m}"`).toBe(false)
    }
  })

  it('the planner code still exists, in separate chunks that only an explicit dynamic import can load', () => {
    const startup = new Set(startupChunks())
    const lazy = assets().filter((f) => !startup.has(f) && MARKERS.some((m) => read(f).includes(m)))
    expect(lazy.length).toBeGreaterThanOrEqual(1)
    // and the start-up code reaches them only through import(): they are named there, never statically imported
    const entry = [...startup].map(read).join('\n')
    for (const f of lazy) {
      const staticImport = new RegExp(`(?:\\bfrom|\\bimport)\\s*["']\\./${f.replace('.', '\\.')}["']`)
      expect(staticImport.test(entry), `${f} is imported statically`).toBe(false)
    }
  })

  it('no request to the courses table exists in the start-up code', () => {
    for (const f of startupChunks()) expect(/from\(\s*["'`]courses["'`]\s*\)/.test(read(f)), f).toBe(false)
  })
})

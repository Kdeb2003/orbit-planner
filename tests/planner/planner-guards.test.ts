// Guards for Phase 4B.1b (Courses cloud layer): the feature is OFF by default and pinned off in production, the
// planner code is cloud-only (no browser storage, no calendar stores), and only plannerApi.ts builds requests for the
// courses table. These are static checks over the repository; they run without any backend.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === '__fixtures__' ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : []
  })
const rel = (f: string) => relative(resolve('.'), f).split(sep).join('/')
const isTest = (f: string) => /\.test\.tsx?$/.test(f)

const FLAG = 'VITE_ENABLE_PLANNER_COURSES'

describe('feature flag VITE_ENABLE_PLANNER_COURSES', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  const flag = async () => (await import('../../src/planner/flag')).PLANNER_COURSES_ENABLED

  it('defaults to OFF when the variable is absent', async () => {
    vi.stubEnv(FLAG, undefined as unknown as string)
    vi.resetModules()
    expect(await flag()).toBe(false)
  })

  it('is ON only for the exact string "true"', async () => {
    for (const [value, expected] of [['true', true], ['false', false], ['', false], ['1', false], ['TRUE', false], ['yes', false], [' true', false]] as const) {
      vi.stubEnv(FLAG, value)
      vi.resetModules()
      expect(await flag(), JSON.stringify(value)).toBe(expected)
    }
  })

  it('is read only in src/planner/flag.ts', () => {
    const readers = walk(resolve('src')).filter((f) => !isTest(f) && !f.endsWith('.d.ts') && code(f).includes(FLAG)).map(rel)
    expect(readers).toEqual(['src/planner/flag.ts'])
  })

  it('the production deploy workflow pins it to \'false\' (and nothing in the workflow can turn it on)', () => {
    const wf = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8')
    expect(wf).toMatch(/^\s*VITE_ENABLE_PLANNER_COURSES: 'false'\s*$/m)
    expect(wf.match(/VITE_ENABLE_PLANNER_COURSES/g)).toHaveLength(1)
    expect(wf).not.toMatch(/VITE_ENABLE_PLANNER_COURSES:\s*['"]?(true|1|yes)/i)
    expect(wf).not.toMatch(/VITE_ENABLE_PLANNER_COURSES:\s*\$\{\{/) // not taken from a variable/secret either
  })

  it('no workflow other than deploy.yml and no tracked env file enables it', () => {
    for (const n of readdirSync(resolve('.github/workflows'))) {
      const text = readFileSync(resolve('.github/workflows', n), 'utf8')
      expect(text, n).not.toMatch(new RegExp(`${FLAG}:\\s*['"]?true`, 'i'))
    }
    for (const n of ['.env', '.env.production', '.env.development', '.env.test']) {
      if (existsSync(resolve(n)) && !n.endsWith('.local')) {
        // these names are git-ignored by `.env.*`, but guard anyway should one ever be committed
        expect(readFileSync(resolve(n), 'utf8'), n).not.toMatch(new RegExp(`^\\s*${FLAG}\\s*=\\s*['"]?true`, 'mi'))
      }
    }
  })

  it('.env.example documents it only as a commented-out example', () => {
    const env = readFileSync(resolve('.env.example'), 'utf8')
    expect(env).toMatch(new RegExp(`^# ${FLAG}=true`, 'm'))
    expect(env).not.toMatch(new RegExp(`^${FLAG}=`, 'm'))
  })

  it('is declared in the typed env', () => {
    expect(readFileSync(resolve('src/vite-env.d.ts'), 'utf8')).toContain(`readonly ${FLAG}?: string`)
  })

  it('the Playwright and Vite configs do not switch it on', () => {
    for (const f of ['playwright.config.ts', 'vite.config.ts']) {
      if (existsSync(resolve(f))) expect(readFileSync(resolve(f), 'utf8'), f).not.toContain(FLAG)
    }
  })
})

describe('planner code is cloud-only and isolated', () => {
  const plannerFiles = [
    ...walk(resolve('src/planner')),
    ...walk(resolve('src/cloud')).filter((f) => /planner/i.test(f)),
  ].filter((f) => !isTest(f))

  it('covers the new modules', () => {
    const names = plannerFiles.map(rel)
    for (const n of ['src/planner/plannerSource.ts', 'src/planner/flag.ts', 'src/planner/PlannerContext.ts', 'src/cloud/plannerApi.ts', 'src/cloud/plannerMappers.ts', 'src/cloud/fakePlannerApi.ts', 'src/cloud/plannerTypes.ts']) {
      expect(names).toContain(n)
    }
  })

  it('never touches browser storage, the calendar stores, logging or secret keys', () => {
    for (const f of plannerFiles) {
      expect(code(f), rel(f)).not.toMatch(
        /localStorage|sessionStorage|indexedDB|orbit\.events|orbit\.series|\borbit\.[a-z]+\.v\d|eventStore|seriesStore|console\.\w+|service[_-]?role|sb_secret/i,
      )
    }
  })

  it('src/planner never imports a Supabase client (only the injected PlannerApi may talk to the server)', () => {
    for (const f of walk(resolve('src/planner')).filter((f) => !isTest(f))) {
      expect(code(f), rel(f)).not.toMatch(/@supabase|lib\/supabase|\bfetch\s*\(|XMLHttpRequest|sendBeacon/)
    }
  })

  it('only src/cloud/plannerApi.ts builds requests for the courses table', () => {
    const users = walk(resolve('src')).filter((f) => !isTest(f) && /\.from\(\s*['"`]courses['"`]\s*\)/.test(code(f))).map(rel)
    expect(users).toEqual(['src/cloud/plannerApi.ts'])
  })

  it('the planner never sends a user id, timestamps or generated key columns in a write', () => {
    const mappers = code(resolve('src/cloud/plannerMappers.ts'))
    const writeFns = mappers.slice(mappers.indexOf('export function coursePatch'), mappers.indexOf('const blankToNull'))
    expect(writeFns).not.toMatch(/user_id|created_at|updated_at|archived_at|_key\b/)
    const api = code(resolve('src/cloud/plannerApi.ts'))
    expect(api).not.toMatch(/user_id/)
  })

  it('the existing calendar data layer does not depend on the planner', () => {
    for (const f of ['src/cloud/cloudApi.ts', 'src/cloud/mappers.ts', 'src/cloud/fakeCloudApi.ts', 'src/calendar/cloudSource.ts', 'src/calendar/autoRefresh.ts', 'src/calendar/localSource.ts', 'src/cloud/importApi.ts']) {
      expect(code(resolve(f)), f).not.toMatch(/planner/i)
    }
  })

  it('the planner modules are reachable only from the session wiring (no page, route or navigation uses them yet)', () => {
    const importers = walk(resolve('src'))
      .filter((f) => !isTest(f) && !/src[\\/](planner|cloud)[\\/]/.test(f))
      .filter((f) => /planner\/|plannerApi|plannerSource|usePlanner|PlannerContext/.test(code(f)))
      .map(rel)
      .sort()
    expect(importers).toEqual(['src/calendar/CalendarProvider.tsx', 'src/calendar/calendarManager.ts'])
    // no Courses route and no navigation entry yet (the page is Checkpoint 2B)
    for (const f of ['src/App.tsx', 'src/layouts/navItems.ts', 'src/layouts/AppLayout.tsx']) {
      expect(code(resolve(f)), f).not.toMatch(/path=["']courses|to:\s*['"]\/courses|['"]\/courses|label:\s*['"]Courses/i)
    }
    expect(existsSync(resolve('src/pages/CoursesPage.tsx'))).toBe(false)
  })
})

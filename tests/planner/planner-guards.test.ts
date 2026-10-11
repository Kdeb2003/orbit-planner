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

  it('Vite config never sets it; Playwright turns it on only for the dedicated "courses" server and pins it off for "auth"', () => {
    expect(readFileSync(resolve('vite.config.ts'), 'utf8')).not.toContain(FLAG)
    const pw = readFileSync(resolve('playwright.config.ts'), 'utf8')
    const servers = pw.slice(pw.indexOf('webServer:')).split(/\r?\n {4}\{\r?\n/).slice(1)
    const withFlag = servers.filter((b) => b.includes(FLAG))
    expect(withFlag).toHaveLength(2)
    const on = withFlag.filter((b) => new RegExp(`${FLAG}: 'true'`).test(b))
    expect(on).toHaveLength(1)
    expect(on[0]).toContain('--port 5197')
    expect(withFlag.find((b) => b.includes('--port 5198'))).toMatch(new RegExp(`${FLAG}: ''`))
    // the local-mode and production-build servers never enable it
    for (const port of ['5199', '5201']) expect(servers.find((b) => b.includes(`--port ${port}`) || b.includes(`${port}`))).not.toMatch(new RegExp(`${FLAG}: 'true'`))
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

  it('the planner modules are reachable only from the session wiring, the feature-gated routes/navigation and the Courses UI', () => {
    const importers = walk(resolve('src'))
      .filter((f) => !isTest(f) && !/src[\\/](planner|cloud)[\\/]/.test(f))
      .filter((f) => /planner\/|plannerApi|plannerSource|usePlanner|PlannerContext/.test(code(f)))
      .map(rel)
      .sort()
    // (the calendar rows import only the TYPE of the read-only course annotation)
    const allowed = ['src/App.tsx', 'src/calendar/CalendarProvider.tsx', 'src/calendar/calendarManager.ts', 'src/layouts/AppLayout.tsx', 'src/pages/CoursesPage.tsx', 'src/pages/TodayPage.tsx', 'src/pages/CalendarPage.tsx', 'src/components/EventItem.tsx', 'src/components/Timeline.tsx']
    expect(importers.filter((f) => !allowed.includes(f) && !f.startsWith('src/components/planner/'))).toEqual([])
    for (const f of allowed) expect(importers).toContain(f)
  })
})

describe('the Courses UI is flag-gated (Checkpoint 2B.1)', () => {
  const app = code(resolve('src/App.tsx'))

  it('the Courses page is only ever loaded through a dynamic import, never statically', () => {
    expect(app).toMatch(/lazy\(\(\) => import\('\.\/pages\/CoursesPage'\)/)
    for (const f of walk(resolve('src')).filter((f) => !isTest(f))) {
      expect(code(f), rel(f)).not.toMatch(/^\s*import[^'"]*from\s+['"][^'"]*pages\/CoursesPage['"]/m)
    }
  })

  it('both Courses routes are registered only when the feature is on', () => {
    expect(app).toMatch(/const plannerOn = isPlannerFeatureOn\(createPlannerApi\)/)
    expect(app).toMatch(/\{plannerOn && <Route path="plan" /)
    expect(app).toMatch(/\{plannerOn && \(\s*<Route\s+path="plan\/courses"/)
    expect(app.match(/path="plan/g)).toHaveLength(2) // nothing else exposes the section
  })

  it('without the feature the navigation is exactly the five existing entries (no Plan)', async () => {
    const { getNavItems, navItems } = await import('../../src/layouts/navItems')
    expect(getNavItems(false)).toBe(navItems)
    expect(navItems.map((i) => i.label)).toEqual(['Today', 'Calendar', 'Study Planner', 'Insights', 'Settings'])
    expect(navItems.some((i) => /plan\b|courses|tasks|exams/i.test(i.to))).toBe(false)
  })

  it('with the feature the bar still has five slots; one Plan entry replaces the Study Planner slot; no Tasks/Exams entry', async () => {
    const { getNavItems } = await import('../../src/layouts/navItems')
    const on = getNavItems(true)
    expect(on).toHaveLength(5)
    expect(on.map((i) => i.label)).toEqual(['Today', 'Calendar', 'Plan', 'Insights', 'Settings'])
    expect(on.find((i) => i.label === 'Plan')).toMatchObject({ to: '/plan', alsoActiveFor: ['/study'] })
    expect(on.some((i) => /tasks|exams/i.test(i.label + i.to))).toBe(false)
  })

  it('the Study Planner route and its Demo data label are untouched', () => {
    expect(app).toMatch(/<Route path="study" element=\{<StudyPlannerPage \/>\} \/>/)
    expect(code(resolve('src/pages/StudyPlannerPage.tsx'))).toContain('<Badge>Demo data</Badge>')
  })

  it('the Courses UI uses theme tokens only (no hex colours), no storage, no calendar writes and no direct Supabase access', () => {
    const files = [...walk(resolve('src/components/planner')), resolve('src/pages/CoursesPage.tsx')].filter((f) => !isTest(f))
    expect(files.length).toBeGreaterThanOrEqual(6)
    for (const f of files) {
      const c = code(f)
      expect(c, rel(f)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/)
      // The Courses UI READS the calendar snapshot (useCalendar) to derive suggestions; it never calls a calendar write.
      expect(c, rel(f)).not.toMatch(/localStorage|sessionStorage|indexedDB|eventStore|seriesStore|createEvent|updateEvent|removeEvent|createSeries|updateSeries|removeSeries|setException|clearException|cal\.source|@supabase|lib\/supabase|\bfetch\s*\(|console\.\w+/)
    }
  })

  it('the course colour tokens exist in the theme', () => {
    const css = readFileSync(resolve('src/styles/index.css'), 'utf8')
    for (let n = 1; n <= 8; n++) expect(css).toMatch(new RegExp(`--color-c${n}:\\s*#[0-9a-f]{6};`, 'i'))
  })
})

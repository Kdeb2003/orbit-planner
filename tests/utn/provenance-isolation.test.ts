// The provenance modules (src/timetable/provenance) stay PURE (no I/O). Checkpoint 3 wires them into the confirmed save
// path only, through the reviewed files listed below; the preview parser and review UI must not import them.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === '__fixtures__' ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : []
  })

describe('timetable provenance code (design stage)', () => {
  const own = walk(resolve('src/timetable/provenance')).filter((f) => !/\.test\.ts$/.test(f))

  it('is pure: no network, storage, Supabase client, calendar source or logging', () => {
    expect(own.length).toBeGreaterThanOrEqual(3)
    for (const f of own) {
      expect(code(f), f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|@supabase|supabase\.|createSupabaseApi|useCalendar|createCloudSource|console\.\w+/)
    }
  })

  // Checkpoint 3 wires the confirmed save. The wiring is allowed ONLY in these reviewed places; anything else is a regression.
  const SAVE_FILES = ['src/timetable/save/saveImport.ts', 'src/timetable/save/fakeImportApi.ts', 'src/cloud/importApi.ts', 'src/components/timetableSave/SaveCard.tsx']
  const rel = (f: string) => relative(resolve('.'), f).split(sep).join('/')

  it('is imported only by the reviewed save modules (not by the preview parser, the review UI or the calendar)', () => {
    const outside = walk(resolve('src')).filter((f) => !f.includes(`${join('src', 'timetable', 'provenance')}`) && !/\.test\.tsx?$/.test(f))
    const importers = outside.filter((f) => /timetable\/provenance|\.\/provenance\/|\.\.\/provenance\//.test(code(f))).map(rel).sort()
    expect(importers.filter((f) => !SAVE_FILES.includes(f))).toEqual([])
  })

  it('only the provenance API module touches the provenance tables and the import RPC; the rest of the app does not', () => {
    const all = walk(resolve('src')).filter((f) => !/\.test\.tsx?$/.test(f))
    const hits = all.filter((f) => /orbit_import_sessions|orbit_forget_import_history|event_import_links|event_imports/.test(code(f))).map(rel)
    expect(hits).toEqual(['src/cloud/importApi.ts'])
  })

  it('nothing in the app writes events or links directly for an import, or calls the forget operation', () => {
    const all = walk(resolve('src')).filter((f) => !/.test.tsx?$/.test(f))
    expect(all.filter((f) => /orbit_forget_import_history/.test(code(f)))).toEqual([])
    const api = code(resolve('src/cloud/importApi.ts'))
    expect(api).not.toMatch(/from('events')|from('event_import_links').(insert|update|delete|upsert)|from('event_imports').(delete|upsert)/)
    expect(api).not.toMatch(/service[_-]?role|sb_secret|SECRET/i)
  })

  it('saving is OFF by default: the flag is read from VITE_ENABLE_TIMETABLE_SAVE only and defaults to false', () => {
    const flag = code(resolve('src/timetable/save/flag.ts'))
    expect(flag).toMatch(/VITE_ENABLE_TIMETABLE_SAVE === 'true'/)
    expect(readFileSync(resolve('.env.example'), 'utf8')).toMatch(/^# VITE_ENABLE_TIMETABLE_SAVE=true/m)
  })

  it('the production workflow pins the save flag to the string false', () => {
    const wf = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8')
    expect(wf).toMatch(/^\s*VITE_ENABLE_TIMETABLE_SAVE: 'false'\s*$/m)
    expect(wf).not.toMatch(/TIMETABLE_SAVE: '?"?true/)
  })

  it('only forward SQL is under migrations/; the rollback lives in supabase/recovery/ where Supabase never runs it', () => {
    const migrations = readdirSync(resolve('supabase/migrations')).sort()
    expect(migrations).toEqual(['20261009120000_core_schema.sql', '20261009120100_rls_policies.sql', '20261015120000_event_imports.sql'])
    expect(migrations.some((n) => /rollback|down|undo/i.test(n))).toBe(false)
    expect(readdirSync(resolve('supabase/recovery'))).toContain('20261015120000_event_imports.rollback.sql')
    expect(existsSync(resolve('supabase/proposals'))).toBe(false)
  })
})

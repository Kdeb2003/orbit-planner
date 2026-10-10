// Static guard for checkpoint 1 (preview only): the import-preview code must not be able to persist, upload or log
// anything. If a later checkpoint adds saving, it must live in a separate, explicitly reviewed module.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/pages/ImportTimetablePage.tsx', 'src/components/timetable', 'src/timetable/import', 'src/timetable/utn']

function files(path: string): string[] {
  const full = resolve(path)
  if (statSync(full).isFile()) return [full]
  return readdirSync(full).flatMap((n) => {
    const p = join(full, n)
    if (statSync(p).isDirectory()) return n === '__fixtures__' ? [] : files(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : []
  })
}

/** Source without comments, so documentation may name what the code must not do. */
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const FORBIDDEN: [RegExp, string][] = [
  [/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./, 'browser storage'],
  [/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, 'network access'],
  [/@supabase|from ['"][./]*(\.\.\/)*cloud\/|supabase/i, 'Supabase / cloud code'],
  [/from ['"][./]*(\.\.\/)*(storage|migration)\//, 'calendar storage or migration code'],
  [/useCalendar|CalendarContext|createCloudSource|\.createEvent\(|\.updateEvent\(/, 'calendar writes'],
  [/console\.(log|info|debug|warn|error)/, 'logging'],
  [/URL\.createObjectURL|FileReader\b.*readAsDataURL/, 'blob URLs'],
]

describe('the timetable preview cannot persist, upload or log', () => {
  const all = ROOTS.flatMap(files)
  it('covers the preview page, its components, the loader and the parser', () => {
    expect(all.length).toBeGreaterThan(20)
  })
  for (const [re, what] of FORBIDDEN) {
    it(`uses no ${what}`, () => {
      const hits = all.filter((f) => re.test(code(f))).map((f) => f.replace(resolve('.'), ''))
      expect(hits).toEqual([])
    })
  }
})

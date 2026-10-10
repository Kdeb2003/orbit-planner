// Static guard: the explicit local->cloud import must never be able to modify or delete the user's
// browser data. (Behavioural coverage lives in src/migration/migration.test.ts.)
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = join(__dirname, '..', '..', 'src')

describe('local data safety (static)', () => {
  it('migration modules contain no code that deletes or clears browser storage', () => {
    const dir = join(src, 'migration')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/removeItem|localStorage.clear|.clear()/)
    }
  })

  it('the import card never creates, updates or removes local events/series', () => {
    const card = readFileSync(join(src, 'components', 'LocalImportCard.tsx'), 'utf8')
    expect(card).not.toMatch(/removeItem|.clear()|eventStore.(remove|create|update|reload)|seriesStore.(remove|create|update|setException|clearException|reload)/)
  })

  it('cloud code never reads or writes the legacy local storage keys', () => {
    for (const dir of ['cloud', 'calendar']) {
      for (const f of readdirSync(join(src, dir)).filter((n) => /.tsx?$/.test(n) && !n.includes('.test.') && n !== 'localSource.ts')) {
        expect(readFileSync(join(src, dir, f), 'utf8'), f).not.toMatch(/orbit.(events|series).v1|localStorage/)
      }
    }
  })
})

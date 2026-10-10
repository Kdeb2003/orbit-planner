// Golden test against the REAL university PDF. The PDF is personal working material and is never committed:
// the test runs only when it exists (default: ../orbit-import-inputs/, or UTN_TIMETABLE_PDF) and is skipped otherwise.
// Expected values were verified against the rendered pages (see docs/timetable-import/).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractFromPdf } from '../../src/timetable/utn/index.ts'
import type { TimetableExtraction } from '../../src/timetable/utn/index.ts'
import { findSessionClashes, selectSessions } from '../../src/timetable/utn/selection.ts'
import type { SelectionResult } from '../../src/timetable/utn/selection.ts'

const PDF = process.env.UTN_TIMETABLE_PDF ?? resolve('..', 'orbit-import-inputs', 'timetable UTN WiSe26-27_AIR all courses(3).pdf')
// Frozen baseline (docs/timetable-import/baseline.md). If the PDF is a different revision these fail on purpose:
// investigate the difference, do not just edit the numbers.
const BASELINE = {
  pdfSha256: 'e614706789dbbe9bcd35e5c5ea6f14081ba31b6f996575cc2cdf2a867d684df3', // "timetable UTN WiSe26-27_AIR all courses(3).pdf", created 2026-09-29, preliminary as of 28 Sep 2026
  selectedHash: '7fbb7d55b2e1a716076fad61acd99be4b108c5a1c0f62b51dd169c2f7880b49a', // sha256 of the sorted sourceKeys of the 168 selected sessions
  clashHash: 'd8a254435e5cb6bf8990d8e0c046cc91364c9d9a21dd653366459e7a6b188bf9', // sha256 of the sorted "date|keyA||keyB" lines of the 29 clashes
  activeWeeks: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 23, 24, 25],
}
const sha = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex')
const WEEKDAYS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' }

describe.skipIf(!existsSync(PDF))('real UTN WiSe 2026/27 timetable PDF', () => {
  let ex: TimetableExtraction
  let sel: SelectionResult
  beforeAll(async () => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(PDF)), standardFontDataUrl: resolve('node_modules', 'pdfjs-dist', 'standard_fonts') + '/' }).promise
    ex = await extractFromPdf(doc as never)
    sel = selectSessions(ex.sessions)
  }, 60_000)

  it('gives the same sessions when PDF.js has no standard-font data (text widths are then 0), so a browser build does not depend on it', async () => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(PDF)) }).promise
    const bare = await extractFromPdf(doc as never)
    expect(bare.sessions.map((s) => s.sourceKey + s.slots.join())).toEqual(ex.sessions.map((s) => s.sourceKey + s.slots.join()))
    expect(bare.sessions.map((s) => s.location?.raw)).toEqual(ex.sessions.map((s) => s.location?.raw))
  }, 60_000)

  it('is the frozen source revision', () => {
    expect(sha(readFileSync(PDF))).toBe(BASELINE.pdfSha256)
  })

  it('frozen baseline: 168 selected sessions, 80 dates 2026-10-12..2027-03-19, active weeks, content hash', () => {
    const s = sel.selected
    expect(s).toHaveLength(168)
    const dates = [...new Set(s.map((x) => x.session.date as string))].sort()
    expect([dates.length, dates[0], dates[dates.length - 1]]).toEqual([80, '2026-10-12', '2027-03-19'])
    expect([...new Set(s.map((x) => x.session.semesterWeek))].sort((a, b) => a - b)).toEqual(BASELINE.activeWeeks)
    expect(sha(s.map((x) => x.session.sourceKey).sort().join(String.fromCharCode(10)))).toBe(BASELINE.selectedHash)
  })

  it('frozen baseline: all 29 clashes are preserved (none filtered), content hash', () => {
    const clashes = findSessionClashes(sel.selected)
    expect(clashes).toHaveLength(29)
    const lines = clashes.map((c) => `${c.date}|${[c.a.session.sourceKey, c.b.session.sourceKey].sort().join('||')}`).sort().join(String.fromCharCode(10))
    expect(sha(lines)).toBe(BASELINE.clashHash)
  })

  it('AI Group B is the only AI group selected; German A2 has 9 online March blocks 13:15-18:15', () => {
    const ai = sel.selected.filter((x) => x.course.code === 'W26M-AINBA')
    expect(new Set(ai.map((x) => x.session.groups.join()))).toEqual(new Set(['B']))
    const march = sel.selected.filter((x) => x.course.code === 'W26M-Deutsch A2' && (x.session.date as string) >= '2027-03-01')
    expect(march).toHaveLength(9)
    expect(march.every((x) => x.session.startTime === '13:15' && x.session.endTime === '18:15' && x.session.location?.kind === 'online')).toBe(true)
  })

  it('the Course List PDF (images only, no timetable) is rejected as unsupported', async () => {
    const list = resolve(PDF, '..', 'Course List winter semester 2027_AIR & HAI_updated(2).pdf')
    if (!existsSync(list)) return
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(list)) }).promise
    const r = await extractFromPdf(doc as never)
    expect(r.supported).toBe(false)
    expect(r.sessions).toEqual([])
  }, 60_000)

  it('has 9 pages: eight rotated timetable pages and the legend', () => {
    expect(ex.layouts).toHaveLength(9)
    expect(ex.layouts.slice(0, 8).every((p) => p.rotation === 90)).toBe(true)
    expect(ex.layouts[8].rotation).toBe(0)
  })

  it('reconstructs 25 consecutive semester weeks with no structural errors', () => {
    expect(ex.tables.map((t) => t.semesterWeek)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(ex.tables.flatMap((t) => t.issues.filter((i) => i.severity === 'error'))).toEqual([])
    expect(ex.tables.reduce((n, t) => n + t.cards.length, 0)).toBe(684)
    expect(ex.sessions).toHaveLength(567)
  })

  it('the only calendar anomalies are the undated week 1 and the duplicated 05.03.2027 in week 23', () => {
    expect([...new Set(ex.anomalies.map((a) => `${a.semesterWeek}:${a.code}`))].sort()).toEqual(['1:no-date', '23:date-weekday-mismatch', '23:duplicate-date'])
  })

  it('selected session counts per course', () => {
    const count = (code: string) => sel.selected.filter((s) => s.course.code === code).length
    expect({
      ai: count('W26M-AINBA'),
      robotics: count('W26M-RBTAD'),
      nlg: count('W26M-NLGAD'),
      nlu: count('W26M-NLUAD'),
      mmf: count('W26M-MMFAD'),
      llm: count('W26M-LLMAD'),
      society: count('W26M-INSIN'),
      german: count('W26M-Deutsch A2'),
    }).toEqual({ ai: 28, robotics: 31, nlg: 6, nlu: 30, mmf: 15, llm: 15, society: 11, german: 32 })
    expect(sel.selected).toHaveLength(168)
    expect(sel.selected.every((s) => s.status === 'confirmed')).toBe(true)
  })

  it('never selects AI Group A (28 Group A sessions excluded)', () => {
    expect(sel.excluded).toHaveLength(28)
    expect(sel.selected.filter((s) => s.course.code === 'W26M-AINBA').every((s) => s.session.groups.join() === 'B')).toBe(true)
  })

  it('weeks without any selected session: 1, 2, 14, 21, 22', () => {
    const weeks = new Set(sel.selected.map((s) => s.session.semesterWeek))
    expect(Array.from({ length: 25 }, (_, i) => i + 1).filter((w) => !weeks.has(w))).toEqual([1, 2, 14, 21, 22])
  })

  it('29 clashes in three recurring pairs', () => {
    const clashes = findSessionClashes(sel.selected)
    const pair = (c: (typeof clashes)[number]) => [c.a.session.courseCode, c.b.session.courseCode].map((x) => x.replace('W26M-', '')).sort().join('+')
    const counts: Record<string, number> = {}
    for (const c of clashes) counts[pair(c)] = (counts[pair(c)] ?? 0) + 1
    expect(counts).toEqual({ 'AINBA+NLUAD': 14, 'INSIN+MMFAD': 9, 'NLGAD+RBTAD': 6 })
  })

  // Each row was checked by eye against a crop of the rendered PDF page (date header, slot label, card text).
  const VERIFIED: [string, string, string, string, string, string][] = [
    ['2026-10-20', '09:00-10:30', 'W26M-AINBA', 'tutorial group B', 'NOP / ALC2', 'Tue'],
    ['2026-10-20', '09:00-10:30', 'W26M-NLUAD', 'tutorial', 'UL / S32', 'Tue'],
    ['2026-10-20', '13:15-14:45', 'W26M-INSIN', 'main', 'UL / S32', 'Tue'],
    ['2026-10-20', '13:15-14:45', 'W26M-MMFAD', 'main', 'UL / S31', 'Tue'],
    ['2026-10-20', '10:45-12:15', 'W26M-LLMAD', 'main', 'UL / S31', 'Tue'],
    ['2026-10-22', '13:15-14:45', 'W26M-NLGAD', 'main', 'NOP / ALC1', 'Thu'],
    ['2026-10-22', '13:15-14:45', 'W26M-RBTAD', 'tutorial', 'NOP / ALC2', 'Thu'],
    ['2026-10-22', '10:45-12:15', 'W26M-AINBA', 'main group B', 'NOP / ALC1', 'Thu'],
    ['2026-12-23', '10:45-12:15', 'W26M-RBTAD', 'main', 'NOP / ALC1', 'Wed'],
    ['2026-12-22', '09:00-10:30', 'W26M-NLUAD', 'tutorial', 'UL / S32', 'Tue'],
    ['2026-12-01', '09:00-10:30', 'W26M-NLUAD', 'tutorial', 'UL / S32', 'Tue'],
    ['2027-01-07', '13:15-14:45', 'W26M-RBTAD', 'tutorial', 'NOP / ALC2', 'Thu'],
    ['2027-02-08', '09:00-12:15', 'W26M-MMFAD', 'main', 'NOP / PC-Pool', 'Mon'],
    ['2026-10-12', '15:00-16:30', 'W26M-Deutsch A2', '', 'UL / S31', 'Mon'],
    ['2026-10-26', '15:00-16:30', 'W26M-Deutsch A2', '', 'UL / S31', 'Mon'],
    ['2027-03-01', '13:15-18:15', 'W26M-Deutsch A2', '', 'online', 'Mon'],
    ['2027-01-19', '10:45-12:15', 'W26M-LLMAD', 'main', 'UL / S31', 'Tue'],
    ['2026-11-20', '15:00-18:15', 'W26M-Deutsch A2', '', 'NOP / ALC1', 'Fri'],
    ['2027-03-15', '13:15-18:15', 'W26M-Deutsch A2', '', 'online', 'Mon'],
  ]
  it.each(VERIFIED)('verified against the rendered page: %s %s %s %s', (date, time, code, type, room, weekday) => {
    const hit = sel.selected.filter((s) => s.session.date === date && `${s.session.startTime}-${s.session.endTime}` === time && s.session.courseCode === code)
    expect(hit).toHaveLength(1)
    expect(hit[0].session).toMatchObject({ typeText: type, weekday: WEEKDAYS[weekday] })
    expect(hit[0].session.location?.raw).toBe(room)
  })
})

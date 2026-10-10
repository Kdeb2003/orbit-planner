import { beforeAll, describe, expect, it } from 'vitest'
import raw from './__fixtures__/utn-wise2627-layouts.json?raw'
import { extractFromLayouts } from './index.ts'
import type { TimetableExtraction } from './index.ts'
import { findSessionClashes, selectSessions } from './selection.ts'
import type { SelectedSession } from './selection.ts'
import { toEventDraft } from './mapping.ts'
import { SLOTS } from './types.ts'
import type { PageLayout, TimetableSession } from './types.ts'

// The fixture holds the real positioned text and painted cells of weeks 1, 4, 5, 8, 12, 13, 14, 20, 21, 23 and 25
// of the UTN WiSe 2026/27 timetable (preliminary as of 28 September 2026) plus its legend page.
// Expected values below were read off the rendered PDF pages, not derived from the parser's output.
interface Fixture {
  weeks: number[]
  pages: PageLayout[]
}
const fixture = JSON.parse(raw) as Fixture
const clone = () => structuredClone(fixture.pages)

let ex: TimetableExtraction
let selected: SelectedSession[]
beforeAll(() => {
  ex = extractFromLayouts(clone())
  selected = selectSessions(ex.sessions).selected
})

const week = (n: number) => ex.tables.find((t) => t.semesterWeek === n)!
const on = (date: string) => ex.sessions.filter((s) => s.date === date)
const sel = (date: string) => selected.filter((s) => s.session.date === date)
const brief = (s: TimetableSession) => `${s.startTime}-${s.endTime} ${s.courseCode.replace('W26M-', '')} ${s.typeText} @ ${s.location?.raw ?? '-'}`

describe('week tables and headers', () => {
  it('finds every fixture week, with the right dates and the 90-degree page rotation', () => {
    expect(ex.tables.map((t) => t.semesterWeek)).toEqual(fixture.weeks)
    expect(fixture.pages.filter((p) => p.rotation === 90).length).toBeGreaterThan(5)
    expect(week(4).days.map((d) => d.date)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'])
    expect(week(13).days.map((d) => d.date)).toEqual(['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-26'])
  })

  it('reads dates from the printed headers, not from week-number arithmetic', () => {
    // Week 12 starts 14 Dec and week 13 on 21 Dec because the PDF says so.
    expect(week(12).days[0].date).toBe('2026-12-14')
    expect(week(25).days[0].date).toBe('2027-03-15')
  })

  it('week 1 prints no dates at all: no date is invented and the notice text is kept as stray text', () => {
    expect(week(1).days.every((d) => d.date === null)).toBe(true)
    expect(ex.anomalies.filter((a) => a.semesterWeek === 1 && a.code === 'no-date')).toHaveLength(6)
    expect(week(1).strayText.map((s) => s.text).join(' ')).toContain('preliminary as of 28 September 2026')
    expect(week(1).cards).toHaveLength(0)
  })

  it('week 23 prints 05.03.2027 for BOTH Friday and Saturday: the Saturday date is withheld, not corrected', () => {
    const w = week(23)
    expect(w.days[4]).toMatchObject({ weekday: 'Friday', date: '2027-03-05', dateText: '05.03.2027' })
    expect(w.days[5]).toMatchObject({ weekday: 'Saturday', date: null, dateText: '05.03.2027' })
    expect(ex.anomalies.map((a) => a.code)).toEqual(expect.arrayContaining(['date-weekday-mismatch', 'duplicate-date']))
    expect(ex.anomalies.find((a) => a.code === 'date-weekday-mismatch')?.message).toContain('Saturday is printed as 05.03.2027')
  })

  it('an empty holiday week (28 Dec - 2 Jan) generates no sessions', () => {
    expect(week(14).days.map((d) => d.date)).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
    expect(ex.sessions.filter((s) => s.semesterWeek === 14)).toEqual([])
  })

  it('the Christmas week only has classes on Mon-Wed (24-26 Dec stay empty)', () => {
    const dates = new Set(ex.sessions.filter((s) => s.semesterWeek === 13).map((s) => s.date))
    expect([...dates].sort()).toEqual(['2026-12-21', '2026-12-22', '2026-12-23'])
  })

  it('tables that break across pages keep their rows (week 4: slots 4-5 are on the next page; week 8: header and rows are on different pages)', () => {
    expect(week(4).pages).toEqual([1, 2])
    expect(week(8).titlePage).toBe(2)
    expect(week(8).pages).toEqual([2, 3])
    expect(week(25).pages).toEqual([7, 8])
    for (const n of [4, 8, 25]) expect(week(n).issues).toEqual([])
  })
})

describe('known tricky days (read from the rendered pages)', () => {
  it('20 Oct 2026 (Tuesday), all selected courses with exact slots and rooms', () => {
    expect(sel('2026-10-20').map((s) => brief(s.session))).toEqual([
      '09:00-10:30 AINBA tutorial group B @ NOP / ALC2',
      '09:00-10:30 NLUAD tutorial @ UL / S32',
      '10:45-12:15 LLMAD main @ UL / S31',
      '13:15-14:45 INSIN main @ UL / S32',
      '13:15-14:45 MMFAD main @ UL / S31',
    ])
  })

  it('20 Oct: AI Group A, Mobile Robot Navigation, Cloud Databases and Psychology are on the page but not selected', () => {
    const all = on('2026-10-20').map((s) => s.courseCode)
    expect(all).toEqual(expect.arrayContaining(['W26M-MOBBA', 'W26M-CLDAD', 'W26M-PSYIN']))
    expect(sel('2026-10-20').some((s) => s.session.groups.includes('A'))).toBe(false)
    expect(on('2026-10-20').filter((s) => s.courseCode === 'W26M-AINBA').map((s) => s.typeText)).toEqual(['tutorial group B', 'tutorial group A'])
  })

  it('20 Oct has no Advanced Robotics session; Robotics main is on Wednesday 21 Oct', () => {
    expect(on('2026-10-20').some((s) => s.courseCode === 'W26M-RBTAD')).toBe(false)
    expect(sel('2026-10-21').map((s) => brief(s.session))).toContain('10:45-12:15 RBTAD main @ NOP / ALC1')
  })

  it('20 Oct clashes: AI tutorial B x NLU tutorial and Informatics & Society x Multimodal', () => {
    const clashes = findSessionClashes(sel('2026-10-20'))
    expect(clashes.map((c) => [c.a.session.courseCode, c.b.session.courseCode].map((x) => x.replace('W26M-', '')).sort().join('+'))).toEqual(['AINBA+NLUAD', 'INSIN+MMFAD'])
  })

  it('22 Oct 2026 (Thursday): NLG main and Robotics tutorial share 13:15-14:45 in different rooms', () => {
    expect(sel('2026-10-22').map((s) => brief(s.session))).toEqual([
      '10:45-12:15 AINBA main group B @ NOP / ALC1',
      '13:15-14:45 NLGAD main @ NOP / ALC1',
      '13:15-14:45 RBTAD tutorial @ NOP / ALC2',
    ])
    expect(findSessionClashes(sel('2026-10-22'))).toHaveLength(1)
  })

  it('touching sessions do not clash and sessions on different days never do', () => {
    const items = selected.filter((s) => s.session.date === '2026-10-20' && ['LLMAD', 'INSIN'].some((c) => s.session.courseCode.endsWith(c)))
    expect(items).toHaveLength(2)
    expect(findSessionClashes(items)).toEqual([])
    // LLM (Tue 10:45) and Robotics (Wed 10:45) look adjacent in the wide layout but are different days
    expect(findSessionClashes(selected.filter((s) => ['2026-10-20', '2026-10-21'].includes(s.session.date as string) && /LLMAD|RBTAD/.test(s.session.courseCode)))).toEqual([])
  })
})

describe('AI Group B filtering', () => {
  it('keeps only Group B main and tutorial sessions and excludes every Group A session', () => {
    const { selected: s, excluded } = selectSessions(ex.sessions)
    const ai = s.filter((x) => x.session.courseCode === 'W26M-AINBA')
    expect(ai.length).toBeGreaterThan(0)
    expect(ai.every((x) => x.session.groups.join() === 'B')).toBe(true)
    expect(ai.map((x) => x.session.kind).sort()).toContain('tutorial')
    expect(excluded.length).toBe(ai.length) // one Group A session for every Group B session
    expect(excluded.every((x) => x.session.groups.join() === 'A')).toBe(true)
  })

  it('flags a card that prints several groups or none instead of guessing', () => {
    const base = ex.sessions.find((s) => s.courseCode === 'W26M-AINBA' && s.groups.join() === 'B')!
    const multi = selectSessions([{ ...base, groups: ['A', 'B'] }]).selected[0]
    expect(multi.status).toBe('needs-review')
    expect(multi.reviewReasons.join()).toContain('several groups')
    const none = selectSessions([{ ...base, groups: [] }]).selected[0]
    expect(none.reviewReasons.join()).toContain('no group printed')
  })

  it('other courses with an optional group or variant are flagged, never silently attended', () => {
    const rbt = ex.sessions.find((s) => s.courseCode === 'W26M-RBTAD')!
    expect(selectSessions([rbt]).selected[0].status).toBe('confirmed')
    expect(selectSessions([{ ...rbt, groups: ['B', 'C'] }]).selected[0].reviewReasons.join()).toContain('attendance not assumed')
    expect(selectSessions([{ ...rbt, variant: 'a' }]).selected[0].status).toBe('needs-review')
  })

  it('selects nothing for unselected courses (e.g. German A1.1, LiT)', () => {
    expect(selected.some((s) => /A1\.1|LiT/.test(s.session.courseCode))).toBe(false)
  })
})

describe('German A2', () => {
  const a2 = () => selected.filter((s) => s.session.courseCode === 'W26M-Deutsch A2')

  it('regular weekly sessions come with their printed room, week by week', () => {
    expect(a2().filter((s) => s.session.semesterWeek === 4).map((s) => brief(s.session))).toEqual(['15:00-16:30 Deutsch A2  @ online'])
    expect(a2().filter((s) => s.session.semesterWeek === 8).map((s) => `${s.session.date} ${brief(s.session)}`)).toEqual([
      '2026-11-16 15:00-16:30 Deutsch A2  @ UL / S31',
      '2026-11-20 15:00-18:15 Deutsch A2  @ NOP / ALC1',
    ])
  })

  it('the March 2027 blocks (weeks 23 and 25 are in the fixture) are online 13:15-18:15 on Mon, Tue and Fri', () => {
    const march = a2().filter((s) => s.session.date! >= '2027-03-01')
    expect(march.map((s) => s.session.date)).toEqual(['2027-03-01', '2027-03-02', '2027-03-05', '2027-03-15', '2027-03-16', '2027-03-19'])
    for (const m of march) {
      expect(m.session).toMatchObject({ startTime: '13:15', endTime: '18:15', slots: [3, 4, 5], spansMultipleSlots: true })
      expect(m.session.location).toEqual({ kind: 'online', raw: 'online' })
    }
  })

  it('week 25 is a one-cell-per-day table whose same-colour neighbours are painted as ONE rectangle: Monday and Tuesday stay separate days', () => {
    const w25 = a2().filter((s) => s.session.semesterWeek === 25)
    expect(w25.map((s) => s.session.weekday)).toEqual(['Monday', 'Tuesday', 'Friday'])
  })

  it('a block that continues on the next page is one session, not three, and not duplicated', () => {
    const mon = a2().filter((s) => s.session.date === '2027-03-15')
    expect(mon).toHaveLength(1)
    expect(new Set(mon[0].session.source.map((r) => r.page))).toEqual(new Set([7, 8]))
  })

  it('13:15-14:45 and 15:00-16:30 are joined only across the 15-minute break, never across lunch', () => {
    expect(SLOTS[2].start).toBe('13:15')
    // week 12 Monday 16:45 session is slot 5 only and is not joined to anything
    expect(a2().find((s) => s.session.date === '2026-12-14')!.session).toMatchObject({ startTime: '16:45', endTime: '18:15', slots: [5] })
    expect(ex.sessions.every((s) => !(s.slots.includes(2) && s.slots.includes(3)))).toBe(true)
  })
})

describe('slots, merging and duplicates', () => {
  it('every session starts and ends exactly on the printed slot boundaries', () => {
    const starts = new Set(SLOTS.map((s) => s.start))
    const ends = new Set(SLOTS.map((s) => s.end))
    for (const s of ex.sessions) {
      expect(starts.has(s.startTime)).toBe(true)
      expect(ends.has(s.endTime)).toBe(true)
      expect(s.timeZone).toBe('Europe/Berlin')
    }
  })

  it('consecutive identical slot cards (project work in slots 4+5) become one 15:00-18:15 session that keeps both source cells', () => {
    const lit = ex.sessions.find((s) => s.courseCode === 'W26M-LiT' && s.slots.join() === '4,5')!
    expect(lit).toMatchObject({ startTime: '15:00', endTime: '18:15', spansMultipleSlots: true })
    expect(lit.source).toHaveLength(2)
    expect(lit.issues.map((i) => i.code)).toContain('merged-adjacent-cards')
  })

  it('same course/type in the same slot is never merged: parallel Student Conference rooms are flagged as duplicate candidates', () => {
    const conf = ex.sessions.filter((s) => s.date === '2027-02-16' && s.typeText === 'Student Conference' && s.slots.join() === '2')
    expect(conf.map((s) => s.location?.raw).sort()).toEqual(['NOP / ALC1', 'NOP / ALC2 / Eventspace'])
    expect(conf.every((s) => s.issues.some((i) => i.code === 'duplicate-candidate'))).toBe(true)
    expect(new Set(conf.map((s) => s.sourceKey)).size).toBe(1)
  })

  it('different tutorial/main sessions of one course on one day stay separate', () => {
    const nlu = ex.sessions.filter((s) => s.courseCode === 'W26M-NLUAD' && s.semesterWeek === 4)
    expect(nlu.map((s) => `${s.date} ${s.kind}`).sort()).toEqual(['2026-10-20 tutorial', '2026-10-21 main'])
    expect(new Set(ex.sessions.filter((s) => !s.issues.some((i) => i.code === 'duplicate-candidate')).map((s) => s.sourceKey)).size).toBe(
      ex.sessions.filter((s) => !s.issues.some((i) => i.code === 'duplicate-candidate')).length,
    )
  })

  it('groups and variants of non-selected courses are parsed (main group B,C / main a / main 2)', () => {
    const w12 = ex.sessions.filter((s) => s.semesterWeek === 12)
    expect(w12.find((s) => s.courseCode === 'W26M-GSPKC')).toMatchObject({ kind: 'main', groups: ['B', 'C'] })
    expect(w12.find((s) => s.courseCode === 'W26M-PMLAD' && s.typeText === 'main 2')).toMatchObject({ variant: '2', groups: [] })
  })

  it('a joint card (REGEL + ETHIN excursion, week 5) keeps both codes and prints no room', () => {
    const joint = ex.sessions.filter((s) => s.jointWith.length > 0)
    expect(joint).toHaveLength(1)
    expect(joint[0]).toMatchObject({ date: '2026-10-28', courseCode: 'W26M-REGEL', jointWith: ['W26M-ETHIN'], kind: 'excursion', startTime: '13:15', endTime: '16:30', location: null })
    expect(selected.some((s) => s.session.courseCode === 'W26M-REGEL')).toBe(false)
  })

  it('a full-day block is two sessions, never one session across the lunch gap (Multimodal, Mon 8 Feb 2027)', () => {
    expect(sel('2027-02-08').map((s) => brief(s.session))).toEqual(['09:00-12:15 MMFAD main @ NOP / PC-Pool', '13:15-18:15 MMFAD main @ NOP / PC-Pool'])
  })

  it('Saturday German A1.1 groups (not selected) keep group A and B apart and split at lunch (week 5)', () => {
    const sat = on('2026-10-31').filter((s) => s.courseCode === 'W26M-Deutsch A1.1')
    expect(sat.map((s) => `${s.startTime}-${s.endTime} ${s.typeText}`)).toEqual(['09:00-12:15 group A', '13:15-14:45 group A', '15:00-18:15 group B'])
  })
})

describe('legend', () => {
  it('maps codes to titles; German courses are not listed and LiT has no title', () => {
    const e = ex.legend.entries
    expect(e.get('W26M-AINBA')?.title).toBe('Artificial Intelligence Basic group 1')
    expect(e.get('W26M-RBTAD')?.title).toBe('Advanced Robotics')
    expect(e.get('W26M-INSIN')?.title).toBe('Informatics & Society')
    expect(e.has('W26M-Deutsch A2')).toBe(false)
    expect(e.get('W26M-LiT')?.title).toBeNull()
  })

  it('card colours agree with the legend colours for every course in the legend (independent code check)', () => {
    expect(ex.sessions.some((s) => s.issues.some((i) => i.code === 'fill-mismatch'))).toBe(false)
  })
})

describe('event mapping (draft only, nothing is persisted)', () => {
  const draft = (date: string, code: string) => toEventDraft(sel(date).find((s) => s.session.courseCode === code)!)

  it('converts Berlin wall-clock time to UTC instants across DST', () => {
    expect(draft('2026-10-20', 'W26M-LLMAD').event).toMatchObject({ start: '2026-10-20T08:45:00.000Z', end: '2026-10-20T10:15:00.000Z', timeZone: 'Europe/Berlin' }) // CEST
    expect(draft('2026-12-22', 'W26M-LLMAD').event).toMatchObject({ start: '2026-12-22T09:45:00.000Z', end: '2026-12-22T11:15:00.000Z' }) // CET
  })

  it('fills the existing university metadata fields and a stable import key', () => {
    const d = draft('2026-10-20', 'W26M-AINBA')
    expect(d.event).toMatchObject({ title: 'Artificial Intelligence Basic — Tutorial', category: 'university', courseCode: 'W26M-AINBA', sessionType: 'tutorial', groupLabel: 'Group B', location: 'NOP / ALC2' })
    expect(d.importKey).toBe('utn-wise2627|2026-10-20|09:00-10:30|W26M-AINBA|tutorial group b')
    expect(d.event.description).toContain('semester week 4')
  })

  it('German A2 is a "german" category event; online is labelled "Online"', () => {
    const d = toEventDraft(selected.find((s) => s.session.date === '2027-03-01')!)
    expect(d.event).toMatchObject({ title: 'German A2', category: 'german', location: 'Online', start: '2027-03-01T12:15:00.000Z', end: '2027-03-01T17:15:00.000Z' })
  })

  it('refuses a session without a date', () => {
    expect(() => toEventDraft({ ...sel('2026-10-20')[0], session: { ...sel('2026-10-20')[0].session, date: null } })).toThrow(/no date/)
  })

  it('the import key does not depend on page, position or room, so a re-export keeps the same identity', () => {
    const s = sel('2026-10-20')[0].session
    const moved = { ...s, location: { kind: 'room' as const, raw: 'NOP / ALC9', campus: 'NOP', room: 'ALC9' } }
    expect(toEventDraft({ ...sel('2026-10-20')[0], session: moved }).importKey).toBe(toEventDraft(sel('2026-10-20')[0]).importKey)
  })
})

describe('malformed or unexpected layouts are reported, not guessed', () => {
  const find = (pages: PageLayout[], pred: (t: PageLayout['texts'][number], p: PageLayout) => boolean) => {
    for (const p of pages) {
      const t = p.texts.find((x) => pred(x, p))
      if (t) return { p, t }
    }
    throw new Error('fixture text not found')
  }

  it('an impossible date makes that day unusable and flags every card on it', () => {
    const pages = clone()
    const { t } = find(pages, (x) => x.str === '16.03.2027')
    t.str = '31.02.2027'
    const bad = extractFromLayouts(pages)
    const tue = bad.tables.find((x) => x.semesterWeek === 25)!.days[1]
    expect(tue).toMatchObject({ date: null, dateText: '31.02.2027' })
    expect(tue.issues.map((i) => i.code)).toContain('invalid-date')
    const broken = bad.sessions.filter((s) => s.semesterWeek === 25 && s.weekday === 'Tuesday')
    expect(broken.length).toBeGreaterThan(0)
    expect(broken.every((s) => s.date === null && s.confidence === 'low')).toBe(true)
    expect(selectSessions(broken).selected.every((s) => s.status === 'needs-review' && s.reviewReasons.join().includes('no usable date'))).toBe(true)
  })

  it('a wrong slot time label is an error on the table', () => {
    const pages = clone()
    const { t } = find(pages, (x, p) => x.str === '09:00-10:30' && p.page === 1)
    t.str = '09:15-10:30'
    const bad = extractFromLayouts(pages)
    expect(bad.tables.flatMap((x) => x.issues).map((i) => i.code)).toContain('unexpected-slot-time')
  })

  it('a missing slot row is reported', () => {
    const pages = clone()
    const { p, t } = find(pages, (x) => x.str === 'Slot 5' && x.y > 0)
    p.texts.splice(p.texts.indexOf(t), 1)
    const bad = extractFromLayouts(pages)
    expect(bad.tables.flatMap((x) => x.issues).map((i) => i.code)).toContain('missing-slot-rows')
  })

  it('a lost title bar is reported but the table is still reconstructed', () => {
    const pages = clone()
    const title = find(pages, (x) => x.str.includes('Semester Week 13'))
    title.p.rects = title.p.rects.filter((r) => !(r.y0 <= title.t.y + 1 && r.y1 >= title.t.y - 1 && r.x1 - r.x0 > 100 && r.fill === '#203864'))
    const bad = extractFromLayouts(pages)
    const w13 = bad.tables.find((x) => x.semesterWeek === 13)!
    expect(w13.issues.map((i) => i.code)).toContain('title-bar-not-found')
  })

  it('a coloured cell whose text is missing is reported and creates no session', () => {
    const pages = clone()
    const before = extractFromLayouts(clone()).sessions.length
    const { p, t } = find(pages, (x, pg) => x.str === 'W26M-LLMAD' && pg.page === 1)
    p.texts = p.texts.filter((x) => Math.abs(x.y - t.y) > 0 || x.x0 !== t.x0)
    // remove the whole card text (all lines share the same horizontal span)
    p.texts = p.texts.filter((x) => !(x.x0 >= t.x0 - 8 && x.x1 <= t.x1 + 8 && x.y >= t.y - 1 && x.y <= t.y + 17))
    const bad = extractFromLayouts(pages)
    expect(bad.tables.flatMap((x) => x.issues).map((i) => i.code)).toContain('painted-cell-without-text')
    expect(bad.sessions.length).toBe(before - 1)
  })

  it('a card without a course code is an error and has low confidence', () => {
    const pages = clone()
    const { t } = find(pages, (x, pg) => x.str === 'W26M-LLMAD' && pg.page === 1)
    t.str = 'LLMAD'
    const bad = extractFromLayouts(pages)
    const s = bad.sessions.find((x) => x.date === '2026-10-20' && x.startTime === '10:45' && x.courseCode === '')!
    expect(s.confidence).toBe('low')
    expect(s.issues.map((i) => i.code)).toContain('no-course-code')
  })
})

describe('unsupported documents fail clearly instead of producing sessions', () => {
  it('the fixture itself is a supported document', () => {
    expect(ex.supported).toBe(true)
    expect(ex.problems.filter((p) => p.severity === 'error')).toEqual([])
  })

  it('a scanned / image-only PDF (pages without a text layer) is rejected', () => {
    const scanned = clone().map((p) => ({ ...p, texts: [], rects: [] }))
    const r = extractFromLayouts(scanned)
    expect(r.supported).toBe(false)
    expect(r.problems.map((p) => p.code)).toEqual(['no-text-layer'])
    expect(r.sessions).toEqual([])
  })

  it('a text PDF that is not a semester timetable (legend page only) is rejected', () => {
    const r = extractFromLayouts(clone().filter((p) => p.texts.some((t) => t.str === 'Course number')))
    expect(r.problems.map((p) => p.code)).toEqual(['no-week-tables'])
    expect(r.sessions).toEqual([])
  })

  it('the right text with a different drawing (no painted cells or grid) is rejected, not guessed', () => {
    const r = extractFromLayouts(clone().map((p) => ({ ...p, rects: [] })))
    expect(r.supported).toBe(false)
    expect(r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['no-cards']))
    expect(r.sessions).toEqual([])
  })

  it('an empty page list is rejected', () => {
    expect(extractFromLayouts([]).problems.map((p) => p.code)).toEqual(['no-text-layer'])
  })
})

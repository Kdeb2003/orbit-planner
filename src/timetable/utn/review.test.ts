import { beforeAll, describe, expect, it } from 'vitest'
import raw from './__fixtures__/utn-wise2627-layouts.json?raw'
import { extractFromLayouts } from './index.ts'
import type { TimetableExtraction } from './index.ts'
import {
  buildReview, choicesToDefs, commitEdit, defaultChoices, describeSource, detectCourses, duplicateOf, filterItems, groupAnomalies, initialState,
  NO_FILTERS, resetEdit, setReviewed, toggleExcluded, validateValues,
} from './review.ts'
import type { ReviewState } from './review.ts'
import type { PageLayout } from './types.ts'

const pages = (JSON.parse(raw) as { pages: PageLayout[] }).pages
let ex: TimetableExtraction
beforeAll(() => {
  ex = extractFromLayouts(structuredClone(pages))
})
const fresh = (): ReviewState => initialState(ex.sessions)
const code = (c: string) => `W26M-${c}`

describe('course detection and defaults', () => {
  it('lists every course printed in the PDF, the default eight first', () => {
    const d = detectCourses(ex.sessions)
    expect(d.length).toBeGreaterThan(8)
    expect(d.filter((c) => c.recommended).map((c) => c.code)).toEqual([code('AINBA'), code('RBTAD'), code('NLGAD'), code('NLUAD'), code('MMFAD'), code('LLMAD'), code('INSIN'), 'W26M-Deutsch A2'])
    expect(d.slice(0, 8).every((c) => c.recommended)).toBe(true)
    expect(d.find((c) => c.code === code('AINBA'))?.groups).toEqual(['A', 'B'])
    expect(d.find((c) => c.code === 'W26M-Deutsch A2')?.category).toBe('german')
  })

  it('ticks the eight defaults and selects AI Group B', () => {
    const ch = defaultChoices(detectCourses(ex.sessions))
    expect(ch.filter((c) => c.included).length).toBe(8)
    expect(ch.find((c) => c.code === code('AINBA'))).toMatchObject({ included: true, group: 'B' })
    expect(ch.find((c) => c.code === code('RBTAD'))?.group).toBeNull()
    expect(choicesToDefs(ch).find((c) => c.code === code('AINBA'))?.onlyGroup).toBe('B')
  })
})

describe('buildReview', () => {
  it('keeps AI Group A out and Group B in without deleting the source records', () => {
    const before = JSON.stringify(ex.sessions)
    const r = buildReview(ex.sessions, fresh())
    const ai = r.items.filter((i) => i.course.code === code('AINBA'))
    expect(ai.length).toBeGreaterThan(0)
    expect(ai.every((i) => i.session.groups.join() === 'B')).toBe(true)
    expect(r.summary.groupExcluded).toBeGreaterThan(0)
    expect(JSON.stringify(ex.sessions)).toBe(before) // parser output is never mutated
    expect(ex.sessions.some((s) => s.courseCode === code('AINBA') && s.groups.join() === 'A')).toBe(true)
  })

  it('switching to Group A swaps the sessions; no group chosen asks for review instead of assuming', () => {
    const s = fresh()
    const a = buildReview(ex.sessions, { ...s, choices: s.choices.map((c) => (c.code === code('AINBA') ? { ...c, group: 'A' } : c)) })
    expect(a.items.filter((i) => i.course.code === code('AINBA')).every((i) => i.session.groups.join() === 'A')).toBe(true)
    const none = buildReview(ex.sessions, { ...s, choices: s.choices.map((c) => (c.code === code('AINBA') ? { ...c, group: null } : c)) })
    const ai = none.items.filter((i) => i.course.code === code('AINBA'))
    expect(ai.some((i) => i.session.groups.join() === 'A')).toBe(true)
    expect(ai.every((i) => i.state === 'needs-review')).toBe(true)
  })

  it('deselecting a course removes its sessions and their clashes', () => {
    const s = fresh()
    const all = buildReview(ex.sessions, s)
    expect(all.clashes.length).toBeGreaterThan(0)
    const without = buildReview(ex.sessions, { ...s, choices: s.choices.map((c) => (c.code === code('NLUAD') ? { ...c, included: false } : c)) })
    expect(without.items.some((i) => i.course.code === code('NLUAD'))).toBe(false)
    expect(without.clashes.every((c) => c.a.course.code !== code('NLUAD') && c.b.course.code !== code('NLUAD'))).toBe(true)
  })

  it('clashes are recalculated after an exclusion and after a corrected time', () => {
    const s = fresh()
    const base = buildReview(ex.sessions, s)
    const clash = base.clashes[0]
    const afterExclude = buildReview(ex.sessions, toggleExcluded(s, clash.a.id, true))
    expect(afterExclude.clashes.length).toBeLessThan(base.clashes.length)
    expect(afterExclude.clashes.some((c) => c.id === clash.id)).toBe(false)
    expect(afterExclude.summary.manuallyExcluded).toBe(1)
    // move b to the evening: that clash disappears
    const moved = commitEdit(s, clash.b.id, clash.b.original, { ...clash.b.values, startTime: '19:00', endTime: '20:00' })
    expect(buildReview(ex.sessions, moved).clashes.some((c) => c.id === clash.id)).toBe(false)
    // restoring brings it back
    expect(buildReview(ex.sessions, toggleExcluded(toggleExcluded(s, clash.a.id, true), clash.a.id, false)).clashes).toHaveLength(base.clashes.length)
  })

  it('records only the corrected fields and resets to the extracted values', () => {
    const s = fresh()
    const it0 = buildReview(ex.sessions, s).items[0]
    const edited = commitEdit(s, it0.id, it0.original, { ...it0.values, room: 'Room X', title: 'Custom title' })
    expect(edited.edits[it0.id]).toEqual({ title: 'Custom title', room: 'Room X' })
    const r = buildReview(ex.sessions, edited).items.find((i) => i.id === it0.id)!
    expect(r.editedFields).toEqual(['title', 'room'])
    expect(r.original).toEqual(it0.original)
    expect(buildReview(ex.sessions, edited).summary).toMatchObject({ edited: 1, correctedFields: 2 })
    // typing the original value back is no change
    expect(commitEdit(edited, it0.id, it0.original, it0.original).edits).toEqual({})
    const back = buildReview(ex.sessions, resetEdit(edited, it0.id)).items.find((i) => i.id === it0.id)!
    expect(back.editedFields).toEqual([])
    expect(back.values).toEqual(it0.original)
  })

  it('validates corrections: dates, times, end after start, empty title, long text', () => {
    const ok = { title: 'T', date: '2026-10-20', startTime: '09:00', endTime: '10:30', room: '' }
    expect(validateValues(ok)).toEqual({})
    expect(validateValues({ ...ok, date: '2026-02-30' }).date).toMatch(/real calendar date/)
    expect(validateValues({ ...ok, date: '20.10.2026' }).date).toBeDefined()
    expect(validateValues({ ...ok, date: '' }).date).toMatch(/required/)
    expect(validateValues({ ...ok, startTime: '9:00' }).startTime).toBeDefined()
    expect(validateValues({ ...ok, startTime: '25:00' }).startTime).toBeDefined()
    expect(validateValues({ ...ok, endTime: '09:00' }).endTime).toMatch(/after the start/)
    expect(validateValues({ ...ok, endTime: '08:00' }).endTime).toMatch(/after the start/)
    expect(validateValues({ ...ok, title: '  ' }).title).toBeDefined()
    expect(validateValues({ ...ok, title: 'x'.repeat(121) }).title).toBeDefined()
    expect(validateValues({ ...ok, room: 'x'.repeat(121) }).room).toBeDefined()
  })

  it('an invalid correction makes the session invalid, not ready, and it never becomes a clash', () => {
    const s = fresh()
    const it0 = buildReview(ex.sessions, s).items.find((i) => i.state === 'ready')!
    const bad = commitEdit(s, it0.id, it0.original, { ...it0.values, endTime: '08:00' })
    const r = buildReview(ex.sessions, bad)
    expect(r.items.find((i) => i.id === it0.id)).toMatchObject({ state: 'invalid' })
    expect(r.clashes.some((c) => c.a.id === it0.id || c.b.id === it0.id)).toBe(false)
  })

  it('flags a second included session with the same identity', () => {
    const s = fresh()
    const items = buildReview(ex.sessions, s).items.filter((i) => i.course.code === code('RBTAD') && i.session.kind === 'main')
    const [a, b] = items
    const same = { ...b.values, date: a.values.date, startTime: a.values.startTime, endTime: a.values.endTime }
    const edited = commitEdit(s, b.id, b.original, same)
    expect(duplicateOf(buildReview(ex.sessions, s).items, b, same)?.id).toBe(a.id)
    const r = buildReview(ex.sessions, edited)
    expect(r.items.find((i) => i.id === a.id)?.errors.identity).toBeDefined()
    expect(r.items.find((i) => i.id === b.id)?.state).toBe('invalid')
    // excluding one resolves it
    expect(buildReview(ex.sessions, toggleExcluded(edited, b.id, true)).items.find((i) => i.id === a.id)?.errors.identity).toBeUndefined()
  })

  it('needs-review sessions stay in "needs attention" until acknowledged; undated ones can never be ready', () => {
    const s = fresh()
    const none = { ...s, choices: s.choices.map((c) => (c.code === code('AINBA') ? { ...c, group: null } : c)) }
    const r = buildReview(ex.sessions, none)
    const target = r.items.find((i) => i.state === 'needs-review')!
    expect(r.summary.needsAttention).toBeGreaterThan(0)
    const acked = buildReview(ex.sessions, setReviewed(none, target.id, true)).items.find((i) => i.id === target.id)!
    expect(acked.state).toBe('ready')

    // an undated session (week 1 has no dates) stays invalid even when acknowledged
    const undatedSessions = ex.sessions.map((x, i) => (i === 0 ? { ...x, date: null } : x))
    const st = initialState(undatedSessions)
    const forced = { ...st, choices: [{ code: undatedSessions[0].courseCode, name: 'X', category: 'university' as const, included: true, group: null }], reviewed: ['0'] }
    const item = buildReview(undatedSessions, forced).items.find((i) => i.id === '0')!
    expect(item.values.date).toBe('')
    expect(item.state).toBe('invalid')
    expect(item.errors.date).toMatch(/required/)
    // a manually entered, valid date resolves it
    const fixed = buildReview(undatedSessions, commitEdit(forced, '0', item.original, { ...item.values, date: '2026-11-02' })).items.find((i) => i.id === '0')!
    expect(fixed.errors.date).toBeUndefined()
    expect(fixed.reasons).not.toContain('no usable date in the source')
  })

  it('warns, without blocking, when a corrected date falls on another weekday', () => {
    const s = fresh()
    const it0 = buildReview(ex.sessions, s).items.find((i) => i.session.weekday === 'Tuesday')!
    const d = it0.values.date
    const next = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8)) + 1)).toISOString().slice(0, 10)
    const r = buildReview(ex.sessions, commitEdit(s, it0.id, it0.original, { ...it0.values, date: next })).items.find((i) => i.id === it0.id)!
    expect(r.warnings.join()).toMatch(/Wednesday/)
    expect(r.errors).toEqual({})
  })

  it('filters by course, week, date and status, and can come back empty', () => {
    const r = buildReview(ex.sessions, fresh())
    const one = r.items[0]
    expect(filterItems(r.items, NO_FILTERS)).toHaveLength(r.items.length)
    expect(filterItems(r.items, { ...NO_FILTERS, course: one.course.code }).every((i) => i.course.code === one.course.code)).toBe(true)
    expect(filterItems(r.items, { ...NO_FILTERS, week: String(one.session.semesterWeek) }).every((i) => i.session.semesterWeek === one.session.semesterWeek)).toBe(true)
    expect(filterItems(r.items, { ...NO_FILTERS, date: one.values.date }).length).toBeGreaterThan(0)
    expect(filterItems(r.items, { ...NO_FILTERS, status: 'clash' }).length).toBe(new Set(r.clashes.flatMap((c) => [c.a.id, c.b.id])).size)
    expect(filterItems(r.items, { ...NO_FILTERS, date: '1999-01-01' })).toEqual([])
    expect(filterItems(r.items, { ...NO_FILTERS, status: 'edited' })).toEqual([])
  })

  it('merged sessions keep every slot card as provenance', () => {
    const multi = ex.sessions.find((s) => s.spansMultipleSlots)!
    expect(multi.source.length).toBe(multi.slots.length)
    expect(multi.source.every((s) => s.page > 0 && s.rawLines.length > 0)).toBe(true)
  })
})

describe('malformed dates in the source', () => {
  it('an impossible printed date is withheld, reported, and the sessions on that day cannot be ready', () => {
    const layouts = structuredClone(pages)
    const base = extractFromLayouts(structuredClone(pages))
    const week4 = base.tables.find((t) => t.semesterWeek === 4)!
    const tuesday = week4.days[1]
    const hit = layouts.find((l) => l.page === week4.titlePage)!.texts.find((t) => t.str.trim() === tuesday.dateText)!
    hit.str = '31.02.2026'
    const broken = extractFromLayouts(layouts)
    expect(broken.supported).toBe(true)
    expect(broken.anomalies.map((a) => a.code)).toContain('invalid-date')
    const lost = broken.sessions.filter((x) => x.semesterWeek === 4 && x.weekday === 'Tuesday')
    expect(lost.length).toBeGreaterThan(0)
    expect(lost.every((x) => x.date === null && x.confidence === 'low')).toBe(true)
    const review = buildReview(broken.sessions, initialState(broken.sessions))
    const items = review.items.filter((i) => i.session.semesterWeek === 4 && i.session.weekday === 'Tuesday')
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.state === 'invalid' && i.values.date === '')).toBe(true)
    expect(review.summary.needsAttention).toBeGreaterThanOrEqual(items.length)
  })
})

describe('source facts', () => {
  it('reads semester, the preliminary notice and groups anomalies by kind', () => {
    const facts = describeSource(ex.layouts, ex.sessions, ex.tables.map((t) => t.title))
    expect(facts.semester).toBe('Winter Semester 2026/2027')
    expect(facts.preliminaryNote).toMatch(/preliminary as of 28 September 2026/)
    const groups = groupAnomalies(ex.anomalies)
    // the fixture holds only some weeks, so it also reports gaps between them
    expect(groups.map((g) => g.code)).toEqual(expect.arrayContaining(['date-weekday-mismatch', 'duplicate-date', 'no-date']))
    expect(groups.find((g) => g.code === 'no-date')?.semesterWeeks).toEqual([1])
    expect(groups.find((g) => g.code === 'duplicate-date')?.semesterWeeks).toEqual([23])
  })
})

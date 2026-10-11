import { beforeAll, describe, expect, it } from 'vitest'
import { deterministicUuid } from '../../cloud/ids'
import type { EventRow } from '../../cloud/types'
import raw from '../utn/__fixtures__/utn-wise2627-layouts.json?raw'
import { extractFromLayouts } from '../utn/index.ts'
import { buildReview, commitEdit, initialState, toggleExcluded } from '../utn/review.ts'
import type { ReviewResult, ReviewState } from '../utn/review.ts'
import type { PageLayout } from '../utn/types.ts'
import { diffRevision } from './diff.ts'
import type { LinkRecord } from './diff.ts'
import { buildBatchInsert, buildImportItems, chunk, publishedOnFromNote, sha256Hex, snapshotOfRow, sourceSlugOf, toRpcItems } from './importItems.ts'
import type { ImportItem } from './importItems.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const pages = (JSON.parse(raw) as { pages: PageLayout[] }).pages

let sessions: ReturnType<typeof extractFromLayouts>['sessions']
let state: ReviewState
let review: ReviewResult
let items: ImportItem[]

beforeAll(async () => {
  sessions = extractFromLayouts(structuredClone(pages)).sessions
  state = initialState(sessions)
  review = buildReview(sessions, state)
  items = (await buildImportItems(ALICE, review.items)).items
})

const row = (i: ImportItem, over: Partial<EventRow> = {}): EventRow => ({
  id: i.eventId, user_id: ALICE, ...i.event, created_at: '2026-10-10T10:00:00.000Z', updated_at: '2026-10-10T10:00:00.000Z', ...over,
})
const link = (i: ImportItem, n: number, over: Partial<LinkRecord> = {}): LinkRecord => ({
  id: `link-${n}`, source_key: i.sourceKey, event_id: i.eventId, imported_snapshot: i.event, source_snapshot: i.source, retired_at: null, ...over,
})
const imported = (list: ImportItem[]) => ({ links: list.map((i, n) => link(i, n)), events: list.map((i) => row(i)) })

/** The same session printed at another time/date by a revised PDF (new key, new deterministic id). */
async function moved(i: ImportItem, to: { date?: string; time?: string }): Promise<ImportItem> {
  const p = i.sourceKey.split('|')
  if (to.date) p[1] = to.date
  if (to.time) p[2] = to.time
  const key = p.join('|')
  return { ...i, sourceKey: key, eventId: await deterministicUuid(`${ALICE}:event`, key) }
}

describe('import items', () => {
  it('turns every reviewed, ready session into one item with a deterministic id', () => {
    expect(items).toHaveLength(review.items.filter((i) => i.state === 'ready').length)
    expect(items.length).toBeGreaterThan(40)
    expect(new Set(items.map((i) => i.eventId)).size).toBe(items.length)
    expect(new Set(items.map((i) => i.sourceKey)).size).toBe(items.length)
    expect(items.every((i) => /^[0-9a-f-]{36}$/.test(i.eventId))).toBe(true)
    expect(new Set(items.map((i) => sourceSlugOf(i.sourceKey)))).toEqual(new Set(['utn-wise2627']))
  })

  it('identity is stable across runs and input order, and never shared between users', async () => {
    const again = (await buildImportItems(ALICE, [...review.items].reverse())).items
    expect(new Map(again.map((i) => [i.sourceKey, i.eventId]))).toEqual(new Map(items.map((i) => [i.sourceKey, i.eventId])))
    const bob = (await buildImportItems(BOB, review.items)).items
    expect(bob.map((i) => i.sourceKey).sort()).toEqual(items.map((i) => i.sourceKey).sort())
    const aliceIds = new Set(items.map((i) => i.eventId))
    expect(bob.some((i) => aliceIds.has(i.eventId))).toBe(false)
  })

  it('writes one-off events in Europe/Berlin (09:00 Berlin = 07:00Z in October, 08:00Z in December) with overlaps kept as separate events', () => {
    const oct = items.find((i) => i.source.date === '2026-10-20' && i.source.startTime === '09:00')!
    expect(oct.event).toMatchObject({ time_zone: 'Europe/Berlin', starts_at: '2026-10-20T07:00:00.000Z', ends_at: '2026-10-20T08:30:00.000Z', category: 'university' })
    const dec = items.find((i) => i.source.date?.startsWith('2026-12') && i.source.startTime === '09:00')!
    expect(dec.event.starts_at.endsWith('T08:00:00.000Z')).toBe(true)
    expect(review.clashes.length).toBeGreaterThan(0)
    for (const c of review.clashes) {
      expect(items.some((i) => i.sourceKey === c.a.session.sourceKey)).toBe(true)
      expect(items.some((i) => i.sourceKey === c.b.session.sourceKey)).toBe(true)
    }
  })

  it('imports the reviewed values (corrections) but keeps the identity of the PDF session', async () => {
    const target = review.items.find((i) => i.state === 'ready')!
    const edited = commitEdit(state, target.id, target.original, { ...target.values, room: 'Room X', title: 'My title' })
    const r2 = buildReview(sessions, edited)
    const it2 = (await buildImportItems(ALICE, r2.items)).items.find((i) => i.sourceKey === target.session.sourceKey)!
    const it1 = items.find((i) => i.sourceKey === target.session.sourceKey)!
    expect(it2.eventId).toBe(it1.eventId)
    expect(it2.event).toMatchObject({ title: 'My title', location: 'Room X' })
    expect(it2.corrected).toBe(true)
    expect(it1.corrected).toBe(false)
    expect(it2.source.room).toBe(it1.source.room) // what the PDF printed is kept separately
  })

  it('skips excluded, invalid and unreviewed sessions and says why; duplicate identities are skipped together', async () => {
    const first = review.items[0]
    const ex = toggleExcluded(state, first.id, true)
    const bad = commitEdit(ex, review.items[1].id, review.items[1].original, { ...review.items[1].values, endTime: '06:00' })
    const r = buildReview(sessions, bad)
    const out = await buildImportItems(ALICE, r.items)
    expect(out.skipped.map((s) => s.reason).sort()).toEqual(['excluded', 'invalid'])
    expect(out.items).toHaveLength(items.length - 2)

    const dupe = { ...review.items[2], id: 'dupe' }
    const out2 = await buildImportItems(ALICE, [...review.items, dupe])
    expect(out2.skipped.filter((s) => s.reason === 'duplicate-source-key')).toHaveLength(2)
    expect(out2.items.some((i) => i.sourceKey === review.items[2].session.sourceKey)).toBe(false)
  })

  it('formats the RPC payload and chunks it under the server limit', () => {
    const rpc = toRpcItems(items)
    expect(Object.keys(rpc[0]).sort()).toEqual(['event', 'event_id', 'source', 'source_key'])
    expect(chunk(rpc).every((c) => c.length <= 50)).toBe(true)
    expect(chunk(rpc).flat()).toHaveLength(rpc.length)
  })

  it('validates the batch row like the table constraints do', async () => {
    const sha = await sha256Hex(new TextEncoder().encode('not a real pdf'))
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    const ok = buildBatchInsert({ slug: 'utn-wise2627', label: 'UTN WiSe 2026/27', sha256: sha, publishedOn: '2026-09-28', selection: ['W26M-AINBA:B'], planned: 168 })
    expect(ok.planned_count).toBe(168)
    for (const bad of [{ slug: 'UTN' }, { slug: '' }, { sha256: 'abc' }, { label: '' }, { planned: -1 }, { planned: 5001 }]) {
      expect(() => buildBatchInsert({ slug: 'utn-wise2627', label: 'x', sha256: sha, publishedOn: null, selection: [], planned: 1, ...bad })).toThrow()
    }
  })

  it('reads the "preliminary as of" date from the PDF notice', () => {
    expect(publishedOnFromNote('Please note that this timetable is preliminary as of 28 September 2026 and is subject to change.')).toBe('2026-09-28')
    expect(publishedOnFromNote('as of 31 February 2026')).toBeNull()
    expect(publishedOnFromNote('no date here')).toBeNull()
    expect(publishedOnFromNote(null)).toBeNull()
  })

  it('the stored snapshot equals what the client computes from the calendar row (so edit detection has no false positives)', () => {
    for (const i of items.slice(0, 20)) expect(snapshotOfRow(row(i))).toEqual(i.event)
  })
})

describe('revision diff', () => {
  it('first import: everything is new, nothing else', () => {
    const d = diffRevision({ incoming: items, links: [], events: [] })
    expect(d.summary).toMatchObject({ new: items.length, unchanged: 0, removed: 0, possibleMoves: 0, ambiguous: 0, blocked: 0 })
  })

  it('importing the same PDF again creates nothing: all unchanged', () => {
    const d = diffRevision({ incoming: items, ...imported(items) })
    expect(d.summary).toMatchObject({ new: 0, unchanged: items.length, sourceChanged: 0, removed: 0, possibleMoves: 0, userEdited: 0 })
  })

  it('an interrupted import resumes with exactly the missing sessions', () => {
    const done = items.slice(0, 20)
    const d = diffRevision({ incoming: items, ...imported(done) })
    expect(d.new.map((i) => i.sourceKey)).toEqual(items.slice(20).map((i) => i.sourceKey))
    expect(d.unchanged).toHaveLength(20)
  })

  it('a changed room in the revised PDF is proposed as a change; a user-edited event turns it into a conflict', async () => {
    const base = imported(items)
    const changed = items.map((i, n) => (n === 0 ? { ...i, source: { ...i.source, room: 'NOP / NEW' } } : i))
    const safe = diffRevision({ incoming: changed, ...base })
    expect(safe.sourceChanged).toHaveLength(1)
    expect(safe.sourceChanged[0]).toMatchObject({ mode: 'safe', changes: [{ field: 'room', from: items[0].source.room, to: 'NOP / NEW' }] })
    expect(safe.summary.unchanged).toBe(items.length - 1)

    const edited = base.events.map((e, n) => (n === 0 ? { ...e, title: 'Renamed by me', updated_at: '2026-10-11T08:00:00.000Z' } : e))
    const conflict = diffRevision({ incoming: changed, links: base.links, events: edited })
    expect(conflict.sourceChanged[0]).toMatchObject({ mode: 'conflict', userEdited: ['title'] })
  })

  it('a user-edited event is kept and reported even when the PDF is unchanged', () => {
    const base = imported(items)
    const events = base.events.map((e, n) => (n === 3 ? { ...e, location: 'My own room' } : e))
    const d = diffRevision({ incoming: items, links: base.links, events })
    expect(d.unchanged[3].userEdited).toEqual(['location'])
    expect(d.summary).toMatchObject({ unchanged: items.length, userEdited: 1, sourceChanged: 0 })
  })

  it('a removed session is listed, never deleted, and its user edits are reported', () => {
    const base = imported(items)
    const events = base.events.map((e, n) => (n === 5 ? { ...e, title: 'Mine' } : e))
    const d = diffRevision({ incoming: items.filter((_, n) => n !== 5 && n !== 6), links: base.links, events })
    expect(d.removed.map((r) => r.link.source_key)).toEqual([items[5].sourceKey, items[6].sourceKey])
    expect(d.removed[0].userEdited).toEqual(['title'])
    expect(d.removed[1].userEdited).toEqual([])
    expect(d.summary.new).toBe(0)
  })

  it('a class that moved to another time on the same date is a HIGH-confidence possible move, not a definite one', async () => {
    const base = imported(items)
    const m = await moved(items[0], { time: '17:00-18:30' })
    const d = diffRevision({ incoming: [m, ...items.slice(1)], ...base })
    expect(d.possibleMoves).toHaveLength(1)
    expect(d.possibleMoves[0]).toMatchObject({ confidence: 'high' })
    expect(d.possibleMoves[0].link.source_key).toBe(items[0].sourceKey)
    expect(d.possibleMoves[0].incoming.sourceKey).toBe(m.sourceKey)
    expect(d.summary).toMatchObject({ new: 0, removed: 0, possibleMoves: 1 })
  })

  it('the same slot on another date within a week is a MEDIUM possible move; a month away is just new + removed', async () => {
    const base = imported(items)
    const day = items[0].source.date as string
    const plus = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
    const near = diffRevision({ incoming: [await moved(items[0], { date: plus(2) }), ...items.slice(1)], ...base })
    expect(near.possibleMoves[0]).toMatchObject({ confidence: 'medium' })
    const far = diffRevision({ incoming: [await moved(items[0], { date: plus(30) }), ...items.slice(1)], ...base })
    expect(far.possibleMoves).toHaveLength(0)
    expect(far.summary).toMatchObject({ new: 1, removed: 1 })
  })

  it('an uncertain match (several candidates) is reported as ambiguous and nothing is paired', async () => {
    const one = items[0]
    const a = await moved(one, { time: '17:00-18:30' })
    const b = await moved(one, { time: '18:30-20:00' })
    const d = diffRevision({ incoming: [a, b, ...items.slice(1)], ...imported(items) })
    expect(d.possibleMoves).toHaveLength(0)
    expect(d.ambiguous).toHaveLength(1)
    expect(d.ambiguous[0]).toMatchObject({ reason: 'several-possible-matches' })
    expect(d.ambiguous[0].links).toHaveLength(1)
    expect(d.ambiguous[0].incoming).toHaveLength(2)
    expect(d.summary).toMatchObject({ new: 0, removed: 0 })
  })

  it('a different course or type never pairs as a move', async () => {
    const a = items[0]
    const head = a.sourceKey.split('|').slice(0, 3).join('|')
    for (const tail of ['W26M-OTHER|main', `${a.sourceKey.split('|')[3]}|some other type`]) {
      const swapped = await moved({ ...a, sourceKey: `${head}|${tail}` }, { time: '17:00-18:30' })
      const d = diffRevision({ incoming: [swapped, ...items.slice(1)], ...imported(items) })
      expect(d.possibleMoves).toHaveLength(0)
      expect(d.summary).toMatchObject({ new: 1, removed: 1 })
    }
  })

  it('an event the user deleted is not resurrected', () => {
    const base = imported(items)
    const links = base.links.map((l, n) => (n === 2 ? { ...l, event_id: null } : l))
    const events = base.events.filter((_, n) => n !== 2)
    const d = diffRevision({ incoming: items, links, events })
    expect(d.deletedByUser).toHaveLength(1)
    expect(d.deletedByUser[0].incoming?.sourceKey).toBe(items[2].sourceKey)
    expect(d.new).toHaveLength(0)
    const gone = diffRevision({ incoming: items.filter((_, n) => n !== 2), links, events })
    expect(gone.deletedByUser[0].incoming).toBeNull()
    expect(gone.removed).toHaveLength(0)
  })

  it('an unrelated event that already uses the deterministic id is never adopted', () => {
    const stranger = row(items[0], { title: 'Something I created myself' })
    const d = diffRevision({ incoming: items, links: [], events: [stranger] })
    expect(d.blocked).toEqual([{ incoming: items[0], reason: 'event-id-taken' }])
    expect(d.new).toHaveLength(items.length - 1)
  })

  it('a link whose event is missing from the read is ambiguous, not "deleted"', () => {
    const base = imported(items)
    const d = diffRevision({ incoming: items, links: base.links, events: base.events.slice(1) })
    expect(d.ambiguous).toHaveLength(1)
    expect(d.ambiguous[0].reason).toBe('event-missing-from-read')
  })

  it('retired sessions are not listed again as removed, and a reappearing one is flagged', () => {
    const base = imported(items)
    const links = base.links.map((l, n) => (n === 0 ? { ...l, retired_at: '2026-11-01T00:00:00.000Z' } : l))
    const without = diffRevision({ incoming: items.slice(1), links, events: base.events })
    expect(without.removed).toHaveLength(0)
    const again = diffRevision({ incoming: items, links, events: base.events })
    expect(again.unchanged[0].reappeared).toBe(true)
  })
})

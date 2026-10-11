import type { EventRow } from '../../cloud/types'
import { EVENT_FIELDS, snapshotOfRow } from './importItems.ts'
import type { EventSnapshot, ImportItem, SourceSnapshot } from './importItems.ts'

/**
 * Revision diff for a (re-)import. Pure and conservative: it only CLASSIFIES. It never decides to change or delete a
 * calendar event; every non-trivial class needs the user's explicit choice in a later checkpoint.
 *
 * Inputs
 *   incoming  what the new PDF (after the user's review) would import
 *   links     rows of `event_import_links` for this source lineage (the durable, cross-device history)
 *   events    the user's current calendar events (at least those referenced by the links, plus any event whose id
 *             an incoming session would take)
 *
 * The three-way view of every linked session:
 *   base   = link.imported_snapshot (what ORBIT wrote)
 *   local  = the event as it is now (the user may have edited or deleted it)
 *   remote = the incoming session (what the new PDF says)
 */

export interface LinkRecord {
  id: string
  source_key: string
  /** NULL = the user deleted the event (tombstone). */
  event_id: string | null
  imported_snapshot: EventSnapshot
  source_snapshot: SourceSnapshot
  retired_at: string | null
}

export type SourceField = 'room' | 'typeText' | 'groups'
const SOURCE_FIELDS: readonly SourceField[] = ['room', 'typeText', 'groups']

export interface FieldChange<F extends string = string> {
  field: F
  from: unknown
  to: unknown
}

/** Event fields whose current value differs from what ORBIT imported = the user's own edits. */
export function userEditedFields(link: Pick<LinkRecord, 'imported_snapshot'>, event: EventRow): (keyof EventSnapshot)[] {
  const now = snapshotOfRow(event)
  return EVENT_FIELDS.filter((f) => now[f] !== link.imported_snapshot[f])
}

export function sourceChanges(base: SourceSnapshot, next: SourceSnapshot): FieldChange<SourceField>[] {
  return SOURCE_FIELDS.filter((f) => JSON.stringify(base[f]) !== JSON.stringify(next[f])).map((f) => ({ field: f, from: base[f], to: next[f] }))
}

export interface UnchangedEntry {
  incoming: ImportItem
  link: LinkRecord
  /** The event carries the user's own edits; they are kept (nothing is proposed). */
  userEdited: (keyof EventSnapshot)[]
  /** The session had been retired earlier and is printed again. */
  reappeared: boolean
}

export interface SourceChangedEntry {
  incoming: ImportItem
  link: LinkRecord
  changes: FieldChange<SourceField>[]
  userEdited: (keyof EventSnapshot)[]
  /** `safe`: the event still equals what ORBIT wrote, so a later checkpoint MAY offer to update it (after confirmation).
   *  `conflict`: the user edited it too; nothing may be changed automatically. */
  mode: 'safe' | 'conflict'
}

export interface RemovedEntry {
  link: LinkRecord
  userEdited: (keyof EventSnapshot)[]
}

export interface PossibleMove {
  link: LinkRecord
  incoming: ImportItem
  /** `high`: same course/type on the same date at another time. `medium`: same slot, another date within a week. */
  confidence: 'high' | 'medium'
  reason: string
  userEdited: (keyof EventSnapshot)[]
}

export interface Ambiguous {
  links: LinkRecord[]
  incoming: ImportItem[]
  reason: 'several-possible-matches' | 'event-missing-from-read'
}

export interface Blocked {
  incoming: ImportItem
  reason: 'event-id-taken'
}

export interface DiffResult {
  /** No link yet: safe to offer for import (the default action). */
  new: ImportItem[]
  unchanged: UnchangedEntry[]
  sourceChanged: SourceChangedEntry[]
  /** Linked, but the new PDF no longer prints it (and no move candidate): NEVER deleted automatically. */
  removed: RemovedEntry[]
  possibleMoves: PossibleMove[]
  /** The user deleted the imported event earlier: not recreated unless the user asks. `incoming` is set when the PDF still prints it. */
  deletedByUser: { link: LinkRecord; incoming: ImportItem | null }[]
  ambiguous: Ambiguous[]
  blocked: Blocked[]
  summary: Record<'new' | 'unchanged' | 'sourceChanged' | 'removed' | 'possibleMoves' | 'deletedByUser' | 'ambiguous' | 'blocked' | 'userEdited', number>
}

/** `slug|date|start-end|codes|type...` -> parts, or null when the key does not have the expected shape. */
function parseKey(key: string): { date: string; time: string; tail: string } | null {
  const p = key.split('|')
  if (p.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(p[1]) || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(p[2])) return null
  return { date: p[1], time: p[2], tail: p.slice(3).join('|') }
}

const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)

function moveCandidate(link: LinkRecord, item: ImportItem): { confidence: 'high' | 'medium'; reason: string } | null {
  const a = parseKey(link.source_key)
  const b = parseKey(item.sourceKey)
  if (!a || !b || a.tail !== b.tail) return null // same course(s), session type and group are required
  if (a.date === b.date && a.time !== b.time) return { confidence: 'high', reason: `same course and type on ${a.date}, time ${a.time} -> ${b.time}` }
  const days = Math.abs(dayNumber(a.date) - dayNumber(b.date))
  if (a.date !== b.date && a.time === b.time && days <= 7) return { confidence: 'medium', reason: `same course, type and time, date ${a.date} -> ${b.date}` }
  return null
}

export function diffRevision(input: { incoming: readonly ImportItem[]; links: readonly LinkRecord[]; events: readonly EventRow[] }): DiffResult {
  const events = new Map(input.events.map((e) => [e.id, e]))
  const linkByKey = new Map(input.links.map((l) => [l.source_key, l]))
  const incomingByKey = new Map(input.incoming.map((i) => [i.sourceKey, i]))

  const out: DiffResult = {
    new: [], unchanged: [], sourceChanged: [], removed: [], possibleMoves: [], deletedByUser: [], ambiguous: [], blocked: [],
    summary: { new: 0, unchanged: 0, sourceChanged: 0, removed: 0, possibleMoves: 0, deletedByUser: 0, ambiguous: 0, blocked: 0, userEdited: 0 },
  }
  const newItems: ImportItem[] = []

  // 1. every incoming session
  for (const item of input.incoming) {
    const link = linkByKey.get(item.sourceKey)
    if (!link) {
      if (events.has(item.eventId)) out.blocked.push({ incoming: item, reason: 'event-id-taken' }) // some other event owns the id: never adopted
      else newItems.push(item)
      continue
    }
    if (link.event_id === null) {
      out.deletedByUser.push({ link, incoming: item })
      continue
    }
    const event = events.get(link.event_id)
    if (!event) {
      out.ambiguous.push({ links: [link], incoming: [item], reason: 'event-missing-from-read' })
      continue
    }
    const edited = userEditedFields(link, event)
    const changes = sourceChanges(link.source_snapshot, item.source)
    if (changes.length === 0) out.unchanged.push({ incoming: item, link, userEdited: edited, reappeared: link.retired_at !== null })
    else out.sourceChanged.push({ incoming: item, link, changes, userEdited: edited, mode: edited.length === 0 ? 'safe' : 'conflict' })
  }

  // 2. linked sessions the new PDF no longer prints
  const gone = input.links.filter((l) => !incomingByKey.has(l.source_key) && l.retired_at === null)
  const goneLive: LinkRecord[] = []
  for (const link of gone) {
    if (link.event_id === null) out.deletedByUser.push({ link, incoming: null })
    else goneLive.push(link)
  }

  // 3. likely moves: pair a vanished link with a new session only when the match is mutual and unique
  const edges: [number, number, ReturnType<typeof moveCandidate>][] = []
  goneLive.forEach((l, i) => newItems.forEach((n, j) => {
    const c = moveCandidate(l, n)
    if (c) edges.push([i, j, c])
  }))
  const seenL = new Set<number>()
  const seenN = new Set<number>()
  for (const [i, j] of edges) {
    if (seenL.has(i) || seenN.has(j)) continue
    // connected component of the bipartite candidate graph
    const compL = new Set<number>([i])
    const compN = new Set<number>([j])
    for (let grew = true; grew;) {
      grew = false
      for (const [a, b] of edges) {
        if (compL.has(a) && !compN.has(b)) { compN.add(b); grew = true }
        if (compN.has(b) && !compL.has(a)) { compL.add(a); grew = true }
      }
    }
    compL.forEach((x) => seenL.add(x))
    compN.forEach((x) => seenN.add(x))
    if (compL.size === 1 && compN.size === 1) {
      const link = goneLive[i]
      const event = events.get(link.event_id as string)
      const c = edges.find(([a, b]) => a === i && b === j)![2]!
      out.possibleMoves.push({ link, incoming: newItems[j], confidence: c.confidence, reason: c.reason, userEdited: event ? userEditedFields(link, event) : [] })
    } else {
      out.ambiguous.push({ links: [...compL].map((x) => goneLive[x]), incoming: [...compN].map((x) => newItems[x]), reason: 'several-possible-matches' })
    }
  }

  out.new = newItems.filter((_, j) => !seenN.has(j))
  for (let i = 0; i < goneLive.length; i++) {
    if (seenL.has(i)) continue
    const link = goneLive[i]
    const event = events.get(link.event_id as string)
    if (!event) out.ambiguous.push({ links: [link], incoming: [], reason: 'event-missing-from-read' })
    else out.removed.push({ link, userEdited: userEditedFields(link, event) })
  }

  const edited = new Set<string>()
  for (const e of [...out.unchanged, ...out.sourceChanged, ...out.removed, ...out.possibleMoves]) if (e.userEdited.length) edited.add(e.link.id)
  out.summary = {
    new: out.new.length, unchanged: out.unchanged.length, sourceChanged: out.sourceChanged.length, removed: out.removed.length,
    possibleMoves: out.possibleMoves.length, deletedByUser: out.deletedByUser.length, ambiguous: out.ambiguous.length,
    blocked: out.blocked.length, userEdited: edited.size,
  }
  return out
}

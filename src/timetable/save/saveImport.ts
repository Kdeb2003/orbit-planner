import { ImportError, mapImportError } from '../../cloud/importApi.ts'
import type { BatchRow, ImportApi, LinkRow } from '../../cloud/importApi.ts'
import type { EventRow } from '../../cloud/types'
import { diffRevision } from '../provenance/diff.ts'
import type { DiffResult } from '../provenance/diff.ts'
import { RPC_CHUNK, buildBatchInsert, buildImportItems, chunk, snapshotOfRow, sourceSlugOf, toRpcItems } from '../provenance/importItems.ts'
import type { ImportItem, SkippedItem } from '../provenance/importItems.ts'
import type { ReviewItem } from '../utn/review.ts'

/**
 * Confirm & Save: writes the reviewed timetable sessions into the signed-in user's calendar through the approved
 * provenance design (see docs/proposals/timetable-import-provenance.md). No React, no Supabase client: the two
 * backends are injected (`imports` = the provenance API, `cloud.loadEvents` = the user's calendar read).
 *
 * Contract with the database (frozen, verified by supabase/tests/save-import.test.ts against the real SQL):
 *  - `planned_count` = the number of NEW events this batch will write (not the PDF's total).
 *  - sessions are written ONLY by `orbit_import_sessions` (insert-only, atomic per chunk of <= 100; we use 50);
 *  - a batch may become `written` only when exactly planned_count links exist, `verified` only when every
 *    linked event still equals what was imported. The database refuses a false claim; we never fake one.
 *  - existing events (manual, edited, or from an earlier import) are never updated, adopted or deleted.
 *
 * Nothing here claims success before (1) the server accepted `written`, (2) the data was read back and compared,
 * and (3) the server accepted `verified`.
 */

export interface SaveContext {
  cloud: { loadEvents(): Promise<EventRow[]> }
  imports: ImportApi
}

export interface SaveInput {
  userId: string
  reviewItems: readonly ReviewItem[]
  /** SHA-256 (hex) of the PDF. The bytes themselves are never stored. */
  sha256: string
  label: string
  publishedOn: string | null
  /** e.g. ['W26M-AINBA:B'] (provenance only). */
  selection: string[]
  /** Schedule overlaps among the selected sessions (warnings; both events are saved). */
  clashes: number
}

export interface SaveCounts {
  /** Sessions this save will create. */
  toCreate: number
  /** Already in the calendar from an earlier import (unchanged, kept as they are). */
  alreadyImported: number
  /** Not imported: excluded, invalid, or still needing review. */
  skipped: number
  /** Sessions whose event id belongs to another event (never adopted) or that you deleted after importing (never recreated). */
  notRecreated: number
  /** Differences from an earlier import (changed in the PDF, no longer printed, possible moves): listed, never applied. */
  differences: number
  /** Overlapping sessions among the selected ones. */
  clashes: number
  /** Imported events you edited yourself (kept untouched). */
  userEdited: number
}

export interface SavePlan {
  slug: string | null
  items: ImportItem[]
  skipped: SkippedItem[]
  diff: DiffResult | null
  toCreate: ImportItem[]
  counts: SaveCounts
  /** A batch of an earlier, interrupted attempt that this save will continue. */
  resume: BatchRow | null
  /** Interrupted batches that cannot be continued (they will be closed with an honest label). */
  retire: BatchRow[]
  /** Another device/tab started an import moments ago: wait instead of racing it. */
  activeElsewhere: BatchRow | null
  links: LinkRow[]
  events: EventRow[]
}

/** A batch younger than this that is still in_progress is treated as a live import on another device. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

export async function checkAvailability(imports: ImportApi): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const p = await imports.probe()
    return p.available ? { ok: true } : { ok: false, reason: p.reason }
  } catch (err) {
    return { ok: false, reason: mapImportError(err).message }
  }
}

/** Reads the cloud and decides, without writing anything, what a save would do. Throws ImportError on a failed read. */
export async function planSave(ctx: SaveContext, input: SaveInput, now: () => number = Date.now): Promise<SavePlan> {
  const { items, skipped } = await buildImportItems(input.userId, input.reviewItems)
  const slugs = new Set(items.map((i) => sourceSlugOf(i.sourceKey)))
  if (slugs.size > 1) throw new ImportError('validation', 'The selected sessions come from more than one timetable source.', 'multi-slug')
  const slug = items.length ? [...slugs][0] : null
  const empty: SaveCounts = { toCreate: 0, alreadyImported: 0, skipped: skipped.length, notRecreated: 0, differences: 0, clashes: input.clashes, userEdited: 0 }
  if (!slug) return { slug, items, skipped, diff: null, toCreate: [], counts: empty, resume: null, retire: [], activeElsewhere: null, links: [], events: [] }

  let links: LinkRow[]
  let batches: BatchRow[]
  let events: EventRow[]
  try {
    ;[links, batches, events] = await Promise.all([ctx.imports.loadLinks(slug), ctx.imports.loadBatches(slug), ctx.cloud.loadEvents()])
  } catch (err) {
    throw mapImportError(err)
  }
  const diff = diffRevision({ incoming: items, links, events })

  const open = batches.filter((b) => b.status === 'in_progress' || b.status === 'failed').sort((a, b) => b.created_at.localeCompare(a.created_at))
  const linkCount = (b: BatchRow) => links.filter((l) => l.batch_id === b.id).length
  // continue the newest interrupted batch of THIS file when its plan still adds up exactly: planned = already written + still missing
  const resume = open.find((b) => b.source_sha256 === input.sha256 && b.planned_count === linkCount(b) + diff.new.length && (diff.new.length > 0 || linkCount(b) > 0)) ?? null
  const others = open.filter((b) => b !== resume)
  const activeElsewhere = others.find((b) => b.status === 'in_progress' && now() - Date.parse(b.updated_at) < ACTIVE_WINDOW_MS) ?? null
  const retire = others.filter((b) => b !== activeElsewhere)

  const counts: SaveCounts = {
    toCreate: diff.new.length,
    alreadyImported: diff.unchanged.length,
    skipped: skipped.length,
    notRecreated: diff.blocked.length + diff.deletedByUser.length,
    differences: diff.sourceChanged.length + diff.removed.length + diff.possibleMoves.length + diff.ambiguous.length,
    clashes: input.clashes,
    userEdited: diff.summary.userEdited,
  }
  return { slug, items, skipped, diff, toCreate: diff.new, counts, resume, retire, activeElsewhere, links, events }
}

export type SaveStage = 'planning' | 'preparing' | 'saving' | 'finishing' | 'verifying'
export interface SaveProgress {
  stage: SaveStage
  done: number
  total: number
}

export type SaveResult =
  /** Everything planned was written, read back, compared and accepted as `verified` by the server. */
  | { kind: 'verified'; created: number; alreadyImported: number; batchId: string }
  /** Nothing new to save (e.g. the same PDF was imported before): no events were created. */
  | { kind: 'nothing-to-do'; alreadyImported: number }
  /** Some sessions were written but fewer than planned (e.g. another device wrote some first): labelled partial, not "complete". */
  | { kind: 'partial'; created: number; planned: number; batchId: string }
  /** Written, but the read-back or the server's verification did not confirm everything: NOT reported as saved correctly. */
  | { kind: 'unverified'; created: number; problems: string[]; batchId: string }
  /** Stopped midway. Safe to retry: the retry only sends what is still missing. */
  | { kind: 'failed'; message: string; errorKind: string; created: number; batchId: string | null }
  | { kind: 'blocked'; message: string }

/** Compares what the server holds with what we meant to write (events and PDF facts). Returns human-readable problems. */
function readBack(batchId: string, items: readonly ImportItem[], links: readonly LinkRow[], events: readonly EventRow[]): { checked: number; problems: string[] } {
  const byKey = new Map(links.map((l) => [l.source_key, l]))
  const eventById = new Map(events.map((e) => [e.id, e]))
  const problems: string[] = []
  let checked = 0
  for (const item of items) {
    const link = byKey.get(item.sourceKey)
    if (!link || link.batch_id !== batchId) continue // not part of this batch (earlier import, or not written)
    checked++
    const ev = link.event_id ? eventById.get(link.event_id) : undefined
    if (!ev) problems.push(`${item.sourceKey}: the calendar event is missing`)
    else if (canon(snapshotOfRow(ev)) !== canon(item.event)) problems.push(`${item.sourceKey}: the stored event differs from what was reviewed`)
    else if (canon(link.source_snapshot) !== canon(item.source)) problems.push(`${item.sourceKey}: the stored source facts differ`)
  }
  return { checked, problems }
}

/**
 * Runs the save. Never throws. Re-plans from the server right before writing, so a retry (or a second device) only
 * ever sends the sessions that are still missing.
 */
export async function executeSave(ctx: SaveContext, input: SaveInput, onProgress: (p: SaveProgress) => void = () => {}, newId: () => string = () => crypto.randomUUID()): Promise<SaveResult> {
  let batchId: string | null = null
  let created = 0
  const api = ctx.imports
  try {
    onProgress({ stage: 'planning', done: 0, total: 1 })
    const plan = await planSave(ctx, input)
    if (!plan.slug) return { kind: 'nothing-to-do', alreadyImported: 0 }
    if (plan.activeElsewhere) {
      return { kind: 'blocked', message: 'Another import of this timetable started a few minutes ago (another tab or device). Wait for it to finish, then check again.' }
    }
    const planned = plan.toCreate.length
    if (!plan.resume && planned === 0) return { kind: 'nothing-to-do', alreadyImported: plan.counts.alreadyImported }

    onProgress({ stage: 'preparing', done: 0, total: 1 })
    // close interrupted batches that cannot be continued, with the honest label (never "written")
    for (const old of plan.retire) {
      const n = plan.links.filter((l) => l.batch_id === old.id).length
      try {
        await api.setStatus(old.id, n > 0 ? 'written_partial' : 'abandoned')
      } catch {
        /* a leftover interrupted batch is harmless: it is never counted as success */
      }
    }

    if (plan.resume) {
      batchId = plan.resume.id
      if (plan.resume.status === 'failed') await api.setStatus(batchId, 'in_progress')
    } else {
      batchId = newId()
      const row = buildBatchInsert({ slug: plan.slug, label: input.label, sha256: input.sha256, publishedOn: input.publishedOn, selection: input.selection, planned })
      try {
        await api.createBatch({ id: batchId, ...row })
      } catch (err) {
        // unknown outcome (e.g. a timeout): did the batch get created after all?
        const there = (await api.loadBatches(plan.slug)).some((b) => b.id === batchId)
        if (!there) throw err
      }
    }
    const planTotal = plan.resume ? plan.resume.planned_count : planned

    // write the missing sessions in chunks, only through the RPC
    const already = plan.resume ? plan.links.filter((l) => l.batch_id === plan.resume!.id).length : 0
    let done = already
    onProgress({ stage: 'saving', done, total: planTotal })
    for (const part of chunk(plan.toCreate, RPC_CHUNK)) {
      const out = await api.importSessions(batchId, toRpcItems(part))
      created += out.filter((o) => o.outcome === 'created').length
      done += out.filter((o) => o.outcome === 'created').length
      onProgress({ stage: 'saving', done, total: planTotal })
    }

    // the server decides whether the batch is complete: count what really exists
    onProgress({ stage: 'finishing', done: 0, total: 1 })
    const linksNow = await api.loadLinks(plan.slug)
    const inBatch = linksNow.filter((l) => l.batch_id === batchId).length
    const complete = inBatch === planTotal
    const written = await api.setStatus(batchId, complete ? 'written' : 'written_partial')

    // read back what the server holds and compare it with what was reviewed
    onProgress({ stage: 'verifying', done: 0, total: 1 })
    const [events, linksAfter] = await Promise.all([ctx.cloud.loadEvents(), api.loadLinks(plan.slug)])
    const rb = readBack(batchId, plan.items, linksAfter, events)
    if (written.status === 'written_partial') {
      return rb.problems.length
        ? { kind: 'unverified', created: inBatch, problems: rb.problems, batchId }
        : { kind: 'partial', created: inBatch, planned: planTotal, batchId }
    }
    if (rb.checked !== planTotal) rb.problems.push(`expected ${planTotal} saved sessions, found ${rb.checked}`)
    if (rb.problems.length) return { kind: 'unverified', created: inBatch, problems: rb.problems, batchId }
    const verified = await api.setStatus(batchId, 'verified')
    if (verified.status !== 'verified') return { kind: 'unverified', created: inBatch, problems: ['the server did not confirm the verification'], batchId }
    return { kind: 'verified', created: inBatch, alreadyImported: plan.counts.alreadyImported, batchId }
  } catch (err) {
    const e = mapImportError(err)
    if (batchId) {
      try {
        await api.setStatus(batchId, 'failed') // makes the interruption visible; the next attempt resumes this batch
      } catch {
        /* the batch simply stays in_progress and is resumed or closed later */
      }
    }
    return { kind: 'failed', message: e.message, errorKind: e.kind, created, batchId }
  }
}

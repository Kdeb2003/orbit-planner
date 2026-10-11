import { deterministicUuid } from '../../cloud/ids'
import { eventPatch, rowToEvent } from '../../cloud/mappers'
import type { EventRow } from '../../cloud/types'
import type { EventInput } from '../../types'
import { zonedTimeToUtc } from '../../utils/time'
import { SESSION_TYPE, sourceDescription } from '../utn/mapping.ts'
import type { ReviewItem } from '../utn/review.ts'

/**
 * Pure building blocks for the (future) confirmed cloud import. NOT wired into the app and NOT used by the
 * preview page: nothing here performs I/O. The static test `tests/utn/provenance-isolation.test.ts` keeps it
 * free of network, storage and Supabase-client code, and keeps the preview code from importing it.
 *
 * Design: docs/proposals/timetable-import-provenance.md. SQL: supabase/migrations/20261015120000_event_imports.sql.
 */

/** The ten event content fields, exactly as stored in `event_import_links.imported_snapshot`. */
export interface EventSnapshot {
  title: string
  category: string
  starts_at: string
  ends_at: string
  time_zone: string
  location: string | null
  description: string | null
  course_code: string | null
  session_type: string | null
  group_label: string | null
}

export const EVENT_FIELDS: readonly (keyof EventSnapshot)[] = [
  'title', 'category', 'starts_at', 'ends_at', 'time_zone', 'location', 'description', 'course_code', 'session_type', 'group_label',
]

/** What the PDF said about the session (stored as `source_snapshot`; compared, never interpreted by the database). */
export interface SourceSnapshot {
  date: string | null
  startTime: string
  endTime: string
  courseCode: string
  typeText: string
  groups: string[]
  /** The printed room text (e.g. `NOP / ALC2`, `online`). */
  room: string | null
  semesterWeek: number
  pages: number[]
}

export interface ImportItem {
  /** Stable identity of the source session (`utn-wise2627|date|start-end|codes|type`). Never contains page/coordinates. */
  sourceKey: string
  /** Deterministic: the same user importing the same source session always addresses the same event row. */
  eventId: string
  /** The content to write: the user's reviewed values (corrections included). */
  event: EventSnapshot
  /** The PDF's own values, so a later revision can tell "the PDF changed" from "the user corrected it". */
  source: SourceSnapshot
  /** True when the reviewed values differ from what the PDF printed. */
  corrected: boolean
}

export interface SkippedItem {
  reviewId: string
  sourceKey: string
  reason: 'excluded' | 'invalid' | 'needs-review' | 'duplicate-source-key'
}

/** `utn-wise2627|2026-10-20|09:00-10:30|W26M-AINBA|tutorial group b` -> `utn-wise2627`. */
export const sourceSlugOf = (sourceKey: string): string => sourceKey.split('|')[0]

/** Same rule as the database CHECK on `source_slug`. */
export const SOURCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function eventSnapshotOf(patch: ReturnType<typeof eventPatch>): EventSnapshot {
  return {
    title: patch.title,
    category: patch.category,
    starts_at: patch.starts_at,
    ends_at: patch.ends_at,
    time_zone: patch.time_zone,
    location: patch.location,
    description: patch.description,
    course_code: patch.course_code,
    session_type: patch.session_type,
    group_label: patch.group_label,
  }
}

/** The canonical snapshot of a calendar row as it is today (what the diff compares with `imported_snapshot`). */
export const snapshotOfRow = (row: EventRow): EventSnapshot => eventSnapshotOf(eventPatch(rowToEvent(row)))

export function sourceSnapshotOf(item: ReviewItem): SourceSnapshot {
  const s = item.session
  return {
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    courseCode: s.courseCode,
    typeText: s.typeText,
    groups: [...s.groups],
    room: s.location?.raw ?? null,
    semesterWeek: s.semesterWeek,
    pages: [...new Set(s.source.map((x) => x.page))].sort((a, b) => a - b),
  }
}

function eventInputOf(item: ReviewItem): EventInput {
  const { session, values, course } = item
  return {
    title: values.title.trim(),
    category: course.category,
    start: zonedTimeToUtc(values.date, values.startTime, session.timeZone).toISOString(),
    end: zonedTimeToUtc(values.date, values.endTime, session.timeZone).toISOString(),
    timeZone: session.timeZone,
    courseCode: session.courseCode,
    sessionType: SESSION_TYPE[session.kind],
    ...(session.groups.length ? { groupLabel: `Group ${session.groups.join(', ')}` } : {}),
    ...(values.room.trim() ? { location: values.room.trim() } : {}),
    description: sourceDescription(session),
  }
}

/**
 * Turns the reviewed sessions into import items. Only sessions that are included, valid and free of open review
 * reasons (`state === 'ready'`) are eligible; everything else is reported in `skipped`, never silently dropped.
 * Two eligible sessions with the same source key are BOTH skipped: the identity would be ambiguous.
 */
export async function buildImportItems(userId: string, reviewed: readonly ReviewItem[]): Promise<{ items: ImportItem[]; skipped: SkippedItem[] }> {
  const skipped: SkippedItem[] = []
  const eligible: ReviewItem[] = []
  for (const it of reviewed) {
    if (it.state === 'ready') eligible.push(it)
    else skipped.push({ reviewId: it.id, sourceKey: it.session.sourceKey, reason: it.state === 'excluded' ? 'excluded' : it.state === 'invalid' ? 'invalid' : 'needs-review' })
  }
  const count = new Map<string, number>()
  for (const it of eligible) count.set(it.session.sourceKey, (count.get(it.session.sourceKey) ?? 0) + 1)

  const items: ImportItem[] = []
  for (const it of eligible) {
    const key = it.session.sourceKey
    if ((count.get(key) ?? 0) > 1) {
      skipped.push({ reviewId: it.id, sourceKey: key, reason: 'duplicate-source-key' })
      continue
    }
    items.push({
      sourceKey: key,
      eventId: await deterministicUuid(`${userId}:event`, key),
      event: eventSnapshotOf(eventPatch(eventInputOf(it))),
      source: sourceSnapshotOf(it),
      corrected: it.editedFields.length > 0,
    })
  }
  return { items, skipped }
}

/** The JSON accepted by `public.orbit_import_sessions` (max 100 items per call). */
export interface RpcItem {
  source_key: string
  event_id: string
  event: EventSnapshot
  source: SourceSnapshot
}

export const RPC_CHUNK = 50

export function toRpcItems(items: readonly ImportItem[]): RpcItem[] {
  return items.map((i) => ({ source_key: i.sourceKey, event_id: i.eventId, event: i.event, source: i.source }))
}

export function chunk<T>(list: readonly T[], size: number = RPC_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** SHA-256 of the PDF bytes as lowercase hex (the bytes themselves are never stored). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** "…preliminary as of 28 September 2026…" -> `2026-09-28`, or null when no such date is printed. */
export function publishedOnFromNote(note: string | null): string | null {
  const m = note ? /as of (\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i.exec(note) : null
  if (!m) return null
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1
  const day = Number(m[1])
  if (month === 0 || day < 1 || day > 31) return null
  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return Number.isNaN(Date.parse(iso)) || new Date(iso).getUTCDate() !== day ? null : iso
}

export interface BatchInsert {
  source_slug: string
  source_label: string
  source_sha256: string
  source_published_on: string | null
  parser_version: number
  selection: string[]
  planned_count: number
}

/** Row for `event_imports`, validated against the same rules as the table's CHECK constraints. Throws on a violation. */
export function buildBatchInsert(input: { slug: string; label: string; sha256: string; publishedOn: string | null; selection: string[]; planned: number }): BatchInsert {
  if (!SOURCE_SLUG_RE.test(input.slug)) throw new Error('invalid source slug')
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('source hash must be 64 lowercase hex characters')
  if (input.label.trim().length < 1 || input.label.length > 120) throw new Error('source label must be 1-120 characters')
  if (!Number.isInteger(input.planned) || input.planned < 0 || input.planned > 5000) throw new Error('planned count out of range')
  return {
    source_slug: input.slug,
    source_label: input.label.trim(),
    source_sha256: input.sha256,
    source_published_on: input.publishedOn,
    parser_version: 1,
    selection: input.selection,
    planned_count: input.planned,
  }
}

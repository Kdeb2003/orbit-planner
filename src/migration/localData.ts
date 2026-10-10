import { STORAGE_KEY as EVENTS_KEY } from '../storage/eventStore'
import type { StorageLike } from '../storage/collection'
import { SERIES_STORAGE_KEY as SERIES_KEY } from '../storage/seriesStore'

/** Raw text of ORBIT's browser-stored calendar, exactly as stored (may include records the app could not read). */
export interface LocalRaw {
  events: string | null
  series: string | null
}

export interface RawCounts {
  events: number
  series: number
  exceptions: number
  /** A key holds text that is not a JSON array (cannot be imported; preserved in the backup). */
  unreadable: boolean
}

/** READ-ONLY access to the legacy local calendar. Nothing in this module writes or deletes storage. */
export function readLocalRaw(storage: Pick<StorageLike, 'getItem'> | null): LocalRaw {
  try {
    return { events: storage?.getItem(EVENTS_KEY) ?? null, series: storage?.getItem(SERIES_KEY) ?? null }
  } catch {
    return { events: null, series: null }
  }
}

function parseArray(raw: string | null): { items: unknown[]; unreadable: boolean } {
  if (!raw) return { items: [], unreadable: false }
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? { items: v, unreadable: false } : { items: [], unreadable: true }
  } catch {
    return { items: [], unreadable: true }
  }
}

/** Counts every stored entry, valid or not (so the preview can say how many were unreadable). */
export function countRaw(raw: LocalRaw): RawCounts {
  const e = parseArray(raw.events)
  const s = parseArray(raw.series)
  const exceptions = s.items.reduce<number>((n, item) => {
    const ex = (item as { exceptions?: unknown } | null)?.exceptions
    return n + (Array.isArray(ex) ? ex.length : 0)
  }, 0)
  return { events: e.items.length, series: s.items.length, exceptions, unreadable: e.unreadable || s.unreadable }
}

export const BACKUP_FORMAT = 'orbit-local-backup'

/**
 * A JSON backup of the original local data. `storage` holds the byte-exact raw values (so the
 * originals can always be restored by hand); `events`/`series` repeat them parsed for readability.
 */
export function buildBackup(raw: LocalRaw, now: Date): string {
  const parsedOrNull = (r: string | null) => {
    if (r === null) return null
    try {
      return JSON.parse(r) as unknown
    } catch {
      return null
    }
  }
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: now.toISOString(),
      note: 'Original ORBIT calendar data from this browser (localStorage). Keep this file; it is not changed by importing to the cloud.',
      counts: countRaw(raw),
      storage: { [EVENTS_KEY]: raw.events, [SERIES_KEY]: raw.series },
      events: parsedOrNull(raw.events),
      series: parsedOrNull(raw.series),
    },
    null,
    2,
  )
}

export function backupFilename(now: Date): string {
  return `orbit-local-backup-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
}

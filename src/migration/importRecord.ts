import type { StorageLike } from '../storage/collection'

/**
 * Durable progress marker for the explicit local -> cloud import, kept in its OWN key
 * (never in orbit.events.v1 / orbit.series.v1). It stores the legacy-id -> cloud-id map so
 * an interrupted import can be resumed, and it says "verified" only after the uploaded data
 * has been read back from the cloud and compared.
 */
export const IMPORT_RECORD_KEY = 'orbit.cloudImport.v1'

export type ImportStatus = 'in-progress' | 'failed' | 'verification-failed' | 'verified' | 'verified-with-skips'

export interface ImportRecord {
  status: ImportStatus
  startedAt: string
  updatedAt: string
  idMap: Record<string, string>
  uploaded: { events: number; series: number; exceptions: number }
  error?: string
  verifiedAt?: string
}

type Store = Record<string, ImportRecord>

export function readImportRecord(storage: Pick<StorageLike, 'getItem'> | null, userId: string): ImportRecord | null {
  try {
    const raw = storage?.getItem(IMPORT_RECORD_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Store
    return data && typeof data === 'object' ? (data[userId] ?? null) : null
  } catch {
    return null
  }
}

export function writeImportRecord(storage: StorageLike | null, userId: string, record: ImportRecord): void {
  if (!storage) return
  try {
    const raw = storage.getItem(IMPORT_RECORD_KEY)
    const data: Store = raw ? (JSON.parse(raw) as Store) : {}
    data[userId] = record
    storage.setItem(IMPORT_RECORD_KEY, JSON.stringify(data))
  } catch {
    /* the marker is advisory: a failure here must not break or hide the import result */
  }
}

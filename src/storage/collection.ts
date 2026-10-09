import type { SaveStatus } from './saveStatus'

/** The subset of the Web Storage API we use. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ParseResult<T> {
  items: T[]
  /** Records that were discarded or repaired (data was lost or altered). */
  dropped: number
  /** The raw text was not a JSON array at all. */
  unreadable: boolean
}

/**
 * Parses a stored JSON array. `sanitize` returns a valid item, or null to drop
 * a record; `lossy` marks a record that was kept but had parts removed.
 * Never throws.
 */
export function parseCollection<T extends { id: string }>(
  raw: string | null,
  sanitize: (value: unknown) => { item: T; lossy?: boolean } | null,
): ParseResult<T> {
  if (!raw) return { items: [], dropped: 0, unreadable: false }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { items: [], dropped: 0, unreadable: true }
  }
  if (!Array.isArray(data)) return { items: [], dropped: 0, unreadable: true }
  const seen = new Set<string>()
  const items: T[] = []
  let dropped = 0
  for (const value of data) {
    const result = sanitize(value)
    if (!result || seen.has(result.item.id)) {
      dropped++
      continue
    }
    if (result.lossy) dropped++
    seen.add(result.item.id)
    items.push(result.item)
  }
  return { items, dropped, unreadable: false }
}

export interface Collection<T> {
  /** Stable reference until the data changes (for useSyncExternalStore). */
  getSnapshot(): readonly T[]
  subscribe(listener: () => void): () => void
  /** Replace all records and persist. Failures are reported via the save status. */
  commit(next: T[]): void
  /** Re-read from storage, e.g. after another tab changed it. */
  reload(): void
}

/**
 * A JSON array in one localStorage key, cached in memory. If stored data had
 * to be discarded, the original text is first copied to `${key}.backup`
 * (once) so a later save cannot destroy it.
 */
export function createCollection<T extends { id: string }>(
  storage: StorageLike | null,
  key: string,
  sanitize: (value: unknown) => { item: T; lossy?: boolean } | null,
  status: SaveStatus,
): Collection<T> {
  const listeners = new Set<() => void>()

  function load(): T[] {
    if (!storage) return []
    try {
      const raw = storage.getItem(key)
      const result = parseCollection(raw, sanitize)
      if (raw && (result.unreadable || result.dropped > 0) && storage.getItem(`${key}.backup`) === null) {
        try {
          storage.setItem(`${key}.backup`, raw)
        } catch {
          /* backup is best-effort */
        }
      }
      return result.items
    } catch {
      return []
    }
  }

  let cache = load()

  return {
    getSnapshot: () => cache,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit(next) {
      cache = next
      if (!storage) {
        status.report('Browser storage is unavailable. Changes will be lost when you close or refresh this page.')
      } else {
        try {
          storage.setItem(key, JSON.stringify(next))
          status.report(null)
        } catch (err) {
          console.error('ORBIT: could not save to localStorage', err)
          status.report('Could not save to browser storage (it may be full or blocked). Recent changes will be lost on refresh.')
        }
      }
      listeners.forEach((l) => l())
    },
    reload() {
      cache = load()
      listeners.forEach((l) => l())
    },
  }
}

/**
 * Tracks whether the last attempt to write to browser storage failed, so the
 * UI can say so instead of implying data was saved.
 */
export interface SaveStatus {
  getSnapshot(): string | null
  subscribe(listener: () => void): () => void
  report(error: string | null): void
}

export function createSaveStatus(): SaveStatus {
  let current: string | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    report(error) {
      if (error === current) return
      current = error
      listeners.forEach((l) => l())
    },
  }
}

/** App-wide status shared by all collections. */
export const saveStatus = createSaveStatus()

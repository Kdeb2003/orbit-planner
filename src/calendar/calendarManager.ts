import type { CloudApi } from '../cloud/cloudApi'
import { startAutoRefresh } from './autoRefresh'
import { createCloudSource } from './cloudSource'
import type { CalendarSource } from './types'

export interface CloudSession {
  userId: string
  source: CalendarSource
  api: CloudApi
}

export interface CalendarManager {
  getSnapshot(): CloudSession | null
  subscribe(listener: () => void): () => void
  /** Sign-in (or account switch) creates a fresh session; null (sign-out) disposes the current one and clears its data. */
  setUser(userId: string | null): void
}

export interface ManagerOptions {
  createApi: (userId: string) => CloudApi | null
  /** Optional extra change feed (Realtime). Must return an unsubscribe function. */
  startRealtime?: (userId: string, onChange: () => void) => () => void
  /** Focus/online/poll refresh. Defaults to the browser implementation; tests pass a stub. */
  autoRefresh?: (source: CalendarSource) => () => void
}

/**
 * Owns the lifetime of the per-user cloud session. It lives outside React state so that
 * StrictMode's mount/unmount/mount cycle simply tears down and rebuilds the session,
 * and so that exactly one session exists at a time.
 */
export function createCalendarManager(options: ManagerOptions): CalendarManager {
  let current: CloudSession | null = null
  let teardown: (() => void) | null = null
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())

  function stop() {
    teardown?.()
    teardown = null
    current?.source.dispose() // drops every private record from memory
    current = null
  }

  return {
    getSnapshot: () => current,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    setUser(userId) {
      if (current?.userId === userId) return
      stop()
      if (userId) {
        const api = options.createApi(userId)
        if (api) {
          const source = createCloudSource(api, { userId })
          const stopAuto = (options.autoRefresh ?? startAutoRefresh)(source)
          const stopRt = options.startRealtime?.(userId, () => void source.refresh())
          teardown = () => {
            stopAuto()
            stopRt?.()
          }
          current = { userId, source, api }
          void source.refresh()
        }
      }
      emit()
    },
  }
}

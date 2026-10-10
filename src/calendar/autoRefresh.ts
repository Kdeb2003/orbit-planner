import type { CalendarSource } from './types'

interface Target {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

interface Env {
  win?: Target
  doc?: Target & { visibilityState: string }
  now?: () => number
  pollMs?: number
  minGapMs?: number
}

/**
 * The reliable cross-device sync path: re-read the calendar when the tab regains focus
 * or visibility, when the network comes back, and on a slow poll while the tab is visible.
 * (Realtime, when enabled, only adds speed on top of this.) Returns a stop function.
 */
export function startAutoRefresh(source: Pick<CalendarSource, 'refresh'>, env: Env = {}): () => void {
  const win = env.win ?? window
  const doc = env.doc ?? document
  const now = env.now ?? Date.now
  const pollMs = env.pollMs ?? 60_000
  const minGap = env.minGapMs ?? 2_000
  let last = now()

  const trigger = () => {
    if (doc.visibilityState === 'hidden') return
    if (now() - last < minGap) return
    last = now()
    void source.refresh()
  }

  win.addEventListener('focus', trigger)
  win.addEventListener('online', trigger)
  doc.addEventListener('visibilitychange', trigger)
  const timer = setInterval(trigger, pollMs)
  return () => {
    win.removeEventListener('focus', trigger)
    win.removeEventListener('online', trigger)
    doc.removeEventListener('visibilitychange', trigger)
    clearInterval(timer)
  }
}

import { useSyncExternalStore } from 'react'
import { saveStatus } from '../storage/saveStatus'

/** Message if the last browser-storage write failed, otherwise null. */
export function useSaveError(): string | null {
  return useSyncExternalStore(saveStatus.subscribe, saveStatus.getSnapshot)
}

import { useSyncExternalStore } from 'react'
import { seriesStore } from '../storage/seriesStore'

/** All recurring series; re-renders when any series or exception changes. */
export function useSeries() {
  const series = useSyncExternalStore(seriesStore.subscribe, seriesStore.getSnapshot)
  return {
    series,
    create: seriesStore.create,
    update: seriesStore.update,
    remove: seriesStore.remove,
    setException: seriesStore.setException,
    clearException: seriesStore.clearException,
  }
}

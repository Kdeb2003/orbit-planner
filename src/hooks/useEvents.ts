import { useSyncExternalStore } from 'react'
import { eventStore } from '../storage/eventStore'

/** All saved events; re-renders when any event is created, updated, or deleted. */
export function useEvents() {
  const events = useSyncExternalStore(eventStore.subscribe, eventStore.getSnapshot)
  return { events, create: eventStore.create, update: eventStore.update, remove: eventStore.remove }
}

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { EventEditorContext } from '../hooks/useEventEditor'
import type { EventEditorApi } from '../hooks/useEventEditor'
import type { ScheduledItem } from '../types'
import { dateKey } from '../utils/time'
import type { DateKey } from '../utils/time'
import { EventDialog } from './EventDialog'

interface EditorState {
  event: ScheduledItem | null
  day: DateKey
}

export function EventEditorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditorState | null>(null)

  const api = useMemo<EventEditorApi>(
    () => ({
      openNew: (day) => setState({ event: null, day: day ?? dateKey(new Date()) }),
      openEdit: (event) => setState({ event, day: dateKey(new Date(event.start), event.timeZone) }),
    }),
    [],
  )

  return (
    <EventEditorContext.Provider value={api}>
      {children}
      {state && <EventDialog event={state.event} day={state.day} onClose={() => setState(null)} />}
    </EventEditorContext.Provider>
  )
}

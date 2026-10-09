import { Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useEvents } from '../hooks/useEvents'
import { EVENT_CATEGORIES } from '../types'
import type { CalendarEvent } from '../types'
import { emptyFormValues, eventToFormValues, validateEventForm } from '../utils/events'
import type { EventFormErrors, EventFormValues } from '../utils/events'
import { TIME_ZONE } from '../utils/time'
import type { DateKey } from '../utils/time'
import { categoryStyle } from './categories'

interface EventDialogProps {
  /** Event being edited, or null to create. */
  event: CalendarEvent | null
  /** Default day for a new event. */
  day: DateKey
  onClose: () => void
}

const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-base px-3 text-sm text-white [color-scheme:dark] placeholder:text-muted/70'

function Field({
  label,
  error,
  htmlFor,
  children,
}: {
  label: string
  error?: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1 text-xs text-deadline">
          {error}
        </p>
      )}
    </div>
  )
}

export function EventDialog({ event, day, onClose }: EventDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { create, update, remove } = useEvents()
  const timeZone = event?.timeZone ?? TIME_ZONE
  const [values, setValues] = useState<EventFormValues>(() =>
    event ? eventToFormValues(event) : emptyFormValues(day, new Date(), timeZone),
  )
  const [errors, setErrors] = useState<EventFormErrors>({})
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  function set<K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) {
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      // Keep a same-day event on the same day when its start date moves.
      if (key === 'startDate' && prev.endDate === prev.startDate) next.endDate = value as string
      return next
    })
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const result = validateEventForm(values, timeZone)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    if (event) update(event.id, result.input)
    else create(result.input)
    onClose()
  }

  function handleDelete() {
    if (event) remove(event.id)
    onClose()
  }

  function bind(key: keyof EventFormValues) {
    return {
      id: `ev-${key}`,
      'aria-invalid': errors[key] ? true : undefined,
      'aria-describedby': errors[key] ? `ev-${key}-error` : undefined,
    }
  }

  const nextDayHint = values.endDate > values.startDate ? 'Ends on a later date.' : ''

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="ev-dialog-title"
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && dialogRef.current?.close()}
      className="m-auto max-h-[94dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-white shadow-2xl backdrop:bg-black/70"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 id="ev-dialog-title" className="text-lg font-semibold">
            {event ? 'Edit event' : 'Add event'}
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-white"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <Field label="Title" htmlFor="ev-title" error={errors.title}>
          <input
            {...bind('title')}
            type="text"
            autoFocus
            maxLength={120}
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Category" htmlFor="ev-category" error={errors.category}>
          <select
            {...bind('category')}
            value={values.category}
            onChange={(e) => set('category', e.target.value as EventFormValues['category'])}
            className={inputClass}
          >
            {EVENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryStyle[c].label}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date" htmlFor="ev-startDate" error={errors.startDate}>
            <input {...bind('startDate')} type="date" value={values.startDate} onChange={(e) => set('startDate', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Start time" htmlFor="ev-startTime" error={errors.startTime}>
            <input {...bind('startTime')} type="time" value={values.startTime} onChange={(e) => set('startTime', e.target.value)} className={inputClass} />
          </Field>
          <Field label="End date" htmlFor="ev-endDate" error={errors.endDate}>
            <input {...bind('endDate')} type="date" value={values.endDate} onChange={(e) => set('endDate', e.target.value)} className={inputClass} />
          </Field>
          <Field label="End time" htmlFor="ev-endTime" error={errors.endTime}>
            <input {...bind('endTime')} type="time" value={values.endTime} onChange={(e) => set('endTime', e.target.value)} className={inputClass} />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted">
          Times are in {timeZone}.{nextDayHint && ` ${nextDayHint}`}
        </p>

        <Field label="Location (optional)" htmlFor="ev-location" error={errors.location}>
          <input {...bind('location')} type="text" maxLength={120} value={values.location} onChange={(e) => set('location', e.target.value)} className={inputClass} />
        </Field>

        <Field label="Notes (optional)" htmlFor="ev-description" error={errors.description}>
          <textarea
            {...bind('description')}
            rows={3}
            maxLength={2000}
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            className={`${inputClass} py-2`}
          />
        </Field>

        {confirmingDelete ? (
          <div role="alertdialog" aria-label="Confirm delete" className="space-y-3 rounded-xl border border-deadline/50 bg-deadline/10 p-3">
            <p className="text-sm">
              Delete <strong>{event?.title}</strong>? This can’t be undone.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmingDelete(false)} className="min-h-11 flex-1 rounded-xl border border-line px-4 text-sm hover:bg-surface-2">
                Keep event
              </button>
              <button type="button" onClick={handleDelete} className="min-h-11 flex-1 rounded-xl bg-deadline px-4 text-sm font-medium text-base">
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {event && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="mr-auto flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-deadline hover:bg-deadline/10"
              >
                <Trash2 size={16} aria-hidden /> Delete
              </button>
            )}
            <button type="button" onClick={() => dialogRef.current?.close()} className="ml-auto min-h-11 rounded-xl border border-line px-4 text-sm hover:bg-surface-2">
              Cancel
            </button>
            <button type="submit" className="min-h-11 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent/90">
              {event ? 'Save changes' : 'Save event'}
            </button>
          </div>
        )}
      </form>
    </dialog>
  )
}

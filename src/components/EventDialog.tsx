import { Ban, Repeat, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useEvents } from '../hooks/useEvents'
import { useSeries } from '../hooks/useSeries'
import { EVENT_CATEGORIES, SESSION_TYPES } from '../types'
import type { RecurringSeries, ScheduledItem, Weekday } from '../types'
import { conflictLines } from '../utils/conflicts'
import {
  defaultRepeat,
  emptyFormValues,
  eventToFormValues,
  timeNotes,
  validateEventForm,
  validateSeriesForm,
} from '../utils/events'
import type { EventFormValues, RepeatFormValues, SeriesFormErrors } from '../utils/events'
import {
  dstWarnings,
  expandSeriesForCandidates,
  orphanedExceptions,
  overrideFromInput,
  seriesToFormValues,
} from '../utils/recurrence'
import { conflictsFor } from '../utils/schedule'
import { formatDayShort, TIME_ZONE } from '../utils/time'
import type { DateKey } from '../utils/time'
import { categoryStyle } from './categories'

interface EventDialogProps {
  /** Event or occurrence being edited, or null to create. */
  event: ScheduledItem | null
  /** Default day for a new event. */
  day: DateKey
  onClose: () => void
}

type Scope = 'single' | 'choose' | 'occurrence' | 'series' | 'missing'

interface Warning {
  heading: string
  lines: string[]
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-base px-3 text-sm text-white [color-scheme:dark] placeholder:text-muted/70'
const secondaryBtn = 'min-h-11 rounded-xl border border-line px-4 text-sm hover:bg-surface-2'
const primaryBtn = 'min-h-11 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent/90'

function Field({ label, error, htmlFor, children }: { label: string; error?: string; htmlFor: string; children: ReactNode }) {
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
  const { events, create, update, remove } = useEvents()
  const seriesApi = useSeries()
  const allSeries = seriesApi.series
  const series: RecurringSeries | undefined = event?.seriesId ? allSeries.find((s) => s.id === event.seriesId) : undefined

  const initialScope: Scope = event?.seriesId ? (series ? 'choose' : 'missing') : 'single'
  const [scope, setScope] = useState<Scope>(initialScope)
  const timeZone = event?.timeZone ?? TIME_ZONE
  const [values, setValues] = useState<EventFormValues>(() =>
    event ? eventToFormValues(event) : emptyFormValues(day, new Date(), timeZone),
  )
  const [repeat, setRepeat] = useState<RepeatFormValues>(() => defaultRepeat(values.startDate))
  const [errors, setErrors] = useState<SeriesFormErrors>({})
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [pending, setPending] = useState<{ warnings: Warning[]; commit: () => void } | null>(null)

  // Open as a modal once, and (re)focus the first field whenever the form step changes.
  // React's autoFocus runs before the dialog is open, so showModal() would otherwise focus the Close button.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [scope])

  const creating = !event
  const weekly = scope === 'series' || (creating && repeat.mode === 'weekly')
  const close = () => dialogRef.current?.close()

  function set<K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) {
    setPending(null)
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      // Keep a same-day event on the same day when its start date moves.
      if (key === 'startDate' && prev.endDate === prev.startDate) next.endDate = value as string
      return next
    })
  }

  function setRepeatField(next: Partial<RepeatFormValues>) {
    setPending(null)
    setRepeat((prev) => ({ ...prev, ...next }))
  }

  function chooseScope(next: 'occurrence' | 'series') {
    if (next === 'series' && series) {
      const form = seriesToFormValues(series)
      setValues(form.values)
      setRepeat(form.repeat)
    }
    setScope(next)
  }

  /** Run `commit` now, or first show warnings the user must acknowledge. */
  function attempt(warnings: Warning[], commit: () => void) {
    const active = warnings.filter((w) => w.lines.length > 0)
    if (active.length) setPending({ warnings: active, commit })
    else commit()
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const nowIso = new Date().toISOString()

    if (weekly) {
      const result = validateSeriesForm(values, repeat, timeZone)
      if (!result.ok) return setErrors(result.errors)
      setErrors({})
      const input = result.input
      const exceptions = series?.exceptions ?? []
      const draft: RecurringSeries = { ...input, id: series?.id ?? 'draft', exceptions, createdAt: nowIso, updatedAt: nowIso }
      const orphans = series ? orphanedExceptions(draft) : []
      const conflicts = conflictsFor(expandSeriesForCandidates(draft), events, allSeries, (i) => i.seriesId === draft.id)
      attempt(
        [
          {
            heading: 'Some individual changes no longer fit this schedule and will be removed:',
            lines: orphans.map((o) => `${formatDayShort(o.originalDate)} (${o.cancelled ? 'cancelled' : 'edited'})`),
          },
          { heading: 'This schedule overlaps other events:', lines: conflictLines(conflicts) },
          { heading: 'Daylight saving notices:', lines: dstWarnings(input) },
        ],
        () => {
          const kept = exceptions.filter((x) => !orphans.includes(x))
          if (series) seriesApi.update(series.id, input, kept)
          else seriesApi.create(input)
          close()
        },
      )
      return
    }

    const result = validateEventForm(values, timeZone)
    if (!result.ok) return setErrors(result.errors)
    setErrors({})
    const input = result.input

    if (scope === 'occurrence' && event && series && event.originalDate) {
      const candidate: ScheduledItem = { ...input, id: event.id, seriesId: series.id, createdAt: nowIso, updatedAt: nowIso }
      const conflicts = conflictsFor([candidate], events, allSeries, (i) => i.id === event.id)
      attempt([{ heading: 'This overlaps other events:', lines: conflictLines(conflicts) }], () => {
        const originalDate = event.originalDate!
        const override = overrideFromInput(series, originalDate, input)
        const wasCancelled = series.exceptions.find((x) => x.originalDate === originalDate)?.cancelled
        if (override || wasCancelled) {
          seriesApi.setException(series.id, { originalDate, ...(wasCancelled && { cancelled: true }), ...(override && { override }) })
        } else seriesApi.clearException(series.id, originalDate)
        close()
      })
      return
    }

    const candidate: ScheduledItem = { ...input, id: event?.id ?? 'new', createdAt: nowIso, updatedAt: nowIso }
    const conflicts = conflictsFor([candidate], events, allSeries, (i) => i.id === event?.id)
    attempt([{ heading: 'This overlaps other events:', lines: conflictLines(conflicts) }], () => {
      if (event) update(event.id, input)
      else create(input)
      close()
    })
  }

  function cancelOccurrence() {
    if (!event?.originalDate || !series) return
    const existing = series.exceptions.find((x) => x.originalDate === event.originalDate)
    seriesApi.setException(series.id, { ...existing, originalDate: event.originalDate, cancelled: true })
    close()
  }

  function resetOccurrence() {
    if (event?.originalDate && series) seriesApi.clearException(series.id, event.originalDate)
    close()
  }

  function handleDelete() {
    if (scope === 'series' && series) seriesApi.remove(series.id)
    else if (event) remove(event.id)
    close()
  }

  function bind(key: keyof EventFormValues) {
    return {
      id: `ev-${key}`,
      'aria-invalid': errors[key] ? true : undefined,
      'aria-describedby': errors[key] ? `ev-${key}-error` : undefined,
    }
  }

  const title =
    scope === 'choose'
      ? 'Edit repeating event'
      : scope === 'occurrence'
        ? 'Edit this occurrence'
        : scope === 'series'
          ? 'Edit series'
          : event
            ? 'Edit event'
            : 'Add event'
  const notes = timeNotes(values, timeZone)

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="ev-dialog-title"
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && close()}
      className="m-auto max-h-[94dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-white shadow-2xl backdrop:bg-black/70"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 id="ev-dialog-title" className="text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-white"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {scope === 'missing' && (
          <>
            <p className="text-sm text-muted">This repeating event no longer exists (it may have been deleted in another tab).</p>
            <button type="button" onClick={close} className={secondaryBtn}>
              Close
            </button>
          </>
        )}

        {scope === 'choose' && event && (
          <>
            <p className="text-sm text-muted">
              <strong className="text-white">{event.title}</strong> repeats weekly. What do you want to change?
            </p>
            <div className="grid gap-2">
              <button type="button" data-autofocus onClick={() => chooseScope('occurrence')} className={`${secondaryBtn} text-left`}>
                <span className="block font-medium">Only this occurrence</span>
                <span className="block text-xs text-muted">Edit, move or cancel just {formatDayShort(event.originalDate!)}.</span>
              </button>
              <button type="button" onClick={() => chooseScope('series')} className={`${secondaryBtn} text-left`}>
                <span className="block font-medium">Entire series</span>
                <span className="block text-xs text-muted">Change the repeating schedule, end date, or delete it.</span>
              </button>
            </div>
          </>
        )}

        {(scope === 'single' || scope === 'occurrence' || scope === 'series') && (
          <>
            <Field label="Title" htmlFor="ev-title" error={errors.title}>
              <input {...bind('title')} type="text" data-autofocus maxLength={120} value={values.title} onChange={(e) => set('title', e.target.value)} className={inputClass} />
            </Field>

            <Field label="Category" htmlFor="ev-category" error={errors.category}>
              <select {...bind('category')} value={values.category} onChange={(e) => set('category', e.target.value as EventFormValues['category'])} className={inputClass}>
                {EVENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryStyle[c].label}
                  </option>
                ))}
              </select>
            </Field>

            {(values.category === 'university' || values.courseCode || values.sessionType || values.groupLabel) && (
              <fieldset className="space-y-3 rounded-xl border border-line p-3">
                <legend className="px-1 text-xs font-medium text-muted">University details (optional)</legend>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Course code" htmlFor="ev-courseCode" error={errors.courseCode}>
                    <input {...bind('courseCode')} type="text" maxLength={30} value={values.courseCode} onChange={(e) => set('courseCode', e.target.value)} className={inputClass} />
                  </Field>
                  <Field label="Session type" htmlFor="ev-sessionType" error={errors.sessionType}>
                    <select {...bind('sessionType')} value={values.sessionType} onChange={(e) => set('sessionType', e.target.value as EventFormValues['sessionType'])} className={inputClass}>
                      <option value="">Not set</option>
                      {SESSION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t.charAt(0).toUpperCase() + t.slice(1)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Group label" htmlFor="ev-groupLabel" error={errors.groupLabel}>
                  <input {...bind('groupLabel')} type="text" maxLength={40} placeholder="e.g. Group B" value={values.groupLabel} onChange={(e) => set('groupLabel', e.target.value)} className={inputClass} />
                </Field>
              </fieldset>
            )}

            {(creating || scope === 'series') && (
              <div>
                <label htmlFor="ev-repeat" className="mb-1 block text-xs font-medium text-muted">
                  Repeat
                </label>
                {scope === 'series' ? (
                  <p id="ev-repeat" className="flex min-h-11 items-center gap-2 text-sm">
                    <Repeat size={16} className="text-muted" aria-hidden /> Weekly
                  </p>
                ) : (
                  <select id="ev-repeat" value={repeat.mode} onChange={(e) => setRepeatField({ mode: e.target.value as RepeatFormValues['mode'] })} className={inputClass}>
                    <option value="none">Does not repeat</option>
                    <option value="weekly">Weekly</option>
                  </select>
                )}
              </div>
            )}

            {weekly && (
              <fieldset className="space-y-3 rounded-xl border border-line p-3">
                <legend className="px-1 text-xs font-medium text-muted">Repeats on</legend>
                <div className="grid grid-cols-7 gap-1">
                  {WEEKDAY_LABELS.map((label, i) => {
                    const on = repeat.weekdays.includes(i as Weekday)
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setRepeatField({
                            weekdays: on ? repeat.weekdays.filter((d) => d !== i) : [...repeat.weekdays, i as Weekday],
                          })
                        }
                        className={`min-h-11 min-w-0 rounded-xl border px-0 text-xs sm:text-sm ${
                          on ? 'border-accent bg-accent/25 text-white' : 'border-line text-muted hover:bg-surface-2'
                        }`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
                {errors.weekdays && (
                  <p role="alert" className="text-xs text-deadline">
                    {errors.weekdays}
                  </p>
                )}
                <Field label="Repeat until (inclusive)" htmlFor="ev-until" error={errors.until}>
                  <input
                    id="ev-until"
                    type="date"
                    value={repeat.until}
                    aria-invalid={errors.until ? true : undefined}
                    aria-describedby={errors.until ? 'ev-until-error' : undefined}
                    onChange={(e) => setRepeatField({ until: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <p className="text-xs text-muted">
                  Times are {timeZone} wall-clock times: a 09:00 event stays at 09:00 after daylight saving changes.
                </p>
              </fieldset>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={weekly ? 'First date' : 'Start date'} htmlFor="ev-startDate" error={errors.startDate}>
                <input {...bind('startDate')} type="date" value={values.startDate} onChange={(e) => set('startDate', e.target.value)} className={inputClass} />
              </Field>
              <Field label="Start time" htmlFor="ev-startTime" error={errors.startTime}>
                <input {...bind('startTime')} type="time" value={values.startTime} onChange={(e) => set('startTime', e.target.value)} className={inputClass} />
              </Field>
              <Field label={weekly ? 'Ends on (same occurrence)' : 'End date'} htmlFor="ev-endDate" error={errors.endDate}>
                <input {...bind('endDate')} type="date" value={values.endDate} onChange={(e) => set('endDate', e.target.value)} className={inputClass} />
              </Field>
              <Field label="End time" htmlFor="ev-endTime" error={errors.endTime}>
                <input {...bind('endTime')} type="time" value={values.endTime} onChange={(e) => set('endTime', e.target.value)} className={inputClass} />
              </Field>
            </div>
            <p className="-mt-2 text-xs text-muted">
              Times are in {timeZone}.{values.endDate > values.startDate ? ' Ends on a later date.' : ''}
            </p>
            {!weekly && notes.map((n) => (
              <p key={n} className="text-xs text-accent-soft">
                {n}
              </p>
            ))}

            <Field label="Location (optional)" htmlFor="ev-location" error={errors.location}>
              <input {...bind('location')} type="text" maxLength={120} value={values.location} onChange={(e) => set('location', e.target.value)} className={inputClass} />
            </Field>

            <Field label="Notes (optional)" htmlFor="ev-description" error={errors.description}>
              <textarea {...bind('description')} rows={3} maxLength={2000} value={values.description} onChange={(e) => set('description', e.target.value)} className={`${inputClass} py-2`} />
            </Field>

            {pending ? (
              <div role="alertdialog" aria-label="Please review" className="space-y-3 rounded-xl border border-work/50 bg-work/10 p-3">
                {pending.warnings.map((w) => (
                  <div key={w.heading} className="text-sm">
                    <p className="font-medium">{w.heading}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-white/85">
                      {w.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPending(null)} className={`${secondaryBtn} flex-1`}>
                    Go back
                  </button>
                  <button type="button" onClick={pending.commit} className={`${primaryBtn} flex-1`}>
                    Save anyway
                  </button>
                </div>
              </div>
            ) : confirmingDelete ? (
              <div role="alertdialog" aria-label="Confirm delete" className="space-y-3 rounded-xl border border-deadline/50 bg-deadline/10 p-3">
                <p className="text-sm">
                  {scope === 'series' ? (
                    <>Delete the whole series <strong>{event?.title}</strong>, including all its occurrences and individual changes? This can’t be undone.</>
                  ) : (
                    <>Delete <strong>{event?.title}</strong>? This can’t be undone.</>
                  )}
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmingDelete(false)} className={`${secondaryBtn} flex-1`}>
                    Keep it
                  </button>
                  <button type="button" onClick={handleDelete} className="min-h-11 flex-1 rounded-xl bg-deadline px-4 text-sm font-medium text-base">
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                {event && scope !== 'occurrence' && (
                  <button type="button" onClick={() => setConfirmingDelete(true)} className="mr-auto flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-deadline hover:bg-deadline/10">
                    <Trash2 size={16} aria-hidden /> {scope === 'series' ? 'Delete series' : 'Delete'}
                  </button>
                )}
                {scope === 'occurrence' && (
                  <div className="mr-auto flex flex-wrap gap-1">
                    <button type="button" onClick={cancelOccurrence} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-deadline hover:bg-deadline/10">
                      <Ban size={16} aria-hidden /> Cancel occurrence
                    </button>
                    {event?.modified && (
                      <button type="button" onClick={resetOccurrence} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-surface-2">
                        <RotateCcw size={16} aria-hidden /> Reset to series
                      </button>
                    )}
                  </div>
                )}
                <button type="button" onClick={close} className={`ml-auto ${secondaryBtn}`}>
                  Cancel
                </button>
                <button type="submit" className={primaryBtn}>
                  {scope === 'series' ? 'Save series' : scope === 'occurrence' ? 'Save occurrence' : event ? 'Save changes' : weekly ? 'Save series' : 'Save event'}
                </button>
              </div>
            )}
          </>
        )}
      </form>
    </dialog>
  )
}

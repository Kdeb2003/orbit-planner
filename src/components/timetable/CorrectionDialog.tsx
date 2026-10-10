import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { EDITABLE_FIELDS, duplicateOf, validateValues, weekdayName } from '../../timetable/utn/review.ts'
import type { EditableField, ReviewItem, SessionValues } from '../../timetable/utn/review.ts'
import { inputClass, primaryBtn, secondaryBtn } from './shared'
import { fullDate, groupLabel, typeLabel } from './labels'

interface Props {
  item: ReviewItem
  /** All items, to detect a session that would duplicate another one. */
  items: readonly ReviewItem[]
  onSave: (values: SessionValues) => void
  onReset: () => void
  onClose: () => void
}

const LABELS: Record<EditableField, string> = { title: 'Title', date: 'Date', startTime: 'Start time (Berlin)', endTime: 'End time (Berlin)', room: 'Room / location' }

function originalText(field: EditableField, v: SessionValues): string {
  if (field === 'date') return v.date ? fullDate(v.date) : 'no date printed'
  return v[field] || 'none'
}

/** Correct one extracted session. The extracted values stay untouched and are shown next to each field. */
export function CorrectionDialog({ item, items, onSave, onReset, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const uid = useId()
  const [values, setValues] = useState<SessionValues>(item.values)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  const errors = validateValues(values)
  const twin = duplicateOf(items, item, values)
  if (twin) errors.identity = `This would duplicate another session (${twin.values.title}, ${twin.values.date} ${twin.values.startTime}–${twin.values.endTime}).`
  const blocked = Object.keys(errors).length > 0
  const day = weekdayName(values.date)
  const weekdayWarning = day && day !== item.session.weekday ? `${values.date} is a ${day}, but the timetable prints ${item.session.weekday}.` : null
  const changed = EDITABLE_FIELDS.filter((f) => values[f] !== item.original[f])
  const close = () => dialogRef.current?.close()
  const set = (field: EditableField, value: string) => setValues((v) => ({ ...v, [field]: value }))

  const field = (f: EditableField, type: string, extra: Record<string, unknown> = {}) => {
    const id = `${uid}-${f}`
    const err = errors[f]
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm font-medium">
          <span>{LABELS[f]}</span>
          {changed.includes(f) && <span className="text-xs font-normal text-accent-soft">changed</span>}
        </label>
        <input
          id={id}
          type={type}
          value={values[f]}
          onChange={(e) => set(f, e.target.value)}
          aria-invalid={!!err}
          aria-describedby={`${id}-hint`}
          className={`${inputClass} ${err ? 'border-deadline' : ''}`}
          {...extra}
        />
        <p id={`${id}-hint`} className="text-xs">
          {err ? <span className="text-deadline">{err}</span> : <span className="text-muted">Extracted: {originalText(f, item.original)}</span>}
          {err && <span className="block text-muted">Extracted: {originalText(f, item.original)}</span>}
        </p>
      </div>
    )
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${uid}-heading`}
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && close()}
      className="m-auto max-h-[94dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-white shadow-2xl backdrop:bg-black/70"
    >
      <form
        noValidate
        className="space-y-4 p-4 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (blocked) return
          onSave(values)
          close()
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${uid}-heading`} className="text-lg font-semibold">
            Correct session
          </h2>
          <button type="button" onClick={close} aria-label="Close" className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-white">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="rounded-xl border border-line bg-surface-2/40 p-3" data-testid="dialog-session">
          <p className="break-words text-sm font-semibold">
            {item.course.displayName} — {typeLabel(item)}
            {groupLabel(item) ? ` · ${groupLabel(item)}` : ''}
          </p>
          <p className="break-all text-xs text-muted">{item.session.courseCode} · semester week {item.session.semesterWeek}</p>
        </div>
        <p className="text-xs text-muted">Corrections are kept only in this preview; the extracted values are never overwritten and can be restored.</p>

        {field('title', 'text', { maxLength: 200, 'data-autofocus': true })}
        {field('date', 'date')}
        <div className="grid grid-cols-2 gap-3">
          {field('startTime', 'time')}
          {field('endTime', 'time')}
        </div>
        {field('room', 'text', { maxLength: 200 })}

        {errors.identity && (
          <p role="alert" className="text-sm text-deadline">
            {errors.identity}
          </p>
        )}
        {weekdayWarning && <p className="text-sm text-work">{weekdayWarning}</p>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            type="button"
            className={secondaryBtn}
            onClick={() => {
              onReset()
              close()
            }}
            disabled={item.editedFields.length === 0}
          >
            Restore extracted values
          </button>
          <button type="button" className={secondaryBtn} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={primaryBtn} disabled={blocked || (changed.length === 0 && item.editedFields.length === 0)}>
            Save correction
          </button>
        </div>
      </form>
    </dialog>
  )
}

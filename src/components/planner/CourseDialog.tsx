import { Check, Loader2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  changedFields,
  COURSE_COLOR_NAMES,
  courseFieldErrors,
  courseMatchesForm,
  courseToForm,
  emptyCourseForm,
  findSameKey,
  formToInput,
  nextFreeColor,
} from '../../planner/courseForm'
import type { CourseFormValues } from '../../planner/courseForm'
import { sharedCodeCourses } from '../../planner/courseOverlap'
import { COURSE_LIMITS } from '../../planner/courseValidation'
import type { PlannerSnapshot, PlannerSource } from '../../planner/plannerSource'
import { COURSE_COLORS } from '../../types/planner'
import type { Course } from '../../types/planner'
import { COURSE_COLOR_CLASSES } from './courseColors'

interface CourseDialogProps {
  /** The course being edited, or null to create one. */
  course: Course | null
  snapshot: PlannerSnapshot
  source: PlannerSource
  /** `notice` is set when the save turned out to have succeeded after an uncertain failure. */
  onClose: (notice?: string) => void
  /** Close the dialog and show the existing course that blocks this one. */
  onLocate: (id: string) => void
}

const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-base px-3 text-sm text-white [color-scheme:dark] placeholder:text-muted/70 aria-[invalid=true]:border-deadline'
const secondaryBtn = 'min-h-11 rounded-xl border border-line px-4 text-sm hover:bg-surface-2 disabled:opacity-50'
const primaryBtn =
  'inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60'

const FIELD_LABELS: Record<string, keyof CourseFormValues> = {
  Name: 'name',
  Code: 'code',
  Institution: 'institution',
  'Term label': 'termLabel',
  'Term start': 'termStart',
  'Term end': 'termEnd',
  Description: 'description',
  Colour: 'color',
}

interface FieldProps {
  id: string
  label: string
  optional?: boolean
  help?: string
  error?: string
  extra?: ReactNode
  children: (a: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode
}

function Field({ id, label, optional, help, error, extra, children }: FieldProps) {
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label} {optional && <span className="font-normal">(optional)</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy })}
      {help && (
        <p id={`${id}-help`} className="mt-1 text-xs text-muted">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-deadline">
          {error}
        </p>
      )}
      {extra}
    </div>
  )
}

interface Stale {
  /** When the rejection arrived; a read that finished later shows the server's current state. */
  at: number
  /** The user reviewed the latest version and chose to keep their own entries. */
  kept: boolean
}

export function CourseDialog({ course, snapshot, source, onClose, onLocate }: CourseDialogProps) {
  const uid = useId()
  const fid = (n: string) => `${uid}-${n}`
  const ref = useRef<HTMLDialogElement>(null)
  // One id per create dialog: a retry after an unclear failure addresses the SAME row, so it can never create a duplicate.
  const [newId] = useState(() => crypto.randomUUID())
  const [values, setValues] = useState<CourseFormValues>(() => (course ? courseToForm(course) : emptyCourseForm(nextFreeColor(snapshot.courses))))
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(course?.updatedAt)
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [stale, setStale] = useState<Stale | null>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) d.showModal()
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  const latest = course ? snapshot.courses.find((c) => c.id === course.id) : undefined
  const editedGone = !!course && !latest
  // A create whose answer was lost may have reached the server: the course with this dialog's id is then ours.
  const created = !course ? snapshot.courses.find((c) => c.id === newId) : undefined
  const createdDiffers = !!created && !courseMatchesForm(created, values)

  // After an unclear failure the automatic re-read may show that the save did reach the server WITH THIS CONTENT: then we are done.
  // Same id but different content is never reported as saved.
  useEffect(() => {
    if (!uncertain) return
    const saved = course
      ? latest !== undefined && latest.updatedAt !== baseUpdatedAt && courseMatchesForm(latest, values)
      : created !== undefined && courseMatchesForm(created, values)
    if (saved) onClose('Your course was saved. The connection dropped before the confirmation arrived, but the server had received it.')
  }, [uncertain, course, latest, created, values, baseUpdatedAt, onClose])

  const errors = showErrors ? courseFieldErrors(values) : {}
  const sameKey = duplicate ? findSameKey(snapshot.courses, values, course?.id) : undefined
  const shared = sharedCodeCourses(snapshot.courses, { id: course?.id, code: values.code, termStart: values.termStart, termEnd: values.termEnd })
  const refreshed = stale !== null && (editedGone || (latest !== undefined && latest.updatedAt !== baseUpdatedAt) || (snapshot.lastSyncedAt ?? 0) > stale.at)
  const staleBlocking = stale !== null && !stale.kept
  const differences = latest ? changedFields(latest, values) : []

  const set = <K extends keyof CourseFormValues>(k: K, v: CourseFormValues[K]) => {
    setValues((p) => ({ ...p, [k]: v }))
    if (k === 'code' || k === 'institution' || k === 'termLabel') setDuplicate(false)
  }
  const close = () => ref.current?.close()
  const focusField = (name: string) => ref.current?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (saving || staleBlocking || editedGone) return
    const found = courseFieldErrors(values)
    const first = Object.keys(found)[0]
    setShowErrors(true)
    if (first) {
      focusField(first)
      return
    }
    setSaving(true)
    setAlert(null)
    setDuplicate(false)
    setUncertain(false)
    const input = formToInput(values)
    // An edit is bound to the version this form was based on (reviewed by the user); a create whose earlier attempt
    // already exists on the server becomes an update of that very course, bound to the version we last saw of it.
    const r = course
      ? await source.updateCourse(course.id, input, baseUpdatedAt)
      : created
        ? await source.updateCourse(created.id, input, created.updatedAt)
        : await source.createCourse(input, newId)
    setSaving(false)
    if (r.ok) {
      onClose()
      return
    }
    if (r.kind === 'duplicate') {
      setDuplicate(true)
      focusField('code')
    } else if (r.kind === 'stale') {
      setStale({ at: Date.now(), kept: false })
      setAlert(r.error)
    } else if (r.kind === 'network') {
      setUncertain(true)
      setAlert(`${r.error} ORBIT could not confirm whether this was saved and is checking the server. Your entries are kept. If you save again, no duplicate is created.`)
    } else {
      setAlert(r.error)
    }
  }

  const title = course ? 'Edit course' : 'Add course'
  const duplicateMessage = duplicate ? 'A course with this code, institution and term label already exists. Change one of them, or open the existing course.' : undefined

  return (
    <dialog
      ref={ref}
      aria-labelledby={fid('title')}
      onCancel={(e) => {
        if (saving) e.preventDefault() // never abandon a running save
      }}
      onClose={() => onClose()}
      onClick={(e) => e.target === ref.current && !saving && close()}
      className="m-auto max-h-[94dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-white shadow-2xl backdrop:bg-black/70"
    >
      <form onSubmit={submit} noValidate className="space-y-4 p-4 sm:p-6" aria-busy={saving}>
        <div className="flex items-center justify-between">
          <h2 id={fid('title')} className="text-lg font-semibold">
            {title}
          </h2>
          <button type="button" onClick={close} disabled={saving} aria-label="Close" className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-white disabled:opacity-50">
            <X size={18} aria-hidden />
          </button>
        </div>

        {alert && (
          <p role="alert" data-testid="course-save-error" className="rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2 text-sm">
            {alert}
          </p>
        )}

        {createdDiffers && (
          <p role="status" data-testid="created-differs" className="rounded-xl border border-work/40 bg-work/10 px-3 py-2 text-sm">
            An earlier attempt of this save did reach the server, but the stored course differs from your entries. It is not reported as saved. Saving now updates that course with what is in the form.
          </p>
        )}

        {editedGone && !stale && (
          <p role="alert" className="rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2 text-sm">
            This course no longer exists (it may have been deleted on another device). Nothing can be saved here.
          </p>
        )}

        {stale && (
          <section aria-label="Changed elsewhere" data-testid="stale-review" className="space-y-2 rounded-xl border border-work/40 bg-work/10 p-3 text-sm">
            {!refreshed ? (
              <>
                <p role="status" className="flex items-center gap-2">
                  <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden /> Refreshing the latest version from the server…
                </p>
                <button type="button" className={secondaryBtn} onClick={() => void source.refresh()}>
                  Refresh again
                </button>
              </>
            ) : editedGone ? (
              <p>This course was deleted on another device or tab. Your entries are kept below, but they cannot be saved to a course that no longer exists.</p>
            ) : (
              latest && (
                <>
                  <p>
                    Another device or tab changed this course.{' '}
                    {differences.length > 0 ? 'Compared with your entries, the latest saved version differs in:' : 'The latest saved version already matches your entries.'}
                  </p>
                  {differences.length > 0 && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      {differences.map((f) => {
                        const key = FIELD_LABELS[f]
                        const lf = courseToForm(latest)
                        const text = key === 'color' ? COURSE_COLOR_NAMES[lf.color] : lf[key] || '(empty)'
                        return (
                          <div key={f} className="contents">
                            <dt className="text-muted">{f}</dt>
                            <dd className="min-w-0 break-words">{text}</dd>
                          </div>
                        )
                      })}
                    </dl>
                  )}
                  {!stale.kept && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        className={secondaryBtn}
                        onClick={() => {
                          setValues(courseToForm(latest))
                          setBaseUpdatedAt(latest.updatedAt)
                          setStale(null)
                          setAlert(null)
                        }}
                      >
                        Use the latest values
                      </button>
                      <button
                        type="button"
                        className={secondaryBtn}
                        onClick={() => {
                          setBaseUpdatedAt(latest.updatedAt)
                          setStale({ ...stale, kept: true })
                          setAlert(null)
                        }}
                      >
                        Keep my entries
                      </button>
                    </div>
                  )}
                </>
              )
            )}
          </section>
        )}
        {stale?.kept && <p className="text-xs text-muted">Saving will replace the latest saved version with your entries.</p>}

        <Field id={fid('name')} label="Course name" error={errors.name} help={`Required, up to ${COURSE_LIMITS.name} characters.`}>
          {(a) => <input {...a} name="name" type="text" data-autofocus autoComplete="off" value={values.name} onChange={(e) => set('name', e.target.value)} className={inputClass} />}
        </Field>

        <Field
          id={fid('code')}
          label="Course code"
          optional
          error={errors.code ?? duplicateMessage}
          help={`Used to match timetable sessions to this course. Up to ${COURSE_LIMITS.code} characters.`}
          extra={
            sameKey && (
              <button type="button" onClick={() => onLocate(sameKey.id)} className="mt-2 min-h-11 rounded-xl border border-line px-3 text-sm hover:bg-surface-2">
                Show the existing course: {sameKey.name}
              </button>
            )
          }
        >
          {(a) => <input {...a} name="code" type="text" autoComplete="off" value={values.code} onChange={(e) => set('code', e.target.value)} className={inputClass} />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={fid('institution')} label="Institution" optional error={errors.institution}>
            {(a) => <input {...a} name="institution" type="text" autoComplete="off" value={values.institution} onChange={(e) => set('institution', e.target.value)} className={inputClass} />}
          </Field>
          <Field id={fid('termLabel')} label="Term / semester" optional error={errors.termLabel} help="Display text only, e.g. WS 26/27.">
            {(a) => <input {...a} name="termLabel" type="text" autoComplete="off" value={values.termLabel} onChange={(e) => set('termLabel', e.target.value)} className={inputClass} />}
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-muted">
            Term dates <span className="font-normal">(optional, both or neither)</span>
          </legend>
          <p className="text-xs text-muted">
            Term dates let ORBIT tell semesters apart when the same course code is reused. Without them, a course whose code is shared with another course cannot be matched to timetable sessions. A term can span at most {COURSE_LIMITS.maxTermDays} days.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={fid('termStart')} label="Term start" error={errors.termStart}>
              {(a) => <input {...a} name="termStart" type="date" value={values.termStart} onChange={(e) => set('termStart', e.target.value)} className={inputClass} />}
            </Field>
            <Field id={fid('termEnd')} label="Term end" error={errors.termEnd}>
              {(a) => <input {...a} name="termEnd" type="date" value={values.termEnd} onChange={(e) => set('termEnd', e.target.value)} className={inputClass} />}
            </Field>
          </div>
        </fieldset>

        {shared.length > 0 && (
          <div role="note" data-testid="dialog-shared-warning" className="flex items-start gap-2 rounded-xl border border-work/40 bg-work/10 p-3 text-xs">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-work" aria-hidden />
            <p>
              Another course uses this code ({shared.map((s) => s.course.name + (s.course.termLabel ? ` · ${s.course.termLabel}` : '')).join(', ')}) and the term dates{' '}
              {shared.some((s) => s.reason === 'missing') ? 'are missing or incomplete' : 'overlap'}. Matching timetable sessions may be ambiguous and stay unassigned. You can still save.
            </p>
          </div>
        )}

        <Field id={fid('description')} label="Description" optional error={errors.description} help={`${values.description.length}/${COURSE_LIMITS.description} characters`}>
          {(a) => <textarea {...a} name="description" rows={3} value={values.description} onChange={(e) => set('description', e.target.value)} className={`${inputClass} py-2`} />}
        </Field>

        <fieldset>
          <legend className="mb-1 text-xs font-medium text-muted">Colour</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {COURSE_COLORS.map((c) => {
              const on = values.color === c
              return (
                <label
                  key={c}
                  className={`relative flex size-11 cursor-pointer items-center justify-center rounded-xl border-2 ${on ? 'border-white' : 'border-line'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-soft`}
                >
                  <input type="radio" name="color" value={c} checked={on} onChange={() => set('color', c)} className="sr-only" aria-label={COURSE_COLOR_NAMES[c]} />
                  <span className={`size-7 rounded-lg ${COURSE_COLOR_CLASSES[c].bg}`} aria-hidden />
                  {on && <Check size={16} className="absolute text-base" aria-hidden />}
                </label>
              )
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={close} disabled={saving} className={secondaryBtn}>
            Cancel
          </button>
          <button type="submit" disabled={saving || staleBlocking || editedGone} className={primaryBtn}>
            {saving && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />}
            {saving ? 'Saving…' : course ? 'Save changes' : 'Add course'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

import { CalendarSearch, Check, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { COURSE_COLOR_NAMES, courseFieldErrors, courseMatchesForm, formToInput } from '../../planner/courseForm'
import type { CourseFormValues } from '../../planner/courseForm'
import { suggestColors } from '../../planner/courseInsights'
import type { AttentionGroup, CalendarInsights } from '../../planner/courseInsights'
import { COURSE_LIMITS } from '../../planner/courseValidation'
import type { PlannerSnapshot, PlannerSource } from '../../planner/plannerSource'
import { COURSE_COLORS } from '../../types/planner'
import type { Course } from '../../types/planner'
import { daysBetween } from '../../utils/time'
import { COURSE_COLOR_CLASSES } from './courseColors'
import { formatDay } from './formatDay'

/** How trustworthy the two data sources are right now. */
export type Freshness = 'loading' | 'unavailable' | 'stale' | 'current'

interface SuggestPanelProps {
  snapshot: PlannerSnapshot
  source: PlannerSource
  insights: CalendarInsights
  calendar: Freshness
  courses: Freshness
  onEditCourse: (course: Course) => void
  /** Open the course dialog prefilled for a term that no existing course covers. */
  onCreateForTerm: (group: AttentionGroup) => void
}

type Phase = 'idle' | 'saving' | 'saved' | 'failed' | 'uncertain' | 'changed'
interface Status {
  phase: Phase
  error?: string
  /** The server said the same code, institution and term label already exists. */
  duplicate?: boolean
  /** The id this attempt was submitted under (so the existing course can be found without reading a ref in render). */
  id?: string
}
type Edits = Partial<CourseFormValues> & { selected?: boolean }

const inputClass = 'min-h-11 w-full rounded-xl border border-line bg-base px-3 text-sm text-white [color-scheme:dark] placeholder:text-muted/70 aria-[invalid=true]:border-deadline'
const btn = 'inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50'
const primary = 'inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60'

const range = (a: string, b: string) => (a === b ? formatDay(a) : `${formatDay(a)} – ${formatDay(b)}`)
const label = (c: Course) => [c.name, c.termLabel].filter(Boolean).join(' · ')
const sessionsWord = (n: number) => `${n} session${n === 1 ? '' : 's'}`

export function SuggestPanel({ snapshot, source, insights, calendar, courses, onEditCourse, onCreateForTerm }: SuggestPanelProps) {
  const [edits, setEdits] = useState<Record<string, Edits>>({})
  const [status, setStatus] = useState<Record<string, Status>>({})
  // One stable id per candidate: a retry after an unclear failure addresses the same row, never a duplicate.
  const ids = useRef(new Map<string, string>())
  // What was submitted per candidate, to check later that a server copy with this id really holds that content.
  const submitted = useRef(new Map<string, CourseFormValues>())
  const [created, setCreated] = useState<{ id: string; name: string }[]>([])
  const [running, setRunning] = useState(false)
  // Messages that are not about a batch (nothing selected / nothing valid), and the codes of the last batch: its summary is
  // derived from the per-candidate status, so a later reconciliation can never leave the two disagreeing.
  const [notice, setNotice] = useState<string | null>(null)
  const [batch, setBatch] = useState<string[] | null>(null)
  const [attempted, setAttempted] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const idFor = (code: string) => {
    let id = ids.current.get(code)
    if (!id) {
      id = crypto.randomUUID()
      ids.current.set(code, id)
    }
    return id
  }

  const colors = useMemo(() => suggestColors(snapshot.courses, insights.suggestions.length), [snapshot.courses, insights.suggestions.length])
  const rows = insights.suggestions.map((g, i) => {
    const e = edits[g.code] ?? {}
    const values: CourseFormValues = {
      name: e.name ?? g.suggestedName,
      code: e.code ?? g.code,
      institution: e.institution ?? '',
      termLabel: e.termLabel ?? '',
      termStart: e.termStart ?? g.firstDate,
      termEnd: e.termEnd ?? g.lastDate,
      description: e.description ?? '',
      color: e.color ?? colors[i],
    }
    return { g, values, selected: e.selected ?? false, st: status[g.code] ?? { phase: 'idle' as Phase }, errors: courseFieldErrors(values) }
  })

  // A create whose answer was lost: once the re-read shows OUR course (same id, same content) it counts as saved.
  useEffect(() => {
    const pending = Object.entries(status).filter(([, s]) => s.phase === 'uncertain')
    if (pending.length === 0) return
    for (const [code] of pending) {
      const found = snapshot.courses.find((c) => c.id === ids.current.get(code))
      const sent = submitted.current.get(code)
      if (!found || !sent) continue
      if (!courseMatchesForm(found, sent)) {
        // The id exists but holds something else (changed elsewhere since): never "saved", never overwritten, never re-created under a new id.
        setStatus((s) => ({ ...s, [code]: { phase: 'changed', id: found.id, error: `A course with this request’s id exists, but it differs from what you submitted (“${sent.name}”): it has changed since. ORBIT did not overwrite it. Review the existing course before deciding what to do.` } }))
        continue
      }
      setCreated((l) => (l.some((x) => x.id === found.id) ? l : [...l, { id: found.id, name: found.name }]))
      setStatus((s) => ({ ...s, [code]: { phase: 'saved' } }))
    }
  }, [snapshot.courses, status])

  const set = (code: string, patch: Edits) => {
    setEdits((p) => ({ ...p, [code]: { ...p[code], ...patch } }))
    if (!('selected' in patch)) setStatus((s) => (s[code]?.phase === 'failed' ? { ...s, [code]: { phase: 'idle' } } : s))
  }

  const busy = running || rows.some((r) => r.st.phase === 'saving')
  const selected = rows.filter((r) => r.selected && r.st.phase !== 'saved' && r.st.phase !== 'changed')

  async function createSelected() {
    if (busy) return
    setAttempted(true)
    setNotice(null)
    setBatch(null)
    const todo = rows.filter((r) => r.selected && r.st.phase !== 'saved' && r.st.phase !== 'changed')
    const valid = todo.filter((r) => Object.keys(r.errors).length === 0)
    if (valid.length === 0) {
      setNotice(todo.length === 0 ? 'Select at least one course to create.' : 'Nothing was created: every selected course needs a correction first.')
      return
    }
    setRunning(true)
    for (const r of valid) {
      if (!alive.current) return // signed out / switched account: the source is gone, nothing more to do
      const code = r.g.code
      setStatus((s) => ({ ...s, [code]: { phase: 'saving' } }))
      submitted.current.set(code, r.values)
      const id = idFor(code)
      const res = await source.createCourse(formToInput(r.values), id)
      if (!alive.current) return
      if (res.ok) {
        setCreated((l) => (l.some((x) => x.id === res.value.id) ? l : [...l, { id: res.value.id, name: res.value.name }]))
        setStatus((s) => ({ ...s, [code]: { phase: 'saved' } }))
        setEdits((p) => ({ ...p, [code]: { ...p[code], selected: false } }))
      } else if (res.kind === 'duplicate') {
        setStatus((s) => ({ ...s, [code]: { phase: 'failed', duplicate: true, error: 'A course with this code, institution and term label already exists. Add a term label or an institution that tells them apart.' } }))
      } else if (res.kind === 'network') {
        setStatus((s) => ({ ...s, [code]: { phase: 'uncertain', id, error: `${res.error} ORBIT could not confirm whether this was saved and is checking the server. Create again is safe: it cannot make a duplicate.` } }))
      } else {
        setStatus((s) => ({ ...s, [code]: { phase: 'failed', error: res.error } }))
      }
    }
    setRunning(false)
    setBatch(todo.map((r) => r.g.code))
  }

  const dismiss = (code: string) => {
    submitted.current.delete(code) // the user closes the unresolved attempt; the id stays reserved for this code
    setStatus((s) => ({ ...s, [code]: { phase: 'idle' } }))
  }

  const stale = calendar === 'stale' || courses === 'stale'
  const pending = calendar === 'loading' || courses === 'loading'
  const unavailable = calendar === 'unavailable' || courses === 'unavailable'
  const { outsideTerm, ambiguous } = insights
  const empty = rows.length === 0 && outsideTerm.length === 0 && ambiguous.length === 0
  const byId = (id: string) => snapshot.courses.find((c) => c.id === id)
  const summary = (() => {
    if (notice) return notice
    if (!batch || running) return null
    const ok = batch.filter((c) => status[c]?.phase === 'saved').length
    const unsure = batch.filter((c) => status[c]?.phase === 'uncertain').length
    const failed = batch.length - ok
    return `Created ${ok} of ${batch.length} selected course${batch.length === 1 ? '' : 's'}.${failed > 0 ? ` ${failed} ${failed === 1 ? 'was' : 'were'} not created${unsure > 0 ? ` (${unsure} not confirmed yet)` : ''}; ${failed === 1 ? 'it is' : 'they are'} still listed below.` : ''}`
  })()
  // Unresolved attempts whose code is no longer suggested (the saved course now resolves it) must stay visible.
  const shown = new Set(rows.map((r) => r.g.code))
  const orphans = Object.entries(status).filter(([code, s]) => (s.phase === 'uncertain' || s.phase === 'changed') && !shown.has(code))
  const attemptActions = (code: string, st: Status) => {
    const existing = snapshot.courses.find((c) => c.id === st.id)
    return (
      <div className="flex flex-wrap gap-2">
        {existing && (
          <button type="button" className={btn} onClick={() => onEditCourse(existing)}>
            Review existing course
          </button>
        )}
        {st.phase === 'changed' && (
          <button type="button" className={btn} onClick={() => dismiss(code)}>
            Dismiss
          </button>
        )}
      </div>
    )
  }

  return (
    <section aria-labelledby="suggest-heading" data-testid="suggest-panel" className="space-y-6 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div>
        <h2 id="suggest-heading" className="flex items-center gap-2 text-base font-semibold">
          <CalendarSearch size={18} aria-hidden /> Suggest from my calendar
        </h2>
        <p className="mt-1 text-sm text-muted">
          ORBIT looks at the course codes on your saved calendar events and shows what is not covered by a course yet. Nothing is created until you choose “Create selected”, and your calendar is never changed.
        </p>
      </div>

      {pending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> Waiting for your calendar and courses to load before suggesting anything…
        </p>
      ) : unavailable ? (
        <p role="alert" className="rounded-xl border border-work/40 bg-work/10 px-3 py-2 text-sm">
          Suggestions are not available because your {calendar === 'unavailable' ? 'calendar' : 'courses'} could not be loaded. Retry from the banner above; nothing is guessed from missing data.
        </p>
      ) : (
        <>
          {stale && (
            <p role="alert" data-testid="suggest-stale" className="flex items-start gap-2 rounded-xl border border-work/40 bg-work/10 px-3 py-2 text-sm">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-work" aria-hidden />
              Your {calendar === 'stale' && courses === 'stale' ? 'calendar and courses' : calendar === 'stale' ? 'calendar' : 'courses'} could not be refreshed. These suggestions use the last data ORBIT loaded and may be out of date.
            </p>
          )}

          {empty && created.length === 0 && (
            <p data-testid="suggest-empty" className="text-sm text-muted">
              Every course code in your calendar is already covered by a course. There is nothing to suggest.
            </p>
          )}

          {summary && (
            <p role="status" data-testid="suggest-summary" className="rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-sm">
              {summary}
            </p>
          )}
          {created.length > 0 && (
            <p role="status" data-testid="suggest-created" className="flex items-start gap-2 text-sm">
              <Check size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>Created: {created.map((c) => `“${c.name}”`).join(', ')}.</span>
            </p>
          )}

          {orphans.length > 0 && (
            <section aria-labelledby="sg-unresolved" data-testid="suggest-unresolved">
              <h3 id="sg-unresolved" className="text-sm font-semibold">
                Not confirmed ({orphans.length})
              </h3>
              <ul className="mt-3 space-y-3">
                {orphans.map(([code, st]) => (
                  <li key={code} data-attempt={code} data-phase={st.phase} className="space-y-2 rounded-xl border border-work/50 bg-work/10 p-3 text-sm">
                    <p>
                      <strong>{code}</strong> {'—'} {st.phase === 'uncertain' ? 'ORBIT could not confirm whether this course was saved and is checking the server. It is not counted as created.' : st.error}
                    </p>
                    {attemptActions(code, st)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="sg-new">
            <h3 id="sg-new" className="text-sm font-semibold">
              No course yet ({rows.length})
            </h3>
            {rows.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No unresolved course codes.</p>
            ) : (
              <>
                <ul className="mt-3 space-y-3">
                  {rows.map(({ g, values, selected: sel, st, errors }) => {
                    const days = daysBetween(g.firstDate, g.lastDate)
                    const fid = (n: string) => `sg-${g.code.replace(/\W+/g, '_')}-${n}`
                    const showErr = sel || attempted
                    const nameErr = showErr ? errors.name : undefined
                    const dateErr = showErr ? errors.termStart ?? errors.termEnd : undefined
                    const instErr = showErr ? errors.institution : undefined
                    const labelErr = showErr ? errors.termLabel : undefined
                    const ready = sel && Object.keys(errors).length === 0
                    return (
                      <li key={g.code} data-suggestion={g.code} data-phase={st.phase} className="space-y-3 rounded-xl border border-line bg-surface-2/40 p-3">
                        <div className="flex flex-wrap items-start gap-3">
                          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                            <input type="checkbox" className="size-5 accent-accent" checked={sel} disabled={busy || st.phase === 'saved'} onChange={(e) => set(g.code, { selected: e.target.checked })} />
                            <span>
                              <span className="sr-only">Select </span>
                              {g.code}
                            </span>
                          </label>
                          <p className="min-w-0 flex-1 text-xs text-muted">
                            {sessionsWord(g.sessionCount)} · {range(g.firstDate, g.lastDate)} · e.g. “{g.exampleTitle}”
                          </p>
                          {sel && (
                            <span data-testid="candidate-state" className={`rounded-full border px-2 py-0.5 text-xs ${ready ? 'border-line text-white' : 'border-work/50 text-work'}`}>
                              {st.phase === 'saving' ? 'Saving…' : st.phase === 'uncertain' ? 'Not confirmed' : st.phase === 'changed' ? 'Changed since submission' : ready ? 'Ready' : 'Needs correction'}
                            </span>
                          )}
                        </div>

                        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                          <div>
                            <label htmlFor={fid('name')} className="mb-1 block text-xs font-medium text-muted">
                              Suggested course name
                            </label>
                            <input id={fid('name')} className={inputClass} value={values.name} disabled={busy} aria-invalid={!!nameErr} aria-describedby={nameErr ? `${fid('name')}-err` : undefined} onChange={(e) => set(g.code, { name: e.target.value })} />
                            {nameErr && (
                              <p id={`${fid('name')}-err`} role="alert" className="mt-1 text-xs text-deadline">
                                {nameErr}
                              </p>
                            )}
                          </div>
                          <div>
                            <label htmlFor={fid('start')} className="mb-1 block text-xs font-medium text-muted">
                              Term start
                            </label>
                            <input id={fid('start')} type="date" className={inputClass} value={values.termStart} disabled={busy} aria-invalid={!!dateErr} aria-describedby={`${fid('dates')}${dateErr ? ` ${fid('date-err')}` : ''}`} onChange={(e) => set(g.code, { termStart: e.target.value })} />
                          </div>
                          <div>
                            <label htmlFor={fid('end')} className="mb-1 block text-xs font-medium text-muted">
                              Term end
                            </label>
                            <input id={fid('end')} type="date" className={inputClass} value={values.termEnd} disabled={busy} aria-invalid={!!dateErr} aria-describedby={`${fid('dates')}${dateErr ? ` ${fid('date-err')}` : ''}`} onChange={(e) => set(g.code, { termEnd: e.target.value })} />
                          </div>
                        </div>
                        <p id={fid('dates')} className="text-xs text-muted">
                          Suggested from calendar — please check.
                        </p>
                        {days > COURSE_LIMITS.maxTermDays && (
                          <p data-testid="range-too-long" className="text-xs text-work">
                            These sessions span {days + 1} days, more than the {COURSE_LIMITS.maxTermDays}-day limit of one term. ORBIT did not shorten the range: pick the dates of one term, or clear both dates, before creating this course.
                          </p>
                        )}
                        {dateErr && (
                          <p id={fid('date-err')} role="alert" className="text-xs text-deadline">
                            {dateErr}
                          </p>
                        )}

                        <details className="text-sm" open={instErr || labelErr ? true : undefined}>
                          <summary className="min-h-11 cursor-pointer py-2 text-xs text-muted">Institution, term label and colour (optional)</summary>
                          <div className="mt-2 grid gap-3 sm:grid-cols-2">
                            <div>
                              <label htmlFor={fid('inst')} className="mb-1 block text-xs font-medium text-muted">
                                Institution
                              </label>
                              <input id={fid('inst')} className={inputClass} value={values.institution} disabled={busy} aria-invalid={!!instErr} aria-describedby={instErr ? `${fid('inst')}-err` : undefined} onChange={(e) => set(g.code, { institution: e.target.value })} />
                              {instErr && (
                                <p id={`${fid('inst')}-err`} role="alert" className="mt-1 text-xs text-deadline">
                                  {instErr}
                                </p>
                              )}
                            </div>
                            <div>
                              <label htmlFor={fid('label')} className="mb-1 block text-xs font-medium text-muted">
                                Term / semester label
                              </label>
                              <input id={fid('label')} className={inputClass} value={values.termLabel} disabled={busy} aria-invalid={!!labelErr} aria-describedby={labelErr ? `${fid('label')}-err` : undefined} onChange={(e) => set(g.code, { termLabel: e.target.value })} />
                              {labelErr && (
                                <p id={`${fid('label')}-err`} role="alert" className="mt-1 text-xs text-deadline">
                                  {labelErr}
                                </p>
                              )}
                            </div>
                          </div>
                          <fieldset className="mt-3">
                            <legend className="mb-1 text-xs font-medium text-muted">Colour</legend>
                            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`Colour for ${g.code}`}>
                              {COURSE_COLORS.map((c) => (
                                <label key={c} className={`relative flex size-11 cursor-pointer items-center justify-center rounded-xl border-2 ${values.color === c ? 'border-white' : 'border-line'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-soft`}>
                                  <input type="radio" className="sr-only" name={fid('color')} aria-label={COURSE_COLOR_NAMES[c]} checked={values.color === c} disabled={busy} onChange={() => set(g.code, { color: c })} />
                                  <span className={`size-7 rounded-lg ${COURSE_COLOR_CLASSES[c].bg}`} aria-hidden />
                                  {values.color === c && <Check size={16} className="absolute text-base" aria-hidden />}
                                </label>
                              ))}
                            </div>
                          </fieldset>
                        </details>

                        {st.error && (
                          <p role="alert" data-testid="candidate-error" className="rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2 text-sm">
                            {st.error}
                          </p>
                        )}
                        {st.phase === 'changed' && attemptActions(g.code, st)}
                      </li>
                    )
                  })}
                </ul>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => void createSelected()} disabled={busy || selected.length === 0} className={primary}>
                    {busy && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />}
                    {busy ? 'Creating…' : `Create selected (${selected.length})`}
                  </button>
                  <button type="button" disabled={busy} className={btn} onClick={() => setEdits((p) => Object.fromEntries(rows.map((r) => [r.g.code, { ...p[r.g.code], selected: true }])))}>
                    Select all
                  </button>
                  <button type="button" disabled={busy || selected.length === 0} className={btn} onClick={() => setEdits((p) => Object.fromEntries(rows.map((r) => [r.g.code, { ...p[r.g.code], selected: false }])))}>
                    Clear selection
                  </button>
                </div>
              </>
            )}
          </section>

          <section aria-labelledby="sg-outside">
            <h3 id="sg-outside" className="text-sm font-semibold">
              Needs attention — outside term ({outsideTerm.length})
            </h3>
            {outsideTerm.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No sessions fall outside the term of an existing course.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {outsideTerm.map((g) => (
                  <li key={g.code} data-outside={g.code} className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3 text-sm">
                    <p>
                      <strong>{g.code}</strong> — {sessionsWord(g.sessionCount)} between {range(g.firstDate, g.lastDate)} fall outside the term dates of {g.courseIds.map((id) => byId(id)).filter((c): c is Course => !!c).map(label).join(', ')}. Those sessions stay unassigned.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btn} onClick={() => onCreateForTerm(g)}>
                        Create a course for this term
                      </button>
                    </div>
                    <p className="text-xs text-muted">The new course opens for review first. Existing courses are not changed.</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="sg-amb">
            <h3 id="sg-amb" className="text-sm font-semibold">
              Needs attention — ambiguous ({ambiguous.length})
            </h3>
            {ambiguous.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No sessions are ambiguous.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {ambiguous.map((g) => {
                  const list = g.courseIds.map(byId).filter((c): c is Course => !!c)
                  return (
                    <li key={g.code} data-ambiguous={g.code} className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3 text-sm">
                      <p>
                        <strong>{g.code}</strong> — {sessionsWord(g.sessionCount)} between {range(g.firstDate, g.lastDate)} could belong to more than one course, so ORBIT does not assign them.
                      </p>
                      <p className="text-xs text-muted">
                        Courses sharing this code: {list.map((c) => `${label(c)} (${c.termStart && c.termEnd ? range(c.termStart, c.termEnd) : 'no term dates'}${c.institution ? `, ${c.institution}` : ''})`).join('; ')}. Term dates that do not overlap tell them apart; the institution does not.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {list.map((c) => (
                          <button key={c.id} type="button" className={btn} onClick={() => onEditCourse(c)} aria-label={`Edit ${c.name} to add or correct its term dates`}>
                            Edit {c.name}
                          </button>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  )
}

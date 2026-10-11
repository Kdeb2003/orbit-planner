import { CalendarSearch, CloudOff, Loader2, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useCalendar } from '../calendar/CalendarContext'
import { ConfirmDialog } from '../components/planner/ConfirmDialog'
import { CourseCard } from '../components/planner/CourseCard'
import { CourseDialog } from '../components/planner/CourseDialog'
import { PlanTabs } from '../components/planner/PlanTabs'
import { SuggestPanel } from '../components/planner/SuggestPanel'
import type { Freshness } from '../components/planner/SuggestPanel'
import { Card } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import type { CourseFormValues } from '../planner/courseForm'
import { analyseCalendar } from '../planner/courseInsights'
import type { AttentionGroup } from '../planner/courseInsights'
import { sharedCodeCourses } from '../planner/courseOverlap'
import { calendarSessions, normaliseCourseCode } from '../planner/courses'
import { usePlanner } from '../planner/PlannerContext'
import type { PlannerResult } from '../planner/plannerSource'
import type { Course } from '../types/planner'

type Dialog = { kind: 'new'; initial?: Partial<CourseFormValues>; hint?: string } | { kind: 'edit'; course: Course }
type Confirm = { kind: 'archive' | 'delete'; course: Course }

const primaryBtn = 'inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60'
const secondaryBtn = 'inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm hover:bg-surface-2'

/**
 * Everything stateful (open dialogs, unsaved form input, confirmations, pending notices) lives in `CoursesManager`,
 * which is KEYED by the signed-in account. A direct switch from account A to B therefore unmounts A's whole interface
 * in the same render that B becomes active: nothing of A (a dialog, a draft, an unfinished operation) can appear
 * under B, and A's late answers land in an unmounted component. No extra subscription or request is involved.
 */
export function CoursesPage() {
  const { state } = useAuth()
  return <CoursesManager key={state.status === 'signed-in' ? state.user.id : state.status} />
}

function CoursesManager() {
  const { enabled, source, snapshot } = usePlanner()
  const { state } = useAuth()
  const cal = useCalendar()
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmPending, setConfirmPending] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  /** The server (or this source) already rejected the confirmation as stale: it must be reviewed and reopened. */
  const [confirmStale, setConfirmStale] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Calendar and courses are read from the existing snapshots only (no extra request). They must belong to the same
  // account; otherwise nothing is combined.
  const sameAccount = !!snapshot && cal.mode === 'cloud' && cal.userId === snapshot.userId
  const sessions = useMemo(() => (sameAccount ? calendarSessions(cal.events, cal.series) : []), [sameAccount, cal.events, cal.series])
  const insights = useMemo(() => analyseCalendar(sessions, snapshot?.courses ?? []), [sessions, snapshot?.courses])
  const calendarFreshness: Freshness = !sameAccount || cal.status === 'loading' ? 'loading' : cal.status === 'error' ? 'unavailable' : cal.offline || cal.error ? 'stale' : 'current'
  const coursesFreshness: Freshness = !snapshot || snapshot.status === 'loading' ? 'loading' : snapshot.status === 'error' || snapshot.unavailable ? 'unavailable' : snapshot.offline || snapshot.error ? 'stale' : 'current'

  // "Show the existing course": scroll to it, focus it and mark it for a few seconds.
  useEffect(() => {
    if (!highlightId) return
    const el = document.getElementById(`course-${highlightId}`)
    el?.scrollIntoView?.({ block: 'center' })
    el?.focus()
    const t = setTimeout(() => setHighlightId(null), 4000)
    return () => clearTimeout(t)
  }, [highlightId])

  const header = (
    <>
      <PageHeader title="Courses" subtitle="The subjects you study, one per term. Timetable sessions are matched to them by course code." />
      <PlanTabs />
    </>
  )

  // Local-only mode: Courses are stored in the cloud account only (never in this browser).
  if (state.status === 'unconfigured') {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <h2 className="font-medium">Courses need an ORBIT account</h2>
          <p className="mt-1 text-sm text-muted">
            Courses are stored in your cloud account, never in this browser. This copy of ORBIT runs in local-only mode, so Courses are not available here. Your local calendar is unaffected.
          </p>
        </Card>
      </div>
    )
  }

  if (!enabled || !source || !snapshot) {
    return (
      <div className="space-y-6">
        {header}
        <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> Loading courses…
        </p>
      </div>
    )
  }

  const { courses, status, offline, error, pendingWrites, skippedInvalid, unavailable } = snapshot
  const active = courses.filter((c) => !c.archivedAt)
  const archived = courses.filter((c) => c.archivedAt)
  const ready = status === 'ready'

  async function runConfirmed(c: Confirm) {
    if (!source) return
    setConfirmPending(true)
    setConfirmError(null)
    // Bound to the version that was on screen when the confirmation was opened, never to whatever refreshed since.
    const v = c.course.updatedAt
    const r: PlannerResult<unknown> = c.kind === 'archive' ? await source.archiveCourse(c.course.id, v) : await source.deleteCourse(c.course.id, v)
    setConfirmPending(false)
    if (r.ok) {
      setConfirm(null)
      setNotice(c.kind === 'archive' ? `“${c.course.name}” was archived. You can restore it under Archived courses.` : `“${c.course.name}” was deleted.`)
    } else {
      if (r.kind === 'stale') setConfirmStale(true)
      setConfirmError(
        r.kind === 'stale'
          ? `${r.error} Nothing was changed. Close this dialog, review the course, and try again if you still want to.`
          : r.kind === 'network'
            ? `${r.error} It may or may not have been saved; ORBIT is checking the server. Close this dialog to see the current state.`
            : r.error,
      )
    }
  }

  async function restore(course: Course) {
    if (!source) return
    setBusyId(course.id)
    setActionError(null)
    const r = await source.restoreCourse(course.id, course.updatedAt) // the version shown on the card
    setBusyId(null)
    if (r.ok) setNotice(`“${course.name}” was restored.`)
    else setActionError(`“${course.name}” was not restored. ${r.error}`)
  }

  const closeDialog = (message?: string) => {
    setDialog(null)
    if (message) setNotice(message)
  }

  const card = (c: Course) => (
    <CourseCard
      key={c.id}
      course={c}
      shared={sharedCodeCourses(courses, c)}
      matching={
        calendarFreshness === 'current' || calendarFreshness === 'stale'
          ? {
              counts: insights.perCourse.get(c.id) ?? { dated: 0, byCode: 0 },
              codeLevel: insights.perCode.get(normaliseCourseCode(c.code)),
              stale: calendarFreshness === 'stale' || coursesFreshness === 'stale',
            }
          : undefined
      }
      busy={busyId === c.id || (confirmPending && confirm?.course.id === c.id)}
      highlighted={highlightId === c.id}
      onEdit={() => {
        setNotice(null)
        setDialog({ kind: 'edit', course: c })
      }}
      onArchive={() => {
        setNotice(null)
        setConfirmError(null)
        setConfirmStale(false)
        setConfirm({ kind: 'archive', course: c })
      }}
      onRestore={() => {
        setNotice(null)
        void restore(c)
      }}
      onDelete={() => {
        setNotice(null)
        setConfirmError(null)
        setConfirmStale(false)
        setConfirm({ kind: 'delete', course: c })
      }}
    />
  )

  const canAdd = ready && !unavailable
  // The confirmation is about ONE reviewed version; if that course changed (or vanished) since, it must be reopened.
  const confirmLatest = confirm ? courses.find((c) => c.id === confirm.course.id) : undefined
  const confirmChanged = !!confirm && (!confirmLatest || confirmLatest.updatedAt !== confirm.course.updatedAt)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Courses" subtitle="The subjects you study, one per term. Timetable sessions are matched to them by course code." />
        <div className="flex items-center gap-3">
          {pendingWrites > 0 && (
            <span role="status" className="flex items-center gap-1.5 text-xs text-muted">
              <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden /> Saving…
            </span>
          )}
          <button
            type="button"
            disabled={!canAdd}
            aria-expanded={suggestOpen}
            aria-controls="suggest-panel-region"
            onClick={() => setSuggestOpen((o) => !o)}
            className={secondaryBtn}
          >
            <CalendarSearch size={16} aria-hidden /> Suggest from my calendar
          </button>
          <button type="button" disabled={!canAdd} onClick={() => setDialog({ kind: 'new' })} className={primaryBtn}>
            <Plus size={16} aria-hidden /> Add course
          </button>
        </div>
      </div>
      <PlanTabs />

      <div id="suggest-panel-region">
        {suggestOpen && canAdd && (
          <SuggestPanel
            snapshot={snapshot}
            source={source}
            insights={insights}
            calendar={calendarFreshness}
            courses={coursesFreshness}
            onEditCourse={(c) => {
              setNotice(null)
              setDialog({ kind: 'edit', course: c })
            }}
            onCreateForTerm={(g: AttentionGroup) =>
              setDialog({
                kind: 'new',
                initial: { name: g.suggestedName, code: g.code, termStart: g.firstDate, termEnd: g.lastDate },
                hint: 'Suggested from calendar — please check. The name and dates come from the sessions in your calendar, not from an official source. If another course already uses this code with the same institution and term label, add a term label that tells them apart.',
              })
            }
          />
        )}
      </div>

      {notice && (
        <p role="status" data-testid="courses-notice" className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-sm">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-white">
            <X size={16} aria-hidden />
          </button>
        </p>
      )}
      {actionError && (
        <p role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-deadline/50 bg-deadline/10 px-3 py-2 text-sm">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss message" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-white">
            <X size={16} aria-hidden />
          </button>
        </p>
      )}

      {unavailable ? (
        <Card>
          <h2 className="flex items-center gap-2 font-medium">
            <TriangleAlert size={16} className="text-work" aria-hidden /> Courses are not available on this server yet
          </h2>
          <p className="mt-1 text-sm text-muted">The Courses tables have not been installed for this account&apos;s database. The rest of ORBIT, including your calendar, works as usual.</p>
          <button type="button" onClick={() => void source.refresh()} className={`${secondaryBtn} mt-3`}>
            <RefreshCw size={14} aria-hidden /> Retry
          </button>
        </Card>
      ) : status === 'loading' ? (
        <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> Loading courses…
        </p>
      ) : status === 'error' ? (
        <Card>
          <h2 className="flex items-center gap-2 font-medium">
            {offline ? <CloudOff size={16} className="text-work" aria-hidden /> : <TriangleAlert size={16} className="text-deadline" aria-hidden />}
            {offline ? 'You are offline' : 'Courses could not be loaded'}
          </h2>
          <p role="alert" className="mt-1 text-sm text-muted">
            {error ?? 'Something went wrong while loading your courses.'}
          </p>
          <button type="button" onClick={() => void source.refresh()} className={`${secondaryBtn} mt-3`}>
            <RefreshCw size={14} aria-hidden /> Retry
          </button>
        </Card>
      ) : (
        <>
          {(offline || error) && (
            <div role="alert" data-testid="courses-banner" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-work/40 bg-work/10 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                {offline ? <CloudOff size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                {error}
              </span>
              <span className="flex gap-2">
                <button type="button" onClick={() => void source.refresh()} className={secondaryBtn}>
                  <RefreshCw size={14} aria-hidden /> Retry
                </button>
                {!offline && (
                  <button type="button" onClick={() => source.dismissError()} className={secondaryBtn}>
                    Dismiss
                  </button>
                )}
              </span>
            </div>
          )}
          {skippedInvalid > 0 && (
            <p role="status" data-testid="courses-skipped" className="flex items-start gap-2 rounded-xl border border-work/40 bg-work/10 px-3 py-2 text-sm">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-work" aria-hidden />
              {skippedInvalid === 1 ? '1 course record' : `${skippedInvalid} course records`} on the server could not be read and {skippedInvalid === 1 ? 'is' : 'are'} not shown. Nothing was changed or deleted.
            </p>
          )}

          {courses.length === 0 ? (
            <Card>
              <h2 className="text-lg font-semibold">No courses yet</h2>
              <p className="mt-1 text-sm text-muted">
                Add the subjects you study this term. Give each one the course code that appears on your timetable, and ORBIT can match timetable sessions to it. Courses are optional; your calendar works without them.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" disabled={!canAdd} onClick={() => setDialog({ kind: 'new' })} className={primaryBtn}>
                  <Plus size={16} aria-hidden /> Add course
                </button>
                <button type="button" disabled={!canAdd} onClick={() => setSuggestOpen(true)} className={secondaryBtn}>
                  <CalendarSearch size={16} aria-hidden /> Suggest from my calendar
                </button>
              </div>
            </Card>
          ) : (
            <>
              <section aria-labelledby="active-courses">
                <h2 id="active-courses" className="mb-3 text-sm font-semibold tracking-wide">
                  Active courses ({active.length})
                </h2>
                {active.length === 0 ? (
                  <p className="text-sm text-muted">No active courses. Restore an archived course below, or add a new one.</p>
                ) : (
                  <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{active.map(card)}</ul>
                )}
              </section>
              {archived.length > 0 && (
                <section aria-labelledby="archived-courses">
                  <h2 id="archived-courses" className="mb-1 text-sm font-semibold tracking-wide text-muted">
                    Archived courses ({archived.length})
                  </h2>
                  <p className="mb-3 text-xs text-muted">Archived courses are kept in full. Timetable sessions with their code can still be matched to them.</p>
                  <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{archived.map(card)}</ul>
                </section>
              )}
            </>
          )}
        </>
      )}

      {dialog && (
        <CourseDialog
          course={dialog.kind === 'edit' ? dialog.course : null}
          initial={dialog.kind === 'new' ? dialog.initial : undefined}
          hint={dialog.kind === 'new' ? dialog.hint : undefined}
          sessions={calendarFreshness === 'current' || calendarFreshness === 'stale' ? sessions : []}
          snapshot={snapshot}
          source={source}
          onClose={closeDialog}
          onLocate={(id) => {
            setDialog(null)
            setHighlightId(id)
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'archive' ? `Archive “${confirm.course.name}”?` : `Delete “${confirm.course.name}” permanently?`}
          confirmLabel={confirm.kind === 'archive' ? 'Archive course' : 'Delete course'}
          pendingLabel={confirm.kind === 'archive' ? 'Archiving…' : 'Deleting…'}
          danger={confirm.kind === 'delete'}
          pending={confirmPending}
          error={confirmError}
          blockedReason={
            confirmChanged || confirmStale
              ? confirmLatest
                ? 'This course changed on another device after you opened this dialog, so the action is disabled. Close this dialog and review the course first.'
                : 'This course no longer exists, so the action is disabled. Close this dialog.'
              : undefined
          }
          onConfirm={() => void runConfirmed(confirm)}
          onCancel={() => setConfirm(null)}
        >
          {confirm.kind === 'archive' ? (
            <>
              <p>Nothing is deleted. The course moves to Archived courses and can be restored at any time.</p>
              <p>Timetable sessions with its code can still be matched to it.</p>
            </>
          ) : (
            <>
              <p>
                This removes the course <strong className="text-white">{confirm.course.name}</strong> from your account. It cannot be undone.
              </p>
              <p>Calendar events are never changed or deleted. Once Tasks and Exams exist, a course that still has any of them cannot be deleted; archive it instead.</p>
            </>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}

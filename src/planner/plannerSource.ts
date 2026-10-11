import type { PlannerApi } from '../cloud/plannerApi'
import { mapCloudError } from '../cloud/errors'
import { courseProblems, coursePatch, courseToWrite, rowMatchesWrite, rowToCourse } from '../cloud/plannerMappers'
import type { CourseRow } from '../cloud/plannerTypes'
import { CloudError } from '../cloud/types'
import type { CloudErrorKind } from '../cloud/types'
import type { Course, CourseInput } from '../types/planner'

export interface PlannerSnapshot {
  /** Owner of the data in this snapshot. */
  userId: string
  status: 'loading' | 'ready' | 'error'
  courses: readonly Course[]
  /** Last failure (load or write), shown until dismissed or the next success. */
  error: string | null
  offline: boolean
  pendingWrites: number
  lastSyncedAt: number | null
  /** Server rows that failed local validation and were not shown. */
  skippedInvalid: number
}

/** `duplicate` = same normalised code, institution and term already exists; `stale` = changed elsewhere (nothing written). */
export type PlannerErrorKind = CloudErrorKind | 'duplicate' | 'stale'

export type PlannerResult<T = void> = { ok: true; value: T } | { ok: false; error: string; kind: PlannerErrorKind }

/**
 * What the Courses UI talks to. All mutations are asynchronous and resolve ONLY after the server confirmed them
 * (no optimistic updates): `ok: false` always means "not saved". One instance belongs to exactly one signed-in user.
 */
export interface PlannerSource {
  readonly userId: string
  getSnapshot(): PlannerSnapshot
  subscribe(listener: () => void): () => void

  /** `id` lets the caller keep one stable id across retries, making a retried create idempotent. */
  createCourse(input: CourseInput, id?: string): Promise<PlannerResult<Course>>
  /** General edit. Never changes the archive state. */
  updateCourse(id: string, input: CourseInput): Promise<PlannerResult<Course>>
  archiveCourse(id: string): Promise<PlannerResult<Course>>
  restoreCourse(id: string): Promise<PlannerResult<Course>>
  deleteCourse(id: string): Promise<PlannerResult>

  /** Re-read from the server. Cheap to call repeatedly (de-duplicated). Never rejects. */
  refresh(): Promise<void>
  dismissError(): void
  /** Sign-out / account switch: drops every private record from memory and ignores late responses. */
  dispose(): void
}

export interface PlannerSourceOptions {
  userId: string
  /** Give up on a request after this long (the outcome is then unknown, so the truth is re-read). */
  timeoutMs?: number
  now?: () => number
  newId?: () => string
  isOnline?: () => boolean
}

const signedOut = { ok: false, error: 'You were signed out.', kind: 'auth' } as const
const staleMessage = 'This course changed on another device (or was removed), so your edit was not saved. ORBIT is refreshing the latest version from the server.'
const stale = (): CloudError => new CloudError('conflict', staleMessage, 'stale')

const byName = (a: Course, b: Course) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)

/** What a successful server round trip hands back: the value for the caller and how it changes the visible list. */
interface Confirmed<T> {
  value: T
  apply: (current: readonly Course[]) => readonly Course[]
}

/**
 * Courses data source for ONE signed-in user (the planner twin of `createCloudSource`). A new instance is
 * created per user and disposed on sign-out/account switch, so one account's data can never be shown to another
 * and late responses from a disposed instance are ignored.
 *
 * Consistency rules
 *  - Pessimistic writes: the visible list changes only from a server-confirmed row, never from a guess, so there
 *    is nothing to roll back and `ok: true` always means saved.
 *  - Writes are serialised (one at a time, in order).
 *  - Every read result is checked: a read that started before a write finished (or while one is pending) is
 *    discarded and repeated, so a stale snapshot can never overwrite newer data.
 *  - Updates, archive/restore and deletes are conditional on the `updated_at` this source last saw: a stale edit
 *    is rejected by the server and nothing is overwritten.
 *  - A request that times out has an unknown outcome: it is reported as not saved, its late answer is never
 *    applied, and the list is re-read so the screen shows what the server really holds.
 */
export function createPlannerSource(api: PlannerApi, options: PlannerSourceOptions): PlannerSource {
  const userId = options.userId
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const timeoutMs = options.timeoutMs ?? 20_000

  let disposed = false
  const listeners = new Set<() => void>()
  let snap: PlannerSnapshot = {
    userId,
    status: 'loading',
    courses: [],
    error: null,
    offline: false,
    pendingWrites: 0,
    lastSyncedAt: null,
    skippedInvalid: 0,
  }

  function set(patch: Partial<PlannerSnapshot>) {
    if (disposed) return
    snap = { ...snap, ...patch }
    listeners.forEach((l) => l())
  }

  // ---- reading -----------------------------------------------------------

  let loadSeq = 0 // identifies the newest read
  let writesDone = 0 // number of confirmed writes so far
  let inFlight: Promise<void> | null = null
  let rerun = false

  function build(rows: CourseRow[]) {
    const courses: Course[] = []
    let skipped = 0
    for (const row of rows) {
      const c = rowToCourse(row)
      if (c && c.userId === userId) courses.push(c) // a row of another owner is never shown
      else skipped++
    }
    return { courses: courses.sort(byName), skipped }
  }

  async function loadOnce(): Promise<void> {
    const seq = ++loadSeq
    const writesAtStart = writesDone
    try {
      const rows = await api.loadCourses()
      if (disposed || seq !== loadSeq) return // a newer read superseded this one
      if (writesDone !== writesAtStart || snap.pendingWrites > 0) {
        rerun = true // stale: a write completed (or is running) after this read started
        return
      }
      const { courses, skipped } = build(rows)
      set({ status: 'ready', courses, skippedInvalid: skipped, error: null, offline: false, lastSyncedAt: now() })
    } catch (err) {
      if (disposed || seq !== loadSeq) return
      const e = mapCloudError(err)
      const offline = e.kind === 'network' || !isOnline()
      set({
        status: snap.lastSyncedAt === null ? 'error' : 'ready', // keep showing the last good data
        error: offline ? 'Offline or unreachable. Showing the last synced data.' : e.message,
        offline,
      })
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (inFlight) {
      rerun = true
      return inFlight
    }
    inFlight = (async () => {
      do {
        rerun = false
        await loadOnce()
      } while (rerun && !disposed && snap.pendingWrites === 0)
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  // ---- writing -----------------------------------------------------------

  let queue: Promise<unknown> = Promise.resolve()

  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new CloudError('network', 'The server did not answer in time. Your change may not have been saved; the list is being re-read.', 'timeout')),
        timeoutMs,
      )
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  function failure(err: unknown): { ok: false; error: string; kind: PlannerErrorKind; e: CloudError } {
    const e = mapCloudError(err)
    const kind: PlannerErrorKind = e.code === 'duplicate_course' ? 'duplicate' : e.code === 'stale' ? 'stale' : e.kind
    return { ok: false, error: e.message, kind, e }
  }

  /**
   * Runs `op` after earlier writes finish. Converts every failure into `{ok:false}`; never throws.
   * `op` only talks to the server; the visible list is changed by `apply`, and only here, after the answer arrived
   * in time and the source is still alive.
   */
  function write<T>(op: () => Promise<Confirmed<T>>): Promise<PlannerResult<T>> {
    if (disposed) return Promise.resolve(signedOut)
    set({ pendingWrites: snap.pendingWrites + 1 })
    const run = queue.then(async (): Promise<PlannerResult<T>> => {
      if (disposed) return signedOut
      try {
        const done = await withTimeout(op())
        if (disposed) return signedOut // signed out while the request was running: touch nothing
        writesDone++
        set({
          courses: [...done.apply(snap.courses)].sort(byName),
          pendingWrites: snap.pendingWrites - 1,
          error: null,
          offline: false,
          lastSyncedAt: now(),
        })
        void refresh() // converge with the server (also picks up other devices' changes)
        return { ok: true, value: done.value }
      } catch (err) {
        const f = failure(err)
        set({ pendingWrites: snap.pendingWrites - 1, error: f.error, offline: f.kind === 'network' })
        // Re-read the server after any failure whose outcome is UNKNOWN or stale, so the screen shows what the server
        // really holds: a network error or timeout can strike after the server committed, an unclassified server error
        // may have, and a stale/id clash means the data changed elsewhere. This is a single read through the one
        // de-duplicated `refresh` (no retry of the write and no loop); if the read fails too (really offline) the last
        // known data stays. Also repeats a read that was discarded while this write was pending.
        const uncertain = f.e.kind === 'network' || f.e.kind === 'unknown' || ['stale', 'id_exists', 'unconfirmed'].includes(f.e.code ?? '')
        if (uncertain || rerun) void refresh()
        return { ok: false, error: f.error, kind: f.kind }
      }
    })
    queue = run
    return run
  }

  const invalid = (problems: string[]): PlannerResult<never> => ({
    ok: false,
    error: `Can’t save: ${problems[0]}`,
    kind: 'validation',
  })

  const find = (id: string) => snap.courses.find((c) => c.id === id)

  /** Replace-or-add one server-confirmed course. */
  function put(row: CourseRow): Confirmed<Course> {
    const course = rowToCourse(row)
    if (!course || course.userId !== userId) throw new CloudError('unknown', 'The server returned a course that could not be read.', 'unconfirmed')
    return { value: course, apply: (cur) => [...cur.filter((c) => c.id !== course.id), course] }
  }

  return {
    userId,
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },

    createCourse(input, id = newId()) {
      const problems = courseProblems(input)
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        const payload = courseToWrite(input, id)
        const row = await api.insertCourse(payload)
        if (row) return put(row)
        // The id already exists. Success only if it is OUR earlier attempt at this very save: read it back and compare.
        const existing = await api.getCourse(id)
        if (!existing) throw new CloudError('unknown', 'The server did not confirm the save.', 'unconfirmed')
        if (!rowMatchesWrite(existing, payload)) {
          throw new CloudError('conflict', 'A different course with this id already exists, so nothing was saved.', 'id_exists')
        }
        return put(existing)
      })
    },

    updateCourse(id, input) {
      const problems = courseProblems(input)
      if (problems.length) return Promise.resolve(invalid(problems))
      return write(async () => {
        const current = find(id)
        if (!current) throw stale()
        const row = await api.updateCourse(id, coursePatch(input), current.updatedAt)
        if (!row) throw stale()
        return put(row)
      })
    },

    archiveCourse(id) {
      return write(async () => {
        const current = find(id)
        if (!current) throw stale()
        // Archiving an already archived course keeps the original archive time.
        const row = await api.archiveCourse(id, current.archivedAt ?? new Date(now()).toISOString(), current.updatedAt)
        if (!row) throw stale()
        return put(row)
      })
    },

    restoreCourse(id) {
      return write(async () => {
        const current = find(id)
        if (!current) throw stale()
        const row = await api.restoreCourse(id, current.updatedAt)
        if (!row) throw stale()
        return put(row)
      })
    },

    deleteCourse(id) {
      return write(async () => {
        const current = find(id)
        if (!current) throw stale()
        if (!(await api.deleteCourse(id, current.updatedAt))) throw stale()
        return { value: undefined, apply: (cur) => cur.filter((c) => c.id !== id) }
      })
    },

    refresh,
    dismissError() {
      set({ error: null })
    },
    dispose() {
      disposed = true
      listeners.clear()
      snap = { ...snap, courses: [], status: 'loading', error: null, skippedInvalid: 0 }
    },
  }
}

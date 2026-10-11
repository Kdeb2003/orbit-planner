import { normaliseKey } from '../planner/normalise'
import { validateCourseInput } from '../planner/courseValidation'
import type { CourseColor } from '../types/planner'
import { isUuid } from './ids'
import type { PlannerApi } from './plannerApi'
import type { CoursePatch, CourseRow } from './plannerTypes'
import { CloudError } from './types'

/**
 * In-memory stand-in for the hosted planner tables, used ONLY by tests (mocked; no network, synthetic data).
 * It models the parts of the real behaviour the app depends on:
 *  - rows are scoped per user (what RLS guarantees): a user's API never sees or touches another user's rows,
 *    while ids are unique across ALL users (primary key), so a foreign id is not "success" for an insert;
 *  - `updated_at` is server-assigned and changes on every update (the optimistic-concurrency token);
 *  - inserts are idempotent per id; invalid UUIDs and rule violations are rejected like PostgreSQL would;
 *  - the unique key (code_key, institution_key, term_key) per user, built with the same rule N as the database;
 *  - failures (offline, rejected writes, slow or lost responses) can be injected.
 */
export class FakePlanner {
  courses = new Map<string, CourseRow[]>() // keyed by owner user id
  calls: { user: string; method: string }[] = []
  offline = false
  /** Reject the next N write calls with this error (before anything is changed). */
  failWrites: { error: CloudError; remaining: number } | null = null
  /** Reject the next N read calls with this error. */
  failReads: { error: CloudError; remaining: number } | null = null
  /**
   * The next N writes are COMMITTED, but the response is lost: 'error' = a network error, 'hang' = never answers.
   * Models "the outcome is unknown" (timeouts, dropped connections).
   */
  loseResponses: { mode: 'error' | 'hang'; remaining: number } | null = null
  private gate: Promise<void> | null = null
  private release: (() => void) | null = null
  private clock = 0

  /** Hold every request until `releaseResponses()`: lets tests interleave requests deterministically. */
  holdResponses() {
    this.gate = new Promise<void>((r) => (this.release = r))
  }
  releaseResponses() {
    this.release?.()
    this.gate = null
  }

  private stamp(): string {
    this.clock++
    return `2026-01-01T00:00:00.${String(this.clock).padStart(6, '0')}+00:00`
  }

  private rows(user: string): CourseRow[] {
    if (!this.courses.has(user)) this.courses.set(user, [])
    return this.courses.get(user)!
  }

  private idTaken(id: string): boolean {
    for (const list of this.courses.values()) if (list.some((r) => r.id === id)) return true
    return false
  }

  /** Test helper: seed a row for a user (as if written from another device). */
  seedCourse(user: string, row: Partial<CourseRow> & Pick<CourseRow, 'id' | 'name'>): CourseRow {
    const full: CourseRow = {
      user_id: user,
      code: null,
      institution: null,
      term_label: null,
      term_start: null,
      term_end: null,
      description: null,
      color: 'c1',
      archived_at: null,
      created_at: this.stamp(),
      updated_at: this.stamp(),
      ...row,
    }
    this.rows(user).push(full)
    return full
  }
  /** Simulates another device editing a course (bumps the version). */
  touchCourse(user: string, id: string, patch: Partial<CourseRow> = {}) {
    const r = this.rows(user).find((x) => x.id === id)
    if (r) Object.assign(r, patch, { updated_at: this.stamp() })
  }

  /** Database-side checks (CHECK constraints). */
  private check(row: CoursePatch) {
    const problems = validateCourseInput({
      name: row.name,
      code: row.code ?? undefined,
      institution: row.institution ?? undefined,
      termLabel: row.term_label ?? undefined,
      termStart: row.term_start ?? undefined,
      termEnd: row.term_end ?? undefined,
      description: row.description ?? undefined,
      color: row.color as CourseColor,
    })
    if (problems.length > 0) throw new CloudError('validation', 'The server rejected this data as invalid.', '23514')
  }

  /** Unique index (user_id, code_key, institution_key, term_key) where code_key is not null. */
  private checkUnique(user: string, row: Pick<CourseRow, 'id' | 'code' | 'institution' | 'term_label'>) {
    if (row.code === null) return
    const key = (r: Pick<CourseRow, 'code' | 'institution' | 'term_label'>) =>
      JSON.stringify([normaliseKey(r.code ?? ''), normaliseKey(r.institution ?? ''), normaliseKey(r.term_label ?? '')])
    const mine = key(row)
    if (this.rows(user).some((r) => r.id !== row.id && r.code !== null && key(r) === mine)) {
      throw new CloudError('conflict', 'A course with this code, institution and term already exists.', 'duplicate_course')
    }
  }

  apiFor(user: string): PlannerApi {
    const enter = async (method: string, write = false) => {
      this.calls.push({ user, method })
      if (this.gate) await this.gate
      if (this.offline) throw new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network')
      const f = write ? this.failWrites : this.failReads
      if (f && f.remaining > 0) {
        f.remaining--
        throw f.error
      }
    }
    /** Called after a write has been committed: may swallow the response. */
    const respond = async <T>(value: T): Promise<T> => {
      const l = this.loseResponses
      if (l && l.remaining > 0) {
        l.remaining--
        if (l.mode === 'hang') return new Promise<T>(() => {})
        throw new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network')
      }
      return value
    }
    const needUuid = (id: string) => {
      if (!isUuid(id)) throw new CloudError('validation', 'The server rejected this data as invalid.', '22P02')
    }
    const mine = () => this.rows(user)
    const find = (id: string, expected: string) => mine().find((x) => x.id === id && x.updated_at === expected)
    const apply = async (method: string, id: string, expected: string, patch: Partial<CourseRow>, checkPatch?: CoursePatch) => {
      await enter(method, true)
      if (checkPatch) this.check(checkPatch) // CHECK constraints are evaluated by the database even for a stale request
      const r = find(id, expected)
      if (!r) return null
      const next = { ...r, ...patch }
      this.checkUnique(user, next)
      Object.assign(r, patch, { updated_at: this.stamp() })
      return respond(structuredClone(r))
    }

    return {
      loadCourses: async () => {
        await enter('loadCourses')
        return structuredClone(mine())
      },
      getCourse: async (id) => {
        await enter('getCourse')
        needUuid(id)
        return structuredClone(mine().find((r) => r.id === id) ?? null)
      },

      insertCourse: async (row) => {
        await enter('insertCourse', true)
        needUuid(row.id)
        if (this.idTaken(row.id)) return null // ON CONFLICT (id) DO NOTHING (also for ids owned by someone else)
        this.check(row)
        this.checkUnique(user, row)
        const full: CourseRow = { ...row, user_id: user, archived_at: null, created_at: this.stamp(), updated_at: this.stamp() }
        mine().push(full)
        return respond(structuredClone(full))
      },
      updateCourse: (id, patch, expected) => apply('updateCourse', id, expected, patch, patch),
      archiveCourse: (id, archivedAt, expected) => apply('archiveCourse', id, expected, { archived_at: archivedAt }),
      restoreCourse: (id, expected) => apply('restoreCourse', id, expected, { archived_at: null }),
      deleteCourse: async (id, expected) => {
        await enter('deleteCourse', true)
        const i = mine().findIndex((x) => x.id === id && x.updated_at === expected)
        if (i < 0) return false
        mine().splice(i, 1)
        return respond(true)
      },
    }
  }
}

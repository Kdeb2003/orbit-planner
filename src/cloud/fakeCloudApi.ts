import type { CloudApi } from './cloudApi'
import { isUuid } from './ids'
import { CloudError } from './types'
import type { EventRow, ExceptionRow, SeriesRow } from './types'

/**
 * In-memory stand-in for the hosted database, used ONLY by tests (mocked; no network).
 * It models the parts of the real behaviour the app depends on:
 *  - rows are scoped per user (what RLS guarantees): a user's API never sees or touches another user's rows;
 *  - `updated_at` is server-assigned and changes on every update (the optimistic-concurrency token);
 *  - inserts are idempotent per id; invalid UUIDs are rejected like PostgreSQL would;
 *  - failures (offline, rejected writes, slow responses) can be injected.
 */
export class FakeCloud {
  events = new Map<string, EventRow[]>()
  series = new Map<string, SeriesRow[]>()
  exceptions = new Map<string, ExceptionRow[]>() // keyed by owner user id
  calls: { user: string; method: string }[] = []
  offline = false
  /** Reject the next N write calls with this error. */
  failWrites: { error: CloudError; remaining: number } | null = null
  private gate: Promise<void> | null = null
  private release: (() => void) | null = null
  private clock = 0

  /** Hold every response until `releaseResponses()`: lets tests interleave requests deterministically. */
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

  private rows<T>(map: Map<string, T[]>, user: string): T[] {
    if (!map.has(user)) map.set(user, [])
    return map.get(user)!
  }

  /** Test helper: seed rows directly for a user (as if written from another device). */
  seedEvent(user: string, row: Omit<EventRow, 'created_at' | 'updated_at' | 'user_id'>): EventRow {
    const full: EventRow = { ...row, user_id: user, created_at: this.stamp(), updated_at: this.stamp() }
    this.rows(this.events, user).push(full)
    return full
  }
  seedSeries(user: string, row: Omit<SeriesRow, 'created_at' | 'updated_at' | 'user_id'>): SeriesRow {
    const full: SeriesRow = { ...row, user_id: user, created_at: this.stamp(), updated_at: this.stamp() }
    this.rows(this.series, user).push(full)
    return full
  }
  /** Simulates another device editing an event (bumps the version). */
  touchEvent(user: string, id: string, patch: Partial<EventRow>) {
    const r = this.rows(this.events, user).find((x) => x.id === id)
    if (r) Object.assign(r, patch, { updated_at: this.stamp() })
  }

  apiFor(user: string): CloudApi {
    const enter = async (method: string, write = false) => {
      this.calls.push({ user, method })
      if (this.gate) await this.gate
      if (this.offline) throw new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network')
      if (write && this.failWrites && this.failWrites.remaining > 0) {
        this.failWrites.remaining--
        throw this.failWrites.error
      }
    }
    const needUuid = (...ids: string[]) => {
      for (const id of ids) if (!isUuid(id)) throw new CloudError('validation', 'The server rejected this data as invalid.', '22P02')
    }
    const myEvents = () => this.rows(this.events, user)
    const mySeries = () => this.rows(this.series, user)
    const myExceptions = () => this.rows(this.exceptions, user)

    return {
      loadEvents: async () => {
        await enter('loadEvents')
        return structuredClone(myEvents())
      },
      loadSeries: async () => {
        await enter('loadSeries')
        return structuredClone(mySeries())
      },
      loadExceptions: async () => {
        await enter('loadExceptions')
        return structuredClone(myExceptions())
      },

      insertEvent: async (row) => {
        await enter('insertEvent', true)
        needUuid(row.id)
        if (myEvents().some((r) => r.id === row.id)) return null
        const full: EventRow = { ...row, user_id: user, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() }
        myEvents().push(full)
        return structuredClone(full)
      },
      updateEvent: async (id, patch, expected) => {
        await enter('updateEvent', true)
        const r = myEvents().find((x) => x.id === id && x.updated_at === expected)
        if (!r) return null
        Object.assign(r, patch, { updated_at: this.stamp() })
        return structuredClone(r)
      },
      deleteEvent: async (id, expected) => {
        await enter('deleteEvent', true)
        const i = myEvents().findIndex((x) => x.id === id && x.updated_at === expected)
        if (i < 0) return false
        myEvents().splice(i, 1)
        return true
      },

      insertSeries: async (row) => {
        await enter('insertSeries', true)
        needUuid(row.id)
        if (mySeries().some((r) => r.id === row.id)) return null
        const full: SeriesRow = { ...row, user_id: user, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() }
        mySeries().push(full)
        return structuredClone(full)
      },
      updateSeries: async (id, patch, expected) => {
        await enter('updateSeries', true)
        const r = mySeries().find((x) => x.id === id && x.updated_at === expected)
        if (!r) return null
        Object.assign(r, patch, { updated_at: this.stamp() })
        return structuredClone(r)
      },
      deleteSeries: async (id, expected) => {
        await enter('deleteSeries', true)
        const i = mySeries().findIndex((x) => x.id === id && x.updated_at === expected)
        if (i < 0) return false
        mySeries().splice(i, 1)
        this.exceptions.set(user, myExceptions().filter((x) => x.series_id !== id)) // ON DELETE CASCADE
        return true
      },

      upsertException: async (row) => {
        await enter('upsertException', true)
        needUuid(row.series_id)
        if (!mySeries().some((s) => s.id === row.series_id)) {
          // RLS: a series you do not own is indistinguishable from one that does not exist
          throw new CloudError('permission', 'Not allowed. You may be signed out; please sign in again.', '42501')
        }
        const list = myExceptions()
        const existing = list.find((x) => x.series_id === row.series_id && x.original_date === row.original_date)
        if (existing) {
          Object.assign(existing, { cancelled: row.cancelled, override: row.override, updated_at: this.stamp() })
          return structuredClone(existing)
        }
        const full: ExceptionRow = { ...row, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() }
        list.push(full)
        return structuredClone(full)
      },
      deleteException: async (seriesId, originalDate) => {
        await enter('deleteException', true)
        this.exceptions.set(user, myExceptions().filter((x) => !(x.series_id === seriesId && x.original_date === originalDate)))
      },

      insertEventsIgnoreDuplicates: async (rows) => {
        await enter('insertEvents', true)
        rows.forEach((r) => needUuid(r.id))
        let n = 0
        for (const row of rows) {
          if (myEvents().some((r) => r.id === row.id)) continue
          myEvents().push({ ...row, user_id: user, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() })
          n++
        }
        return n
      },
      insertSeriesIgnoreDuplicates: async (rows) => {
        await enter('insertSeries', true)
        rows.forEach((r) => needUuid(r.id))
        let n = 0
        for (const row of rows) {
          if (mySeries().some((r) => r.id === row.id)) continue
          mySeries().push({ ...row, user_id: user, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() })
          n++
        }
        return n
      },
      insertExceptionsIgnoreDuplicates: async (rows) => {
        await enter('insertExceptions', true)
        let n = 0
        for (const row of rows) {
          if (!mySeries().some((s) => s.id === row.series_id)) throw new CloudError('permission', 'Not allowed.', '42501')
          if (myExceptions().some((x) => x.series_id === row.series_id && x.original_date === row.original_date)) continue
          myExceptions().push({ ...row, created_at: row.created_at ?? this.stamp(), updated_at: this.stamp() })
          n++
        }
        return n
      },
    }
  }
}

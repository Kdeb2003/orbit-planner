import type { SupabaseClient } from '@supabase/supabase-js'
import type { BatchInsert, EventSnapshot, RpcItem, SourceSnapshot } from '../timetable/provenance/importItems.ts'

/**
 * The ONLY code that talks to the provenance tables (`event_imports`, `event_import_links`) and to the RPC
 * `orbit_import_sessions`. It uses the signed-in user's session and the publishable key; row level security, the
 * column privileges and the integrity triggers of the SQL design decide what is allowed. Nothing here uses a
 * service-role key, and nothing writes events or links directly: sessions are written ONLY through the RPC.
 *
 * Design: docs/proposals/timetable-import-provenance.md. SQL: supabase/migrations/20261015120000_event_imports.sql.
 */

export type BatchStatus = 'in_progress' | 'failed' | 'abandoned' | 'written' | 'written_partial' | 'verified'

export interface BatchRow {
  id: string
  source_slug: string
  source_sha256: string
  planned_count: number
  status: BatchStatus
  created_at: string
  updated_at: string
  written_at: string | null
  verified_at: string | null
}

export interface LinkRow {
  id: string
  batch_id: string
  source_key: string
  /** NULL = the user deleted the event (tombstone). */
  event_id: string | null
  imported_snapshot: EventSnapshot
  source_snapshot: SourceSnapshot
  retired_at: string | null
}

export interface RpcOutcome {
  source_key: string
  event_id: string | null
  outcome: 'created' | 'already-linked' | 'event-id-taken'
}

export type ImportErrorKind = 'network' | 'auth' | 'unavailable' | 'state' | 'validation' | 'unknown'

/** A failure of the import backend with a message that is safe to show (no URLs, tokens or SQL details). */
export class ImportError extends Error {
  kind: ImportErrorKind
  code?: string
  constructor(kind: ImportErrorKind, message: string, code?: string) {
    super(message)
    this.name = 'ImportError'
    this.kind = kind
    this.code = code
  }
}

interface PostgrestLike {
  code?: string
  message?: string
}

export function mapImportError(error: unknown, status = 0): ImportError {
  if (error instanceof ImportError) return error
  const e = (error ?? {}) as PostgrestLike
  const code = e.code ?? ''
  const msg = e.message ?? ''
  if (status === 0 && !code) return new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network')
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(msg)) return new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network')
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883' || /Could not find the (function|table)/i.test(msg)) {
    return new ImportError('unavailable', 'Saving a timetable is not available on this server yet (the import feature is not installed).', code)
  }
  if (code === 'PGRST301' || code === 'PGRST303' || /jwt/i.test(msg) || code === '28000') return new ImportError('auth', 'Your session has expired. Please sign in again.', code || 'jwt')
  if (code === '42501' || status === 401 || status === 403) return new ImportError('auth', 'Not allowed. You may be signed out; please sign in again.', code || String(status))
  if (code === '55000' || code === 'P0002') return new ImportError('state', 'The import changed on the server (another device or tab may be importing). Retry in a moment.', code)
  if (/^2[23]/.test(code) || status === 400) return new ImportError('validation', 'The server rejected part of the data.', code || '400')
  return new ImportError('unknown', 'Something went wrong while talking to the server.', code || String(status))
}

export interface ImportApi {
  /** Is the provenance feature installed? Never writes. */
  probe(): Promise<{ available: true } | { available: false; reason: string }>
  loadLinks(slug: string): Promise<LinkRow[]>
  loadBatches(slug: string): Promise<BatchRow[]>
  createBatch(row: BatchInsert & { id: string }): Promise<void>
  /** 1..100 items; atomic per call, idempotent, insert-only. */
  importSessions(batch: string, items: RpcItem[]): Promise<RpcOutcome[]>
  /** The database re-checks the claim (links counted, events compared) and rejects a false one. */
  setStatus(batch: string, status: BatchStatus): Promise<BatchRow>
}

const PAGE = 1000

export function createSupabaseImportApi(client: SupabaseClient): ImportApi {
  async function unwrap<T>(p: PromiseLike<{ data: T | null; error: unknown; status: number }>): Promise<T> {
    let res
    try {
      res = await p
    } catch (err) {
      throw mapImportError(err, 0)
    }
    if (res.error) throw mapImportError(res.error, res.status)
    return res.data as T
  }

  async function loadAll<T>(table: string, slug: string): Promise<T[]> {
    const out: T[] = []
    for (let from = 0; ; from += PAGE) {
      const rows = await unwrap<T[]>(client.from(table).select('*').eq('source_slug', slug).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  return {
    async probe() {
      try {
        await unwrap(client.from('event_imports').select('id').limit(1))
        await unwrap(client.from('event_import_links').select('id').limit(1))
        // An empty list is rejected (22023) before anything is read or written: it proves the function exists.
        const res = await client.rpc('orbit_import_sessions', { p_batch: crypto.randomUUID(), p_items: [] })
        if (res.error) {
          const err = mapImportError(res.error, res.status)
          if (err.kind === 'unavailable') throw err
        }
        return { available: true as const }
      } catch (err) {
        const e = mapImportError(err)
        return { available: false as const, reason: e.message }
      }
    },
    loadLinks: (slug) => loadAll<LinkRow>('event_import_links', slug),
    loadBatches: (slug) => loadAll<BatchRow>('event_imports', slug),
    async createBatch(row) {
      await unwrap(client.from('event_imports').insert(row))
    },
    async importSessions(batch, items) {
      return unwrap<RpcOutcome[]>(client.rpc('orbit_import_sessions', { p_batch: batch, p_items: items }))
    },
    async setStatus(batch, status) {
      const rows = await unwrap<BatchRow[]>(client.from('event_imports').update({ status }).eq('id', batch).select())
      if (!rows[0]) throw new ImportError('state', 'The import batch could not be found. Retry.', 'not-found')
      return rows[0]
    },
  }
}

import { ImportError } from '../../cloud/importApi.ts'
import type { BatchRow, BatchStatus, ImportApi, LinkRow, RpcOutcome } from '../../cloud/importApi.ts'
import type { FakeCloud } from '../../cloud/fakeCloudApi.ts'
import type { RpcItem } from '../provenance/importItems.ts'
import { snapshotOfRow } from '../provenance/importItems.ts'

/**
 * In-memory stand-in for the provenance backend, used ONLY by unit/UI tests (a MOCK: the real SQL is exercised by
 * supabase/tests/save-import.test.ts in PGlite). It models the contract the save service depends on: insert-only
 * idempotent RPC, event-id collisions never adopted, `written` needs exactly planned_count links, `verified` needs
 * unchanged events, and failure injection.
 */
export class FakeImportApi implements ImportApi {
  batches: BatchRow[] = []
  links: LinkRow[] = []
  calls: string[] = []
  available = true
  offline = false
  /** Fail the RPC call number N (1-based) with a network error. */
  failChunk: number | null = null
  failStatus: BatchStatus | null = null
  private chunkNo = 0
  private clock = 0

  private readonly cloud: FakeCloud
  private readonly user: string

  constructor(cloud: FakeCloud, user: string) {
    this.cloud = cloud
    this.user = user
  }

  private enter(name: string) {
    this.calls.push(name)
    if (this.offline) throw new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network')
    if (!this.available) throw new ImportError('unavailable', 'Saving a timetable is not available on this server yet (the import feature is not installed).', 'PGRST202')
  }
  private stamp = () => new Date(Date.now() + this.clock++).toISOString() // real clock: "started a moment ago" must mean something

  async probe() {
    this.calls.push('probe')
    if (this.offline) return { available: false as const, reason: 'Can’t reach the server.' }
    return this.available ? { available: true as const } : { available: false as const, reason: 'Saving a timetable is not available on this server yet (the import feature is not installed).' }
  }
  async loadLinks(slug: string) {
    this.enter('loadLinks')
    return this.links.filter((l) => l.source_key.startsWith(`${slug}|`)).map((l) => structuredClone(l))
  }
  async loadBatches(slug: string) {
    this.enter('loadBatches')
    return this.batches.filter((b) => b.source_slug === slug).map((b) => ({ ...b }))
  }
  async createBatch(row: { id: string; source_slug: string; source_sha256: string; planned_count: number }) {
    this.enter('createBatch')
    this.batches.push({ id: row.id, source_slug: row.source_slug, source_sha256: row.source_sha256, planned_count: row.planned_count, status: 'in_progress', created_at: this.stamp(), updated_at: this.stamp(), written_at: null, verified_at: null })
  }
  async importSessions(batchId: string, items: RpcItem[]): Promise<RpcOutcome[]> {
    this.enter('importSessions')
    if (items.length < 1 || items.length > 100) throw new ImportError('validation', 'The server rejected part of the data.', '22023')
    if (this.failChunk !== null && ++this.chunkNo === this.failChunk) throw new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network')
    const b = this.batches.find((x) => x.id === batchId)
    if (!b) throw new ImportError('state', 'unknown batch', 'P0002')
    if (b.status !== 'in_progress') throw new ImportError('state', 'The import changed on the server.', '55000')
    const existing = await this.cloud.apiFor(this.user).loadEvents()
    const out: RpcOutcome[] = []
    for (const it of items) {
      const link = this.links.find((l) => l.source_key === it.source_key)
      if (link) {
        out.push({ source_key: it.source_key, event_id: link.event_id, outcome: 'already-linked' })
        continue
      }
      if (existing.some((e) => e.id === it.event_id)) {
        out.push({ source_key: it.source_key, event_id: it.event_id, outcome: 'event-id-taken' })
        continue
      }
      const row = this.cloud.seedEvent(this.user, { id: it.event_id, ...it.event })
      existing.push(row)
      this.links.push({ id: `l-${this.links.length}`, batch_id: batchId, source_key: it.source_key, event_id: it.event_id, imported_snapshot: snapshotOfRow(row), source_snapshot: structuredClone(it.source), retired_at: null })
      out.push({ source_key: it.source_key, event_id: it.event_id, outcome: 'created' })
    }
    return out
  }
  async setStatus(batchId: string, status: BatchStatus): Promise<BatchRow> {
    this.enter('setStatus')
    if (this.failStatus === status) throw new ImportError('network', 'Can’t reach the server. Nothing more was saved; you can retry.', 'network')
    const b = this.batches.find((x) => x.id === batchId)
    if (!b) throw new ImportError('state', 'not found', 'not-found')
    const n = this.links.filter((l) => l.batch_id === b.id).length
    const legal =
      (b.status === 'in_progress' && ['failed', 'abandoned', 'written', 'written_partial'].includes(status)) ||
      (b.status === 'failed' && ['in_progress', 'abandoned', 'written', 'written_partial'].includes(status)) ||
      (b.status === 'written' && status === 'verified')
    if (!legal) throw new ImportError('state', 'illegal status change', '55000')
    if (status === 'written' && n !== b.planned_count) throw new ImportError('state', 'incomplete', '55000')
    if (status === 'written_partial' && n >= b.planned_count) throw new ImportError('state', 'complete', '55000')
    if (status === 'verified') {
      const events = await this.cloud.apiFor(this.user).loadEvents()
      const intact = this.links.filter((l) => l.batch_id === b.id).filter((l) => {
        const e = events.find((x) => x.id === l.event_id)
        return !!e && JSON.stringify(snapshotOfRow(e)) === JSON.stringify(l.imported_snapshot)
      }).length
      if (n !== b.planned_count || intact !== n) throw new ImportError('state', 'verification failed', '55000')
      b.verified_at = this.stamp()
    }
    if (['written', 'written_partial'].includes(status)) b.written_at = this.stamp()
    b.status = status
    b.updated_at = this.stamp()
    return { ...b }
  }
}

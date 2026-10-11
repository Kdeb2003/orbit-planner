// Pure(ish) logic of scripts/hosted-two-user-rls-check.mjs, split out so it can be unit-tested with fake clients
// (tests/utn/hosted-script-guards.test.ts). Nothing here reads the environment, prints, or creates a client.

/** What went wrong, safe to print: a PostgREST code or a short message. Never a request, a URL or a credential. */
export const safeError = (e) => String(e?.code || e?.message || 'error').slice(0, 80)

/** A missing RPC: PostgREST answers 404 / PGRST202 (not found in the schema cache). */
export const rpcMissing = (res) => !!res?.error && (res.status === 404 || res.error.code === 'PGRST202' || /Could not find the function/i.test(res.error.message ?? ''))

/**
 * Decides what to do about the provenance checks.
 *   - tables and both RPCs present            -> run them
 *   - nothing present, mode not required      -> SKIP (the pre-migration run; the summary says so loudly)
 *   - nothing present, --require-provenance   -> FAIL (a post-migration run must never pass by skipping)
 *   - tables XOR rpcs present                 -> FAIL in every mode (an inconsistent deployment)
 */
export function provenanceDecision({ tables, rpcs, require }) {
  if (tables && rpcs) return { action: 'run' }
  if (!tables && !rpcs) {
    return require
      ? { action: 'fail', reason: '--require-provenance: the provenance tables and RPCs are missing (migration not applied?)' }
      : { action: 'skip', reason: 'provenance tables and RPCs do not exist yet (migration not applied)' }
  }
  return { action: 'fail', reason: `inconsistent deployment: tables ${tables ? 'present' : 'MISSING'}, RPCs ${rpcs ? 'present' : 'MISSING'}` }
}

/** Process exit code: any failed check, a crash, an incomplete cleanup, or (in require mode) any skipped check fails the run. */
export function exitCode({ results, crashed, require }) {
  const failed = results.some((r) => r.ok === false)
  const skipped = results.some((r) => r.ok === null)
  return failed || crashed || (require && skipped) ? 1 : 0
}

/**
 * Removes what ONE account's run created and VERIFIES that nothing is left. Never throws.
 *   tracked   { events: string[], series: string[] }  ids this run created (or might have created by mistake)
 *   titleLike the run marker as an ESCAPED LIKE pattern
 *   slug      the run's own source slug
 *   provenance whether the provenance tables/RPCs exist
 * Every failing step is recorded (code only) and makes `ok` false:
 *   a delete or sweep that errors, a verification read that errors, any run-created row that remains, an exception.
 */
export async function cleanupUser({ c, tracked, titleLike, slug, provenance }) {
  const problems = []
  const step = async (what, fn) => {
    try {
      const r = await fn()
      if (r?.error) problems.push(`${what}: ${safeError(r.error)}`)
      return r
    } catch (e) {
      problems.push(`${what}: threw (${e?.name ?? "Error"})`) // the exception text is never reported: it could carry request details
      return null
    }
  }
  const countOf = async (what, fn) => {
    const r = await step(what, fn)
    if (!r || r.error || !Array.isArray(r.data)) {
      if (r && !r.error) problems.push(`${what}: no result`)
      return 0
    }
    return r.data.length
  }

  // 1. provenance first, through the one supported operation, scoped to this run's slug
  if (provenance) await step('forget import history', () => c.rpc('orbit_forget_import_history', { p_slug: slug }))
  // 2. exactly the rows this run tracked
  for (const id of tracked.series) await step(`delete series ${id}`, () => c.from('recurring_series').delete().eq('id', id))
  for (const id of tracked.events) await step(`delete event ${id}`, () => c.from('events').delete().eq('id', id))
  // 3. anything else carrying THIS run's marker (a row a failing check created by mistake), within the account's own RLS space
  await step('sweep events by marker', () => c.from('events').delete().like('title', titleLike))
  await step('sweep series by marker', () => c.from('recurring_series').delete().like('title', titleLike))

  // 4. verify: nothing created by this run may remain
  let remaining = 0
  remaining += await countOf('verify events by marker', () => c.from('events').select('id').like('title', titleLike))
  remaining += await countOf('verify series by marker', () => c.from('recurring_series').select('id').like('title', titleLike))
  if (tracked.events.length) remaining += await countOf('verify tracked events', () => c.from('events').select('id').in('id', tracked.events))
  if (tracked.series.length) remaining += await countOf('verify tracked series', () => c.from('recurring_series').select('id').in('id', tracked.series))
  if (provenance) {
    remaining += await countOf('verify import batches', () => c.from('event_imports').select('id').eq('source_slug', slug))
    remaining += await countOf('verify import links', () => c.from('event_import_links').select('id').eq('source_slug', slug))
  }
  if (remaining > 0) problems.push(`${remaining} run-created record(s) remain`)
  return { ok: problems.length === 0, remaining, problems }
}

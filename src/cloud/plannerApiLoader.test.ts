import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { lazyPlannerApiFactory } from './plannerApiLoader'

const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

function spyClient(rows: unknown[] = []) {
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'range']) builder[m] = () => builder
  builder.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null, status: 200 }).then(ok)
  const from = vi.fn(() => builder)
  return { client: { from } as unknown as SupabaseClient, from }
}

describe('lazyPlannerApiFactory (feature flag)', () => {
  it('is undefined when the flag is off, and the client is never touched', () => {
    const { client, from } = spyClient()
    expect(lazyPlannerApiFactory({ enabled: false, client })).toBeUndefined()
    expect(from).not.toHaveBeenCalled()
  })

  it('is undefined without a Supabase client (local-only mode), even when the flag is on', () => {
    expect(lazyPlannerApiFactory({ enabled: true, client: null })).toBeUndefined()
  })

  it('loads the API on demand, shares it between users and calls, and building it sends no request', async () => {
    const { client, from } = spyClient()
    const factory = lazyPlannerApiFactory({ enabled: true, client })!
    const first = factory(USER)
    expect(first).toBeInstanceOf(Promise)
    const api = await first
    expect(from).not.toHaveBeenCalled()
    expect(await factory('bbbbbbbb-0000-4000-8000-000000000002')).toBe(api)
    await api.loadCourses()
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('courses')
  })
})

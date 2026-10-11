// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthController } from '../auth/authController'
import { AuthProvider } from '../auth/AuthProvider'
import { createFakeAuthClient, fakeSession } from '../auth/fakeAuthClient'
import { FakeCloud } from '../cloud/fakeCloudApi'
import { FakePlanner } from '../cloud/fakePlannerApi'
import { lazyPlannerApiFactory } from '../cloud/plannerApiLoader'
import { eventToWrite } from '../cloud/mappers'
import { CloudError } from '../cloud/types'
import { usePlanner } from '../planner/PlannerContext'
import type { CourseInput } from '../types/planner'
import { startAutoRefresh } from './autoRefresh'
import { createCalendarManager } from './calendarManager'
import type { CalendarManager } from './calendarManager'
import { CalendarProvider } from './CalendarProvider'
import type { CalendarSource } from './types'

const A = fakeSession.user.id
const B = '00000000-0000-4000-8000-0000000000bb'
const sessionB = { ...fakeSession, user: { id: B, email: 'bob@example.test' } }
const C1 = 'c0c0c0c0-0000-4000-8000-000000000001'
const C2 = 'c0c0c0c0-0000-4000-8000-000000000002'
const E1 = '11111111-1111-4111-8111-111111111111'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick()
}
const algebra: CourseInput = { name: 'Linear Algebra', code: 'MATH 101', color: 'c1' }
const eventRow = () => eventToWrite({ title: 'Lecture', category: 'university', start: '2026-10-12T07:00:00.000Z', end: '2026-10-12T08:30:00.000Z', timeZone: 'Europe/Berlin' }, E1)

// The manager loads the planner code with a dynamic import; load it once up front so the first test is not at the mercy of a slow transform.
beforeAll(async () => {
  await import('../planner/plannerSource')
})

/** Waits until the session's planner source has been attached (its code loads on demand). */
const attached = (m: CalendarManager) => vi.waitFor(() => expect(m.getSnapshot()?.planner).not.toBeNull(), { timeout: 5_000 })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('session manager with the planner', () => {
  function make(cloud: FakeCloud, planner: FakePlanner | null, autoRefresh = vi.fn((target: Pick<CalendarSource, 'refresh'>) => (void target, () => {}))) {
    const manager = createCalendarManager({
      createApi: (id) => cloud.apiFor(id),
      createPlannerApi: planner ? (id) => planner.apiFor(id) : undefined,
      autoRefresh,
    })
    return { manager, autoRefresh }
  }

  it('without a planner API (feature off) there is no planner session, and auto-refresh gets the calendar source itself', async () => {
    const { manager, autoRefresh } = make(new FakeCloud(), null)
    manager.setUser(A)
    const session = manager.getSnapshot()!
    expect(session.planner).toBeNull()
    expect(autoRefresh).toHaveBeenCalledTimes(1)
    expect(autoRefresh.mock.calls[0][0]).toBe(session.source)
    manager.setUser(null)
  })

  it('with the feature off NO request to the courses table is ever built (real factory, spy client)', async () => {
    const spy = { from: vi.fn(), rpc: vi.fn() }
    const manager = createCalendarManager({
      createApi: (id) => new FakeCloud().apiFor(id),
      createPlannerApi: lazyPlannerApiFactory({ enabled: false, client: spy as unknown as SupabaseClient }),
      autoRefresh: () => () => {},
    })
    manager.setUser(A)
    await manager.getSnapshot()!.source.refresh()
    manager.setUser(B)
    manager.setUser(null)
    expect(spy.from).not.toHaveBeenCalled()
    expect(spy.rpc).not.toHaveBeenCalled()
  })

  it('creates one planner source per user, loads it, and disposes it on sign-out', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: C1, name: 'Private course' })
    const { manager } = make(new FakeCloud(), planner)
    manager.setUser(A)
    expect(manager.getSnapshot()!.planner).toBeNull() // its code is loaded on demand, so it arrives a moment later
    await attached(manager)
    await settle()
    const s = manager.getSnapshot()!
    expect(s.planner).not.toBeNull()
    expect(s.planner!.userId).toBe(A)
    expect(s.planner!.getSnapshot().courses.map((c) => c.name)).toEqual(['Private course'])
    manager.setUser(null)
    expect(manager.getSnapshot()).toBeNull()
    expect(s.planner!.getSnapshot().courses).toEqual([])
    expect(JSON.stringify(s.planner!.getSnapshot())).not.toContain('Private course')
  })

  it('does not rebuild the session for the same user, and does not touch the planner twice', async () => {
    const planner = new FakePlanner()
    const { manager } = make(new FakeCloud(), planner)
    manager.setUser(A)
    await attached(manager)
    await settle()
    const first = manager.getSnapshot()
    manager.setUser(A)
    expect(manager.getSnapshot()).toBe(first)
    expect(planner.calls.filter((c) => c.method === 'loadCourses')).toHaveLength(1)
    manager.setUser(null)
  })

  it('account switch: A\'s in-flight planner read is discarded and never reaches B', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: C1, name: 'Alice private' })
    planner.seedCourse(B, { id: C2, name: 'Bob private' })
    const { manager } = make(new FakeCloud(), planner)
    planner.holdResponses() // A's read is on the wire
    manager.setUser(A)
    await attached(manager)
    const aSource = manager.getSnapshot()!.planner!
    manager.setUser(B) // sign-out of A and sign-in of B
    await attached(manager)
    const bSource = manager.getSnapshot()!.planner!
    expect(bSource).not.toBe(aSource)
    planner.releaseResponses() // A's late response arrives
    await settle()
    expect(aSource.getSnapshot().courses).toEqual([])
    expect(bSource.getSnapshot().userId).toBe(B)
    expect(bSource.getSnapshot().courses.map((c) => c.name)).toEqual(['Bob private'])
    expect(JSON.stringify(bSource.getSnapshot())).not.toContain('Alice private')
    manager.setUser(null)
  })

  it('account switch: a write started by A that resolves later returns "signed out" and changes nothing for B', async () => {
    const planner = new FakePlanner()
    const { manager } = make(new FakeCloud(), planner)
    manager.setUser(A)
    await attached(manager)
    const aSource = manager.getSnapshot()!.planner!
    planner.holdResponses()
    const pending = aSource.createCourse(algebra, C1)
    await settle()
    manager.setUser(B)
    await attached(manager)
    const bSource = manager.getSnapshot()!.planner!
    planner.releaseResponses()
    expect(await pending).toMatchObject({ ok: false, kind: 'auth' })
    await settle()
    expect(bSource.getSnapshot().courses).toEqual([])
    expect(aSource.getSnapshot().courses).toEqual([])
    manager.setUser(null)
  })

  it('a failing planner does not stop the calendar from loading', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(A, { ...eventRow(), user_id: undefined } as never)
    const planner = new FakePlanner()
    planner.offline = true
    const { manager } = make(cloud, planner)
    manager.setUser(A)
    await attached(manager)
    await settle()
    const s = manager.getSnapshot()!
    expect(s.source.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(s.source.getSnapshot().events).toHaveLength(1)
    expect(s.planner!.getSnapshot()).toMatchObject({ status: 'error', offline: true })
    manager.setUser(null)
  })

  it('a missing courses table (migration not applied) is a contained planner error', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(A, { ...eventRow(), user_id: undefined } as never)
    const planner = new FakePlanner()
    planner.failReads = { error: new CloudError('unknown', 'Courses are not available on this server yet.', 'planner_unavailable'), remaining: 99 }
    const { manager } = make(cloud, planner)
    manager.setUser(A)
    await attached(manager)
    await settle()
    const s = manager.getSnapshot()!
    expect(s.source.getSnapshot().events).toHaveLength(1)
    expect(s.planner!.getSnapshot()).toMatchObject({ status: 'error', error: 'Courses are not available on this server yet.' })
    manager.setUser(null)
  })
  it('sign-out while the planner code is still loading: nothing is ever attached or requested', async () => {
    const planner = new FakePlanner()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const manager = createCalendarManager({
      createApi: (id) => new FakeCloud().apiFor(id),
      createPlannerApi: async (id) => {
        await gate
        return planner.apiFor(id)
      },
      autoRefresh: () => () => {},
    })
    manager.setUser(A)
    manager.setUser(null)
    release()
    await settle()
    expect(manager.getSnapshot()).toBeNull()
    expect(planner.calls).toEqual([])
  })

  it('account switch while the previous planner code is still loading: it is never attached to the next session', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: C1, name: 'Alice private' })
    planner.seedCourse(B, { id: C2, name: 'Bob private' })
    const releases = new Map<string, () => void>()
    const manager = createCalendarManager({
      createApi: (id) => new FakeCloud().apiFor(id),
      createPlannerApi: (id) => new Promise((res) => releases.set(id, () => res(planner.apiFor(id)))),
      autoRefresh: () => () => {},
    })
    manager.setUser(A)
    manager.setUser(B)
    await settle()
    releases.get(B)!() // B's load finishes first ...
    await settle()
    releases.get(A)!() // ... then A's late one
    await settle()
    const s = manager.getSnapshot()!
    expect(s.userId).toBe(B)
    expect(s.planner!.userId).toBe(B)
    expect(s.planner!.getSnapshot().courses.map((c) => c.name)).toEqual(['Bob private'])
    expect(planner.calls.some((c) => c.user === A)).toBe(false) // A's API was never used
    manager.setUser(null)
  })

  it('has exactly one refresh scheduler with a planner, and a failed planner load is retried on the next refresh trigger', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: C1, name: 'Mine' })
    let attempts = 0
    const autoRefresh = vi.fn((target: Pick<CalendarSource, 'refresh'>) => (void target, () => {}))
    const manager = createCalendarManager({
      createApi: (id) => new FakeCloud().apiFor(id),
      createPlannerApi: (id) => {
        if (++attempts === 1) throw new Error('chunk failed to load')
        return planner.apiFor(id)
      },
      autoRefresh,
    })
    manager.setUser(A)
    await settle()
    expect(manager.getSnapshot()!.planner).toBeNull() // calendar-only for now, no crash
    expect(autoRefresh).toHaveBeenCalledTimes(1)
    await autoRefresh.mock.calls[0][0].refresh() // the focus/poll trigger
    await settle()
    expect(manager.getSnapshot()!.planner!.getSnapshot().courses.map((c) => c.name)).toEqual(['Mine'])
    expect(autoRefresh).toHaveBeenCalledTimes(1)
    manager.setUser(null)
  })
})

describe('one refresh lifecycle for calendar and planner', () => {
  function counting() {
    const listeners = new Map<string, Set<() => void>>()
    const target = {
      addEventListener: (t: string, l: () => void) => (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l),
      removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    }
    const fire = (t: string) => listeners.get(t)?.forEach((l) => l())
    const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
    return { target, fire, count }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('has ONE set of listeners and ONE timer, refreshes each source once per trigger, honours the gap and hidden tabs, and cleans up on sign-out', async () => {
    const win = counting()
    const dc = counting()
    const doc = { ...dc.target, visibilityState: 'visible' }
    let clock = 1_000_000
    const cloud = new FakeCloud()
    const planner = new FakePlanner()
    const manager = createCalendarManager({
      createApi: (id) => cloud.apiFor(id),
      createPlannerApi: (id) => planner.apiFor(id),
      autoRefresh: (t) => startAutoRefresh(t, { win: win.target, doc, now: () => clock, pollMs: 60_000, minGapMs: 2_000 }),
    })
    const reads = () => ({ events: cloud.calls.filter((c) => c.method === 'loadEvents').length, courses: planner.calls.filter((c) => c.method === 'loadCourses').length })

    manager.setUser(A)
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toEqual({ events: 1, courses: 1 }) // the initial load
    expect(win.count()).toBe(2) // focus + online
    expect(dc.count()).toBe(1) // visibilitychange
    expect(vi.getTimerCount()).toBe(1)

    clock += 5_000
    win.fire('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toEqual({ events: 2, courses: 2 }) // exactly once each

    clock += 500
    win.fire('focus') // inside the 2 s gap
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toEqual({ events: 2, courses: 2 })

    clock += 5_000
    doc.visibilityState = 'hidden'
    dc.fire('visibilitychange')
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toEqual({ events: 2, courses: 2 }) // hidden tab: skipped

    doc.visibilityState = 'visible'
    clock += 5_000
    win.fire('online')
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toEqual({ events: 3, courses: 3 })

    clock += 60_000
    await vi.advanceTimersByTimeAsync(60_000) // the single poll timer fires
    expect(reads()).toEqual({ events: 4, courses: 4 })

    manager.setUser(null)
    expect(win.count()).toBe(0)
    expect(dc.count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an account switch tears down the old listeners/timer and installs exactly one new set', async () => {
    const win = counting()
    const dc = counting()
    const doc = { ...dc.target, visibilityState: 'visible' }
    const manager = createCalendarManager({
      createApi: (id) => new FakeCloud().apiFor(id),
      createPlannerApi: (id) => new FakePlanner().apiFor(id),
      autoRefresh: (t) => startAutoRefresh(t, { win: win.target, doc }),
    })
    manager.setUser(A)
    manager.setUser(B)
    expect(win.count()).toBe(2)
    expect(dc.count()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    manager.setUser(null)
    expect(win.count() + dc.count() + vi.getTimerCount()).toBe(0)
  })
})

function Probe() {
  const { enabled, source, snapshot } = usePlanner()
  return (
    <div>
      <span data-testid="enabled">{String(enabled)}</span>
      <span data-testid="user">{source?.userId ?? 'none'}</span>
      <span data-testid="courses">{snapshot ? snapshot.courses.map((c) => c.name).join('|') : 'null'}</span>
    </div>
  )
}

describe('CalendarProvider and usePlanner', () => {
  function mount(cloud: FakeCloud, planner: FakePlanner | undefined) {
    const f = createFakeAuthClient(fakeSession)
    render(
      <AuthProvider controller={createAuthController(f.client, { redirectTo: 'http://localhost/' })}>
        <CalendarProvider createApi={(id) => cloud.apiFor(id)} createPlannerApi={planner ? (id) => planner.apiFor(id) : undefined}>
          <Probe />
        </CalendarProvider>
      </AuthProvider>,
    )
    return f
  }

  it('is disabled by default: no planner session, no snapshot, and the calendar is unaffected', async () => {
    const cloud = new FakeCloud()
    cloud.seedEvent(A, { ...eventRow(), user_id: undefined } as never)
    mount(cloud, undefined)
    await waitFor(() => expect(screen.getByTestId('enabled').textContent).toBe('false'))
    await settle()
    expect(screen.getByTestId('user').textContent).toBe('none')
    expect(screen.getByTestId('courses').textContent).toBe('null')
    expect(cloud.calls.some((c) => c.method === 'loadEvents')).toBe(true) // calendar still works
  })

  it('when enabled, exposes the signed-in user\'s courses only, and nothing after sign-out', async () => {
    const cloud = new FakeCloud()
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: C1, name: 'Alice course' })
    planner.seedCourse(B, { id: C2, name: 'Bob course' })
    const f = mount(cloud, planner)
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('Alice course'))
    expect(screen.getByTestId('enabled').textContent).toBe('true')
    expect(screen.getByTestId('user').textContent).toBe(A)

    act(() => f.emit('SIGNED_OUT', null))
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'))
    expect(screen.getByTestId('courses').textContent).toBe('null')
    expect(document.body.textContent).not.toContain('Alice course')
  })

  it('switching accounts never shows the previous user\'s courses to the next user', async () => {
    const cloud = new FakeCloud()
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: C1, name: 'Alice course' })
    planner.seedCourse(B, { id: C2, name: 'Bob course' })
    const f = mount(cloud, planner)
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('Alice course'))

    planner.holdResponses() // B's first read stays in flight, so we can inspect the in-between state
    act(() => f.emit('SIGNED_IN', sessionB))
    await settle()
    expect(document.body.textContent).not.toContain('Alice course')
    expect(screen.getByTestId('user').textContent).not.toBe(A)

    planner.releaseResponses()
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('Bob course'))
    expect(screen.getByTestId('user').textContent).toBe(B)
    expect(document.body.textContent).not.toContain('Alice course')
  })
})

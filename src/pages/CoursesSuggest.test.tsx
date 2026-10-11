// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '../App'
import { createAuthController } from '../auth/authController'
import { AuthProvider } from '../auth/AuthProvider'
import { createFakeAuthClient, fakeSession } from '../auth/fakeAuthClient'
import { FakeCloud } from '../cloud/fakeCloudApi'
import { FakePlanner } from '../cloud/fakePlannerApi'
import { eventToWrite, seriesToWrite } from '../cloud/mappers'
import { CloudError } from '../cloud/types'
import type { EventInput, SeriesInput } from '../types'

const A = fakeSession.user.id
const B = '00000000-0000-4000-8000-0000000000bb'
const sessionB = { ...fakeSession, user: { id: B, email: 'bob@example.test' } }
const opts = { redirectTo: 'http://localhost/' }
const cid = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`
const eid = (n: number) => `e0e0e0e0-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeAll(async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
  await import('../planner/plannerSource')
  await import('../planner/courseInsights')
  await import('./CoursesPage')
})
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(tick)
}

function ev(cloud: FakeCloud, n: number, day: string, courseCode: string | undefined, title: string, user = A) {
  const input: EventInput = { title, category: 'university', start: `${day}T09:00:00.000Z`, end: `${day}T10:30:00.000Z`, timeZone: 'Europe/Berlin', ...(courseCode && { courseCode }) }
  cloud.seedEvent(user, eventToWrite(input, eid(n)) as never)
}
function weekly(cloud: FakeCloud, n: number, courseCode: string, startDate: string, untilDate: string, title: string, user = A) {
  const input: SeriesInput = {
    title, category: 'university', timeZone: 'Europe/Berlin', courseCode,
    recurrence: { frequency: 'weekly', weekdays: [0], startDate, untilDate },
    startTime: '10:00', endTime: '11:30', endDayOffset: 0,
  }
  return cloud.seedSeries(user, seriesToWrite(input, eid(100 + n)) as never)
}

interface MountOptions {
  cloud?: FakeCloud
  planner?: FakePlanner | null
  path?: string
}
function mount({ cloud = new FakeCloud(), planner = new FakePlanner(), path = '/plan/courses' }: MountOptions = {}) {
  const f = createFakeAuthClient(fakeSession)
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider controller={createAuthController(f.client, opts)}>
        <AppRoutes createApi={(u) => cloud.apiFor(u)} createPlannerApi={planner ? (u) => planner.apiFor(u) : undefined} />
      </AuthProvider>
    </MemoryRouter>,
  )
  return { f, cloud, planner }
}

const panel = () => screen.getByTestId('suggest-panel')
const row = (code: string) => panel().querySelector(`[data-suggestion="${code}"]`) as HTMLElement
const open = async () => {
  await screen.findByRole('heading', { level: 1, name: 'Courses' })
  await waitFor(() => expect((screen.getAllByRole('button', { name: /Suggest from my calendar/ })[0] as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getAllByRole('button', { name: /Suggest from my calendar/ })[0])
  await screen.findByTestId('suggest-panel')
  await waitFor(() => expect(screen.queryByText(/Waiting for your calendar/)).toBeNull())
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const writes = (cloud: FakeCloud) => cloud.calls.filter((c) => !/^load/.test(c.method))

describe('suggest from my calendar', () => {
  function inf() {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-20', 'inf 101', 'Informatics')
    ev(cloud, 2, '2026-11-05', 'INF  101', 'Informatics')
    ev(cloud, 3, '2026-11-12', ' Inf 101', 'Intro Informatics')
    ev(cloud, 4, '2026-11-09', 'MA 1', 'Calculus')
    ev(cloud, 5, '2026-11-10', undefined, 'No code at all')
    return cloud
  }

  it('lists each unresolved code once with count, dates, example and an editable name, and creates nothing by itself', async () => {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    const r = row('INF 101')
    expect(r.textContent).toMatch(/3 sessions · 5 Nov 2026 – 20 Nov 2026 · e\.g\. “Informatics”/)
    expect((within(r).getByLabelText('Suggested course name') as HTMLInputElement).value).toBe('Informatics') // most frequent title
    expect((within(r).getByLabelText('Term start') as HTMLInputElement).value).toBe('2026-11-05')
    expect((within(r).getByLabelText('Term end') as HTMLInputElement).value).toBe('2026-11-20')
    expect(r.textContent).toContain('Suggested from calendar — please check.')
    expect(row('MA 1').textContent).toMatch(/1 session ·/)
    expect(panel().querySelectorAll('[data-suggestion]')).toHaveLength(2) // the event without a code is not a candidate
    expect(planner!.courses.get(A) ?? []).toHaveLength(0)
    expect(writes(cloud)).toEqual([])
    expect(screen.getByRole('heading', { level: 3, name: /No course yet \(2\)/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: /Needs attention — outside term \(0\)/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: /Needs attention — ambiguous \(0\)/ })).toBeTruthy()
  })

  it('creates only the selected, edited candidates, resolves them, and never writes to the calendar', async () => {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    const r = row('INF 101')
    fireEvent.click(within(r).getByLabelText(/Select INF 101/))
    type(within(r).getByLabelText('Suggested course name'), 'Introduction to Informatics')
    type(within(r).getByLabelText('Term end'), '2027-02-12')
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected \(1\)/ }))
    await screen.findByTestId('suggest-created')
    expect(planner!.courses.get(A)).toHaveLength(1)
    expect(planner!.courses.get(A)![0]).toMatchObject({ name: 'Introduction to Informatics', code: 'INF 101', term_start: '2026-11-05', term_end: '2027-02-12' })
    await waitFor(() => expect(panel().querySelector('[data-suggestion="INF 101"]')).toBeNull()) // resolved: gone
    expect(row('MA 1')).toBeTruthy() // the unselected one is untouched
    expect(screen.getByTestId('suggest-summary').textContent).toMatch(/Created 1 of 1/)
    expect(writes(cloud)).toEqual([]) // not a single event/series/exception write
    expect(cloud.events.get(A)).toHaveLength(5)
  })

  it('a range longer than a term is flagged, never clipped, and blocks creation until the user fixes it', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2025-09-01', 'LONG 1', 'Long running')
    ev(cloud, 2, '2027-01-15', 'LONG 1', 'Long running')
    const { planner } = mount({ cloud })
    await open()
    const r = row('LONG 1')
    expect((within(r).getByLabelText('Term start') as HTMLInputElement).value).toBe('2025-09-01') // as in the calendar
    expect((within(r).getByLabelText('Term end') as HTMLInputElement).value).toBe('2027-01-15')
    expect(within(r).getByTestId('range-too-long').textContent).toMatch(/did not shorten the range/)
    fireEvent.click(within(r).getByLabelText(/Select LONG 1/))
    expect(within(r).getByTestId('candidate-state').textContent).toBe('Needs correction')
    expect(within(r).getByText('A term can span at most 400 days.')).toBeTruthy()
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected/ }))
    await screen.findByText(/every selected course needs a correction/)
    expect(planner!.courses.get(A) ?? []).toHaveLength(0)
    type(within(r).getByLabelText('Term start'), '2026-10-01')
    expect(within(r).getByTestId('candidate-state').textContent).toBe('Ready')
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected/ }))
    await waitFor(() => expect(planner!.courses.get(A)).toHaveLength(1))
    expect(planner!.courses.get(A)![0]).toMatchObject({ term_start: '2026-10-01', term_end: '2027-01-15' })
  })

  it('a partial failure is reported truthfully; the failed candidate stays, a retry reuses its id and creates exactly one course', async () => {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    fireEvent.click(within(panel()).getByRole('button', { name: /Select all/ }))
    planner!.failWrites = { error: new CloudError('permission', 'Not allowed. You may be signed out; please sign in again.', '42501'), remaining: 1 }
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected \(2\)/ }))
    await waitFor(() => expect(screen.getByTestId('suggest-summary').textContent).toMatch(/Created 1 of 2.*1 was not created/))
    expect(planner!.courses.get(A)).toHaveLength(1)
    const failed = panel().querySelector('[data-phase="failed"]') as HTMLElement
    expect(within(failed).getByTestId('candidate-error').textContent).toMatch(/Not allowed/)
    const code = failed.getAttribute('data-suggestion')!
    expect(planner!.courses.get(A)!.some((c) => c.code === code)).toBe(false)
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected \(1\)/ }))
    await waitFor(() => expect(planner!.courses.get(A)).toHaveLength(2))
    expect(screen.getByTestId('suggest-summary').textContent).toMatch(/Created 1 of 1/)
    expect(new Set(planner!.courses.get(A)!.map((c) => c.id)).size).toBe(2)
  })

  it('an unclear network outcome keeps the candidate, never claims success, and is recognised once the server shows it', async () => {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    fireEvent.click(within(row('MA 1')).getByLabelText(/Select MA 1/))
    planner!.loseResponses = { mode: 'error', remaining: 1 }
    planner!.failReads = { error: new CloudError('network', 'Can’t reach the server.', 'network'), remaining: 1 } // the first re-read fails too
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected/ }))
    await waitFor(() => expect(screen.getByTestId('suggest-summary').textContent).toMatch(/Created 0 of 1.*not confirmed/))
    expect(planner!.courses.get(A)).toHaveLength(1) // it did reach the server
    const r = row('MA 1')
    expect(within(r).getByTestId('candidate-state').textContent).toBe('Not confirmed')
    expect(screen.queryByTestId('suggest-created')).toBeNull() // not claimed
    // the next refresh shows the course; the candidate is then recognised as saved (same id and content)
    fireEvent.click(within(screen.getByTestId('courses-banner')).getByRole('button', { name: /Retry/ }))
    await screen.findByTestId('suggest-created')
    expect(planner!.courses.get(A)).toHaveLength(1)
    // the aggregate follows the per-candidate status: no stale "Created 0 of 1 … not confirmed"
    await waitFor(() => expect(screen.getByTestId('suggest-summary').textContent).toBe('Created 1 of 1 selected course.'))
    expect(screen.getByTestId('suggest-created').textContent).toBe('Created: “Calculus”.') // listed once
  })

  async function lostCreate() {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    fireEvent.click(within(row('MA 1')).getByLabelText(/Select MA 1/))
    planner!.loseResponses = { mode: 'error', remaining: 1 }
    planner!.failReads = { error: new CloudError('network', 'Can’t reach the server.', 'network'), remaining: 1 }
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected/ }))
    await waitFor(() => expect(screen.getByTestId('suggest-summary').textContent).toMatch(/not confirmed/))
    return planner!
  }

  it('a lost create that another device changed is never reported as saved, stays visible and offers a review', async () => {
    const planner = await lostCreate()
    const server = planner.courses.get(A)![0]
    const id = server.id
    server.name = 'Renamed on my phone' // another device edits the committed course
    fireEvent.click(within(screen.getByTestId('courses-banner')).getByRole('button', { name: /Retry/ }))
    // the code is now covered, so the candidate row is gone, but the unresolved attempt is not
    const un = await screen.findByTestId('suggest-unresolved')
    expect(un.textContent).toMatch(/differs from what you submitted \(“Calculus”\).*not overwrite/)
    expect(panel().querySelector('[data-suggestion="MA 1"]')).toBeNull()
    expect(screen.queryByTestId('suggest-created')).toBeNull()
    expect(screen.getByTestId('suggest-summary').textContent).toMatch(/Created 0 of 1.*1 was not created/)
    // nothing was overwritten or re-created under another id
    expect(planner.courses.get(A)).toHaveLength(1)
    expect(planner.courses.get(A)![0]).toMatchObject({ id, name: 'Renamed on my phone' })
    // a safe way to look at it; dismissing is the user’s explicit choice
    fireEvent.click(within(un).getByRole('button', { name: 'Review existing course' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect((screen.getByLabelText(/Course name/) as HTMLInputElement).value).toBe('Renamed on my phone')
    expect(planner.courses.get(A)![0].name).toBe('Renamed on my phone')
  })

  it('edits made while a create is unconfirmed are not credited to the earlier submission', async () => {
    const planner = await lostCreate()
    type(within(row('MA 1')).getByLabelText('Suggested course name'), 'Something I typed afterwards')
    fireEvent.click(within(screen.getByTestId('courses-banner')).getByRole('button', { name: /Retry/ }))
    await screen.findByTestId('suggest-created')
    expect(screen.getByTestId('suggest-created').textContent).toBe('Created: “Calculus”.')
    expect(planner.courses.get(A)![0].name).toBe('Calculus')
  })

  it('an unconfirmed create stays listed (with the existing course) when its code stops being suggested but the content differs', async () => {
    const planner = await lostCreate()
    planner.courses.get(A)![0].term_label = 'WS 26' // changed elsewhere
    fireEvent.click(within(screen.getByTestId('courses-banner')).getByRole('button', { name: /Retry/ }))
    const un = await screen.findByTestId('suggest-unresolved')
    fireEvent.click(within(un).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByTestId('suggest-unresolved')).toBeNull())
    expect(planner.courses.get(A)).toHaveLength(1)
  })

  it('shows institution and term-label errors beside their inputs and blocks the invalid submission', async () => {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    const r = row('MA 1')
    fireEvent.click(within(r).getByLabelText(/Select MA 1/))
    const inst = within(r).getByLabelText('Institution')
    const label = within(r).getByLabelText('Term / semester label')
    type(inst, 'I'.repeat(121))
    type(label, 'T'.repeat(41))
    expect(inst.getAttribute('aria-invalid')).toBe('true')
    expect(label.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(inst.getAttribute('aria-describedby')!)!.textContent).toBe('Institution can be at most 120 characters.')
    expect(document.getElementById(label.getAttribute('aria-describedby')!)!.textContent).toBe('Term label can be at most 40 characters.')
    expect(within(r).getByTestId('candidate-state').textContent).toBe('Needs correction')
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected/ }))
    await screen.findByText(/every selected course needs a correction/)
    expect(planner!.courses.get(A) ?? []).toHaveLength(0)
    type(inst, 'Uni')
    type(label, 'WS 26')
    expect(inst.getAttribute('aria-invalid')).toBe('false')
    expect(inst.getAttribute('aria-describedby')).toBeNull()
    expect(within(r).getByTestId('candidate-state').textContent).toBe('Ready')
  })

  it('a duplicate created elsewhere in the meantime is reported at the candidate and nothing is overwritten', async () => {
    const cloud = inf()
    const { planner } = mount({ cloud })
    await open()
    planner!.seedCourse(A, { id: cid(9), name: 'Made on my phone', code: 'MA 1' }) // not yet visible to this tab
    fireEvent.click(within(row('MA 1')).getByLabelText(/Select MA 1/))
    fireEvent.click(within(panel()).getByRole('button', { name: /Create selected/ }))
    const r = row('MA 1')
    await within(r).findByText(/already exists.*term label/)
    expect(planner!.courses.get(A)).toHaveLength(1)
    expect(planner!.courses.get(A)![0].name).toBe('Made on my phone')
  })

  it('codes already covered by a course are not suggested; nothing to suggest says so', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-05', 'x 1', 'Covered')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Covered course', code: 'X 1' })
    mount({ cloud, planner })
    await open()
    await screen.findByTestId('suggest-empty')
    expect(panel().querySelectorAll('[data-suggestion]')).toHaveLength(0)
  })

  it('recurring series: cancelled and re-coded occurrences are not sessions, moved ones are counted where they went', async () => {
    const cloud = new FakeCloud()
    const s = weekly(cloud, 1, 'SER 1', '2026-11-02', '2026-11-23', 'Series lecture')
    cloud.exceptions.set(A, [
      { series_id: s.id, original_date: '2026-11-02', cancelled: true, override: null, created_at: '', updated_at: '' },
      { series_id: s.id, original_date: '2026-11-09', cancelled: false, override: { courseCode: '' }, created_at: '', updated_at: '' },
      { series_id: s.id, original_date: '2026-11-16', cancelled: false, override: { start: '2027-03-02T09:00:00.000Z', end: '2027-03-02T10:00:00.000Z' }, created_at: '', updated_at: '' },
    ])
    mount({ cloud })
    await open()
    expect(row('SER 1').textContent).toMatch(/2 sessions · 23 Nov 2026 – 2 Mar 2027/)
  })

  it('outside-term codes offer a prefilled, reviewable new course and leave existing courses alone', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2027-03-15', 'X 1', 'Spring lecture')
    ev(cloud, 2, '2027-03-22', 'X 1', 'Spring lecture')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Winter course', code: 'X 1', term_start: '2026-10-01', term_end: '2027-02-28' })
    mount({ cloud, planner })
    await open()
    const g = panel().querySelector('[data-outside="X 1"]') as HTMLElement
    expect(g.textContent).toMatch(/2 sessions between 15 Mar 2027 – 22 Mar 2027 fall outside the term dates of Winter course\./)
    fireEvent.click(within(g).getByRole('button', { name: 'Create a course for this term' }))
    const d = screen.getByRole('dialog', { name: 'Add course' })
    expect(within(d).getByTestId('course-hint').textContent).toMatch(/Suggested from calendar — please check/)
    expect((within(d).getByLabelText(/Course name/) as HTMLInputElement).value).toBe('Spring lecture')
    expect((within(d).getByLabelText(/Course code/) as HTMLInputElement).value).toBe('X 1')
    expect((within(d).getByLabelText('Term start') as HTMLInputElement).value).toBe('2027-03-15')
    expect((within(d).getByLabelText('Term end') as HTMLInputElement).value).toBe('2027-03-22')
    expect(planner.courses.get(A)).toHaveLength(1) // nothing saved yet
    // same code + institution + term label as the winter course would clash: ORBIT says so and invents nothing
    expect(within(d).getByTestId('dialog-same-key').textContent).toMatch(/Winter course.*already has this code/)
    expect((within(d).getByLabelText(/Term \/ semester/) as HTMLInputElement).value).toBe('')
    type(within(d).getByLabelText(/Term \/ semester/), 'SS 27')
    await waitFor(() => expect(within(d).queryByTestId('dialog-same-key')).toBeNull())
    fireEvent.click(within(d).getByRole('button', { name: 'Add course' }))
    await waitFor(() => expect(planner.courses.get(A)).toHaveLength(2))
    expect(planner.courses.get(A)![0]).toMatchObject({ name: 'Winter course', term_end: '2027-02-28' }) // unchanged
    await waitFor(() => expect(panel().querySelector('[data-outside="X 1"]')).toBeNull()) // resolved
  })

  it('ambiguous codes list the courses that share them and offer to edit them; ORBIT never picks one', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-10', 'Y 1', 'Ambiguous session')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Course P', code: 'Y 1', institution: 'P' })
    planner.seedCourse(A, { id: cid(2), name: 'Course Q', code: 'y 1', institution: 'Q', term_start: '2026-10-01', term_end: '2027-02-01' })
    mount({ cloud, planner })
    await open()
    const g = panel().querySelector('[data-ambiguous="Y 1"]') as HTMLElement
    expect(g.textContent).toMatch(/1 session between 10 Nov 2026 could belong to more than one course, so ORBIT does not assign them/)
    expect(g.textContent).toMatch(/Course P \(no term dates, P\); Course Q \(1 Oct 2026 – 1 Feb 2027, Q\)/)
    fireEvent.click(within(g).getByRole('button', { name: /Edit Course P/ }))
    expect(screen.getByRole('dialog', { name: 'Edit course' })).toBeTruthy()
    expect((within(screen.getByRole('dialog')).getByLabelText(/Course name/) as HTMLInputElement).value).toBe('Course P')
  })
})

describe('freshness of the sources', () => {
  it('waits while the calendar is still loading and suggests nothing from missing data', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-05', 'NEW 1', 'A lecture')
    cloud.holdResponses() // the calendar read is on the wire
    const planner = new FakePlanner()
    mount({ cloud, planner })
    await screen.findByRole('heading', { level: 1, name: 'Courses' })
    await screen.findByRole('heading', { name: 'No courses yet' }) // the courses did load (planner is not held by the calendar)
    fireEvent.click(screen.getAllByRole('button', { name: /Suggest from my calendar/ })[0])
    await screen.findByText(/Waiting for your calendar and courses to load/)
    expect(panel().querySelector('[data-suggestion]')).toBeNull()
    cloud.releaseResponses()
    await waitFor(() => expect(row('NEW 1')).toBeTruthy())
  })

  it('an offline refresh marks the suggestions as possibly out of date instead of presenting them as current', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-05', 'NEW 1', 'A lecture')
    mount({ cloud })
    await open()
    expect(screen.queryByTestId('suggest-stale')).toBeNull()
    cloud.offline = true
    vi.setSystemTime(Date.now() + 10_000)
    fireEvent.focus(window) // the app's own refresh trigger
    await screen.findByTestId('suggest-stale')
    expect(screen.getByTestId('suggest-stale').textContent).toMatch(/could not be refreshed.*may be out of date/)
    expect(row('NEW 1')).toBeTruthy() // last known data still shown, clearly labelled
  })
})

describe('matching information on the course cards (C-12 and §6.2)', () => {
  it('shows how many sessions are matched by dates, by code, and the code-level ambiguous / outside counts', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-10', 'A 1', 'In winter')
    ev(cloud, 2, '2026-11-17', 'A 1', 'In winter')
    ev(cloud, 3, '2027-05-05', 'A 1', 'In summer')
    ev(cloud, 4, '2027-03-15', 'A 1', 'Between terms')
    ev(cloud, 5, '2026-11-10', 'U 1', 'Undated one')
    ev(cloud, 6, '2026-11-10', 'S 1', 'Shared')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Winter', code: 'A 1', term_start: '2026-10-01', term_end: '2027-02-28' })
    planner.seedCourse(A, { id: cid(2), name: 'Summer', code: 'A 1', term_start: '2027-04-01', term_end: '2027-09-30' })
    planner.seedCourse(A, { id: cid(3), name: 'Undated', code: 'U 1' })
    planner.seedCourse(A, { id: cid(4), name: 'Shared one', code: 'S 1' })
    planner.seedCourse(A, { id: cid(5), name: 'Shared two', code: 'S 1' })
    planner.seedCourse(A, { id: cid(6), name: 'Codeless' })
    planner.seedCourse(A, { id: cid(7), name: 'Archived', code: 'U 1', archived_at: '2026-01-01T00:00:00+00:00', term_start: '2025-10-01', term_end: '2026-02-01' })
    mount({ cloud, planner })
    await screen.findByRole('heading', { level: 3, name: 'Winter' })
    const card = (n: string) => screen.getByRole('heading', { level: 3, name: n }).closest('li') as HTMLElement
    await waitFor(() => expect(within(card('Winter')).getByTestId('match-summary').textContent).toMatch(/2.*matched by term dates.*0.*matched by code only/))
    expect(within(card('Summer')).getByTestId('match-summary').textContent).toMatch(/1.*matched by term dates/)
    expect(within(card('Winter')).getByTestId('code-level-counts').textContent).toMatch(/code A 1 as a whole \(shared by 2 courses\): 1 outside every term — these are not assigned to any course/)
    // archived course ruled out by its dates, so the undated one is still the single match, by code
    expect(within(card('Undated')).getByTestId('match-summary').textContent).toMatch(/0.*matched by term dates.*1.*matched by code only/)
    expect(within(card('Shared one')).getByTestId('match-summary').textContent).toMatch(/0.*matched by term dates.*0.*matched by code only/)
    expect(within(card('Shared one')).getByTestId('code-level-counts').textContent).toMatch(/1 ambiguous/)
    expect(within(card('Shared two')).getByTestId('code-level-counts').textContent).toMatch(/1 ambiguous/)
    expect(within(card('Codeless')).getByTestId('match-summary').textContent).toMatch(/No course code/)
  })

  it('the dialog warns, with the real session count, when saving would make matched sessions ambiguous', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-10', 'X 1', 'One')
    ev(cloud, 2, '2026-11-17', 'X 1', 'Two')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Existing', code: 'X 1' })
    mount({ cloud, planner })
    await screen.findByRole('heading', { level: 3, name: 'Existing' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add course' })[0])
    const d = screen.getByRole('dialog', { name: 'Add course' })
    type(within(d).getByLabelText(/Course name/), 'Second X')
    expect(within(d).queryByTestId('dialog-impact')).toBeNull()
    type(within(d).getByLabelText(/Course code/), 'x 1')
    await waitFor(() => expect(within(d).getByTestId('dialog-impact').textContent).toMatch(/Existing: 2 would become ambiguous.*Nothing in your calendar is changed, and you can still save/))
    // a dated term that does not contain these sessions rules the new course out for them: they stay matched, no warning
    type(within(d).getByLabelText('Term start'), '2027-04-01')
    type(within(d).getByLabelText('Term end'), '2027-09-30')
    await waitFor(() => expect(within(d).queryByTestId('dialog-impact')).toBeNull())
    // a term that contains them makes them ambiguous again
    type(within(d).getByLabelText('Term start'), '2026-10-01')
    type(within(d).getByLabelText('Term end'), '2027-02-01')
    await waitFor(() => expect(within(d).getByTestId('dialog-impact').textContent).toMatch(/2 would become ambiguous/))
    type(within(d).getByLabelText(/Course code/), 'other code')
    await waitFor(() => expect(within(d).queryByTestId('dialog-impact')).toBeNull())
  })
})

describe('direct account switch', () => {
  it('discards the open panel, selections, drafts and notices; the next account sees only its own suggestions', async () => {
    const cloud = new FakeCloud()
    ev(cloud, 1, '2026-11-05', 'AAA 1', 'Alice lecture')
    ev(cloud, 2, '2026-11-05', 'BBB 1', 'Bob lecture', B)
    const planner = new FakePlanner()
    const { f } = mount({ cloud, planner })
    await open()
    fireEvent.click(within(row('AAA 1')).getByLabelText(/Select AAA 1/))
    type(within(row('AAA 1')).getByLabelText('Suggested course name'), 'Alice draft name')
    expect(screen.getByDisplayValue('Alice draft name')).toBeTruthy()
    act(() => f.emit('SIGNED_IN', sessionB))
    await settle()
    expect(screen.queryByTestId('suggest-panel')).toBeNull()
    expect(screen.queryByDisplayValue('Alice draft name')).toBeNull()
    expect(document.body.textContent).not.toContain('AAA 1')
    await open()
    expect(row('BBB 1')).toBeTruthy()
    expect(panel().querySelector('[data-suggestion="AAA 1"]')).toBeNull()
    expect(panel().textContent).not.toContain('Alice')
    expect(planner.courses.get(A) ?? []).toHaveLength(0)
    expect(planner.courses.get(B) ?? []).toHaveLength(0)
  })
})

describe('calendar and Today annotations', () => {
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
  const around = (day: string) => {
    const d = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
    return { term_start: d(-100), term_end: d(100) }
  }
  const seedToday = (cloud: FakeCloud, n: number, code: string | undefined, title: string) => {
    const day = today()
    cloud.seedEvent(A, eventToWrite({ title, category: 'university', start: `${day}T20:00:00.000Z`, end: `${day}T21:00:00.000Z`, timeZone: 'Europe/Berlin', ...(code && { courseCode: code }) }, eid(n)) as never)
  }

  it('shows a small read-only course note on a session with exactly one matching course, keeping the event as it was', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, 1, 'X 1', 'Evening lecture')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Linear Algebra', code: 'x 1', color: 'c3' })
    mount({ cloud, planner, path: '/' })
    await waitFor(() => expect(screen.getAllByText('Evening lecture').length).toBeGreaterThan(0))
    const note = (await screen.findAllByTestId('course-annotation'))[0] // the same session can appear in both Today lists
    expect(note.textContent).toMatch(/Course: Linear Algebra · Matched by code/)
    expect(note.querySelector('.bg-c3')).toBeTruthy() // an accent, in addition to the category dot
    expect(screen.getAllByText('Evening lecture')[0].closest('button')!.querySelector('.bg-university')).toBeTruthy() // category colour kept
    expect(planner.courses.get(A)).toHaveLength(1)
    expect(writes(cloud)).toEqual([])
  })

  it('a dated match is not labelled "matched by code", and an archived course says so', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, 1, 'X 1', 'Evening lecture')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Old Course', code: 'X 1', archived_at: '2026-01-01T00:00:00+00:00', ...around(today()) })
    mount({ cloud, planner, path: '/' })
    const note = (await screen.findAllByTestId('course-annotation'))[0] // the same session can appear in both Today lists
    expect(note.textContent).toMatch(/Old Course · Archived course/)
    expect(note.textContent).not.toMatch(/Matched by code/)
  })

  it('never annotates ambiguous, outside-term, code-less or cancelled sessions', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, 1, 'AMB 1', 'Ambiguous one')
    seedToday(cloud, 2, 'OUT 1', 'Outside one')
    seedToday(cloud, 3, undefined, 'No code one')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'P', code: 'AMB 1' })
    planner.seedCourse(A, { id: cid(2), name: 'Q', code: 'AMB 1' })
    planner.seedCourse(A, { id: cid(3), name: 'Old term', code: 'OUT 1', term_start: '2020-01-01', term_end: '2020-06-01' })
    mount({ cloud, planner, path: '/' })
    await waitFor(() => expect(screen.getAllByText('Ambiguous one').length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.getAllByText('No code one').length).toBeGreaterThan(0))
    await settle()
    expect(screen.queryByTestId('course-annotation')).toBeNull()
  })

  it('with the feature off the sessions render exactly as before', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, 1, 'X 1', 'Evening lecture')
    mount({ cloud, planner: null, path: '/' })
    await waitFor(() => expect(screen.getAllByText('Evening lecture').length).toBeGreaterThan(0))
    await settle()
    expect(screen.queryByTestId('course-annotation')).toBeNull()
  })

  it('also annotates the calendar day list', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, 1, 'X 1', 'Evening lecture')
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: cid(1), name: 'Linear Algebra', code: 'X 1' })
    mount({ cloud, planner, path: '/calendar' })
    await waitFor(() => expect(screen.getAllByText('Evening lecture').length).toBeGreaterThan(0))
    await screen.findByTestId('course-annotation')
  })
})

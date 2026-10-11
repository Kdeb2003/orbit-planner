// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '../App'
import { createAuthController, createUnconfiguredController } from '../auth/authController'
import { AuthProvider } from '../auth/AuthProvider'
import { createFakeAuthClient, fakeSession } from '../auth/fakeAuthClient'
import { FakeCloud } from '../cloud/fakeCloudApi'
import { FakePlanner } from '../cloud/fakePlannerApi'
import { CloudError } from '../cloud/types'

const A = fakeSession.user.id
const B = '00000000-0000-4000-8000-0000000000bb'
const sessionB = { ...fakeSession, user: { id: B, email: 'bob@example.test' } }
const id = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`
const opts = { redirectTo: 'http://localhost/' }

// jsdom has no <dialog> behaviour
beforeAll(async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
  await import('../planner/plannerSource') // the manager loads it on demand; warm it up
  await import('./CoursesPage')
})
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

interface MountOptions {
  cloud?: FakeCloud
  planner?: FakePlanner | null
  path?: string
  local?: boolean
}
function mount({ cloud = new FakeCloud(), planner = new FakePlanner(), path = '/plan/courses', local = false }: MountOptions = {}) {
  const f = createFakeAuthClient(fakeSession)
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider controller={local ? createUnconfiguredController() : createAuthController(f.client, opts)}>
        <AppRoutes createApi={(u) => cloud.apiFor(u)} createPlannerApi={planner ? (u) => planner.apiFor(u) : undefined} />
      </AuthProvider>
    </MemoryRouter>,
  )
  return { f, cloud, planner }
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Courses' })
const dialog = (name: string) => screen.getByRole('dialog', { name })
const field = (d: HTMLElement, label: RegExp | string) => within(d).getByLabelText(label) as HTMLInputElement
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const openAdd = async () => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add course' })[0])
  return dialog('Add course')
}
const save = (d: HTMLElement, name = 'Add course') => fireEvent.click(within(d).getByRole('button', { name }))
const card = (name: string) => screen.getByRole('heading', { level: 3, name }).closest('li') as HTMLElement
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(tick)
}

describe('feature flag and navigation', () => {
  it('flag off: no Plan entry, Study Planner stays in the bar, and /plan/courses is not a route', async () => {
    mount({ planner: null, path: '/plan/courses' })
    await screen.findByText('Quick actions') // fell through to Today
    expect(screen.queryByRole('heading', { name: 'Courses' })).toBeNull()
    for (const nav of screen.getAllByRole('navigation', { name: 'Main' })) {
      expect(within(nav).queryByRole('link', { name: 'Plan' })).toBeNull()
      expect(within(nav).getAllByRole('link')).toHaveLength(5)
      expect(within(nav).getByRole('link', { name: /Study/ })).toBeTruthy()
    }
  })

  it('flag on: ONE Plan entry takes the Study Planner slot (still five items), Tasks and Exams are not offered', async () => {
    mount()
    await heading()
    for (const nav of screen.getAllByRole('navigation', { name: 'Main' })) {
      expect(within(nav).getAllByRole('link')).toHaveLength(5)
      const plan = within(nav).getByRole('link', { name: 'Plan' })
      expect(plan.getAttribute('aria-current')).toBe('page')
      expect(within(nav).queryByRole('link', { name: /Study/ })).toBeNull()
    }
    expect(screen.queryByRole('link', { name: /Tasks|Exams/ })).toBeNull()
    expect(screen.queryByRole('tab', { name: /Tasks|Exams/ })).toBeNull()
  })

  it('the Study Planner demo is still reachable from Plan, keeps its Demo data label, and Plan stays highlighted there', async () => {
    mount()
    await heading()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Plan sections' })).getByRole('link', { name: /Study planner/ }))
    await screen.findByRole('heading', { level: 1, name: 'Study Planner' })
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0)
    expect(within(screen.getAllByRole('navigation', { name: 'Main' })[0]).getByRole('link', { name: 'Plan' }).className).toMatch(/accent/)
  })

  it('/plan redirects to the Courses section', async () => {
    mount({ path: '/plan' })
    await heading()
  })

  it('local-only mode shows the cloud-only explanation and never pretends to store courses', async () => {
    mount({ local: true })
    await screen.findByText('Courses need an ORBIT account')
    expect(screen.getByText(/never in this browser/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add course' })).toBeNull()
    expect(Object.keys(localStorage).filter((k) => /course/i.test(k))).toEqual([])
    // L-1: no Plan entry in local-only mode; the normal Study Planner navigation and the five mobile slots stay
    for (const nav of screen.getAllByRole('navigation', { name: 'Main' })) {
      expect(within(nav).getAllByRole('link')).toHaveLength(5)
      expect(within(nav).queryByRole('link', { name: /^Plan$/ })).toBeNull()
      expect(within(nav).getByRole('link', { name: /Study/ })).toBeTruthy()
    }
  })
})

describe('states', () => {
  it('loading, then the empty state', async () => {
    const planner = new FakePlanner()
    planner.holdResponses()
    mount({ planner })
    await heading()
    expect(screen.getAllByRole('status').some((s) => /Loading courses/.test(s.textContent ?? ''))).toBe(true)
    expect((screen.getAllByRole('button', { name: 'Add course' })[0] as HTMLButtonElement).disabled).toBe(true)
    planner.releaseResponses()
    await screen.findByRole('heading', { name: 'No courses yet' })
    expect((screen.getAllByRole('button', { name: 'Add course' })[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows active courses, a separate archived section marked by text, and every field that is set', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Linear Algebra', code: 'MATH 101', institution: 'Example University', term_label: 'WS 26/27', term_start: '2026-10-12', term_end: '2027-02-12', color: 'c3', description: 'Synthetic notes' })
    planner.seedCourse(A, { id: id(2), name: 'Old Course', archived_at: '2026-01-05T10:00:00+00:00', color: 'c8' })
    mount({ planner })
    await screen.findByRole('heading', { name: /Active courses \(1\)/ })
    const c = card('Linear Algebra')
    for (const t of ['MATH 101', 'Example University', 'WS 26/27', '12 Oct 2026', '12 Feb 2027', 'Cyan', 'Synthetic notes']) expect(c.textContent, t).toContain(t)
    expect(c.getAttribute('data-archived')).toBe('false')
    const archived = within(screen.getByRole('region', { name: /Archived courses/ }))
    const old = archived.getByRole('heading', { level: 3, name: 'Old Course' }).closest('li') as HTMLElement
    expect(old.textContent).toContain('Archived')
    expect(old.getAttribute('data-archived')).toBe('true')
    expect(within(old).getByRole('button', { name: 'Restore Old Course' })).toBeTruthy()
    expect(within(old).queryByRole('button', { name: 'Archive Old Course' })).toBeNull()
  })

  it('a failed first load is an error card with a manual Retry that works', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Linear Algebra' })
    planner.offline = true
    mount({ planner })
    await screen.findByRole('heading', { name: 'You are offline' })
    expect(screen.getByRole('alert').textContent).toMatch(/Offline or unreachable/)
    planner.offline = false
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
  })

  it('going offline later keeps the courses and shows a banner with Retry', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Linear Algebra' })
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    planner.offline = true
    await act(async () => {
      await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add course' })[0])
    fireEvent.change(field(dialog('Add course'), /Course name/), { target: { value: 'X' } })
    save(dialog('Add course'))
    await waitFor(() => expect(screen.getByTestId('course-save-error')).toBeTruthy())
    fireEvent.click(within(dialog('Add course')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByTestId('courses-banner').textContent).toMatch(/Offline|unreachable/))
    expect(screen.getByRole('heading', { level: 3, name: 'Linear Algebra' })).toBeTruthy()
  })

  it('a missing courses table is a clear "not available" message and the calendar keeps working', async () => {
    const cloud = new FakeCloud()
    const planner = new FakePlanner()
    planner.failReads = { error: new CloudError('unknown', 'Courses are not available on this server yet.', 'planner_unavailable'), remaining: 99 }
    mount({ cloud, planner })
    await screen.findByText('Courses are not available on this server yet')
    expect((screen.getAllByRole('button', { name: 'Add course' })[0] as HTMLButtonElement).disabled).toBe(true)
    expect(cloud.calls.some((c) => c.method === 'loadEvents')).toBe(true)
  })

  it('warns when server rows were skipped as invalid, without changing them', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Fine' })
    planner.seedCourse(A, { id: id(2), name: '   ' })
    mount({ planner })
    await screen.findByTestId('courses-skipped')
    expect(screen.getByTestId('courses-skipped').textContent).toMatch(/1 course record.*not shown.*Nothing was changed or deleted/)
    expect(planner.courses.get(A)).toHaveLength(2)
  })
})

describe('creating a course', () => {
  it('needs only a name, stores blanks as NULL, closes after the server confirmed, and never touches the calendar', async () => {
    const { cloud, planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    expect(document.activeElement).toBe(field(d, /Course name/)) // focus goes to the first field
    type(field(d, /Course name/), '  Linear Algebra ')
    save(d)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add course' })).toBeNull())
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    expect(planner!.courses.get(A)![0]).toMatchObject({ name: 'Linear Algebra', code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null })
    expect(cloud.calls.filter((c) => /^(insert|update|delete|upsert)/.test(c.method))).toEqual([])
  })

  it('saves every optional field and the chosen colour', async () => {
    const { planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Data Mining')
    type(field(d, /Course code/), 'CS 450')
    type(field(d, /Institution/), 'Example University')
    type(field(d, /Term \/ semester/), 'WS 26/27')
    type(field(d, /Term start/), '2026-10-12')
    type(field(d, /Term end/), '2027-02-12')
    type(field(d, /Description/), 'Synthetic description')
    fireEvent.click(within(d).getByRole('radio', { name: 'Pink' }))
    save(d)
    await waitFor(() => expect(planner!.courses.get(A)).toHaveLength(1))
    expect(planner!.courses.get(A)![0]).toMatchObject({ name: 'Data Mining', code: 'CS 450', institution: 'Example University', term_label: 'WS 26/27', term_start: '2026-10-12', term_end: '2027-02-12', description: 'Synthetic description', color: 'c7' })
  })

  it('offers eight named colours as a radio group, preselects a free one, and marks the selection by more than colour', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Taken', color: 'c1' })
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Taken' })
    const d = await openAdd()
    const radios = within(d).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Violet', 'Blue', 'Cyan', 'Green', 'Amber', 'Orange', 'Pink', 'Red'])
    expect((within(d).getByRole('radio', { name: 'Blue' }) as HTMLInputElement).checked).toBe(true) // c1 is taken
    expect(d.querySelectorAll('svg.lucide-check')).toHaveLength(1)
  })

  it('shows inline, associated errors and sends nothing for invalid input', async () => {
    const { planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    save(d)
    const name = field(d, /Course name/)
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
    expect(name.getAttribute('aria-describedby')).toContain(`${name.id}-error`)
    expect(within(d).getByText('Name is required.').getAttribute('role')).toBe('alert')
    expect(document.activeElement).toBe(name)
    expect(planner!.calls.some((c) => c.method === 'insertCourse')).toBe(false)

    type(name, 'Valid')
    type(field(d, /Term start/), '2026-10-12')
    save(d)
    await within(d).findByText('Set both term dates or neither.')
    type(field(d, /Term end/), '2026-10-01')
    await within(d).findByText('Term end cannot be before term start.')
    type(field(d, /Term end/), '2027-12-01')
    await within(d).findByText('A term can span at most 400 days.')
    type(field(d, /Term end/), '')
    type(field(d, /Term start/), '')
    type(field(d, /Course code/), 'x'.repeat(31))
    type(field(d, /Description/), 'y'.repeat(2001))
    type(field(d, /Institution/), 'z'.repeat(121))
    type(field(d, /Term \/ semester/), 'w'.repeat(41))
    for (const t of [/Code can be at most 30/, /Description can be at most 2000/, /Institution can be at most 120/, /Term label can be at most 40/]) expect(within(d).getByText(t)).toBeTruthy()
    expect(planner!.calls.some((c) => c.method === 'insertCourse')).toBe(false)
  })

  it('explains what term dates are for and the 120-character name limit', async () => {
    mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    expect(d.textContent).toMatch(/Term dates let ORBIT tell semesters apart when the same course code is reused/)
    expect(d.textContent).toMatch(/up to 120 characters/)
  })

  it('a pending save shows progress, disables repeat submits and Close/Cancel, and sends one request', async () => {
    const { planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Slow')
    planner!.holdResponses()
    save(d)
    await within(d).findByRole('button', { name: 'Saving…' })
    const btn = within(d).getByRole('button', { name: 'Saving…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect((within(d).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(d).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    planner!.releaseResponses()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add course' })).toBeNull())
    expect(planner!.calls.filter((c) => c.method === 'insertCourse')).toHaveLength(1)
    expect(planner!.courses.get(A)).toHaveLength(1)
  })

  it('a failed save keeps the dialog and the input open, with the reason', async () => {
    const { planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Kept input')
    planner!.failWrites = { error: new CloudError('permission', 'Not allowed. You may be signed out; please sign in again.', '42501'), remaining: 1 }
    save(d)
    await within(d).findByText(/Not allowed/)
    expect(field(d, /Course name/).value).toBe('Kept input')
    expect(screen.queryByRole('heading', { level: 3, name: 'Kept input' })).toBeNull()
    save(d) // a manual retry works
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add course' })).toBeNull())
    expect(planner!.courses.get(A)).toHaveLength(1)
  })
})

describe('editing', () => {
  it('edits a course and clears optional fields (stored as NULL)', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Linear Algebra', code: 'MATH 101', institution: 'Uni', term_label: 'WS', term_start: '2026-10-12', term_end: '2027-02-12', description: 'notes', color: 'c2' })
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear Algebra' }))
    const d = dialog('Edit course')
    expect(field(d, /Course name/).value).toBe('Linear Algebra')
    expect(field(d, /Term end/).value).toBe('2027-02-12')
    for (const l of [/Course code/, /Institution/, /Term \/ semester/, /Term start/, /Term end/, /Description/]) type(field(d, l), '')
    type(field(d, /Course name/), 'Linear Algebra II')
    save(d, 'Save changes')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit course' })).toBeNull())
    expect(planner.courses.get(A)![0]).toMatchObject({ name: 'Linear Algebra II', code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c2' })
  })
})

describe('duplicate, stale and uncertain outcomes', () => {
  const algebra = { id: id(1), name: 'Linear Algebra', code: 'MATH 101', institution: 'Uni', term_label: 'WS' }

  it('duplicate: stays open, explains it at the code field, offers to show the existing course, changes nothing', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, algebra)
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Algebra again')
    type(field(d, /Course code/), ' math  101 ')
    type(field(d, /Institution/), 'uni')
    type(field(d, /Term \/ semester/), 'ws')
    save(d)
    const code = field(d, /Course code/)
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'))
    expect(within(d).getByText(/already exists/).getAttribute('role')).toBe('alert')
    expect(code.getAttribute('aria-describedby')).toContain(`${code.id}-error`)
    expect(document.activeElement).toBe(code)
    expect(field(d, /Course name/).value).toBe('Algebra again')
    expect(planner.courses.get(A)).toHaveLength(1)
    // the live shared-code note is also there, but saving was not blocked client-side

    fireEvent.click(within(d).getByRole('button', { name: /Show the existing course: Linear Algebra/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add course' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(card('Linear Algebra')))
    expect(card('Linear Algebra').className).toMatch(/ring-2/)
  })

  it('editing the code into a duplicate is also a field error and nothing is overwritten', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, algebra)
    planner.seedCourse(A, { id: id(2), name: 'Other', code: 'MATH 102', institution: 'Uni', term_label: 'WS' })
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Other' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Other' }))
    const d = dialog('Edit course')
    type(field(d, /Course code/), 'math 101')
    save(d, 'Save changes')
    await within(d).findByText(/already exists/)
    expect(planner.courses.get(A)!.find((c) => c.id === id(2))!.code).toBe('MATH 102')
  })

  it('stale: the dialog stays open, keeps the unsaved input, blocks saving until the user reviews the latest version, and never overwrites by itself', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, algebra)
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear Algebra' }))
    const d = dialog('Edit course')
    type(field(d, /Course name/), 'My laptop edit')
    planner.touchCourse(A, id(1), { name: 'Phone edit' }) // another device saves first
    save(d, 'Save changes')
    const review = await screen.findByTestId('stale-review')
    await waitFor(() => expect(within(review).getByText(/differs in/)).toBeTruthy())
    expect(within(review).getByText('Phone edit')).toBeTruthy() // the latest saved value, shown for review
    expect(screen.getByTestId('course-save-error').textContent).toMatch(/refreshing the latest version/i)
    expect(field(d, /Course name/).value).toBe('My laptop edit') // input preserved
    expect(planner.courses.get(A)![0].name).toBe('Phone edit') // server untouched
    expect((within(d).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(review).getByRole('button', { name: 'Keep my entries' }))
    expect((within(d).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
    expect(d.textContent).toMatch(/replace the latest saved version/)
    save(d, 'Save changes')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit course' })).toBeNull())
    expect(planner.courses.get(A)![0].name).toBe('My laptop edit')
  })

  it('stale: "Use the latest values" replaces the form with the newer server data (only on request)', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, algebra)
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear Algebra' }))
    const d = dialog('Edit course')
    type(field(d, /Course name/), 'My laptop edit')
    planner.touchCourse(A, id(1), { name: 'Phone edit' })
    save(d, 'Save changes')
    const review = await screen.findByTestId('stale-review')
    await waitFor(() => within(review).getByRole('button', { name: 'Use the latest values' }))
    fireEvent.click(within(review).getByRole('button', { name: 'Use the latest values' }))
    expect(field(d, /Course name/).value).toBe('Phone edit')
    expect(screen.queryByTestId('stale-review')).toBeNull()
    expect(planner.courses.get(A)![0].name).toBe('Phone edit')
  })

  it('stale because the course was deleted elsewhere: nothing can be saved', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, algebra)
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear Algebra' }))
    const d = dialog('Edit course')
    type(field(d, /Course name/), 'Edit of a ghost')
    planner.courses.set(A, [])
    save(d, 'Save changes')
    await within(d).findByText(/deleted on another device or tab/)
    expect((within(d).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
    expect(field(d, /Course name/).value).toBe('Edit of a ghost')
  })

  it('a lost response after the server saved: the dialog explains, keeps the input, and closes by itself once the re-read shows the course', async () => {
    const { planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Committed anyway')
    planner!.loseResponses = { mode: 'error', remaining: 1 }
    save(d)
    // the automatic reconciliation read finds the committed course; the dialog then closes with an explanation
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add course' })).toBeNull())
    expect(screen.getByTestId('courses-notice').textContent).toMatch(/saved.*server had received it/i)
    expect(screen.getAllByRole('heading', { level: 3, name: 'Committed anyway' })).toHaveLength(1)
    expect(planner!.courses.get(A)).toHaveLength(1)
  })

  it('network failure where nothing was saved: the dialog never claims success, keeps the input, and a retry creates exactly one course', async () => {
    const { planner } = mount()
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Offline attempt')
    planner!.offline = true
    save(d)
    const alert = await within(d).findByTestId('course-save-error')
    expect(alert.textContent).toMatch(/could not confirm whether this was saved/)
    expect(field(d, /Course name/).value).toBe('Offline attempt')
    expect(screen.queryByTestId('courses-notice')).toBeNull()
    await settle()
    expect(screen.getByRole('dialog', { name: 'Add course' })).toBeTruthy() // still open: nothing was saved
    planner!.offline = false
    save(d)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add course' })).toBeNull())
    expect(planner!.courses.get(A)).toHaveLength(1)
    expect(planner!.calls.filter((c) => c.method === 'insertCourse').length).toBe(2) // same id both times
  })
})

describe('archive, restore and delete', () => {
  const seed = () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Linear Algebra', code: 'MATH 101' })
    return planner
  }

  it('archive needs an explicit confirmation; cancelling changes nothing; confirming keeps the course in the archived section', async () => {
    const planner = seed()
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive Linear Algebra' }))
    const d = dialog('Archive “Linear Algebra”?')
    expect(d.textContent).toMatch(/Nothing is deleted/)
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Cancel' })) // safe default
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }))
    expect(planner.courses.get(A)![0].archived_at).toBeNull()
    expect(planner.calls.some((c) => c.method === 'archiveCourse')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Archive Linear Algebra' }))
    fireEvent.click(within(dialog('Archive “Linear Algebra”?')).getByRole('button', { name: 'Archive course' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const archived = await screen.findByRole('region', { name: /Archived courses \(1\)/ })
    expect(within(archived).getByRole('heading', { level: 3, name: 'Linear Algebra' })).toBeTruthy()
    expect(planner.courses.get(A)![0].archived_at).not.toBeNull()
    expect(planner.courses.get(A)).toHaveLength(1) // nothing deleted
    expect(screen.getByTestId('courses-notice').textContent).toMatch(/archived/)
  })

  it('restore moves it back to the active list through a confirmed server update', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Old', archived_at: '2026-01-05T10:00:00+00:00' })
    mount({ planner })
    await screen.findByRole('button', { name: 'Restore Old' })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old' }))
    await screen.findByRole('heading', { name: /Active courses \(1\)/ })
    expect(planner.courses.get(A)![0].archived_at).toBeNull()
  })

  it('delete names the course, explains what is and is not affected, and deletes only after confirmation', async () => {
    const planner = seed()
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Linear Algebra' }))
    const d = dialog('Delete “Linear Algebra” permanently?')
    expect(d.textContent).toMatch(/Calendar events are never changed or deleted/)
    expect(d.textContent).toMatch(/Tasks and Exams/)
    expect(planner.courses.get(A)).toHaveLength(1)
    fireEvent.click(within(d).getByRole('button', { name: 'Delete course' }))
    await screen.findByRole('heading', { name: 'No courses yet' })
    expect(planner.courses.get(A)).toEqual([])
  })

  it('a failed delete keeps the dialog open with the reason and deletes nothing', async () => {
    const planner = seed()
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Linear Algebra' }))
    const d = dialog('Delete “Linear Algebra” permanently?')
    planner.failWrites = { error: new CloudError('validation', 'The server rejected this data as invalid.', '23503'), remaining: 1 }
    fireEvent.click(within(d).getByRole('button', { name: 'Delete course' }))
    await within(d).findByText(/rejected this data/)
    expect(planner.courses.get(A)).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 3, name: 'Linear Algebra' })).toBeTruthy()
  })

  it('archiving a course that changed elsewhere is rejected as stale and nothing is archived', async () => {
    const planner = seed()
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    planner.touchCourse(A, id(1), { description: 'phone' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive Linear Algebra' }))
    const d = dialog('Archive “Linear Algebra”?')
    fireEvent.click(within(d).getByRole('button', { name: 'Archive course' }))
    await within(d).findByTestId('confirm-blocked')
    expect(within(d).getAllByText(/changed on another device/).length).toBeGreaterThan(0)
    expect(planner.courses.get(A)![0].archived_at).toBeNull()
  })
})

describe('shared course codes (non-blocking)', () => {
  it('warns on cards whose code is shared with undated or overlapping courses, but not for separate terms', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Undated A', code: 'CS 1', institution: 'U1' })
    planner.seedCourse(A, { id: id(2), name: 'Undated B', code: 'cs  1', institution: 'U2' })
    planner.seedCourse(A, { id: id(3), name: 'Term one', code: 'DB 1', term_start: '2026-10-01', term_end: '2027-02-01' })
    planner.seedCourse(A, { id: id(4), name: 'Term two', code: 'DB 1', term_start: '2027-04-01', term_end: '2027-08-01' })
    planner.seedCourse(A, { id: id(5), name: 'Over one', code: 'OS 1', term_start: '2026-10-01', term_end: '2027-02-01' })
    planner.seedCourse(A, { id: id(6), name: 'Over two', code: 'OS 1', term_start: '2027-01-15', term_end: '2027-06-01' })
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Undated A' })
    expect(within(card('Undated A')).getByTestId('shared-code-warning').textContent).toMatch(/Undated B.*missing or incomplete.*ambiguous/)
    expect(within(card('Over one')).getByTestId('shared-code-warning').textContent).toMatch(/overlap/)
    expect(within(card('Term one')).queryByTestId('shared-code-warning')).toBeNull()
    expect(within(card('Term two')).queryByTestId('shared-code-warning')).toBeNull()
  })

  it('the dialog shows a live warning and still saves', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Existing', code: 'CS 1', institution: 'U1', term_label: 'WS' })
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Existing' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Second')
    type(field(d, /Course code/), 'CS 1')
    type(field(d, /Institution/), 'U2')
    expect(within(d).getByTestId('dialog-shared-warning').textContent).toMatch(/may be ambiguous/)
    type(field(d, /Term start/), '2027-04-01')
    type(field(d, /Term end/), '2027-08-01')
    expect(within(d).getByTestId('dialog-shared-warning')).toBeTruthy() // the other course has no dates
    save(d)
    await waitFor(() => expect(planner.courses.get(A)).toHaveLength(2))
  })
})

describe('accounts', () => {
  it('switching accounts never shows the previous user\'s courses, and sign-out leaves none on screen', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Alice course' })
    planner.seedCourse(B, { id: id(2), name: 'Bob course' })
    const { f } = mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Alice course' })
    planner.holdResponses()
    act(() => f.emit('SIGNED_IN', sessionB))
    await settle()
    expect(document.body.textContent).not.toContain('Alice course')
    planner.releaseResponses()
    await screen.findByRole('heading', { level: 3, name: 'Bob course' })
    expect(document.body.textContent).not.toContain('Alice course')
    act(() => f.emit('SIGNED_OUT', null))
    await waitFor(() => expect(document.body.textContent).not.toContain('Bob course'))
  })
})


/** Triggers the app's own focus refresh (the single auto-refresh scheduler) after moving the clock past its minimum gap. */
// The scheduler captured `Date.now` when the session started, so the clock must be faked BEFORE mounting (`fakeClock()`).
const fakeClock = () => vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
async function focusRefresh() {
  vi.setSystemTime(Date.now() + 10_000)
  fireEvent.focus(window)
  await settle()
}
const updates = (p: FakePlanner, method = 'updateCourse') => p.calls.filter((c) => c.method === method).length

describe('edits are bound to the version the user reviewed', () => {
  const algebra = { id: id(1), name: 'Linear Algebra', code: 'MATH 101' }

  it('a refresh that already brought a newer version cannot be overwritten by the older form; the stale review is shown and input kept', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, algebra)
    fakeClock()
    mount({ planner })
    await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear Algebra' }))
    const d = dialog('Edit course') // opened with v1
    type(field(d, /Course name/), 'My laptop edit')
    planner.touchCourse(A, id(1), { name: 'Phone edit' }) // another device: v2
    await focusRefresh() // the source now holds v2 BEFORE the user clicks Save
    await screen.findByRole('heading', { level: 3, name: 'Phone edit' })

    save(d, 'Save changes') // the v1 form
    const review = await screen.findByTestId('stale-review')
    expect(updates(planner)).toBe(0) // no request was sent at all
    expect(planner.courses.get(A)![0].name).toBe('Phone edit')
    expect(field(d, /Course name/).value).toBe('My laptop edit') // input preserved
    expect(within(review).getByText('Phone edit')).toBeTruthy()
    expect((within(d).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)

    // the user reviews and keeps their entries: the form is now based on v2
    fireEvent.click(within(review).getByRole('button', { name: 'Keep my entries' }))
    // ... but a FURTHER concurrent change (v3) is still rejected
    planner.touchCourse(A, id(1), { name: 'Third edit' })
    save(d, 'Save changes')
    await waitFor(() => expect(screen.getByTestId('stale-review')).toBeTruthy())
    expect(planner.courses.get(A)![0].name).toBe('Third edit')
    expect(field(d, /Course name/).value).toBe('My laptop edit')
    expect(screen.getByTestId('course-save-error').textContent).toMatch(/refreshing/i)

    // after reviewing v3 too, the save is allowed and is the user's explicit choice
    await waitFor(() => within(screen.getByTestId('stale-review')).getByRole('button', { name: 'Keep my entries' }))
    fireEvent.click(within(screen.getByTestId('stale-review')).getByRole('button', { name: 'Keep my entries' }))
    save(d, 'Save changes')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit course' })).toBeNull())
    expect(planner.courses.get(A)![0].name).toBe('My laptop edit')
  })
})

describe('confirmations are bound to the reviewed version', () => {
  const seed = () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Linear Algebra', code: 'MATH 101' })
    return planner
  }

  for (const [kind, button, confirmName, method] of [
    ['archive', 'Archive Linear Algebra', 'Archive course', 'archiveCourse'],
    ['delete', 'Delete Linear Algebra', 'Delete course', 'deleteCourse'],
  ] as const) {
    it(`${kind}: a refresh that brings a newer version disables the confirmation and nothing is written`, async () => {
      const planner = seed()
      fakeClock()
      mount({ planner })
      await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
      fireEvent.click(screen.getByRole('button', { name: button }))
      const d = screen.getByRole('dialog')
      planner.touchCourse(A, id(1), { description: 'phone edit' })
      await focusRefresh()
      await within(d).findByTestId('confirm-blocked')
      expect((within(d).getByRole('button', { name: confirmName }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(within(d).getByRole('button', { name: confirmName }))
      expect(updates(planner, method)).toBe(0)
      expect(planner.courses.get(A)).toHaveLength(1)
      expect(planner.courses.get(A)![0].archived_at).toBeNull()
    })

    it(`${kind}: a change the source has not seen yet is rejected by the version check, and the action stays disabled until reopened`, async () => {
      const planner = seed()
      mount({ planner })
      await screen.findByRole('heading', { level: 3, name: 'Linear Algebra' })
      fireEvent.click(screen.getByRole('button', { name: button }))
      const d = screen.getByRole('dialog')
      planner.touchCourse(A, id(1), { description: 'phone edit' }) // no refresh yet
      fireEvent.click(within(d).getByRole('button', { name: confirmName }))
      await within(d).findByTestId('confirm-blocked')
      expect(within(d).getAllByText(/changed on another device/).length).toBeGreaterThan(0)
      expect(planner.courses.get(A)).toHaveLength(1)
      expect(planner.courses.get(A)![0].archived_at).toBeNull()
      await waitFor(() => expect((within(d).getByRole('button', { name: confirmName }) as HTMLButtonElement).disabled).toBe(true))
      // a fresh review: close, reopen on the latest version, confirm
      fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }))
      await settle()
      fireEvent.click(screen.getByRole('button', { name: button }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: confirmName }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
  }

  it('restore uses the version shown on the card: a change the source has not seen is rejected and nothing is restored', async () => {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Old', archived_at: '2026-01-05T10:00:00+00:00' })
    mount({ planner })
    await screen.findByRole('button', { name: 'Restore Old' })
    planner.touchCourse(A, id(1), { description: 'phone edit' })
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old' }))
    await screen.findByText(/was not restored/)
    expect(planner.courses.get(A)![0].archived_at).not.toBeNull()
  })
})

describe('a direct account switch leaves nothing of the previous account on screen', () => {
  function setup() {
    const planner = new FakePlanner()
    planner.seedCourse(A, { id: id(1), name: 'Alice course', code: 'AL 1' })
    planner.seedCourse(B, { id: id(2), name: 'Bob course', code: 'BO 1' })
    const m = mount({ planner })
    return { planner, f: m.f }
  }
  const switchToB = async (f: ReturnType<typeof setup>['f']) => {
    act(() => f.emit('SIGNED_IN', sessionB))
    await screen.findByRole('heading', { level: 3, name: 'Bob course' })
  }
  const bobUntouched = (planner: FakePlanner) => {
    expect(planner.courses.get(B)).toHaveLength(1)
    expect(planner.courses.get(B)![0]).toMatchObject({ name: 'Bob course', code: 'BO 1', archived_at: null })
  }

  it('an open Edit dialog (with unsaved changes) disappears', async () => {
    const { planner, f } = setup()
    await screen.findByRole('heading', { level: 3, name: 'Alice course' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alice course' }))
    type(field(dialog('Edit course'), /Course name/), 'Alice unsaved edit')
    await switchToB(f)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByDisplayValue('Alice unsaved edit')).toBeNull()
    expect(document.body.textContent).not.toContain('Alice')
    bobUntouched(planner)
  })

  it('an open Add dialog with unsaved entries disappears and is never submitted for B', async () => {
    const { planner, f } = setup()
    await screen.findByRole('heading', { level: 3, name: 'Alice course' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Draft from A')
    type(field(d, /Course code/), 'DR 1')
    await switchToB(f)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByDisplayValue('Draft from A')).toBeNull()
    expect(planner.courses.get(B)).toHaveLength(1)
    expect(planner.calls.filter((c) => c.method === 'insertCourse')).toHaveLength(0)
    // B opens a fresh Add dialog: empty
    const d2 = await openAdd()
    expect(field(d2, /Course name/).value).toBe('')
    expect(field(d2, /Course code/).value).toBe('')
  })

  it('an open Delete confirmation disappears and nothing is deleted for either account', async () => {
    const { planner, f } = setup()
    await screen.findByRole('heading', { level: 3, name: 'Alice course' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alice course' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await switchToB(f)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(planner.calls.some((c) => c.method === 'deleteCourse')).toBe(false)
    expect(planner.courses.get(A)).toHaveLength(1)
    bobUntouched(planner)
  })

  it('an operation still in flight when the account switches never produces a notice or a change in the next interface', async () => {
    const { planner, f } = setup()
    await screen.findByRole('heading', { level: 3, name: 'Alice course' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive Alice course' }))
    planner.holdResponses()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive course' }))
    await settle()
    act(() => f.emit('SIGNED_IN', sessionB))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    planner.releaseResponses() // A's request answers late
    await screen.findByRole('heading', { level: 3, name: 'Bob course' })
    await settle()
    expect(screen.queryByTestId('courses-notice')).toBeNull()
    expect(document.body.textContent).not.toContain('Alice')
    expect(screen.queryByRole('region', { name: /Archived courses/ })).toBeNull()
    bobUntouched(planner)
  })
})

describe('an uncertain create is only reported as saved when the stored content is what was submitted', () => {
  it('the same id with different content keeps the dialog open, says so, and shows no success notice', async () => {
    const planner = new FakePlanner()
    mount({ planner })
    await screen.findByRole('heading', { name: 'No courses yet' })
    const d = await openAdd()
    type(field(d, /Course name/), 'Mine')
    planner.loseResponses = { mode: 'error', remaining: 1 }
    planner.failReads = { error: new CloudError('network', 'Can’t reach the server.', 'network'), remaining: 1 } // the first reconciliation read fails
    save(d)
    await within(d).findByTestId('course-save-error')
    const banner = await screen.findByTestId('courses-banner')
    const stored = planner.courses.get(A)![0] // it WAS committed
    planner.touchCourse(A, stored.id, { name: 'Changed by someone else' })
    fireEvent.click(within(banner).getByRole('button', { name: /Retry/ }))
    await within(d).findByTestId('created-differs')
    expect(screen.getByRole('dialog', { name: 'Add course' })).toBeTruthy()
    expect(screen.queryByTestId('courses-notice')).toBeNull()
    expect(field(d, /Course name/).value).toBe('Mine')
    expect(planner.courses.get(A)).toHaveLength(1)
    expect(planner.courses.get(A)![0].name).toBe('Changed by someone else') // nothing overwritten yet
  })
})

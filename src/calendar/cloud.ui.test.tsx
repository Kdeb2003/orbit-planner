// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppRoutes } from '../App'
import { createAuthController } from '../auth/authController'
import { AuthProvider } from '../auth/AuthProvider'
import { createFakeAuthClient, fakeSession } from '../auth/fakeAuthClient'
import { FakeCloud } from '../cloud/fakeCloudApi'
import { CloudError } from '../cloud/types'
import { eventToWrite } from '../cloud/mappers'

const A = fakeSession.user.id
const B = '00000000-0000-4000-8000-0000000000bb'
const sessionB = { ...fakeSession, user: { id: B, email: 'bob@example.test' } }
const opts = { redirectTo: 'http://localhost/' }

// jsdom has no <dialog> behaviour
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})
beforeEach(() => localStorage.clear())
afterEach(cleanup)

function today() {
  const d = new Date()
  // Berlin calendar day of "now" (what the app uses), formatted YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d)
}

function mount(cloud: FakeCloud, path = '/') {
  const f = createFakeAuthClient(fakeSession)
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider controller={createAuthController(f.client, opts)}>
        <AppRoutes createApi={(id) => cloud.apiFor(id)} />
      </AuthProvider>
    </MemoryRouter>,
  )
  return f
}

const seedToday = (cloud: FakeCloud, user: string, title: string, id: string) => {
  const day = today()
  cloud.seedEvent(user, eventToWrite({ title, category: 'personal', start: `${day}T20:00:00.000Z`, end: `${day}T21:00:00.000Z`, timeZone: 'Europe/Berlin' }, id))
}
const state = () => screen.getByTestId('sync-status').getAttribute('data-state')

describe('cloud mode in the UI (mocked cloud)', () => {
  it('shows a loading state, then the signed-in user\'s calendar, and a "saved" indicator', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, A, 'My cloud event', 'aaaaaaaa-1111-4111-8111-111111111111')
    cloud.holdResponses()
    mount(cloud)
    await waitFor(() => expect(screen.getAllByText(/Loading/).length).toBeGreaterThan(0))
    expect(screen.queryByText('My cloud event')).toBeNull()
    expect(screen.queryByText('Quick actions')).toBeNull() // no empty-looking calendar while loading
    cloud.releaseResponses()
    await waitFor(() => expect(screen.getAllByText('My cloud event').length).toBeGreaterThan(0))
    expect(state()).toBe('saved')
    expect(screen.getByTestId('sync-status').textContent).toMatch(/Saved to cloud/)
  })

  it('a failed first load shows an error with a working retry (not an empty calendar)', async () => {
    const cloud = new FakeCloud()
    cloud.offline = true
    mount(cloud)
    await waitFor(() => expect(screen.getByText(/Couldn’t load your calendar/)).toBeTruthy())
    cloud.offline = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('Quick actions')).toBeTruthy())
  })

  it('a failed save keeps the form open with "Not saved"; fixing the problem and retrying saves exactly once', async () => {
    const cloud = new FakeCloud()
    mount(cloud)
    await waitFor(() => expect(screen.getByText('Quick actions')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: /Add event/ })[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Retry me' } })

    cloud.failWrites = { error: new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network'), remaining: 1 }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save event' }))
    await waitFor(() => expect(within(dialog).getByTestId('save-error').textContent).toMatch(/Not saved/))
    expect(screen.getByRole('dialog')).toBeTruthy() // still open
    expect(cloud.events.get(A) ?? []).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save event' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(cloud.events.get(A)).toHaveLength(1)
    expect(cloud.events.get(A)![0].title).toBe('Retry me')
    await waitFor(() => expect(screen.getAllByText('Retry me').length).toBeGreaterThan(0))
  })

  it('a concurrent change on another device is rejected on save, with an explanation, and nothing is overwritten', async () => {
    const cloud = new FakeCloud()
    const id = 'aaaaaaaa-2222-4222-8222-222222222222'
    seedToday(cloud, A, 'Shared event', id)
    mount(cloud)
    await waitFor(() => expect(screen.getAllByText('Shared event').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('Shared event')[0].closest('button')!)
    const dialog = await screen.findByRole('dialog')
    cloud.touchEvent(A, id, { title: 'Edited on the phone' })
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Edited on the laptop' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(within(dialog).getByTestId('save-error').textContent).toMatch(/another device/))
    expect(cloud.events.get(A)![0].title).toBe('Edited on the phone')
  })

  it('shows a sync error banner with retry when a background refresh fails, keeping the last data', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, A, 'Still visible', 'aaaaaaaa-3333-4333-8333-333333333333')
    mount(cloud)
    await waitFor(() => expect(screen.getAllByText('Still visible').length).toBeGreaterThan(0))
    cloud.offline = true
    // trigger a refresh through the Retry-capable status control path: focus event is rate-limited, so call via visibility
    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 2100))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(['offline', 'error']).toContain(state()))
    expect(screen.getAllByText('Still visible').length).toBeGreaterThan(0)
    cloud.offline = false
    fireEvent.click(screen.getByTestId('sync-status'))
    await waitFor(() => expect(state()).toBe('saved'))
  }, 10_000)

  it('switching accounts clears the previous user\'s data and never shows it to the next user', async () => {
    const cloud = new FakeCloud()
    seedToday(cloud, A, 'Alice only', 'aaaaaaaa-4444-4444-8444-444444444444')
    seedToday(cloud, B, 'Bob only', 'bbbbbbbb-4444-4444-8444-444444444444')
    const f = mount(cloud)
    await waitFor(() => expect(screen.getAllByText('Alice only').length).toBeGreaterThan(0))

    act(() => f.emit('SIGNED_OUT', null))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
    expect(screen.queryByText('Alice only')).toBeNull()

    act(() => f.emit('SIGNED_IN', sessionB))
    await waitFor(() => expect(screen.getAllByText('Bob only').length).toBeGreaterThan(0))
    expect(screen.queryByText('Alice only')).toBeNull()
    expect(document.body.innerHTML).not.toContain('Alice only')
  })

  it('legacy browser data is never shown as the signed-in account\'s data', async () => {
    localStorage.setItem(
      'orbit.events.v1',
      JSON.stringify([{ id: 'x', title: 'Old local event', category: 'personal', start: `${today()}T20:00:00.000Z`, end: `${today()}T21:00:00.000Z`, timeZone: 'Europe/Berlin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]),
    )
    mount(new FakeCloud())
    await waitFor(() => expect(screen.getByText('Quick actions')).toBeTruthy())
    expect(screen.queryByText('Old local event')).toBeNull()
    expect(screen.getByTestId('local-data-notice').textContent).toMatch(/not included until you import/)
  })
})

describe('local import card (mocked cloud)', () => {
  const localEvent = {
    id: 'legacy-1',
    title: 'Saved in browser',
    category: 'personal',
    start: '2026-10-09T08:00:00.000Z',
    end: '2026-10-09T09:00:00.000Z',
    timeZone: 'Europe/Berlin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('previews first, requires a backup and an explicit confirmation, then imports and verifies; local data stays', async () => {
    const raw = JSON.stringify([localEvent])
    localStorage.setItem('orbit.events.v1', raw)
    // the stores load at module import; make them read the seeded value
    const { eventStore } = await import('../storage/eventStore')
    eventStore.reload()
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}
    HTMLAnchorElement.prototype.click = () => {}

    const cloud = new FakeCloud()
    mount(cloud, '/settings')
    const card = await screen.findByTestId('local-import')
    expect(card.textContent).toMatch(/1<\/strong> event|1 event|event\(s\)/)
    expect(cloud.events.get(A) ?? []).toHaveLength(0) // nothing uploaded on load

    fireEvent.click(within(card).getByRole('button', { name: /Preview import/ }))
    const preview = await screen.findByTestId('import-preview')
    expect(preview.textContent).toMatch(/Events: 1 to upload/)
    const upload = within(preview).getByRole('button', { name: /Upload to my account/ })
    expect((upload as HTMLButtonElement).disabled).toBe(true) // needs backup + confirmation
    fireEvent.click(within(card).getByRole('button', { name: /Download backup/ }))
    expect((upload as HTMLButtonElement).disabled).toBe(true) // still needs the explicit confirmation
    fireEvent.click(within(preview).getByRole('checkbox'))
    expect((upload as HTMLButtonElement).disabled).toBe(false)
    expect(cloud.events.get(A) ?? []).toHaveLength(0) // still nothing uploaded

    fireEvent.click(upload)
    await waitFor(() => expect(screen.getByTestId('import-result').textContent).toMatch(/Imported and verified/))
    expect(cloud.events.get(A)).toHaveLength(1)
    expect(localStorage.getItem('orbit.events.v1')).toBe(raw) // untouched
  })
})

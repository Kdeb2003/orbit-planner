// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppRoutes } from '../App'
import { createAuthController, createUnconfiguredController } from './authController'
import type { AuthController } from './authController'
import { AuthProvider } from './AuthProvider'
import { createFakeAuthClient, fakeSession } from './fakeAuthClient'

const opts = { redirectTo: 'http://localhost/' }
const EVENTS_KEY = 'orbit.events.v1'
const localEvents = JSON.stringify([
  {
    id: 'e1',
    title: 'Local only event',
    category: 'personal',
    start: '2026-10-09T08:00:00.000Z',
    end: '2026-10-09T09:00:00.000Z',
    timeZone: 'Europe/Berlin',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
])

function setup(controller: AuthController, path = '/', signupEnabled = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider controller={controller} signupEnabled={signupEnabled}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function settled() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const appIsVisible = () => screen.queryByText('Quick actions') !== null
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)

describe('missing Supabase configuration', () => {
  it('shows a setup message on the sign-in route instead of a form', async () => {
    setup(createUnconfiguredController(), '/login')
    expect(screen.getByText('Sign-in isn’t set up')).toBeTruthy()
    expect(screen.getByText(/\.env\.local/)).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('keeps the app usable in local-only mode', () => {
    localStorage.setItem(EVENTS_KEY, localEvents)
    setup(createUnconfiguredController(), '/')
    expect(appIsVisible()).toBe(true)
    expect(screen.getByText('Local-only mode')).toBeTruthy()
  })
})

describe('protected routes', () => {
  it('redirects every app route to sign-in when signed out', async () => {
    for (const path of ['/', '/calendar', '/study', '/insights', '/settings']) {
      const f = createFakeAuthClient(null)
      setup(createAuthController(f.client, opts), path)
      await settled()
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
      expect(appIsVisible()).toBe(false)
      cleanup()
    }
  })

  it('shows a loading state while the session is being checked, never the app', () => {
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/')
    expect(screen.getByText('Checking your session…')).toBeTruthy()
    expect(appIsVisible()).toBe(false)
  })

  it('restores an existing session without showing the sign-in page', async () => {
    const f = createFakeAuthClient(fakeSession)
    setup(createAuthController(f.client, opts), '/')
    await settled()
    expect(appIsVisible()).toBe(true)
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
    expect(screen.getByTestId('local-data-notice').textContent).toMatch(/not backed up/)
  })

  it('sends an already signed-in user away from the sign-in page', async () => {
    const f = createFakeAuthClient(fakeSession)
    setup(createAuthController(f.client, opts), '/login')
    await settled()
    expect(appIsVisible()).toBe(true)
  })
})

describe('login and logout', () => {
  it('shows an error for wrong credentials and stays on the form', async () => {
    const f = createFakeAuthClient(null)
    f.next.signIn = { error: { code: 'invalid_credentials' } }
    setup(createAuthController(f.client, opts), '/login')
    await settled()
    type('Email', 'qa@example.test')
    type('Password', 'wrong-password')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Incorrect email or password.'))
    expect(appIsVisible()).toBe(false)
  })

  it('validates empty input without calling Supabase', async () => {
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/login')
    await settled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/email/i))
    expect(f.calls.some((c) => c.method === 'signIn')).toBe(false)
  })

  it('signs in, shows the app, then signs out back to the sign-in page', async () => {
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/login')
    await settled()
    type('Email', 'qa@example.test')
    type('Password', 'right-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(appIsVisible()).toBe(true))
    expect(screen.getAllByText('qa@example.test').length).toBeGreaterThan(0)

    fireEvent.click(screen.getAllByRole('button', { name: /Sign out/ })[0])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
    expect(appIsVisible()).toBe(false)
  })

  it('reacts to the session ending elsewhere (expiry) with a notice', async () => {
    const f = createFakeAuthClient(fakeSession)
    setup(createAuthController(f.client, opts), '/')
    await settled()
    expect(appIsVisible()).toBe(true)
    act(() => f.emit('SIGNED_OUT', null))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
    expect(screen.getByRole('status').textContent).toMatch(/session has ended/)
  })
})

describe('registration, confirmation and recovery', () => {
  it('registration asks the user to confirm their email', async () => {
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/register')
    await settled()
    type('Email', 'new@example.test')
    type(/^Password/, 'a-long-password-1')
    type('Confirm password', 'a-long-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Check your email' })).toBeTruthy())
    expect(appIsVisible()).toBe(false) // not signed in until confirmed
  })

  it('registration form rejects mismatching passwords', async () => {
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/register')
    await settled()
    type('Email', 'new@example.test')
    type(/^Password/, 'a-long-password-1')
    type('Confirm password', 'another-password-2')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/do not match/))
  })

  it('registration can be closed: no link on sign-in, notice on /register', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    setup(c, '/login', false)
    await settled()
    expect(screen.queryByText('Create one')).toBeNull()
    cleanup()
    setup(c, '/register', false)
    await settled()
    expect(screen.getByText('Registration closed')).toBeTruthy()
    expect(screen.queryByLabelText('Confirm password')).toBeNull()
  })

  it('password reset request shows a neutral confirmation', async () => {
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/forgot-password')
    await settled()
    type('Email', 'qa@example.test')
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/If an account exists/))
  })

  it('a recovery link opens the new-password form on ANY route, then signs the user in', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    setup(c, '/calendar')
    await settled()
    act(() => f.emit('PASSWORD_RECOVERY', fakeSession))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeTruthy())
    expect(appIsVisible()).toBe(false)

    type(/^New password/, 'short')
    type('Confirm new password', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least/))

    type(/^New password/, 'brand-new-password-1')
    type('Confirm new password', 'brand-new-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Choose a new password' })).toBeNull())
  })

  it('an expired email link is explained on the sign-in page', async () => {
    const f = createFakeAuthClient(null)
    const c = createAuthController(f.client, opts)
    c.setNotice('That email link has expired or was already used. Request a new one.')
    setup(c, '/login')
    await settled()
    expect(screen.getByRole('status').textContent).toMatch(/expired/)
  })
})

describe('existing local data is preserved', () => {
  it('signing in, using the app and signing out never touches the calendar keys', async () => {
    localStorage.setItem(EVENTS_KEY, localEvents)
    localStorage.setItem('orbit.series.v1', '[]')
    const before = { ...localStorage }
    const f = createFakeAuthClient(null)
    setup(createAuthController(f.client, opts), '/login')
    await settled()
    type('Email', 'qa@example.test')
    type('Password', 'right-password-1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(appIsVisible()).toBe(true))
    fireEvent.click(screen.getAllByRole('button', { name: /Sign out/ })[0])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())

    expect(localStorage.getItem(EVENTS_KEY)).toBe(localEvents) // byte-identical
    expect(localStorage.getItem('orbit.series.v1')).toBe('[]')
    // The auth layer wrote nothing of its own (supabase-js owns session storage) and no credentials anywhere.
    expect({ ...localStorage }).toEqual(before)
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/password/i)
  })

  it('does not claim local events are backed up', async () => {
    const f = createFakeAuthClient(fakeSession)
    setup(createAuthController(f.client, opts), '/settings')
    await settled()
    expect(screen.getAllByText(/only in this browser/).length).toBeGreaterThan(1) // banner + account card
    expect(screen.queryByText(/synced|backed up to the cloud/i)).toBeNull()
  })
})

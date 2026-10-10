import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockSupabaseAuth, TEST_EMAIL, TEST_PASSWORD, trackOrigins } from './authMock'
import { ev, readStorage, seed } from './helpers'

const EVENTS_KEY = 'orbit.events.v1'
const localEvent = ev({
  id: 'local1',
  title: 'QA Local Event',
  category: 'personal',
  start: '2026-10-09T08:00:00.000Z',
  end: '2026-10-09T09:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
})
const RAW_EVENTS = JSON.stringify([localEvent])

const appVisible = (page: Page) => page.getByText('Quick actions')
const signInForm = (page: Page) => page.getByRole('heading', { name: 'Sign in' })

async function fillLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

const authKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sb-')))

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test.describe(`authentication flows (${vp.name} ${vp.width}x${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('unauthenticated visitors cannot reach any app route', async ({ page, context }) => {
      await seed(context, { raw: { [EVENTS_KEY]: RAW_EVENTS } })
      await mockSupabaseAuth(page)
      for (const route of ['/', '/calendar', '/study', '/insights', '/settings']) {
        await page.goto(`/#${route}`)
        await expect(signInForm(page)).toBeVisible()
        await expect(page).toHaveURL(/#\/login$/)
        await expect(appVisible(page)).toBeHidden()
        await expect(page.getByText('QA Local Event')).toBeHidden()
      }
    })

    test('wrong password is rejected; correct password signs in; session survives reload; sign-out ends it', async ({ page, context }) => {
      await seed(context, { raw: { [EVENTS_KEY]: RAW_EVENTS } })
      const log = await mockSupabaseAuth(page)
      const origins = trackOrigins(page)
      await page.goto('/')
      await expect(signInForm(page)).toBeVisible()

      // validation happens before any network call
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert')).toContainText('Enter your email address.')
      expect(log.requests.filter((r) => r.url.pathname.endsWith('/token'))).toHaveLength(0)

      await fillLogin(page, TEST_EMAIL, 'wrong-password-123')
      await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')
      await expect(appVisible(page)).toBeHidden()

      await page.getByLabel('Password').fill(TEST_PASSWORD)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(appVisible(page)).toBeVisible()
      await expect(page).toHaveURL(/#\/$/)
      await expect(page.getByTestId('local-data-notice')).toContainText('stored in your account')
      expect((await authKeys(page)).length).toBe(1) // session is stored by supabase-js, under its own key

      // Session restoration after a refresh
      await page.reload()
      await expect(appVisible(page)).toBeVisible()
      await expect(signInForm(page)).toBeHidden()
      // …and a direct link to a protected page works while signed in
      await page.goto('/#/settings')
      await expect(page.getByTestId('account-email')).toHaveText(TEST_EMAIL)
      // visiting /login while signed in goes back to the app
      await page.goto('/#/login')
      await expect(appVisible(page)).toBeVisible()

      // Sign out (Settings works at every viewport size)
      await page.goto('/#/settings')
      await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).first().click()
      await expect(signInForm(page)).toBeVisible()
      expect(await authKeys(page)).toEqual([])
      await page.goto('/#/calendar')
      await expect(signInForm(page)).toBeVisible()
      await page.reload()
      await expect(signInForm(page)).toBeVisible() // stays signed out after refresh

      // Local calendar data survived the whole flow untouched, and nothing sensitive lives in orbit.* keys
      expect(await readStorage(page, EVENTS_KEY)).toBe(RAW_EVENTS)
      const all = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('orbit.')))
      expect(JSON.stringify(all)).not.toContain(TEST_PASSWORD)
      expect(JSON.stringify(all)).not.toMatch(/access_token|refresh_token/)
      // Only the mock origin was contacted: no silent connection to any other project
      expect([...origins].filter((o) => !o.startsWith('http://localhost:5198'))).toEqual([])
      expect(log.requests.some((r) => r.url.pathname.endsWith('/logout'))).toBe(true)
    })

    test('events saved in this browser are NOT shown as the account’s data, and stay untouched', async ({ page, context }) => {
      await seed(context, { raw: { [EVENTS_KEY]: RAW_EVENTS } })
      await mockSupabaseAuth(page)
      await page.goto('/')
      await fillLogin(page, TEST_EMAIL, TEST_PASSWORD)
      await expect(appVisible(page)).toBeVisible()
      await page.goto('/#/calendar')
      await page.locator('[data-date="2026-10-09"]').click()
      await expect(page.getByRole('button', { name: /^QA Local Event/ })).toHaveCount(0)
      expect(await readStorage(page, EVENTS_KEY)).toBe(RAW_EVENTS)
      // …but they are offered for an explicit, optional import
      await page.goto('/#/settings')
      await expect(page.getByTestId('local-import')).toContainText('1 event')
    })

    test('registration: asks to confirm email, redirects to the app base URL (not a hash route)', async ({ page, baseURL }) => {
      const log = await mockSupabaseAuth(page)
      await page.goto('/#/login')
      await page.getByRole('link', { name: 'Create one' }).click()
      await page.getByLabel('Email').fill('new.user@example.test')
      await page.getByLabel(/^Password/).fill('a-long-secret-1')
      await page.getByLabel('Confirm password').fill('a-different-one-2')
      await page.getByRole('button', { name: 'Create account' }).click()
      await expect(page.getByRole('alert')).toContainText('do not match')
      await page.getByLabel('Confirm password').fill('a-long-secret-1')
      await page.getByRole('button', { name: 'Create account' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await expect(appVisible(page)).toBeHidden()
      const signup = log.requests.find((r) => r.url.pathname.endsWith('/signup'))!
      expect(signup.url.searchParams.get('redirect_to')).toBe(`${baseURL}/`)
      expect(signup.url.searchParams.get('redirect_to')).not.toContain('#')
    })

    test('password reset request + recovery link opens the new-password form and signs in', async ({ page, baseURL }) => {
      const log = await mockSupabaseAuth(page)
      await page.goto('/#/login')
      await page.getByRole('link', { name: 'Forgot password?' }).click()
      await page.getByLabel('Email').fill(TEST_EMAIL)
      await page.getByRole('button', { name: 'Send reset link' }).click()
      await expect(page.getByRole('status')).toContainText('If an account exists')
      const recover = log.requests.find((r) => r.url.pathname.endsWith('/recover'))!
      expect(recover.url.searchParams.get('redirect_to')).toBe(`${baseURL}/`)

      // The user clicks the emailed link: it returns to the site root with ?code= (PKCE)
      await page.goto('/?code=mock-recovery-code')
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
      await expect(appVisible(page)).toBeHidden()
      await page.getByLabel(/^New password/).fill('short')
      await page.getByLabel('Confirm new password').fill('short')
      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(page.getByRole('alert')).toContainText('at least')
      await page.getByLabel(/^New password/).fill('brand-new-password-1')
      await page.getByLabel('Confirm new password').fill('brand-new-password-1')
      await page.getByRole('button', { name: 'Update password' }).click()
      await expect(appVisible(page)).toBeVisible()
      expect(log.passwordUpdates).toEqual(['brand-new-password-1'])
      await expect(page).not.toHaveURL(/code=/) // the one-time code is removed from the address bar
    })

    test('email-confirmation link signs the new user in', async ({ page }) => {
      await mockSupabaseAuth(page)
      await page.goto('/#/register')
      await page.getByLabel('Email').fill('new.user@example.test')
      await page.getByLabel(/^Password/).fill('a-long-secret-1')
      await page.getByLabel('Confirm password').fill('a-long-secret-1')
      await page.getByRole('button', { name: 'Create account' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await page.goto('/?code=mock-confirm-code')
      await expect(appVisible(page)).toBeVisible()
      await expect(page).not.toHaveURL(/code=/)
    })

    test('an expired/used email link is explained and does not break routing', async ({ page }) => {
      await mockSupabaseAuth(page)
      await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
      await expect(signInForm(page)).toBeVisible()
      await expect(page.getByRole('status')).toContainText('expired or was already used')
      await expect(page).toHaveURL(/#\/login$/)
    })

    test('signing out in another tab ends this tab\'s session with a notice', async ({ context }) => {
      const a = await context.newPage()
      const b = await context.newPage()
      await mockSupabaseAuth(a)
      await mockSupabaseAuth(b)
      await a.goto('/')
      await fillLogin(a, TEST_EMAIL, TEST_PASSWORD)
      await expect(appVisible(a)).toBeVisible()
      await b.goto('/#/settings')
      await expect(b.getByTestId('account-email')).toBeVisible()
      await b.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).first().click()
      await expect(signInForm(b)).toBeVisible()
      await expect(signInForm(a)).toBeVisible({ timeout: 10_000 })
    })

    test('login page has no horizontal overflow and touch-sized controls', async ({ page }) => {
      await mockSupabaseAuth(page)
      await page.goto('/')
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      expect(sw).toBeLessThanOrEqual(cw)
      for (const loc of [page.getByLabel('Email'), page.getByLabel('Password'), page.getByRole('button', { name: 'Sign in' })]) {
        expect((await loc.boundingBox())!.height).toBeGreaterThanOrEqual(40)
      }
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0) // no app chrome while signed out
      await page.screenshot({ path: `e2e-artifacts/screenshots/auth-login-${vp.name}.png` })
    })
  })
}

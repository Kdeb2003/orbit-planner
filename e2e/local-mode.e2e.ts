import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

// Supabase is NOT configured for this project's dev server (see playwright.config.ts).
test.describe('local-only mode (Supabase not configured)', () => {
  test('sign-in routes explain the setup instead of crashing or connecting anywhere', async ({ page }) => {
    const external: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (u.protocol.startsWith('http') && u.origin !== 'http://localhost:5199') external.push(u.origin)
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    for (const route of ['/#/login', '/#/register', '/#/forgot-password']) {
      await page.goto(route)
      await expect(page.getByRole('heading', { name: 'Sign-in isn’t set up' })).toBeVisible()
      await expect(page.getByText('VITE_SUPABASE_URL is not set.')).toBeVisible()
      await expect(page.getByLabel('Password')).toHaveCount(0)
    }
    expect(errors).toEqual([])
    expect(external).toEqual([])
  })

  test('the calendar keeps working and says it is local-only', async ({ page }) => {
    await openApp(page)
    await expect(page.getByText('Quick actions')).toBeVisible()
    await page.goto('/#/settings')
    await expect(page.getByText('Local-only mode.')).toBeVisible()
  })
})

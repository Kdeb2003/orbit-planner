import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockSupabaseAuth, TEST_EMAIL, TEST_PASSWORD, USER_ID } from './authMock'
import { addEvent, goToCalendar } from './helpers'
import { fixturePdf, recordRequests, textOnly, uploadAndWait } from './timetableFixtures'

// With Supabase configured (mocked Auth/REST, no real project): the import page is behind sign-in and a full
// preview performs no calendar write. Existing cloud calendar behaviour keeps working afterwards.

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(TEST_EMAIL)
  await page.getByLabel('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Quick actions')).toBeVisible()
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved')
}

test.describe('import timetable with authentication configured', () => {
  test('signed-out visitors are sent to sign-in and the page never loads', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await page.goto('/#/import-timetable')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toHaveCount(0)
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
    expect(log.db.log).toEqual([]) // no calendar request while signed out
  })

  test('signed in: preview works, nothing is written to the cloud or to browser storage, calendar still works', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    const writesBefore = log.db.log.filter((l) => !l.startsWith('GET')).length
    const requests = recordRequests(page)

    await page.getByRole('link', { name: /Import timetable/ }).click()
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()
    await uploadAndWait(page, fixturePdf())
    await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Review sessions/ }).click()
    await page.locator('li[data-session-id]').first().getByRole('button', { name: /^Exclude/ }).click()
    await page.getByRole('button', { name: /Review summary/ }).click()
    await expect(page.getByTestId('preview-complete')).toBeVisible()

    // no cloud write, no PDF upload, nothing outside the app origin or the mocked auth/REST routes
    expect(log.db.log.filter((l) => !l.startsWith('GET')).length).toBe(writesBefore)
    expect(log.db.rowsOf('events', USER_ID)).toEqual([])
    expect(requests.filter((r) => /\/rest\/v1\//.test(r.url) && r.method !== 'GET')).toEqual([])
    expect(requests.filter((r) => r.postData && !/\/auth\/v1\//.test(r.url))).toEqual([])
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('orbit.')))
    expect(keys).toEqual([])
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => !k.startsWith('sb-')))).toEqual([])

    // the existing cloud calendar still saves events afterwards
    await page.getByRole('link', { name: 'Back to calendar' }).click()
    await goToCalendar(page)
    await addEvent(page, { title: 'After preview', category: 'University', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:30' })
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved')
    const rows = log.db.rowsOf('events', USER_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'After preview' })
  })

  test('an unsupported PDF is refused here too', async ({ page }) => {
    await mockSupabaseAuth(page)
    await signIn(page)
    await page.goto('/#/import-timetable')
    await uploadAndWait(page, textOnly())
    await expect(page.getByRole('alert')).toContainText('not a supported UTN timetable', { timeout: 30_000 })
    await expect(page.locator('li[data-session-id]')).toHaveCount(0)
  })
})

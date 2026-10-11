import { expect, test } from '@playwright/test'
import { mockSupabaseAuth, TEST_EMAIL, TEST_PASSWORD } from './authMock'

// The default build (VITE_ENABLE_PLANNER_COURSES unset, as in production) with sign-in configured: Courses do not exist.

test('feature off: no Plan entry, /plan/courses is not a route, and no request ever touches the courses table', async ({ page }) => {
  const log = await mockSupabaseAuth(page)
  const loaded: string[] = []
  page.on('request', (r) => loaded.push(r.url()))
  await page.goto('/')
  await page.getByLabel('Email').fill(TEST_EMAIL)
  await page.getByLabel('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Quick actions')).toBeVisible()
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved')

  const nav = page.getByRole('navigation', { name: 'Main' }).filter({ visible: true })
  await expect(nav.getByRole('link')).toHaveCount(5)
  await expect(nav.getByRole('link', { name: /Study/ })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Plan', exact: true })).toHaveCount(0)

  await page.goto('/#/plan/courses')
  await expect(page.getByText('Quick actions')).toBeVisible() // fell through to Today
  await expect(page.getByRole('heading', { level: 1, name: 'Courses', exact: true })).toHaveCount(0)
  await page.goto('/#/plan')
  await expect(page.getByText('Quick actions')).toBeVisible()

  // the calendar keeps working
  await page.getByRole('link', { name: 'Calendar' }).filter({ visible: true }).first().click()
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved')

  expect(log.db.log.filter((l) => / courses /.test(l))).toEqual([])
  expect(loaded.filter((u) => /\/rest\/v1\/courses|CoursesPage|cloud\/plannerApi\.ts|plannerSource|plannerMappers|courseInsights|SuggestPanel/.test(u))).toEqual([]) // not even the code is fetched
})

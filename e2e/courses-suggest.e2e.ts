import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockSupabaseAuth, TEST_EMAIL, TEST_PASSWORD, USER_ID } from './authMock'
import type { MockLog } from './authMock'

// Course suggestions and session matching with the feature ON (project "courses", dev server on port 5197) against the
// mocked Supabase. Synthetic data only.

const chip = (page: Page) => page.getByTestId('sync-status')
const dlg = (page: Page) => page.getByRole('dialog')
const eid = (n: number) => `e0e0e0e0-0000-4000-8000-${String(n).padStart(12, '0')}`
const cid = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(TEST_EMAIL)
  await page.getByLabel('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Quick actions')).toBeVisible()
  await expect(chip(page)).toHaveAttribute('data-state', 'saved')
}

function seedEvent(log: MockLog, n: number, day: string, code: string | null, title: string, start = '09:00', end = '10:30') {
  log.db.seed('events', USER_ID, {
    id: eid(n), title, category: 'university', starts_at: `${day}T${start}:00+00:00`, ends_at: `${day}T${end}:00+00:00`, time_zone: 'Europe/Berlin',
    location: null, description: null, course_code: code, session_type: null, group_label: null,
  })
}
const seedCourse = (log: MockLog, row: Record<string, unknown>) =>
  log.db.seed('courses', USER_ID, { code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c1', archived_at: null, ...row })

async function openSuggest(page: Page) {
  await page.goto('/#/plan/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
  const btn = page.getByRole('button', { name: /Suggest from my calendar/ }).first()
  await expect(btn).toBeEnabled()
  await btn.click()
  await expect(page.getByTestId('suggest-panel')).toBeVisible()
  await expect(page.getByText(/Waiting for your calendar/)).toHaveCount(0)
}

test.describe('Suggest from my calendar (feature on)', () => {
  test('suggest, edit, create selected: only courses are written, never calendar rows', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedEvent(log, 1, '2026-11-05', 'inf 101', 'Informatics')
    seedEvent(log, 2, '2026-11-12', 'INF  101', 'Informatics')
    seedEvent(log, 3, '2026-11-09', 'MA 1', 'Calculus')
    await signIn(page)
    const eventsBefore = JSON.stringify(log.db.rowsOf('events', USER_ID))
    await openSuggest(page)
    const row = page.locator('[data-suggestion="INF 101"]')
    await expect(row).toContainText('2 sessions')
    await expect(row).toContainText('Suggested from calendar — please check.')
    expect(log.db.rowsOf('courses', USER_ID)).toHaveLength(0) // nothing yet
    await row.getByLabel(/Select INF 101/).check()
    await row.getByLabel('Suggested course name').fill('Introduction to Informatics')
    await page.getByRole('button', { name: /Create selected \(1\)/ }).click()
    await expect(page.getByTestId('suggest-summary')).toContainText('Created 1 of 1')
    await expect(page.locator('[data-suggestion="INF 101"]')).toHaveCount(0)
    await expect(page.locator('[data-suggestion="MA 1"]')).toBeVisible()
    expect(log.db.rowsOf('courses', USER_ID)).toHaveLength(1)
    expect(log.db.rowsOf('courses', USER_ID)[0]).toMatchObject({ name: 'Introduction to Informatics', code: 'INF 101', term_start: '2026-11-05', term_end: '2026-11-12' })
    expect(JSON.stringify(log.db.rowsOf('events', USER_ID))).toBe(eventsBefore)
    expect(log.db.log.filter((l) => /^(POST|PATCH|DELETE) (events|recurring_series|series_exceptions)/.test(l))).toEqual([])
    // the new course card shows how the sessions match
    await expect(page.getByTestId('match-summary').first()).toContainText('matched by term dates')
  })

  test('a range longer than one term is flagged and never silently shortened', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedEvent(log, 1, '2025-09-01', 'LONG 1', 'Long running')
    seedEvent(log, 2, '2027-01-15', 'LONG 1', 'Long running')
    await signIn(page)
    await openSuggest(page)
    const row = page.locator('[data-suggestion="LONG 1"]')
    await expect(row.getByLabel('Term start')).toHaveValue('2025-09-01')
    await expect(row.getByTestId('range-too-long')).toBeVisible()
    await row.getByLabel(/Select LONG 1/).check()
    await page.getByRole('button', { name: /Create selected/ }).click()
    await expect(page.getByText(/every selected course needs a correction/)).toBeVisible()
    expect(log.db.rowsOf('courses', USER_ID)).toHaveLength(0)
  })

  test('outside-term and ambiguous groups, and the matching counts on cards', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedEvent(log, 1, '2027-03-15', 'X 1', 'Spring lecture')
    seedEvent(log, 2, '2026-11-10', 'Y 1', 'Shared')
    seedEvent(log, 3, '2026-11-10', 'X 1', 'Winter lecture')
    seedCourse(log, { id: cid(1), name: 'Winter course', code: 'X 1', term_start: '2026-10-01', term_end: '2027-02-28' })
    seedCourse(log, { id: cid(2), name: 'Course P', code: 'Y 1', institution: 'P' })
    seedCourse(log, { id: cid(3), name: 'Course Q', code: 'Y 1', institution: 'Q' })
    await signIn(page)
    await openSuggest(page)
    await expect(page.locator('[data-outside="X 1"]')).toContainText('fall outside the term dates of Winter course')
    await expect(page.locator('[data-ambiguous="Y 1"]')).toContainText('could belong to more than one course')
    const winter = page.getByRole('heading', { level: 3, name: 'Winter course' }).locator('xpath=ancestor::li')
    await expect(winter.getByTestId('match-summary')).toContainText('1 matched by term dates')
    await expect(winter.getByTestId('code-level-counts')).toContainText('1 outside every term')
    await page.locator('[data-outside="X 1"]').getByRole('button', { name: 'Create a course for this term' }).click()
    await expect(dlg(page).getByTestId('course-hint')).toContainText('Suggested from calendar — please check')
    await expect(dlg(page).getByLabel(/Course code/)).toHaveValue('X 1')
    await expect(dlg(page).getByLabel('Term start')).toHaveValue('2027-03-15')
    expect(log.db.rowsOf('courses', USER_ID)).toHaveLength(3) // nothing saved by opening it
  })

  test('keyboard: select with Space, create with Enter', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedEvent(log, 1, '2026-11-05', 'KB 1', 'Keyboard course')
    await signIn(page)
    await openSuggest(page)
    const box = page.getByLabel(/Select KB 1/)
    await box.focus()
    await page.keyboard.press('Space')
    await expect(box).toBeChecked()
    const create = page.getByRole('button', { name: /Create selected \(1\)/ })
    await create.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('suggest-summary')).toContainText('Created 1 of 1')
    expect(log.db.rowsOf('courses', USER_ID)).toHaveLength(1)
  })

  test('a failed refresh labels the suggestions as possibly out of date', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedEvent(log, 1, '2026-11-05', 'NEW 1', 'A lecture')
    await signIn(page)
    await openSuggest(page)
    log.db.offline = true
    await page.waitForTimeout(2300) // the app's refresh trigger has a 2 s minimum gap
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.getByTestId('suggest-stale')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-suggestion="NEW 1"]')).toBeVisible()
  })
})

test.describe('course notes on Today and Calendar', () => {
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())

  test('a session with one matching course shows a read-only note; ambiguous ones show none; the flag-off app is unchanged', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    const day = today()
    seedEvent(log, 1, day, 'ONE 1', 'Matched lecture', '18:00', '19:00')
    seedEvent(log, 2, day, 'AMB 1', 'Ambiguous lecture', '19:30', '20:30')
    seedCourse(log, { id: cid(1), name: 'Linear Algebra', code: 'one 1', color: 'c4' })
    seedCourse(log, { id: cid(2), name: 'P', code: 'AMB 1' })
    seedCourse(log, { id: cid(3), name: 'Q', code: 'AMB 1' })
    await signIn(page)
    const notes = page.getByTestId('course-annotation')
    await expect(notes.first()).toBeVisible()
    // the same session may be listed twice on Today (day list and Up next); every note is the one matching course
    await expect(notes.filter({ hasNotText: 'Linear Algebra' })).toHaveCount(0)
    await expect(notes.first()).toContainText('Linear Algebra')
    await expect(notes.first()).toContainText('Matched by code')
    await expect(page.getByText('Ambiguous lecture').first()).toBeVisible()
    expect(log.db.log.filter((l) => /^(POST|PATCH|DELETE) (events|recurring_series|series_exceptions)/.test(l))).toEqual([])
  })
})

test.describe('responsive layout of the suggestion panel', () => {
  for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 768, 1024], ['mobile', 390, 844], ['small mobile', 320, 640]] as const) {
    test(`${name} (${width}px): no horizontal overflow, 44px targets`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      const log = await mockSupabaseAuth(page)
      seedEvent(log, 1, '2026-11-05', 'A VERY LONG COURSE CODE 12345', 'A very long session title that has to wrap on narrow screens instead of overflowing')
      seedEvent(log, 2, '2026-11-06', 'B 2', 'Second')
      seedEvent(log, 3, '2027-03-15', 'X 1', 'Spring')
      seedEvent(log, 4, '2026-11-10', 'Y 1', 'Shared')
      seedCourse(log, { id: cid(1), name: 'Winter course', code: 'X 1', term_start: '2026-10-01', term_end: '2027-02-28' })
      seedCourse(log, { id: cid(2), name: 'Course P with a rather long name', code: 'Y 1', institution: 'P' })
      seedCourse(log, { id: cid(3), name: 'Course Q', code: 'Y 1', institution: 'Q' })
      await signIn(page)
      await openSuggest(page)
      await expect(page.locator('[data-ambiguous="Y 1"]')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="suggest-panel"] button, [data-testid="suggest-panel"] input:not([type=radio]), [data-testid="suggest-panel"] textarea')]
          .filter((el) => el.offsetParent !== null)
          .filter((el) => {
            const r = el.getBoundingClientRect()
            const box = el.closest('label')?.getBoundingClientRect() ?? r
            return r.width > 0 && Math.max(r.height, box.height) < 43.5
          })
          .map((el) => `${el.tagName} ${el.textContent?.trim().slice(0, 30) ?? ''}`),
      )
      expect(small).toEqual([])
    })
  }
})

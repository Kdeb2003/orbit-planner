import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mockSupabaseAuth, TEST_EMAIL, TEST_EMAIL_2, TEST_PASSWORD, TEST_PASSWORD_2, USER_ID, USER_ID_2 } from './authMock'
import { MockCloudDb } from './cloudMock'

// Courses UI with the feature ON (dev server on port 5197) against the mocked Supabase (Auth + REST). Synthetic data only;
// no real project, credentials or personal data. The mock imitates PostgREST/RLS; real constraints are covered by the SQL tests.

const chip = (page: Page) => page.getByTestId('sync-status')
const dlg = (page: Page) => page.getByRole('dialog')
const courses = (db: MockCloudDb, user = USER_ID) => db.rowsOf('courses', user)

async function signIn(page: Page, email = TEST_EMAIL, password = TEST_PASSWORD) {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Quick actions')).toBeVisible()
  await expect(chip(page)).toHaveAttribute('data-state', 'saved')
}

async function openCourses(page: Page) {
  await page.goto('/#/plan/courses')
  await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
}

const seedCourse = (db: MockCloudDb, row: Record<string, unknown>, user = USER_ID) =>
  db.seed('courses', user, { code: null, institution: null, term_label: null, term_start: null, term_end: null, description: null, color: 'c1', archived_at: null, ...row })

const ids = (n: number) => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`

async function add(page: Page, v: { name: string; code?: string; institution?: string; term?: string; start?: string; end?: string }) {
  await page.getByRole('button', { name: 'Add course' }).first().click()
  const d = dlg(page)
  await d.getByLabel('Course name').fill(v.name)
  if (v.code) await d.getByLabel(/Course code/).fill(v.code)
  if (v.institution) await d.getByLabel(/Institution/).fill(v.institution)
  if (v.term) await d.getByLabel(/Term \/ semester/).fill(v.term)
  if (v.start) await d.getByLabel('Term start').fill(v.start)
  if (v.end) await d.getByLabel('Term end').fill(v.end)
  await d.getByRole('button', { name: 'Add course' }).click()
}

test.describe('Courses (feature on)', () => {
  test('navigation: one Plan entry, five slots, Courses section, Study Planner stays reachable', async ({ page }) => {
    await mockSupabaseAuth(page)
    await signIn(page)
    const nav = page.getByRole('navigation', { name: 'Main' }).filter({ visible: true })
    await expect(nav.getByRole('link')).toHaveCount(5)
    await expect(nav.getByRole('link', { name: 'Plan', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: /Tasks|Exams/ })).toHaveCount(0)
    await nav.getByRole('link', { name: 'Plan', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Plan sections' }).getByRole('link', { name: /Study planner/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Study Planner' })).toBeVisible()
    await expect(page.getByText('Demo data').first()).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Plan', exact: true })).toHaveAttribute('aria-current', 'page')
  })

  test('empty state, add (name only), persists across reload, then edit, archive, restore, delete — with no calendar writes', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    const eventWritesBefore = log.db.log.filter((l) => /^(POST|PATCH|DELETE) (events|recurring_series|series_exceptions)/.test(l)).length
    await openCourses(page)
    await expect(page.getByRole('heading', { name: 'No courses yet' })).toBeVisible()

    await add(page, { name: 'Linear Algebra' })
    await expect(dlg(page)).toBeHidden()
    await expect(page.getByRole('heading', { level: 3, name: 'Linear Algebra' })).toBeVisible()
    expect(courses(log.db)).toHaveLength(1)
    expect(courses(log.db)[0]).toMatchObject({ name: 'Linear Algebra', code: null, institution: null, term_start: null })

    await page.reload()
    await expect(page.getByRole('heading', { level: 3, name: 'Linear Algebra' })).toBeVisible()

    await page.getByRole('button', { name: 'Edit Linear Algebra' }).click()
    await dlg(page).getByLabel(/Course code/).fill('MATH 101')
    await dlg(page).getByLabel('Term start').fill('2026-10-12')
    await dlg(page).getByLabel('Term end').fill('2027-02-12')
    await dlg(page).getByRole('radio', { name: 'Green' }).check({ force: true })
    await dlg(page).getByRole('button', { name: 'Save changes' }).click()
    await expect(dlg(page)).toBeHidden()
    expect(courses(log.db)[0]).toMatchObject({ code: 'MATH 101', term_start: '2026-10-12', term_end: '2027-02-12', color: 'c4' })
    await expect(page.getByText('12 Oct 2026')).toBeVisible()

    await page.getByRole('button', { name: 'Archive Linear Algebra' }).click()
    await expect(dlg(page)).toContainText('Nothing is deleted')
    await dlg(page).getByRole('button', { name: 'Archive course' }).click()
    await expect(dlg(page)).toBeHidden()
    const archived = page.getByRole('region', { name: /Archived courses/ })
    await expect(archived.getByRole('heading', { level: 3, name: 'Linear Algebra' })).toBeVisible()
    await expect(archived).toContainText('Archived')
    expect(courses(log.db)[0].archived_at).not.toBeNull()

    await archived.getByRole('button', { name: 'Restore Linear Algebra' }).click()
    await expect(page.getByRole('heading', { name: /Active courses \(1\)/ })).toBeVisible()
    expect(courses(log.db)[0].archived_at).toBeNull()

    await page.getByRole('button', { name: 'Delete Linear Algebra' }).click()
    await expect(dlg(page)).toContainText('Calendar events are never changed or deleted')
    await dlg(page).getByRole('button', { name: 'Delete course' }).click()
    await expect(page.getByRole('heading', { name: 'No courses yet' })).toBeVisible()
    expect(courses(log.db)).toHaveLength(0)

    // not a single calendar write happened during all of this
    expect(log.db.log.filter((l) => /^(POST|PATCH|DELETE) (events|recurring_series|series_exceptions)/.test(l)).length).toBe(eventWritesBefore)
  })

  test('validation is inline, focuses the first problem, and sends nothing', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    await openCourses(page)
    await page.getByRole('button', { name: 'Add course' }).first().click()
    const writes = () => log.db.log.filter((l) => /^(POST|PATCH) courses/.test(l)).length
    await dlg(page).getByRole('button', { name: 'Add course' }).click()
    await expect(dlg(page).getByRole('alert').filter({ hasText: 'Name is required.' })).toBeVisible()
    await expect(dlg(page).getByLabel('Course name')).toBeFocused()
    await expect(dlg(page).getByLabel('Course name')).toHaveAttribute('aria-invalid', 'true')
    await dlg(page).getByLabel('Course name').fill('X')
    await dlg(page).getByLabel('Term start').fill('2026-10-12')
    await dlg(page).getByRole('button', { name: 'Add course' }).click()
    await expect(dlg(page)).toContainText('Set both term dates or neither.')
    await dlg(page).getByLabel('Term end').fill('2026-10-01')
    await expect(dlg(page)).toContainText('Term end cannot be before term start.')
    await dlg(page).getByLabel('Term end').fill('2027-12-31')
    await expect(dlg(page)).toContainText('A term can span at most 400 days.')
    expect(writes()).toBe(0)
  })

  test('duplicate: field error, existing course can be located, nothing is overwritten', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedCourse(log.db, { id: ids(1), name: 'Linear Algebra', code: 'MATH 101', institution: 'Uni', term_label: 'WS' })
    await signIn(page)
    await openCourses(page)
    await add(page, { name: 'Again', code: ' math  101 ', institution: 'uni', term: 'ws' })
    await expect(dlg(page).getByLabel(/Course code/)).toHaveAttribute('aria-invalid', 'true')
    await expect(dlg(page)).toContainText('already exists')
    await expect(dlg(page).getByLabel('Course name')).toHaveValue('Again')
    expect(courses(log.db)).toHaveLength(1)
    await dlg(page).getByRole('button', { name: /Show the existing course/ }).click()
    await expect(dlg(page)).toBeHidden()
    await expect(page.locator(`#course-${ids(1)}`)).toBeFocused()
  })

  test('same code in another term is allowed and the shared-code warning appears only where sessions could be ambiguous', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedCourse(log.db, { id: ids(1), name: 'Databases WS', code: 'DB 1', term_label: 'WS 26/27', term_start: '2026-10-01', term_end: '2027-02-01' })
    seedCourse(log.db, { id: ids(2), name: 'Undated A', code: 'OS 1' })
    await signIn(page)
    await openCourses(page)
    await add(page, { name: 'Databases SS', code: 'DB 1', term: 'SS 27', start: '2027-04-01', end: '2027-08-01' })
    await expect(dlg(page)).toBeHidden()
    expect(courses(log.db)).toHaveLength(3)
    await expect(page.getByTestId('shared-code-warning')).toHaveCount(0)
    await add(page, { name: 'Undated B', code: 'OS 1' })
    await expect(dlg(page).getByTestId('dialog-shared-warning')).toBeVisible()
  })

  test('stale edit: input is kept, saving waits for review, and the newer server data is never overwritten silently', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedCourse(log.db, { id: ids(1), name: 'Linear Algebra', code: 'MATH 101' })
    await signIn(page)
    await openCourses(page)
    await page.getByRole('button', { name: 'Edit Linear Algebra' }).click()
    await dlg(page).getByLabel('Course name').fill('My laptop edit')
    Object.assign(courses(log.db)[0], { name: 'Phone edit', updated_at: '2026-10-10T00:00:00.000999+00:00' }) // another device saved first
    await dlg(page).getByRole('button', { name: 'Save changes' }).click()
    const review = page.getByTestId('stale-review')
    await expect(review).toContainText('Another device or tab changed this course')
    await expect(review).toContainText('Phone edit')
    await expect(dlg(page).getByLabel('Course name')).toHaveValue('My laptop edit')
    await expect(dlg(page).getByRole('button', { name: 'Save changes' })).toBeDisabled()
    expect(courses(log.db)[0].name).toBe('Phone edit')
    await review.getByRole('button', { name: 'Use the latest values' }).click()
    await expect(dlg(page).getByLabel('Course name')).toHaveValue('Phone edit')
    await dlg(page).getByRole('button', { name: 'Save changes' }).click()
    await expect(dlg(page)).toBeHidden()
  })

  test('network failure: never claims success, keeps input, the retry creates exactly one course', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    await openCourses(page)
    log.db.offline = true
    await add(page, { name: 'Offline attempt' })
    await expect(page.getByTestId('course-save-error')).toContainText('could not confirm whether this was saved')
    await expect(dlg(page).getByLabel('Course name')).toHaveValue('Offline attempt')
    log.db.offline = false
    await dlg(page).getByRole('button', { name: 'Add course' }).click()
    await expect(dlg(page)).toBeHidden()
    expect(courses(log.db)).toHaveLength(1)
    await expect(page.getByRole('heading', { level: 3, name: 'Offline attempt' })).toHaveCount(1)
  })

  test('missing courses table: clear message, calendar unaffected', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    log.db.coursesInstalled = false
    await signIn(page)
    await openCourses(page)
    await expect(page.getByText('Courses are not available on this server yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add course' }).first()).toBeDisabled()
    await page.getByRole('link', { name: 'Calendar' }).filter({ visible: true }).first().click()
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved')
  })

  test('accounts: another user never sees these courses; sign-out clears the page', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    seedCourse(log.db, { id: ids(1), name: 'Alice course' })
    seedCourse(log.db, { id: ids(2), name: 'Bob course' }, USER_ID_2)
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page)
    await openCourses(page)
    await expect(page.getByRole('heading', { level: 3, name: 'Alice course' })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(await page.content()).not.toContain('Alice course')
    await signIn(page, TEST_EMAIL_2, TEST_PASSWORD_2)
    await openCourses(page)
    await expect(page.getByRole('heading', { level: 3, name: 'Bob course' })).toBeVisible()
    expect(await page.content()).not.toContain('Alice course')
    expect(courses(log.db, USER_ID_2)).toHaveLength(1)
  })
})

test.describe('Courses accessibility and responsive layout', () => {
  async function seeded(page: Page) {
    const log = await mockSupabaseAuth(page)
    seedCourse(log.db, { id: ids(1), name: 'A very long course name that must wrap instead of overflowing the narrow screen width', code: 'LONGCODE-1234567890', institution: 'An institution with a rather long name as well', term_label: 'WS 26/27', term_start: '2026-10-12', term_end: '2027-02-12', description: 'Synthetic description text', color: 'c3' })
    seedCourse(log.db, { id: ids(2), name: 'Shared A', code: 'SH 1' })
    seedCourse(log.db, { id: ids(3), name: 'Shared B', code: 'SH 1' })
    seedCourse(log.db, { id: ids(4), name: 'Old course', code: 'OLD 1', archived_at: '2026-01-05T10:00:00+00:00', color: 'c8' })
    await signIn(page)
    await openCourses(page)
    await expect(page.getByRole('heading', { level: 3, name: 'Old course' })).toBeVisible()
    return log
  }

  const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  const smallTargets = (scope: Page) =>
    scope.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden]), textarea')]
        .filter((el) => el.offsetParent !== null && !el.closest('.sr-only') && el.getAttribute('type') !== 'radio')
        .filter((el) => {
          const r = el.getBoundingClientRect()
          const box = el.closest('label')?.getBoundingClientRect() ?? r
          return r.width > 0 && Math.max(r.height, box.height) < 43.5
        })
        .map((el) => `${el.tagName} ${el.textContent?.trim().slice(0, 30) ?? ''}`),
    )

  for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 768, 1024], ['mobile', 390, 844], ['small mobile', 320, 640]] as const) {
    test(`${name} (${width}px): no horizontal overflow, 44px targets, dialogs fit`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await seeded(page)
      expect(await noOverflow(page)).toBe(true)
      expect(await smallTargets(page)).toEqual([])
      await page.getByRole('button', { name: 'Add course' }).first().click()
      await expect(dlg(page)).toBeVisible()
      expect(await noOverflow(page)).toBe(true)
      const box = (await dlg(page).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(await smallTargets(page)).toEqual([])
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Delete Old course' }).click()
      expect(await noOverflow(page)).toBe(true)
      const cbox = (await dlg(page).boundingBox())!
      expect(cbox.x + cbox.width).toBeLessThanOrEqual(width)
      if (width < 768) {
        await page.getByRole('button', { name: 'Cancel' }).click()
        await expect(page.getByRole('navigation', { name: 'Main' }).filter({ visible: true }).getByRole('link')).toHaveCount(5)
      }
    })
  }

  test('keyboard: dialog opens with focus on the first field, Escape closes and returns focus, form is fully operable by keyboard', async ({ page }) => {
    const log = await seeded(page)
    const addBtn = page.getByRole('button', { name: 'Add course' }).first()
    await addBtn.focus()
    await page.keyboard.press('Enter')
    await expect(dlg(page).getByLabel('Course name')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dlg(page)).toBeHidden()
    await expect(addBtn).toBeFocused()

    await addBtn.press('Enter')
    await page.keyboard.type('Typed with the keyboard')
    // Tab through the fields to the colour group and pick one with the arrow keys, then submit with Enter
    await dlg(page).getByRole('radio', { name: 'Violet' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(dlg(page).getByRole('radio', { name: 'Blue' })).toBeChecked()
    await dlg(page).getByLabel('Course name').press('Enter')
    await expect(dlg(page)).toBeHidden()
    expect(courses(log.db).find((c) => c.name === 'Typed with the keyboard')).toMatchObject({ color: 'c2' })
  })

  test('semantics: headings, named controls, associated errors, archived status as text', async ({ page }) => {
    await seeded(page)
    await expect(page.getByRole('heading', { level: 2, name: /Active courses/ })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: /Archived courses/ })).toBeVisible()
    await expect(page.getByRole('region', { name: /Archived courses/ })).toContainText('Archived')
    await page.getByRole('button', { name: 'Add course' }).first().click()
    await expect(dlg(page)).toHaveAccessibleName('Add course')
    for (const l of ['Course name', /Course code/, /Institution/, /Term \/ semester/, 'Term start', 'Term end', /Description/]) await expect(dlg(page).getByLabel(l)).toBeVisible()
    await dlg(page).getByRole('button', { name: 'Add course' }).click()
    const name = dlg(page).getByLabel('Course name')
    const describedBy = await name.getAttribute('aria-describedby')
    expect(describedBy).toContain('-error')
    for (const part of describedBy!.split(' ')) await expect(page.locator(`[id="${part}"]`)).toHaveCount(1)
    await expect(dlg(page).getByRole('alert').first()).toBeVisible()
  })

  test('reduced motion: the saving spinner does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const log = await seeded(page)
    log.db.delayMs = 800
    await page.getByRole('button', { name: 'Add course' }).first().click()
    await dlg(page).getByLabel('Course name').fill('Slow')
    await dlg(page).getByRole('button', { name: 'Add course' }).click()
    const spinner = dlg(page).locator('svg.lucide-loader-circle')
    await expect(spinner).toBeVisible()
    expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await expect(dlg(page)).toBeHidden()
  })
})

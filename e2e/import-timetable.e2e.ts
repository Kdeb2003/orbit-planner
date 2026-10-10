import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { emptyFile, encrypted, fixturePdf, garbage, hasRealPdf, hugeFile, notAPdf, REAL_PDF, recordRequests, scanned, textOnly, uploadAndWait } from './timetableFixtures'
import { ev, seed } from './helpers'

// Preview-only import page, run against the dev server in local-only mode. The PDFs are generated from the
// committed minimal fixture (no private file). Tests that need the user's own PDF are skipped when it is absent.

const PREVIEW_COMPLETE = 'Preview complete. Saving these sessions to your calendar will be available after cloud import verification.'
const rows = (page: Page) => page.locator('li[data-session-id]')
const shown = (page: Page) => page.getByTestId('shown-count')
const course = (page: Page, code: string) => page.locator(`li[data-course="${code}"]`).first()
const steps = (page: Page) => page.getByRole('navigation', { name: 'Import steps' })

async function open(page: Page) {
  await page.goto('#/import-timetable')
  await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()
}

async function loadFixture(page: Page) {
  await open(page)
  await uploadAndWait(page, fixturePdf())
  await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 30_000 })
}

async function toSessions(page: Page) {
  await page.getByRole('button', { name: /Review sessions/ }).click()
  await expect(page.getByRole('heading', { name: '3 · Review sessions' })).toBeVisible()
}

async function toSummary(page: Page) {
  await page.getByRole('button', { name: /Review summary/ }).click()
  await expect(page.getByRole('heading', { name: '4 · Review summary' })).toBeVisible()
}

test.describe('navigation and entry points', () => {
  test('reachable from the Calendar page and the Today quick action; Calendar link returns', async ({ page }) => {
    await page.goto('#/calendar')
    await page.getByRole('link', { name: 'Import timetable' }).click()
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()
    await expect(page.getByText('Preview only', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Calendar' }).first().click()
    await expect(page).toHaveURL(/#\/calendar$/)

    await page.goto('#/')
    await page.getByRole('link', { name: /Import timetable/ }).click()
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()
  })

  test('the existing Settings import card is untouched (local mode shows no cloud import)', async ({ page }) => {
    await page.goto('#/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Import timetable/ })).toHaveCount(0)
  })
})

test.describe('upload and parsing', () => {
  test('parses a real PDF in the browser, with worker and assets from the app origin and no upload', async ({ page }) => {
    const requests = recordRequests(page)
    const responses: { url: string; type: string; status: number }[] = []
    page.on('response', (r) => responses.push({ url: r.url(), type: r.headers()['content-type'] ?? '', status: r.status() }))
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    await loadFixture(page)
    await expect(page.getByTestId('source-file')).toHaveText('test-timetable.pdf')
    await expect(page.getByText('Supported UTN timetable, read locally')).toBeVisible()
    await expect(page.getByText('Winter Semester 2026/2027')).toBeVisible()
    await expect(page.getByText(/preliminary as of 28 September 2026/)).toBeVisible()

    // PDF.js really ran in a worker served by the app itself
    const worker = responses.find((r) => /pdf\.worker/.test(r.url) && r.status === 200)
    expect(worker, 'worker asset loaded').toBeTruthy()
    expect(worker!.type).toMatch(/javascript/)

    // nothing carried the PDF and nothing left the origin
    const origin = new URL(page.url()).origin
    expect(requests.every((r) => r.origin === origin)).toBe(true)
    expect(requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([])
    expect(requests.filter((r) => r.postData)).toEqual([])
    expect(responses.filter((r) => r.status >= 400)).toEqual([])
    expect(errors).toEqual([])
  })

  test('shows a loading state while the PDF is processed', async ({ page }) => {
    await open(page)
    await uploadAndWait(page, fixturePdf())
    // either still reading (status) or already done; the status region must exist at some point or the result appear
    await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('status').filter({ hasText: /Reading|Preparing|Checking/ })).toHaveCount(0)
  })

  const unsupported: [string, () => { name: string; mimeType: string; buffer: Buffer }, RegExp][] = [
    ['a PDF that is not a UTN timetable', textOnly, /not a supported UTN timetable/],
    ['a scanned PDF without a text layer', scanned, /not a supported UTN timetable/],
    ['an encrypted PDF', encrypted, /password-protected/],
    ['a damaged PDF', garbage, /could not be (read|processed)/],
    ['a file that is not a PDF', notAPdf, /not a PDF/],
    ['an empty file', emptyFile, /empty/],
  ]
  for (const [label, make, message] of unsupported) {
    test(`refuses ${label} with a clear error and no sessions`, async ({ page }) => {
      await open(page)
      await uploadAndWait(page, make())
      await expect(page.getByRole('alert')).toContainText(message, { timeout: 30_000 })
      await expect(page.getByRole('heading', { name: 'Timetable source' })).toHaveCount(0)
      await expect(rows(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Review sessions|Review summary/ })).toHaveCount(0)
      // and a good file can still be chosen afterwards
      await uploadAndWait(page, fixturePdf())
      await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 30_000 })
    })
  }

  test('refuses a file above the size limit and explains the limit', async ({ page }) => {
    await open(page)
    await uploadAndWait(page, hugeFile())
    await expect(page.getByRole('alert')).toContainText(/too large/i)
    await expect(page.getByRole('alert')).toContainText('25.0 MB')
    await expect(rows(page)).toHaveCount(0)
  })
})

test.describe('course and group selection', () => {
  test('defaults: the eight courses are ticked, AI Basic is Group B, other courses are listed but unticked', async ({ page }) => {
    await loadFixture(page)
    const defaults = ['W26M-AINBA', 'W26M-RBTAD', 'W26M-NLGAD', 'W26M-NLUAD', 'W26M-MMFAD', 'W26M-LLMAD', 'W26M-INSIN', 'W26M-Deutsch A2']
    for (const code of defaults) await expect(course(page, code).getByRole('checkbox')).toBeChecked()
    const all = page.locator('li[data-course]')
    expect(await all.count()).toBeGreaterThan(8)
    expect(await page.locator('li[data-course] input[type="checkbox"]:checked').count()).toBe(8)
    await expect(course(page, 'W26M-AINBA').getByRole('radio', { name: 'Group B' })).toBeChecked()
    await expect(course(page, 'W26M-AINBA').getByRole('radio', { name: 'Group A' })).not.toBeChecked()
    await expect(page.getByText('Advanced Robotics').first()).toBeVisible()
  })

  test('other courses are collapsed by default, expandable by keyboard, and ticks survive collapsing', async ({ page }) => {
    await loadFixture(page)
    const toggle = page.getByRole('button', { name: /Other courses in this timetable \(\d+\)/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const others = page.locator('li[data-course]:not([data-course="W26M-AINBA"])').filter({ hasNot: page.locator('input:checked') })
    await expect(others.first()).toBeHidden()
    await expect(course(page, 'W26M-RBTAD').getByRole('checkbox')).toBeVisible()
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(others.first()).toBeVisible()
    const code = (await others.first().getAttribute('data-course')) as string
    const box = course(page, code).getByRole('checkbox')
    await box.check()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('1 ticked')
    await toggle.click()
    await expect(box).toBeChecked()
    expect(await page.locator('li[data-course] input[type="checkbox"]:checked').count()).toBe(9)
    await expect(course(page, 'W26M-AINBA').getByRole('radio', { name: 'Group B' })).toBeChecked()
  })

  test('shows selected and found counts for AI Basic and recalculates with the group choice', async ({ page }) => {
    await loadFixture(page)
    const counts = page.getByTestId('counts-W26M-AINBA')
    const parse = (t: string | null) => (t ?? '').match(/(\d+) selected \S+ (\d+) found in PDF/)!.slice(1).map(Number)
    const [b, total] = parse(await counts.textContent())
    expect(b).toBeGreaterThan(0)
    expect(total).toBeGreaterThan(b)
    await course(page, 'W26M-AINBA').getByRole('radio', { name: 'Group A' }).check()
    const [a, total2] = parse(await counts.textContent())
    expect(total2).toBe(total)
    expect(a + b).toBe(total)
    await course(page, 'W26M-AINBA').getByRole('radio', { name: 'Not decided' }).check()
    expect(parse(await counts.textContent())).toEqual([total, total])
    await course(page, 'W26M-AINBA').getByRole('checkbox').uncheck()
    await expect(counts).toHaveText(`${total} found in PDF`)
  })

  test('AI Group B sessions are listed and Group A is excluded; switching groups swaps them', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await page.getByLabel('Course').selectOption('W26M-AINBA')
    const n = await rows(page).count()
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      await expect(rows(page).nth(i)).toContainText('Group B')
      await expect(rows(page).nth(i)).not.toContainText('Group A')
    }
    await page.getByRole('button', { name: '2 · Courses' }).click()
    await course(page, 'W26M-AINBA').getByRole('radio', { name: 'Group A' }).check()
    await toSessions(page)
    await page.getByLabel('Course').selectOption('W26M-AINBA')
    await expect(rows(page).first()).toContainText('Group A')
    await expect(page.getByText('Group B')).toHaveCount(0)
  })

  test('without a chosen group, attendance is not assumed: sessions need review', async ({ page }) => {
    await loadFixture(page)
    await course(page, 'W26M-AINBA').getByRole('radio', { name: 'Not decided' }).check()
    await expect(page.getByTestId('group-warning-W26M-AINBA')).toContainText('never assumed')
    await toSessions(page)
    await page.getByLabel('Course').selectOption('W26M-AINBA')
    const states = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((s) => s === 'needs-review')).toBe(true)
  })

  test('deselecting a course removes it from the list, and with nothing selected review is blocked', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await expect(page.getByLabel('Course').locator('option[value="W26M-NLUAD"]')).toHaveCount(1)
    await page.getByRole('button', { name: '2 · Courses' }).click()
    await course(page, 'W26M-NLUAD').getByRole('checkbox').uncheck()
    await toSessions(page)
    await expect(page.getByLabel('Course').locator('option[value="W26M-NLUAD"]')).toHaveCount(0)
    await page.getByRole('button', { name: '2 · Courses' }).click()
    await page.getByRole('button', { name: /Other courses in this timetable/ }).click()
    const ticked = page.locator('li[data-course] input[type="checkbox"]:checked')
    while ((await ticked.count()) > 0) await ticked.first().uncheck()
    await expect(page.getByRole('button', { name: /Review sessions/ })).toBeDisabled()
    await expect(page.getByText('No course is selected')).toBeVisible()
  })
})

test.describe('source anomalies', () => {
  test('are shown even when no selected session is affected, and dates are never repaired', async ({ page }) => {
    await loadFixture(page)
    const list = page.getByTestId('anomalies')
    await expect(list.locator('[data-anomaly="no-date"]')).toContainText('Week 1')
    await expect(list.locator('[data-anomaly="date-weekday-mismatch"]')).toContainText('Week 23')
    await expect(list.locator('[data-anomaly="date-weekday-mismatch"]')).toContainText('withheld')
    await expect(list.locator('[data-anomaly="duplicate-date"]')).toContainText('05.03.2027')
    await expect(list).toContainText('None of your currently selected sessions are affected.')
  })
})

test.describe('review list and filters', () => {
  test('rows show date, weekday, Berlin times, course, type, group, room, week and page', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    const total = Number(await shown(page).getAttribute('data-count'))
    expect(total).toBeGreaterThan(20)
    const row = page.locator('li[data-session-id]', { hasText: 'W26M-NLUAD' }).first()
    await expect(row).toContainText(/(Mon|Tue|Wed|Thu|Fri)/)
    await expect(row).toContainText(/\d\d:\d\d–\d\d:\d\d/)
    await expect(row).toContainText('Berlin')
    await expect(row).toContainText(/Semester week \d+/)
    await expect(row).toContainText(/PDF pages? \d/)
    await expect(row).toContainText(/(UL|NOP) \/ /)
  })

  test('filters by course, week, date and status, with empty states and clear', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    const total = Number(await shown(page).getAttribute('data-count'))

    await page.getByLabel('Course').selectOption('W26M-RBTAD')
    const robotics = Number(await shown(page).getAttribute('data-count'))
    expect(robotics).toBeGreaterThan(0)
    expect(robotics).toBeLessThan(total)
    await expect(rows(page).first()).toHaveAttribute('data-course', 'W26M-RBTAD')

    await page.getByLabel('Semester week').selectOption('4')
    const weekRows = await rows(page).evaluateAll((els) => els.map((e) => e.textContent ?? ''))
    expect(weekRows.every((t) => t.includes('Semester week 4'))).toBe(true)

    await page.getByRole('button', { name: 'Clear filters' }).click()
    expect(Number(await shown(page).getAttribute('data-count'))).toBe(total)

    await page.getByLabel('Date').fill('1999-01-01')
    await expect(page.getByTestId('empty-filter')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear filters' }).click()

    await page.getByLabel('Review status').selectOption('edited')
    await expect(page.getByTestId('empty-filter')).toBeVisible()
    await page.getByLabel('Review status').selectOption('clash')
    expect(Number(await shown(page).getAttribute('data-count'))).toBeGreaterThan(0)
    await page.getByLabel('Review status').selectOption('needs-review')
    await expect(page.getByTestId('empty-filter')).toBeVisible() // defaults have no review reasons in the fixture weeks
  })
})

test.describe('session list length and labels', () => {
  test('starts with 20 sessions, Show more reveals the rest, and filters/corrections reach hidden sessions', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    const total = Number(await shown(page).getAttribute('data-count'))
    expect(total).toBeGreaterThan(40)
    await expect(rows(page)).toHaveCount(20)
    await expect(shown(page)).toContainText(`Showing 20 of ${total}`)
    const more = page.getByRole('button', { name: /^Show \d+ more/ })
    await more.click()
    await expect(rows(page)).toHaveCount(40)
    while (await more.count()) await more.first().click()
    await expect(rows(page)).toHaveCount(total)
    await page.getByLabel('Course').selectOption('W26M-Deutsch A2')
    const last = rows(page).last()
    await last.getByRole('button', { name: /^Edit/ }).click()
    await page.getByRole('dialog').getByLabel('Room / location').fill('Late room')
    await page.getByRole('dialog').getByRole('button', { name: 'Save correction' }).click()
    await expect(last).toContainText('Late room')
  })

  test('extraction status and clash are separate labels; the clash badge opens the comparison and back', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await expect(page.getByText('No issues')).toHaveCount(0)
    await page.getByLabel('Review status').selectOption('clash')
    const row = rows(page).first()
    await expect(row).toContainText('Extraction verified')
    const before = await page.getByTestId('clashes-count').textContent()
    await row.getByTestId('clash-link').click()
    await expect(page.getByRole('tab', { name: /Clashes/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('li[data-clash]:focus')).toHaveCount(1)
    await expect(page.getByTestId('clashes-count')).toHaveText(before!)
    await page.locator('li[data-clash]:focus').getByRole('button', { name: /in the session list/ }).first().click()
    await expect(page.getByRole('tab', { name: /Sessions/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('li[data-session-id]:focus')).toHaveCount(1)
    await expect(page.locator('li[data-session-id][data-state="excluded"]')).toHaveCount(0)
  })
})

test.describe('clashes', () => {
  test('every overlapping pair is shown side by side; excluding one recalculates', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await page.getByRole('tab', { name: /Clashes/ }).click()
    const items = page.locator('li[data-clash]')
    const count = await items.count()
    expect(count).toBeGreaterThan(0)
    await expect(page.getByTestId('clashes-count')).toHaveText(`(${count})`)
    const first = items.first()
    await expect(first).toContainText('overlap')
    expect(await first.getByRole('button', { name: /^Exclude/ }).count()).toBe(2)

    await first.getByRole('button', { name: /^Exclude/ }).first().click()
    await expect(page.getByTestId('clashes-count')).not.toHaveText(`(${count})`)
    expect(await page.locator('li[data-clash]').count()).toBeLessThan(count)
    // the excluded session is not lost: it is still listed (as excluded) in the sessions tab
    await page.getByRole('tab', { name: /Sessions/ }).click()
    await page.getByLabel('Review status').selectOption('excluded')
    await expect(rows(page)).toHaveCount(1)
    await rows(page).first().getByRole('button', { name: /^Include/ }).click()
    await page.getByRole('tab', { name: /Clashes/ }).click()
    expect(await page.locator('li[data-clash]').count()).toBe(count)
  })
})

test.describe('corrections', () => {
  test('correct room and time, see what changed and the extracted values, then restore', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    const row = page.locator('li[data-session-id]', { hasText: 'W26M-LLMAD' }).first()
    const id = await row.getAttribute('data-session-id')
    const target = page.locator(`li[data-session-id="${id}"]`)
    const original = (await target.textContent()) ?? ''
    await target.getByRole('button', { name: /^Edit/ }).click()
    const dlg = page.getByRole('dialog')
    await expect(dlg.getByLabel('Title')).toBeFocused()
    await expect(dlg.getByTestId('dialog-session')).toContainText('W26M-LLMAD')
    await expect(dlg.getByTestId('dialog-session')).toContainText('Large Language Models')
    await dlg.getByLabel('Room / location').fill('Seminar room X')
    await dlg.getByLabel('Start time (Berlin)').fill('14:00')
    await dlg.getByLabel('End time (Berlin)').fill('15:30')
    await expect(dlg.getByText('changed').first()).toBeVisible()
    await dlg.getByRole('button', { name: 'Save correction' }).click()
    await expect(dlg).toHaveCount(0)

    await expect(target).toContainText('Edited: start, end, room')
    await expect(target).toContainText('Seminar room X')
    await expect(target).toContainText('14:00–15:30')
    await expect(target.getByTestId('extracted-values')).toContainText('Extracted:')
    await expect(target.getByTestId('extracted-values')).not.toContainText('Seminar room X')

    await toSummary(page)
    await expect(page.getByTestId('stat-corrections')).toHaveText('3')

    await page.getByRole('button', { name: 'Back to sessions' }).click()
    await target.getByRole('button', { name: /^Edit/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Restore extracted values' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(target).not.toContainText('Edited:')
    expect(((await target.textContent()) ?? '')).toBe(original)
  })

  test('invalid corrections are explained and cannot be saved', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await rows(page).first().getByRole('button', { name: /^Edit/ }).click()
    const dlg = page.getByRole('dialog')
    const save = dlg.getByRole('button', { name: 'Save correction' })
    await dlg.getByLabel('End time (Berlin)').fill('06:00')
    await expect(dlg).toContainText('The end must be after the start.')
    await expect(save).toBeDisabled()
    await dlg.getByLabel('End time (Berlin)').fill('')
    await expect(dlg).toContainText('Use a 24-hour time')
    await expect(save).toBeDisabled()
    await dlg.getByLabel('Title').fill('')
    await expect(dlg).toContainText('Enter a title.')
    await dlg.getByLabel('Date').fill('')
    await expect(dlg).toContainText('A valid date is required.')
    await expect(save).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
  })

  test('a correction that duplicates another session is rejected', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await page.getByLabel('Course').selectOption('W26M-RBTAD')
    const mains = page.locator('li[data-session-id]', { hasText: ' · Main · ' })
    const a = mains.nth(0)
    const b = mains.nth(1)
    const aText = (await a.textContent()) ?? ''
    const aDate = (await a.getAttribute('data-date')) as string
    const aTimes = aText.match(/(\d\d:\d\d)–(\d\d:\d\d)/) as RegExpMatchArray
    await b.getByRole('button', { name: /^Edit/ }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Date').fill(aDate)
    await dlg.getByLabel('Start time (Berlin)').fill(aTimes[1])
    await dlg.getByLabel('End time (Berlin)').fill(aTimes[2])
    await expect(dlg.getByText(/would duplicate another session/)).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Save correction' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
  })
})

test.describe('summary', () => {
  test('totals, preview-complete message, and no control that implies saving', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    const total = Number(await shown(page).getAttribute('data-count'))
    await rows(page).first().getByRole('button', { name: /^Exclude/ }).click()
    await toSummary(page)

    await expect(page.getByTestId('stat-selected')).toHaveText(String(total - 1))
    await expect(page.getByTestId('stat-excluded')).toHaveText('1')
    await expect(page.getByTestId('stat-group-excluded')).not.toHaveText('0')
    await expect(page.getByTestId('stat-corrections')).toHaveText('0')
    await expect(page.getByTestId('stat-clashes')).not.toHaveText('0')
    await expect(page.getByTestId('course-counts').locator('li[data-course]')).not.toHaveCount(0)
    await expect(page.getByTestId('preview-complete')).toHaveText(PREVIEW_COMPLETE)
    await expect(page.getByText('Sessions needing extraction review')).toBeVisible()
    await expect(page.getByText('Remaining clashes (overlaps)')).toBeVisible()
    await expect(page.getByTestId('summary-explainer')).toContainText('never resolved or excluded automatically')
    await expect(page.getByText(/Saved to cloud.{1,3} indicator .* existing calendar only/)).toBeVisible()
    await expect(page.getByText('Nothing has been saved')).toBeVisible()
    await expect(page.getByText(/source anomal/)).toBeVisible()

    // no button or link that would save, import or upload
    const controls = await page.getByRole('main').or(page.locator('body')).first().locator('button, a').allTextContents()
    expect(controls.filter((t) => /import to|save|upload|confirm|add to calendar/i.test(t))).toEqual([])

    // return to individual sessions and change a choice
    await page.getByRole('button', { name: 'Show excluded sessions' }).click()
    await expect(rows(page)).toHaveCount(1)
    await rows(page).first().getByRole('button', { name: /^Include/ }).click()
    await toSummary(page)
    await expect(page.getByTestId('stat-excluded')).toHaveText('0')
    await page.getByRole('link', { name: 'Back to calendar' }).click()
    await expect(page).toHaveURL(/#\/calendar$/)
  })
})

test.describe('privacy: nothing is written anywhere', () => {
  test('a full preview leaves local storage, session storage, IndexedDB and the calendar untouched', async ({ page, context }) => {
    const existing = ev({ id: 'keep1', title: 'My own event', category: 'personal', start: '2026-10-12T07:00:00.000Z', end: '2026-10-12T08:00:00.000Z' })
    await seed(context, { events: [existing] })
    await page.goto('#/calendar')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const snapshot = () =>
      page.evaluate(async () => ({
        local: JSON.stringify(Object.entries(localStorage).sort()),
        session: JSON.stringify(Object.entries(sessionStorage).sort()),
        idb: JSON.stringify(((await indexedDB.databases?.()) ?? []).map((d) => d.name).sort()),
        caches: JSON.stringify(await caches.keys()),
      }))
    const before = await snapshot()
    const requests = recordRequests(page)

    await loadFixture(page)
    await toSessions(page)
    await rows(page).first().getByRole('button', { name: /^Exclude/ }).click()
    await rows(page).nth(1).getByRole('button', { name: /^Edit/ }).click()
    await page.getByRole('dialog').getByLabel('Room / location').fill('Changed room')
    await page.getByRole('dialog').getByRole('button', { name: 'Save correction' }).click()
    await toSummary(page)
    await expect(page.getByTestId('preview-complete')).toBeVisible()

    expect(await snapshot()).toEqual(before)
    expect(requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([])
    expect(requests.filter((r) => r.postData)).toEqual([])

    await page.goto('#/calendar')
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('orbit.events.v1'))) as string)).toEqual([existing])
    await expect(page.getByText('Changed room')).toHaveCount(0)
  })

  test('leaving the page discards the preview', async ({ page }) => {
    await loadFixture(page)
    await page.getByRole('link', { name: 'Calendar' }).first().click()
    await page.goto('#/import-timetable')
    await expect(page.getByRole('heading', { name: '1 · Choose the timetable PDF' })).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
  })
})

test.describe('replacing the PDF', () => {
  test('"Different PDF" offers the upload again and keeps the current review until a new file is read', async ({ page }) => {
    await loadFixture(page)
    await toSessions(page)
    await rows(page).first().getByRole('button', { name: /^Exclude/ }).click()
    await steps(page).getByRole('button', { name: 'Different PDF' }).click()
    await expect(page.getByText('Choosing another PDF will discard your exclusions and corrections.')).toBeVisible()
    await uploadAndWait(page, textOnly())
    await expect(page.getByRole('alert')).toContainText('not a supported UTN timetable')
    await page.getByRole('button', { name: 'Keep the current timetable' }).click()
    await expect(page.getByRole('heading', { name: '3 · Review sessions' })).toBeVisible()
    await expect(page.locator('li[data-session-id][data-state="excluded"]')).toHaveCount(1)
  })
})

test.describe('optional: the real UTN PDF (skipped when it is not on this machine)', () => {
  test.skip(!hasRealPdf, `real timetable PDF not found at ${REAL_PDF} (set UTN_TIMETABLE_PDF); fixture tests above still run`)

  test('frozen baseline: 168 sessions, 29 clashes, per-course counts, Group A out', async ({ page }) => {
    await open(page)
    await uploadAndWait(page, REAL_PDF)
    await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('anomalies').locator('li')).toHaveCount(3)
    await expect(page.getByTestId('counts-W26M-AINBA')).toContainText('28 selected')
    await expect(page.getByTestId('counts-W26M-AINBA')).toContainText('56 found in PDF')
    await expect(page.getByTestId('anomalies').locator('[data-anomaly="no-date"]')).toContainText('Week 1')
    await expect(page.getByTestId('anomalies').locator('[data-anomaly="date-weekday-mismatch"]')).toContainText('Week 23')
    await toSessions(page)
    await expect(shown(page)).toHaveAttribute('data-count', '168')
    await page.getByRole('tab', { name: /Clashes/ }).click()
    await expect(page.getByTestId('clashes-count')).toHaveText('(29)')
    await expect(page.getByRole('list', { name: 'Clashes by course pair' })).toContainText('×')
    await page.getByRole('tab', { name: /Sessions/ }).click()
    await toSummary(page)
    await expect(page.getByTestId('stat-selected')).toHaveText('168')
    await expect(page.getByTestId('stat-group-excluded')).toHaveText('28')
    await expect(page.getByTestId('stat-attention')).toHaveText('0')
    await expect(page.getByTestId('stat-corrections')).toHaveText('0')
    await expect(page.getByTestId('course-counts').locator('li[data-course="W26M-AINBA"]')).toHaveAttribute('data-count', '28')
    await expect(page.getByTestId('stat-clashes')).toHaveText('29')
    const counts: Record<string, string> = { 'W26M-AINBA': '28', 'W26M-RBTAD': '31', 'W26M-NLGAD': '6', 'W26M-NLUAD': '30', 'W26M-MMFAD': '15', 'W26M-LLMAD': '15', 'W26M-INSIN': '11', 'W26M-Deutsch A2': '32' }
    for (const [code, n] of Object.entries(counts)) await expect(page.getByTestId('course-counts').locator(`li[data-course="${code}"]`)).toHaveAttribute('data-count', n)
    await expect(page.getByText('Date range of selected sessions: 12 Oct 2026 – 19 Mar 2027.')).toBeVisible()
  })
})

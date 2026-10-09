import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  addEvent,
  cell,
  countOn,
  dayItems,
  dialog,
  expectedDates,
  fillForm,
  goToCalendar,
  gotoMonth,
  NOW,
  openApp,
  readStorage,
  selectDay,
  submit,
  visibleDates,
} from './helpers'

// One continuous story on a single page (state carries from step to step).
test.describe.configure({ mode: 'serial' })

let page: Page
const TITLE = 'QA Artificial Intelligence'

/** Every cell in the visible month grid must have exactly the expected number of events. */
async function expectGrid(expected: Set<string>) {
  for (const d of await visibleDates(page)) {
    expect(await countOn(page, d), `events on ${d}`).toBe(expected.has(d) ? 1 : 0)
  }
}

async function openOccurrence(date: string) {
  await selectDay(page, date)
  await dayItems(page).filter({ hasText: TITLE }).first().getByRole('button').click()
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', locale: 'en-GB' })
  page = await context.newPage()
  await openApp(page, '/', NOW)
  await goToCalendar(page)
})

test.afterAll(async () => {
  await page.context().close()
})

test('B. create weekly series Mon+Wed 12 Oct - 14 Dec 2026', async () => {
  await addEvent(page, {
    title: TITLE,
    category: 'University',
    repeat: 'weekly',
    weekdays: ['Mon', 'Wed'],
    startDate: '2026-10-12',
    startTime: '09:00',
    endDate: '2026-10-12',
    endTime: '10:30',
    until: '2026-12-14',
  })

  // Exactly one series record, no per-occurrence copies, no one-off events
  const series = JSON.parse((await readStorage(page, 'orbit.series.v1')) ?? '[]')
  expect(series).toHaveLength(1)
  expect(series[0].recurrence.weekdays).toEqual([0, 2])
  expect(await readStorage(page, 'orbit.events.v1')).toBeNull()

  const expected = expectedDates([0, 2], '2026-10-12', '2026-12-14')
  expect(expected.has('2026-10-12') && expected.has('2026-10-14') && expected.has('2026-10-19') && expected.has('2026-10-21')).toBe(true)

  for (const month of ['October 2026', 'November 2026', 'December 2026']) {
    await gotoMonth(page, month)
    await expectGrid(expected)
  }
  // Explicit spot checks, including the boundary
  await gotoMonth(page, 'December 2026')
  expect(await countOn(page, '2026-12-14')).toBe(1)
  expect(await countOn(page, '2026-12-16')).toBe(0) // Wednesday after the end date
  expect(await countOn(page, '2026-12-21')).toBe(0)
  await gotoMonth(page, 'January 2027')
  for (const d of await visibleDates(page)) expect(await countOn(page, d)).toBe(d <= '2026-12-14' && expected.has(d) ? 1 : 0)
  await gotoMonth(page, 'October 2026')
  expect(await countOn(page, '2026-10-05')).toBe(0) // Monday before the first date
  expect(await countOn(page, '2026-10-13')).toBe(0) // Tuesday
})

test('B2. week view lists the same occurrences', async () => {
  await gotoMonth(page, 'October 2026')
  await selectDay(page, '2026-10-12')
  await page.getByRole('button', { name: 'week', exact: true }).click()
  const monday = page.getByRole('region', { name: /12 October 2026/ })
  await expect(monday).toContainText(TITLE)
  await expect(monday).toContainText('09:00 – 10:30')
  await expect(page.getByRole('region', { name: /13 October 2026/ })).toContainText('No events')
  await expect(page.getByRole('region', { name: /14 October 2026/ })).toContainText(TITLE)
  await page.getByRole('button', { name: 'month', exact: true }).click()
})

test('C. edit only the 19 Oct occurrence', async () => {
  await gotoMonth(page, 'October 2026')
  await openOccurrence('2026-10-19')
  await expect(dialog(page).getByText('Edit repeating event')).toBeVisible()
  await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
  await dialog(page).getByLabel('Location (optional)').fill('Room 204')
  await submit(page, 'Save occurrence')
  await expect(dialog(page)).toBeHidden()

  const check = async () => {
    await gotoMonth(page, 'October 2026')
    await selectDay(page, '2026-10-19')
    await expect(dayItems(page).first()).toContainText('Room 204')
    await expect(dayItems(page).first()).toContainText('Edited')
    await selectDay(page, '2026-10-12')
    await expect(dayItems(page).first()).not.toContainText('Room 204')
    await expect(dayItems(page).first()).not.toContainText('Edited')
    await selectDay(page, '2026-10-26')
    await expect(dayItems(page).first()).not.toContainText('Room 204')
    await expect(dayItems(page).first()).not.toContainText('Edited')
  }
  await check()
  await page.reload()
  await goToCalendar(page)
  await check()
})

test('D. move 21 Oct occurrence to 22 Oct', async () => {
  await openOccurrence('2026-10-21')
  await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
  await fillForm(page, { startDate: '2026-10-22' }) // end date follows (same-day event)
  await expect(dialog(page).locator('#ev-endDate')).toHaveValue('2026-10-22')
  await submit(page, 'Save occurrence')
  await expect(dialog(page)).toBeHidden()

  expect(await countOn(page, '2026-10-21')).toBe(0)
  expect(await countOn(page, '2026-10-22')).toBe(1)
  await selectDay(page, '2026-10-22')
  await expect(dayItems(page)).toHaveCount(1)
  await expect(dayItems(page).first()).toContainText('Edited')
  await expect(dayItems(page).first()).toContainText('09:00 – 10:30')
  await selectDay(page, '2026-10-21')
  await expect(page.getByText('No events on this day.')).toBeVisible()
  // The series carries on normally: next Monday & Wednesday are still single occurrences.
  for (const d of ['2026-10-26', '2026-10-28']) expect(await countOn(page, d)).toBe(1)
  // One series record, one exception keyed by the ORIGINAL date.
  const series = JSON.parse((await readStorage(page, 'orbit.series.v1'))!)
  expect(series).toHaveLength(1)
  expect(series[0].exceptions.map((e: { originalDate: string }) => e.originalDate).sort()).toEqual(['2026-10-19', '2026-10-21'])
})

test('E. cancel and restore 26 Oct', async () => {
  await openOccurrence('2026-10-26')
  await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
  await dialog(page).getByRole('button', { name: 'Cancel occurrence' }).click()
  await expect(dialog(page)).toBeHidden()

  expect(await countOn(page, '2026-10-26')).toBe(0) // excluded from the month grid / active counts
  await selectDay(page, '2026-10-26')
  await expect(dayItems(page)).toHaveCount(1)
  await expect(dayItems(page).first()).toContainText('Cancelled')
  await expect(dayItems(page).first().getByRole('button', { name: /Restore/ })).toBeVisible()
  // Reload keeps it cancelled
  await page.reload()
  await goToCalendar(page)
  expect(await countOn(page, '2026-10-26')).toBe(0)

  await selectDay(page, '2026-10-26')
  await dayItems(page).first().getByRole('button', { name: /Restore/ }).click()
  expect(await countOn(page, '2026-10-26')).toBe(1)
  await selectDay(page, '2026-10-26')
  await expect(dayItems(page)).toHaveCount(1)
  await expect(dayItems(page).first()).not.toContainText('Cancelled')
  const series = JSON.parse((await readStorage(page, 'orbit.series.v1'))!)
  expect(series[0].exceptions.map((e: { originalDate: string }) => e.originalDate)).not.toContain('2026-10-26')
})

test('F. entire-series edit respects exceptions; orphan warning; delete', async () => {
  // Change time to 10:00-11:30
  await openOccurrence('2026-10-12')
  await dialog(page).getByRole('button', { name: /Entire series/ }).click()
  await expect(dialog(page).getByText('Edit series')).toBeVisible()
  await fillForm(page, { startTime: '10:00', endTime: '11:30' })
  await submit(page, 'Save series')
  await expect(dialog(page)).toBeHidden()

  const timeOn = async (d: string) => {
    await selectDay(page, d)
    return dayItems(page).first().textContent()
  }
  expect(await timeOn('2026-10-12')).toContain('10:00 – 11:30')
  expect(await timeOn('2026-10-14')).toContain('10:00 – 11:30')
  expect(await timeOn('2026-10-26')).toContain('10:00 – 11:30')
  // 19 Oct keeps its location override and follows the new time
  expect(await timeOn('2026-10-19')).toContain('10:00 – 11:30')
  expect(await timeOn('2026-10-19')).toContain('Room 204')
  // The moved occurrence keeps its own (moved) absolute time - documented policy
  expect(await timeOn('2026-10-22')).toContain('09:00 – 10:30')

  // Remove Wednesday: the moved 21 Oct exception no longer fits -> warning, nothing lost silently
  await openOccurrence('2026-10-12')
  await dialog(page).getByRole('button', { name: /Entire series/ }).click()
  await fillForm(page, { weekdays: ['Mon'] })
  await submit(page, 'Save series')
  const warn = dialog(page).getByRole('alertdialog', { name: 'Please review' })
  await expect(warn).toBeVisible()
  await expect(warn).toContainText('no longer fit this schedule')
  await expect(warn).toContainText('Wed 21 Oct')
  // Go back: nothing saved, still editable
  await warn.getByRole('button', { name: 'Go back' }).click()
  await expect(warn).toBeHidden()
  let series = JSON.parse((await readStorage(page, 'orbit.series.v1'))!)
  expect(series[0].recurrence.weekdays).toEqual([0, 2])
  expect(series[0].exceptions.map((e: { originalDate: string }) => e.originalDate)).toContain('2026-10-21')
  // Save anyway: weekday removed, orphan removed, Monday exception kept
  await submit(page, 'Save series')
  await warn.getByRole('button', { name: 'Save anyway' }).click()
  await expect(dialog(page)).toBeHidden()
  series = JSON.parse((await readStorage(page, 'orbit.series.v1'))!)
  expect(series[0].recurrence.weekdays).toEqual([0])
  expect(series[0].exceptions.map((e: { originalDate: string }) => e.originalDate)).toEqual(['2026-10-19'])
  expect(await countOn(page, '2026-10-14')).toBe(0)
  expect(await countOn(page, '2026-10-22')).toBe(0)
  expect(await countOn(page, '2026-10-19')).toBe(1)

  // Delete series: confirmation, keep, then delete
  await openOccurrence('2026-10-12')
  await dialog(page).getByRole('button', { name: /Entire series/ }).click()
  await dialog(page).getByRole('button', { name: 'Delete series' }).click()
  await expect(dialog(page).getByText(/including all its occurrences/)).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Keep it' }).click()
  expect(JSON.parse((await readStorage(page, 'orbit.series.v1'))!)).toHaveLength(1)
  await dialog(page).getByRole('button', { name: 'Delete series' }).click()
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog(page)).toBeHidden()
  for (const m of ['October 2026', 'November 2026', 'December 2026']) {
    await gotoMonth(page, m)
    for (const d of await visibleDates(page)) expect(await countOn(page, d)).toBe(0)
  }
  expect(JSON.parse((await readStorage(page, 'orbit.series.v1'))!)).toHaveLength(0)
  void cell
})

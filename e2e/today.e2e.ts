import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { ev, openApp, seed, weeklySeries } from './helpers'

const card = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
const summary = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('..')

// Mon/Wed 09:00-10:30 university series + unrelated-date and other-category events
const series = weeklySeries({
  title: 'QA Series',
  exceptions: [{ originalDate: '2026-10-14', cancelled: true }],
})
const unrelatedUni = ev({ id: 'x1', title: 'QA Other Day Uni', start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T10:00:00.000Z' })
const afternoon = ev({ id: 'x2', title: 'QA Afternoon Shift', category: 'work', start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T16:00:00.000Z' }) // 16:00-18:00 Berlin
const study = ev({ id: 'x3', title: 'QA Study', category: 'study', start: '2026-10-12T11:00:00.000Z', end: '2026-10-12T12:00:00.000Z' }) // 13:00-14:00

test.describe('Today dashboard with fixed clock', () => {
  test('Mon 12 Oct 09:30 Berlin: happening now, up next, summaries ignore unrelated dates', async ({ page, context }) => {
    await seed(context, { series: [series], events: [unrelatedUni, afternoon, study] })
    await openApp(page, '/', new Date('2026-10-12T07:30:00Z'))

    await expect(card(page, 'Happening now')).toContainText('QA Series')
    await expect(card(page, 'Happening now')).toContainText('09:00 – 10:30')
    await expect(card(page, 'Up next')).toContainText('QA Study') // 13:00 is the next start
    // summaries: university = 1 occurrence today (NOT 2: the 20 Oct event is another day)
    await expect(summary(page, 'University today')).toContainText('1 · 1h 30m')
    await expect(summary(page, 'Work today')).toContainText('1 · 2h')
    await expect(summary(page, 'Study today')).toContainText('1 · 1h')
    // timeline lists only today's three items, in order
    const tl = card(page, 'Today’s timeline')
    await expect(tl.locator('li')).toHaveCount(3)
    await expect(tl).not.toContainText('QA Other Day Uni')
    await expect(tl.locator('li').first()).toContainText('QA Series')
  })

  test('cancelled occurrence is excluded (Wed 14 Oct)', async ({ page, context }) => {
    await seed(context, { series: [series] })
    await openApp(page, '/', new Date('2026-10-14T07:30:00Z'))
    await expect(card(page, 'Happening now')).toContainText('No event in progress')
    await expect(summary(page, 'University today')).toContainText('0 · 0m')
    await expect(page.getByText('Nothing scheduled for today.')).toBeVisible()
    // Up next skips the cancelled one and shows the following Monday
    await expect(card(page, 'Up next')).toContainText('QA Series')
    await expect(card(page, 'Up next')).toContainText('Mon 19 Oct')
  })

  test('up next after the last event today points to a later day; empty states', async ({ page, context }) => {
    await seed(context, { series: [series] })
    await openApp(page, '/', new Date('2026-10-12T15:00:00Z'))
    await expect(card(page, 'Happening now')).toContainText('No event in progress')
    // Wed 14 Oct is cancelled, so the next one is Mon 19 Oct
    await expect(card(page, 'Up next')).toContainText('Mon 19 Oct')
    await expect(card(page, 'Up next')).not.toContainText('14 Oct')
  })

  test('truly empty calendar', async ({ page }) => {
    await openApp(page)
    await expect(page.getByText('Your calendar is empty')).toBeVisible()
    await expect(card(page, 'Up next')).toContainText('No upcoming events')
    await expect(summary(page, 'University today')).toContainText('0 · 0m')
  })

  test('live clock ticks and follows Europe/Berlin, not the device zone', async ({ page }) => {
    await openApp(page, '/', new Date('2026-10-09T10:00:00Z')) // device is Los Angeles
    const clock = page.getByLabel('Current time')
    await expect(clock).toHaveText('12:00:00') // CEST
    await page.clock.runFor(3000)
    await expect(clock).toHaveText('12:00:03')
    await page.clock.setSystemTime(new Date('2026-10-26T11:00:00Z')) // after fall-back: CET
    await page.clock.runFor(1000)
    await expect(clock).toHaveText('12:00:01')
  })
})

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { addEvent, dayItems, dialog, ev, goToCalendar, openApp, seed, selectDay, submit, weeklySeries } from './helpers'

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small-mobile', width: 320, height: 700 },
] as const

const MON_NOW = new Date('2026-10-12T07:30:00Z') // Mon 12 Oct 09:30 Berlin
const fixture = {
  series: [weeklySeries({ title: 'QA Artificial Intelligence', location: 'Room 204' })],
  events: [
    ev({ id: 'w1', title: 'QA Very Long Shift Title That Should Truncate Nicely Without Breaking Layout', category: 'work', start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T16:00:00.000Z' }),
    ev({ id: 'n1', title: 'QA Night', category: 'work', start: '2026-10-09T21:00:00.000Z', end: '2026-10-10T03:00:00.000Z' }),
  ],
}

async function noHorizontalOverflow(page: Page, where: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  expect(sw, `horizontal overflow on ${where}: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw)
}

async function inViewport(page: Page, loc: ReturnType<Page['locator']>, what: string) {
  const box = await loc.boundingBox()
  const vp = page.viewportSize()!
  expect(box, `${what} has a box`).not.toBeNull()
  expect(box!.x, `${what} left`).toBeGreaterThanOrEqual(-0.5)
  expect(box!.x + box!.width, `${what} right`).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box!.y, `${what} top`).toBeGreaterThanOrEqual(-0.5)
  expect(box!.y + box!.height, `${what} bottom`).toBeLessThanOrEqual(vp.height + 0.5)
}

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('no horizontal overflow, navigation works', async ({ page, context }) => {
      await seed(context, fixture)
      await openApp(page, '/', MON_NOW)
      const links: [string, RegExp][] = [
        ['Today', /Good|Working/],
        ['Calendar', /October 2026/],
        ['Study Planner', /Study Planner/],
        ['Insights', /Insights/],
        ['Settings', /Settings/],
      ]
      for (const [name, heading] of links) {
        // desktop shows the sidebar, smaller screens the bottom bar ("Study Planner" is shortened to "Study")
        const label = size.width < 768 && name === 'Study Planner' ? 'Study' : name
        await page.getByRole('link', { name: label, exact: true }).filter({ visible: true }).click()
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
        await noHorizontalOverflow(page, `${name} @${size.width}`)
      }
      // week view too
      await page.getByRole('link', { name: 'Calendar', exact: true }).filter({ visible: true }).click()
      await page.getByRole('button', { name: 'week', exact: true }).click()
      await noHorizontalOverflow(page, `calendar week @${size.width}`)
    })

    test('calendar controls reachable and touch-sized', async ({ page, context }) => {
      await seed(context, fixture)
      await openApp(page, '/calendar', MON_NOW)
      for (const name of ['Previous month', 'Next month', 'Today', 'month', 'week', 'Add event']) {
        const b = page.getByRole('button', { name, exact: true }).first()
        await expect(b).toBeVisible()
        await inViewport(page, b, name)
        const box = (await b.boundingBox())!
        expect(box.height, `${name} height`).toBeGreaterThanOrEqual(40)
      }
      // month cells are tappable and the selected-day card works
      await selectDay(page, '2026-10-12')
      await expect(dayItems(page).first()).toContainText('QA Artificial Intelligence')
      // long titles truncate instead of overflowing
      await noHorizontalOverflow(page, 'calendar with long title')
    })

    test('dialog fits viewport, scrolls, weekday toggles usable, validation visible, Escape + focus', async ({ page, context }) => {
      await seed(context, fixture)
      await openApp(page, '/calendar', MON_NOW)
      const trigger = page.getByRole('button', { name: 'Add event' }).first()
      await trigger.click()
      const d = dialog(page)
      await expect(d).toBeVisible()

      // initial focus in Title, dialog inside viewport
      await expect(d.getByLabel('Title')).toBeFocused()
      await inViewport(page, d, 'dialog')

      // weekly section
      await d.getByLabel('Repeat').selectOption('weekly')
      await inViewport(page, d, 'dialog (weekly)')
      const dbox = (await d.boundingBox())!
      for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
        const t = d.getByRole('button', { name: day, exact: true })
        await t.scrollIntoViewIfNeeded()
        const b = (await t.boundingBox())!
        expect(b.width, `${day} width`).toBeGreaterThanOrEqual(28) // WCAG 2.2 AA minimum target is 24px
        expect(b.height, `${day} height`).toBeGreaterThanOrEqual(40)
        expect(b.x + b.width, `${day} inside dialog`).toBeLessThanOrEqual(dbox.x + dbox.width + 0.5)
      }
      // all seven toggles sit on one row (no orphaned 'Sun' on its own line)
      const ys = await Promise.all(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(async (day) => (await d.getByRole('button', { name: day, exact: true }).boundingBox())!.y))
      expect(Math.max(...ys) - Math.min(...ys), 'weekday toggles wrap onto several rows').toBeLessThanOrEqual(2)
      // toggle works
      const tue = d.getByRole('button', { name: 'Tue', exact: true })
      await tue.click()
      await expect(tue).toHaveAttribute('aria-pressed', 'true')

      // content is scrollable and the action buttons are reachable
      const scrollable = await d.evaluate((el) => el.scrollHeight > el.clientHeight)
      const save = d.getByRole('button', { name: 'Save series' })
      await save.scrollIntoViewIfNeeded()
      await expect(save).toBeVisible()
      await inViewport(page, save, 'Save button')
      await inViewport(page, d.getByRole('button', { name: 'Cancel', exact: true }), 'Cancel button')
      if (size.height <= 900 && size.width < 768) expect(scrollable, 'dialog should scroll on phones').toBe(true)

      // validation messages visible
      await save.click()
      const err = d.getByText('Title is required.')
      await err.scrollIntoViewIfNeeded()
      await expect(err).toBeVisible()
      await inViewport(page, err, 'error message')
      await noHorizontalOverflow(page, 'dialog open')

      // Escape closes and returns focus to the trigger
      await page.keyboard.press('Escape')
      await expect(d).toBeHidden()
      await expect(trigger).toBeFocused()
      expect(await page.evaluate(() => localStorage.getItem('orbit.series.v1'))).toBe(JSON.stringify(fixture.series)) // nothing saved by invalid submit/escape
    })

    test('conflict warning is reachable and "Go back"/"Save anyway" are tappable', async ({ page, context }) => {
      await seed(context, fixture)
      await openApp(page, '/calendar', MON_NOW)
      await addEvent(page, { title: 'QA Overlap', category: 'Work', startDate: '2026-10-12', startTime: '09:30', endDate: '2026-10-12', endTime: '10:00' }, { save: false })
      await submit(page)
      const w = dialog(page).getByRole('alertdialog', { name: 'Please review' })
      await expect(w).toBeVisible()
      for (const n of ['Go back', 'Save anyway']) {
        const b = w.getByRole('button', { name: n })
        await b.scrollIntoViewIfNeeded()
        await inViewport(page, b, n)
        expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(40)
      }
      await noHorizontalOverflow(page, 'conflict warning')
    })

    test('delete and restore controls reachable', async ({ page, context }) => {
      const cancelled = weeklySeries({ title: 'QA Artificial Intelligence', exceptions: [{ originalDate: '2026-10-12', cancelled: true }] })
      await seed(context, { series: [cancelled] })
      await openApp(page, '/calendar', MON_NOW)
      await selectDay(page, '2026-10-12')
      const restore = dayItems(page).first().getByRole('button', { name: /Restore/ })
      await restore.scrollIntoViewIfNeeded()
      await inViewport(page, restore, 'Restore')
      await selectDay(page, '2026-10-14')
      await dayItems(page).first().getByRole('button').click()
      await dialog(page).getByRole('button', { name: /Entire series/ }).click()
      const del = dialog(page).getByRole('button', { name: 'Delete series' })
      await del.scrollIntoViewIfNeeded()
      await inViewport(page, del, 'Delete series')
      await del.click()
      for (const n of ['Keep it', 'Delete']) {
        const b = dialog(page).getByRole('button', { name: n, exact: true })
        await b.scrollIntoViewIfNeeded()
        await inViewport(page, b, n)
      }
    })
  })
}

test.describe('mobile bottom navigation does not hide content', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('last card is fully visible above the bottom bar', async ({ page, context }) => {
    await seed(context, fixture)
    await openApp(page, '/', MON_NOW)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const nav = (await page.getByRole('navigation', { name: 'Main' }).filter({ visible: true }).boundingBox())!
    const last = (await page.locator('main section').last().boundingBox())!
    expect(last.y + last.height).toBeLessThanOrEqual(nav.y + 0.5)
    // Calendar page too
    await page.getByRole('link', { name: 'Calendar', exact: true }).filter({ visible: true }).click()
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const last2 = (await page.locator('main section').last().boundingBox())!
    expect(last2.y + last2.height).toBeLessThanOrEqual(nav.y + 0.5)
  })
})

test.describe('screenshots', () => {
  const dir = 'e2e-artifacts/screenshots'

  test('desktop today + calendar', async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await seed(context, fixture)
    await openApp(page, '/', MON_NOW)
    await expect(page.getByText('Happening now')).toBeVisible()
    await page.screenshot({ path: `${dir}/1-desktop-today-recurring.png` })
    await goToCalendar(page)
    await selectDay(page, '2026-10-12')
    await page.screenshot({ path: `${dir}/2-desktop-calendar-weekly.png` })
  })

  test('mobile calendar, recurring dialog, edit-scope choice, conflict', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await seed(context, fixture)
    await openApp(page, '/calendar', MON_NOW)
    await selectDay(page, '2026-10-12')
    await page.screenshot({ path: `${dir}/3-mobile-calendar.png` })

    await page.getByRole('button', { name: 'Add event' }).first().click()
    await dialog(page).getByLabel('Category').selectOption({ label: 'University' })
    await dialog(page).getByLabel('Repeat').selectOption('weekly')
    await dialog(page).getByRole('button', { name: 'Wed', exact: true }).click()
    await page.screenshot({ path: `${dir}/4-mobile-recurring-dialog.png` })
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()

    await dayItems(page).filter({ hasText: 'QA Artificial Intelligence' }).first().getByRole('button').click()
    await page.screenshot({ path: `${dir}/5-mobile-edit-scope.png` })
    await page.keyboard.press('Escape')

    await addEvent(page, { title: 'QA Overlap', category: 'Work', startDate: '2026-10-12', startTime: '09:30', endDate: '2026-10-12', endTime: '10:00' }, { save: false })
    await submit(page)
    await dialog(page).getByRole('alertdialog', { name: 'Please review' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${dir}/6-mobile-conflict-warning.png` })
  })
})

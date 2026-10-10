import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { fixturePdf, uploadAndWait } from './timetableFixtures'

// The review UI at the four required widths: no horizontal scrolling on any step, usable controls and a dialog
// that fits the screen.

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const vp of [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test.describe(`import timetable at ${vp.width}px`, () => {
    test.use({ viewport: vp })

    test('every step fits the screen and the controls stay reachable', async ({ page }) => {
      await page.goto('#/import-timetable')
      await expect(page.getByRole('heading', { name: '1 · Choose the timetable PDF' })).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(0)

      await uploadAndWait(page, fixturePdf())
      await expect(page.getByRole('heading', { name: '2 · Courses and groups' })).toBeVisible({ timeout: 30_000 })
      expect(await overflow(page)).toBeLessThanOrEqual(0)
      // course selection works by touch-sized controls
      const box = page.locator('li[data-course="W26M-AINBA"]').getByRole('radio', { name: 'Group A' })
      await box.check()
      await expect(box).toBeChecked()
      await page.locator('li[data-course="W26M-AINBA"]').getByRole('radio', { name: 'Group B' }).check()

      await page.getByRole('button', { name: /Review sessions/ }).click()
      await expect(page.getByRole('heading', { name: '3 · Review sessions' })).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(0)

      // filters are usable
      await page.getByLabel('Course').selectOption('W26M-NLUAD')
      await expect(page.getByTestId('shown-count')).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(0)
      await page.getByRole('button', { name: 'Clear filters' }).click()

      // buttons are at least 40px tall
      const edit = page.locator('li[data-session-id]').first().getByRole('button', { name: /^Edit/ })
      expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(40)

      // correction dialog fits
      await edit.click()
      const dlg = page.getByRole('dialog')
      await expect(dlg).toBeVisible()
      const b = (await dlg.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.height).toBeLessThanOrEqual(vp.height)
      await dlg.getByLabel('Room / location').fill('Somewhere')
      await expect(dlg.getByRole('button', { name: 'Save correction' })).toBeVisible()
      await dlg.getByRole('button', { name: 'Save correction' }).scrollIntoViewIfNeeded()
      await dlg.getByRole('button', { name: 'Save correction' }).click()
      await expect(dlg).toHaveCount(0)

      // side-by-side clash comparison
      await page.getByRole('tab', { name: /Clashes/ }).click()
      const clash = page.locator('li[data-clash]').first()
      await expect(clash).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(0)
      const halves = await clash.locator('div.grid > div').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()))
      expect(halves).toHaveLength(2)
      if (vp.width >= 640) expect(Math.abs(halves[0].top - halves[1].top)).toBeLessThan(2) // side by side
      else expect(halves[1].top).toBeGreaterThan(halves[0].top) // stacked, still readable
      for (const h of halves) {
        expect(h.left).toBeGreaterThanOrEqual(0)
        expect(h.right).toBeLessThanOrEqual(vp.width)
      }

      await page.getByRole('button', { name: /Review summary/ }).click()
      await expect(page.getByRole('heading', { name: '4 · Review summary' })).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(0)
      await expect(page.getByTestId('preview-complete')).toBeVisible()
    })
  })
}

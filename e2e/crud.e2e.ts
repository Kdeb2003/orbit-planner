import { expect, test } from '@playwright/test'
import { addEvent, cell, countOn, dayItems, dialog, fillForm, goToCalendar, openApp, selectDay, submit } from './helpers'

test.describe('A. single event CRUD', () => {
  test('create, view, edit, persist, delete', async ({ page }) => {
    await openApp(page)

    // Empty state
    await expect(page.getByText('Your calendar is empty')).toBeVisible()

    // Create (Today quick action)
    await page.getByRole('button', { name: /Add event/ }).first().click()
    await fillForm(page, {
      title: 'QA Single Lecture',
      category: 'University',
      startDate: '2026-10-09',
      startTime: '14:00',
      endDate: '2026-10-09',
      endTime: '15:30',
      location: 'Room 1',
    })
    await submit(page)
    await expect(dialog(page)).toBeHidden()

    // Today shows it
    await expect(page.getByRole('list').getByText('QA Single Lecture')).toBeVisible()
    await expect(page.getByText('14:00 – 15:30').first()).toBeVisible()

    // Calendar shows it on the right date
    await goToCalendar(page)
    expect(await countOn(page, '2026-10-09')).toBe(1)
    expect(await countOn(page, '2026-10-08')).toBe(0)
    await selectDay(page, '2026-10-09')
    await expect(dayItems(page)).toHaveCount(1)
    await expect(dayItems(page).first()).toContainText('QA Single Lecture')

    // Edit title and location
    await dayItems(page).first().getByRole('button').click()
    await expect(dialog(page).getByText('Edit event')).toBeVisible()
    await dialog(page).getByLabel('Title').fill('QA Single Lecture v2')
    await dialog(page).getByLabel('Location (optional)').fill('Room 204')
    await submit(page, 'Save changes')
    await expect(dialog(page)).toBeHidden()
    await expect(dayItems(page).first()).toContainText('QA Single Lecture v2')
    await expect(dayItems(page).first()).toContainText('Room 204')

    // Persistence across reload
    await page.reload()
    await goToCalendar(page)
    expect(await countOn(page, '2026-10-09')).toBe(1)
    await selectDay(page, '2026-10-09')
    await expect(dayItems(page).first()).toContainText('QA Single Lecture v2')

    // Delete with confirmation
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: 'Delete' }).click()
    await expect(dialog(page).getByText(/can’t be undone/)).toBeVisible()
    await dialog(page).getByRole('button', { name: 'Keep it' }).click()
    await expect(dialog(page)).toBeVisible()
    await dialog(page).getByRole('button', { name: 'Delete' }).click()
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).last().click()
    await expect(dialog(page)).toBeHidden()
    expect(await countOn(page, '2026-10-09')).toBe(0)
    await page.reload()
    await goToCalendar(page)
    expect(await countOn(page, '2026-10-09')).toBe(0)
  })

  test('invalid submissions show errors and save nothing', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: /Add event/ }).first().click()

    // Empty title
    await submit(page)
    await expect(dialog(page).getByText('Title is required.')).toBeVisible()
    await expect(dialog(page)).toBeVisible()

    // Missing date
    await fillForm(page, { title: 'x' })
    await dialog(page).locator('#ev-startDate').fill('')
    await submit(page)
    await expect(dialog(page).getByText('Enter a valid start date.')).toBeVisible()

    // End before start
    await fillForm(page, { startDate: '2026-10-09', startTime: '10:00', endDate: '2026-10-09', endTime: '09:00' })
    await submit(page)
    await expect(dialog(page).getByText('End must be after the start.')).toBeVisible()

    // End equal to start
    await fillForm(page, { endTime: '10:00' })
    await submit(page)
    await expect(dialog(page).getByText('End must be after the start.')).toBeVisible()

    // Weekly without weekdays / until before start
    await fillForm(page, { endTime: '11:00', repeat: 'weekly', weekdays: [], until: '2026-10-01' })
    await submit(page)
    await expect(dialog(page).getByText('Choose at least one weekday.')).toBeVisible()
    await expect(dialog(page).getByText('Repeat-until must not be before the start date.')).toBeVisible()

    // Overlong title is capped by maxLength; cancel leaves nothing behind
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog(page)).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('orbit.events.v1'))).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('orbit.series.v1'))).toBeNull()
  })

  test('overnight one-off event shows on both days with correct label and durations', async ({ page }) => {
    await openApp(page)
    await goToCalendar(page)
    await addEvent(page, {
      title: 'QA Night Shift',
      category: 'Work',
      startDate: '2026-10-09',
      startTime: '23:00',
      endDate: '2026-10-10',
      endTime: '05:00',
    })
    expect(await countOn(page, '2026-10-09')).toBe(1)
    expect(await countOn(page, '2026-10-10')).toBe(1)
    expect(await countOn(page, '2026-10-11')).toBe(0)
    await selectDay(page, '2026-10-09')
    await expect(dayItems(page).first()).toContainText('23:00 → 05:00 (+1d)')
    await selectDay(page, '2026-10-10')
    await expect(dayItems(page).first()).toContainText('until 05:00')

    // Daily duration on Today: 1h on Fri (23:00-24:00), 5h on Sat
    await page.getByRole('link', { name: 'Today' }).filter({ visible: true }).click()
    await expect(page.getByText('Work today').locator('..')).toContainText('1 · 1h')
    await page.clock.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    await page.reload()
    await expect(page.getByText('Work today').locator('..')).toContainText('1 · 5h')
    // Still stored once
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('orbit.events.v1') ?? '[]'))
    expect(stored).toHaveLength(1)
    expect(stored[0].start).toBe('2026-10-09T21:00:00.000Z')
    expect(stored[0].end).toBe('2026-10-10T03:00:00.000Z')
    void cell
  })
})

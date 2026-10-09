import { expect, test } from '@playwright/test'
import {
  addEvent,
  countOn,
  dayItems,
  dialog,
  ev,
  fillForm,
  goToCalendar,
  gotoMonth,
  openApp,
  readStorage,
  seed,
  selectDay,
  submit,
  TS,
  weeklySeries,
} from './helpers'

test.describe('time zones and DST (browser, device zone = Los Angeles)', () => {
  test('one-off times convert to correct UTC and are never silently changed', async ({ page }) => {
    await openApp(page)
    await goToCalendar(page)
    await addEvent(page, { title: 'QA Summer', startDate: '2026-07-15', startTime: '09:00', endDate: '2026-07-15', endTime: '10:00' })
    await addEvent(page, { title: 'QA Winter', startDate: '2026-01-15', startTime: '09:00', endDate: '2026-01-15', endTime: '10:00' })
    const stored = JSON.parse((await readStorage(page, 'orbit.events.v1'))!)
    const by = (t: string) => stored.find((e: { title: string }) => e.title === t)
    expect(by('QA Summer').start).toBe('2026-07-15T07:00:00.000Z') // CEST = UTC+2
    expect(by('QA Winter').start).toBe('2026-01-15T08:00:00.000Z') // CET = UTC+1
    await gotoMonth(page, 'July 2026')
    await selectDay(page, '2026-07-15')
    await expect(dayItems(page).first()).toContainText('09:00 – 10:00')
  })

  test('nonexistent local time is rejected with a clear message; nothing saved', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: /Add event/ }).first().click()
    await fillForm(page, { title: 'QA Gap', startDate: '2026-03-29', startTime: '02:30', endDate: '2026-03-29', endTime: '04:00' })
    await submit(page)
    await expect(dialog(page).getByText('This time does not exist on that date (clocks move forward).')).toBeVisible()
    expect(await readStorage(page, 'orbit.events.v1')).toBeNull()
  })

  test('ambiguous local time: first occurrence used, user told, entered time preserved on reopen', async ({ page }) => {
    await openApp(page)
    await goToCalendar(page)
    await page.getByRole('button', { name: /Add event/ }).first().click()
    await fillForm(page, { title: 'QA Twice', startDate: '2026-10-25', startTime: '02:30', endDate: '2026-10-25', endTime: '04:00' })
    await expect(dialog(page).getByText(/happens twice that night/)).toBeVisible()
    await submit(page)
    await expect(dialog(page)).toBeHidden()
    const stored = JSON.parse((await readStorage(page, 'orbit.events.v1'))!)
    expect(stored[0].start).toBe('2026-10-25T00:30:00.000Z') // first 02:30 (CEST)
    await gotoMonth(page, 'October 2026')
    await selectDay(page, '2026-10-25')
    await dayItems(page).first().getByRole('button').click()
    await expect(dialog(page).locator('#ev-startTime')).toHaveValue('02:30')
    await expect(dialog(page).locator('#ev-endTime')).toHaveValue('04:00')
  })

  test('weekly 09:00 stays 09:00 across spring and autumn transitions and the year boundary', async ({ page, context }) => {
    await seed(context, {
      series: [
        weeklySeries({ id: 'spring', title: 'QA Spring', recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-03-16', untilDate: '2026-04-13' } }),
        weeklySeries({ id: 'autumn', title: 'QA Autumn', recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-12', untilDate: '2026-11-09' } }),
        weeklySeries({ id: 'year', title: 'QA Year', recurrence: { frequency: 'weekly', weekdays: [3], startDate: '2026-12-17', untilDate: '2027-01-21' } }),
      ],
    })
    await openApp(page, '/', new Date('2026-03-16T10:00:00Z'))
    await goToCalendar(page)
    await gotoMonth(page, 'March 2026')
    for (const d of ['2026-03-23', '2026-03-30']) {
      await selectDay(page, d) // 29 Mar is the switch to CEST
      await expect(dayItems(page).first()).toContainText('09:00 – 10:30')
    }
    await gotoMonth(page, 'October 2026')
    for (const d of ['2026-10-19', '2026-10-26']) {
      await selectDay(page, d) // 25 Oct is the switch back to CET
      await expect(dayItems(page).first()).toContainText('09:00 – 10:30')
    }
    await gotoMonth(page, 'December 2026')
    expect(await countOn(page, '2026-12-17')).toBe(1)
    expect(await countOn(page, '2026-12-31')).toBe(1)
    await gotoMonth(page, 'January 2027')
    expect(await countOn(page, '2027-01-07')).toBe(1)
    expect(await countOn(page, '2027-01-21')).toBe(1)
    expect(await countOn(page, '2027-01-28')).toBe(0)
  })

  test('series whose local time falls in the DST gap warns, can be reviewed, and is flagged after saving', async ({ page }) => {
    await openApp(page, '/', new Date('2026-03-16T10:00:00Z'))
    await goToCalendar(page)
    await addEvent(
      page,
      { title: 'QA Gap Series', category: 'Work', repeat: 'weekly', weekdays: ['Sat'], startDate: '2026-03-21', startTime: '22:00', endDate: '2026-03-22', endTime: '02:30', until: '2026-04-04' },
      { save: false },
    )
    await submit(page)
    const w = dialog(page).getByRole('alertdialog', { name: 'Please review' })
    await expect(w).toContainText('Daylight saving notices')
    await expect(w).toContainText('02:30 does not exist')
    await w.getByRole('button', { name: 'Go back' }).click()
    expect(await readStorage(page, 'orbit.series.v1')).toBeNull()
    await submit(page)
    await w.getByRole('button', { name: 'Save anyway' }).click()
    await expect(dialog(page)).toBeHidden()
    await gotoMonth(page, 'March 2026')
    await selectDay(page, '2026-03-28')
    await expect(dayItems(page).first()).toContainText('Shifted for DST')
    await selectDay(page, '2026-03-21')
    await expect(dayItems(page).first()).not.toContainText('Shifted for DST')
  })
})

test.describe('storage and data safety (isolated browser contexts)', () => {
  const oldEvents = [ev({ id: 'old1', title: 'QA Phase 2A Event', start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T09:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })]

  test('Phase 2A events load unchanged and their storage key is not rewritten by series work', async ({ page, context }) => {
    const raw = JSON.stringify(oldEvents)
    await seed(context, { raw: { 'orbit.events.v1': raw } })
    await openApp(page)
    await goToCalendar(page)
    expect(await countOn(page, '2026-10-09')).toBe(1)
    await addEvent(page, { title: 'QA New Series', category: 'Study', repeat: 'weekly', weekdays: ['Tue'], startDate: '2026-10-13', startTime: '18:00', endDate: '2026-10-13', endTime: '19:00', until: '2026-11-03' })
    await selectDay(page, '2026-10-13')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
    await dialog(page).getByLabel('Location (optional)').fill('Library')
    await submit(page, 'Save occurrence')
    expect(await readStorage(page, 'orbit.events.v1')).toBe(raw) // byte-identical
    expect(JSON.parse((await readStorage(page, 'orbit.series.v1'))!)).toHaveLength(1)
  })

  test('invalid stored records are dropped safely, valid ones survive, raw data is backed up', async ({ page, context }) => {
    const goodSeries = weeklySeries({ id: 'good', title: 'QA Good Series', exceptions: [{ originalDate: '2026-10-14', cancelled: true }, { originalDate: 'garbage' }] })
    const events = [...oldEvents, { id: 'bad1', title: '', category: 'work' }, 'junk', null, { ...oldEvents[0], id: 'bad2', category: 'nope' }]
    await seed(context, {
      raw: { 'orbit.events.v1': JSON.stringify(events), 'orbit.series.v1': JSON.stringify([goodSeries, { id: 'bad' }, 42]) },
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openApp(page)
    await goToCalendar(page)
    expect(await countOn(page, '2026-10-09')).toBe(1)
    expect(await countOn(page, '2026-10-12')).toBe(1) // good series works
    expect(await countOn(page, '2026-10-14')).toBe(0) // its valid exception still applies
    expect(await readStorage(page, 'orbit.events.v1.backup')).toBe(JSON.stringify(events))
    expect(await readStorage(page, 'orbit.series.v1.backup')).not.toBeNull()
    expect(errors).toEqual([])
    // and the app can still save afterwards
    await addEvent(page, { title: 'QA After Recovery', startDate: '2026-10-15', startTime: '10:00', endDate: '2026-10-15', endTime: '11:00' })
    expect(await countOn(page, '2026-10-15')).toBe(1)
  })

  test('corrupt JSON does not crash the app and is preserved in a backup', async ({ page, context }) => {
    await seed(context, { raw: { 'orbit.events.v1': '{not json', 'orbit.series.v1': '[[[' } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openApp(page)
    await expect(page.getByText('Your calendar is empty')).toBeVisible()
    expect(await readStorage(page, 'orbit.events.v1.backup')).toBe('{not json')
    expect(await readStorage(page, 'orbit.series.v1.backup')).toBe('[[[')
    expect(errors).toEqual([])
  })

  test('failed write shows a clear "Not saved" banner instead of false success', async ({ page, context }) => {
    await context.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('quota', 'QuotaExceededError')
      }
    })
    await openApp(page)
    await expect(page.getByText('Not saved.')).toBeHidden()
    await goToCalendar(page)
    await addEvent(page, { title: 'QA Unsaved', startDate: '2026-10-09', startTime: '10:00', endDate: '2026-10-09', endTime: '11:00' })
    await expect(page.getByRole('alert').filter({ hasText: 'Not saved.' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'lost on refresh' })).toBeVisible()
  })

  test('changes made in another tab appear without reload', async ({ context }) => {
    const a = await context.newPage()
    const b = await context.newPage()
    await openApp(a)
    await goToCalendar(a)
    await openApp(b)
    await goToCalendar(b)
    expect(await countOn(a, '2026-10-09')).toBe(0)
    await addEvent(b, { title: 'QA From Tab B', startDate: '2026-10-09', startTime: '10:00', endDate: '2026-10-09', endTime: '11:00' })
    await expect.poll(() => countOn(a, '2026-10-09')).toBe(1)
    // series too
    await addEvent(b, { title: 'QA Series Tab B', category: 'Work', repeat: 'weekly', weekdays: ['Mon'], startDate: '2026-10-12', startTime: '13:00', endDate: '2026-10-12', endTime: '14:00', until: '2026-10-26' })
    await expect.poll(() => countOn(a, '2026-10-12')).toBe(1)
  })

  test('no duplicate occurrences after edits and reloads', async ({ page, context }) => {
    await seed(context, { series: [weeklySeries({ exceptions: [{ originalDate: '2026-10-14', override: { title: 'QA Renamed' } }] })] })
    await openApp(page)
    await goToCalendar(page)
    for (let i = 0; i < 3; i++) {
      await page.reload()
      await goToCalendar(page)
      expect(await countOn(page, '2026-10-14')).toBe(1)
      expect(await countOn(page, '2026-10-12')).toBe(1)
    }
    void TS
  })
})

test.describe('university metadata', () => {
  test('course code, session type and group label can be set, shown, overridden and persisted', async ({ page }) => {
    await openApp(page)
    await goToCalendar(page)
    await addEvent(page, {
      title: 'QA Metadata Course',
      category: 'University',
      courseCode: 'QA101',
      sessionType: 'Tutorial',
      groupLabel: 'Group B',
      repeat: 'weekly',
      weekdays: ['Mon'],
      startDate: '2026-10-12',
      startTime: '09:00',
      endDate: '2026-10-12',
      endTime: '10:00',
      until: '2026-10-26',
    })
    const series = JSON.parse((await readStorage(page, 'orbit.series.v1'))!)
    expect(series[0]).toMatchObject({ courseCode: 'QA101', sessionType: 'tutorial', groupLabel: 'Group B' })

    await selectDay(page, '2026-10-12')
    await expect(dayItems(page).first()).toContainText('QA101 · Tutorial · Group B')

    // override one occurrence only
    await selectDay(page, '2026-10-19')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
    await expect(dialog(page).getByLabel('Course code')).toHaveValue('QA101')
    await dialog(page).getByLabel('Group label').fill('Group C')
    await dialog(page).getByLabel('Session type').selectOption({ label: 'Seminar' })
    await submit(page, 'Save occurrence')
    await expect(dayItems(page).first()).toContainText('QA101 · Seminar · Group C')
    await selectDay(page, '2026-10-12')
    await expect(dayItems(page).first()).toContainText('QA101 · Tutorial · Group B')

    // survives reload
    await page.reload()
    await goToCalendar(page)
    await selectDay(page, '2026-10-19')
    await expect(dayItems(page).first()).toContainText('QA101 · Seminar · Group C')

    // the section is hidden for non-university categories and fields are optional
    await page.getByRole('button', { name: /Add event/ }).first().click()
    await dialog(page).getByLabel('Category').selectOption({ label: 'Work' })
    await expect(dialog(page).getByLabel('Course code')).toBeHidden()
    await dialog(page).getByLabel('Category').selectOption({ label: 'University' })
    await expect(dialog(page).getByLabel('Course code')).toBeVisible()
  })
})

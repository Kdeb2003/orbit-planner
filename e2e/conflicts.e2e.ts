import { expect, test } from '@playwright/test'
import { addEvent, countOn, dayItems, dialog, ev, fillForm, goToCalendar, openApp, readStorage, seed, selectDay, submit, weeklySeries } from './helpers'

const warning = (page: import('@playwright/test').Page) => dialog(page).getByRole('alertdialog', { name: 'Please review' })

const uni = ev({ id: 'u1', title: 'QA Lecture', start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T09:30:00.000Z' }) // 10:00-11:30 Berlin

test.describe('conflict detection (browser)', () => {
  test('work overlapping university: lists names/times, Go back returns to editing, Save anyway saves', async ({ page, context }) => {
    await seed(context, { events: [uni] })
    await openApp(page)
    await goToCalendar(page)
    await addEvent(
      page,
      { title: 'QA Shift', category: 'Work', startDate: '2026-10-09', startTime: '11:00', endDate: '2026-10-09', endTime: '13:00' },
      { save: false },
    )
    await submit(page)
    const w = warning(page)
    await expect(w).toBeVisible()
    await expect(w).toContainText('This overlaps other events')
    await expect(w).toContainText('“QA Lecture”')
    await expect(w).toContainText('10:00 – 11:30')
    await expect(w).toContainText('11:00 – 13:00')
    // nothing saved yet
    expect(JSON.parse((await readStorage(page, 'orbit.events.v1'))!)).toHaveLength(1)

    await w.getByRole('button', { name: 'Go back' }).click()
    await expect(w).toBeHidden()
    await expect(dialog(page).getByLabel('Title')).toHaveValue('QA Shift') // form intact

    await submit(page)
    await warning(page).getByRole('button', { name: 'Save anyway' }).click()
    await expect(dialog(page)).toBeHidden()
    const stored = JSON.parse((await readStorage(page, 'orbit.events.v1'))!)
    expect(stored.map((e: { title: string }) => e.title).sort()).toEqual(['QA Lecture', 'QA Shift']) // both kept, neither altered
    expect(stored.find((e: { id: string }) => e.id === 'u1')).toEqual(uni)
    expect(await countOn(page, '2026-10-09')).toBe(2)
  })

  test('adjacent events do not conflict', async ({ page, context }) => {
    await seed(context, { events: [uni] })
    await openApp(page)
    await goToCalendar(page)
    await addEvent(page, { title: 'QA After', category: 'Work', startDate: '2026-10-09', startTime: '11:30', endDate: '2026-10-09', endTime: '12:30' }, { save: false })
    await submit(page)
    await expect(dialog(page)).toBeHidden() // saved directly: no warning
    expect(await countOn(page, '2026-10-09')).toBe(2)
  })

  test('two recurring university sessions overlapping', async ({ page, context }) => {
    await seed(context, { series: [weeklySeries({ recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-12', untilDate: '2026-11-30' } })] })
    await openApp(page)
    await goToCalendar(page)
    await addEvent(
      page,
      { title: 'QA Physics', category: 'University', repeat: 'weekly', weekdays: ['Mon'], startDate: '2026-10-12', startTime: '10:00', endDate: '2026-10-12', endTime: '11:00', until: '2026-11-30' },
      { save: false },
    )
    await submit(page)
    await expect(warning(page)).toContainText('“QA Series”')
    await expect(warning(page)).toContainText('more overlaps') // 8 Mondays -> truncated list
    await warning(page).getByRole('button', { name: 'Save anyway' }).click()
    await expect(dialog(page)).toBeHidden()
    expect(JSON.parse((await readStorage(page, 'orbit.series.v1'))!)).toHaveLength(2)
  })

  test('single event vs a modified (moved) occurrence, and no false conflict at the original time', async ({ page, context }) => {
    const moved = weeklySeries({
      recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-12', untilDate: '2026-11-30' },
      exceptions: [{ originalDate: '2026-10-12', override: { start: '2026-10-13T12:00:00.000Z', end: '2026-10-13T13:30:00.000Z' } }], // Tue 14:00-15:30 Berlin
    })
    await seed(context, { series: [moved] })
    await openApp(page)
    await goToCalendar(page)
    // At the occurrence's ORIGINAL time on 12 Oct: no conflict (it moved away)
    await addEvent(page, { title: 'QA Original Slot', category: 'Work', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:00' }, { save: false })
    await submit(page)
    await expect(dialog(page)).toBeHidden()
    // At the new time on 13 Oct: conflict
    await addEvent(page, { title: 'QA New Slot', category: 'Work', startDate: '2026-10-13', startTime: '14:30', endDate: '2026-10-13', endTime: '15:00' }, { save: false })
    await submit(page)
    await expect(warning(page)).toContainText('“QA Series”')
    await expect(warning(page)).toContainText('14:00 – 15:30')
    await warning(page).getByRole('button', { name: 'Go back' }).click()
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  })

  test('conflict across midnight (and overnight vs overnight)', async ({ page, context }) => {
    const night = ev({ id: 'n1', title: 'QA Night A', category: 'work', start: '2026-10-09T21:00:00.000Z', end: '2026-10-10T03:00:00.000Z' }) // Fri 23:00 - Sat 05:00
    await seed(context, { events: [night] })
    await openApp(page)
    await goToCalendar(page)
    // Saturday 04:00-06:00 overlaps only the tail of the Friday-night shift
    await addEvent(page, { title: 'QA Early', category: 'Work', startDate: '2026-10-10', startTime: '04:00', endDate: '2026-10-10', endTime: '06:00' }, { save: false })
    await submit(page)
    await expect(warning(page)).toContainText('“QA Night A”')
    await warning(page).getByRole('button', { name: 'Go back' }).click()
    // Overnight vs overnight: Fri 22:00 -> Sat 02:00
    await fillForm(page, { title: 'QA Night B', startDate: '2026-10-09', startTime: '22:00', endDate: '2026-10-10', endTime: '02:00' })
    await submit(page)
    await expect(warning(page)).toContainText('“QA Night A”')
    await warning(page).getByRole('button', { name: 'Go back' }).click()
    // Sat 05:00 start touches the shift's end exactly: no conflict
    await fillForm(page, { title: 'QA Touching', startDate: '2026-10-10', startTime: '05:00', endDate: '2026-10-10', endTime: '06:00' })
    await submit(page)
    await expect(dialog(page)).toBeHidden()
  })

  test('cancelled occurrence creates no conflict; deadlines never conflict', async ({ page, context }) => {
    const s = weeklySeries({
      recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-12', untilDate: '2026-11-30' },
      exceptions: [{ originalDate: '2026-10-12', cancelled: true }],
    })
    await seed(context, { series: [s] })
    await openApp(page)
    await goToCalendar(page)
    await addEvent(page, { title: 'QA Over Cancelled', category: 'Work', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:00' }, { save: false })
    await submit(page)
    await expect(dialog(page)).toBeHidden() // no warning
    // Next Monday is NOT cancelled: conflict
    await addEvent(page, { title: 'QA Over Active', category: 'Work', startDate: '2026-10-19', startTime: '09:00', endDate: '2026-10-19', endTime: '10:00' }, { save: false })
    await submit(page)
    await expect(warning(page)).toBeVisible()
    await warning(page).getByRole('button', { name: 'Go back' }).click()
    // Deadline policy: same slot, category Deadline -> no warning
    await fillForm(page, { title: 'QA Due', category: 'Deadline' })
    await submit(page)
    await expect(dialog(page)).toBeHidden()
  })

  test('editing an event / a series does not conflict with itself', async ({ page, context }) => {
    await seed(context, { events: [uni], series: [weeklySeries()] })
    await openApp(page)
    await goToCalendar(page)
    // one-off: change only the title
    await selectDay(page, '2026-10-09')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByLabel('Title').fill('QA Lecture renamed')
    await submit(page, 'Save changes')
    await expect(dialog(page)).toBeHidden() // no warning
    // whole series: change only the location
    await selectDay(page, '2026-10-12')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: /Entire series/ }).click()
    await dialog(page).getByLabel('Location (optional)').fill('Room 9')
    await submit(page, 'Save series')
    await expect(dialog(page)).toBeHidden() // no warning
    // single occurrence: change only the location
    await selectDay(page, '2026-10-14')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
    await dialog(page).getByLabel('Location (optional)').fill('Room 10')
    await submit(page, 'Save occurrence')
    await expect(dialog(page)).toBeHidden()
  })
})

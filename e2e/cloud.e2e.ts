import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { mockSupabaseAuth, TEST_EMAIL, TEST_EMAIL_2, TEST_PASSWORD, TEST_PASSWORD_2, USER_ID, USER_ID_2 } from './authMock'
import { MockCloudDb } from './cloudMock'
import { addEvent, countOn, cell, dayItems, dialog, ev, fillForm, goToCalendar, gotoMonth, readStorage, seed, selectDay, submit, TS, weeklySeries } from './helpers'

// Real supabase-js + real app against a MOCKED Auth and REST API (see cloudMock.ts). No hosted project is contacted.

const appVisible = (page: Page) => page.getByText('Quick actions')
const chip = (page: Page) => page.getByTestId('sync-status')

async function signIn(page: Page, email = TEST_EMAIL, password = TEST_PASSWORD) {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(appVisible(page)).toBeVisible()
  await expect(chip(page)).toHaveAttribute('data-state', 'saved')
}

/** A second "device": a separate browser context (own storage and session) sharing the same mock cloud. */
async function newDevice(context: BrowserContext, db: MockCloudDb, email = TEST_EMAIL, password = TEST_PASSWORD) {
  const ctx = await context.browser()!.newContext({ timezoneId: 'America/Los_Angeles', locale: 'en-GB', baseURL: 'http://localhost:5198' })
  const page = await ctx.newPage()
  await mockSupabaseAuth(page, { db })
  await signIn(page, email, password)
  return { page, ctx }
}

const rows = (db: MockCloudDb, table: 'events' | 'recurring_series' | 'series_exceptions', user = USER_ID) => db.rowsOf(table, user)

test.describe('cloud calendar (mocked REST API)', () => {
  test('nothing is requested while signed out; events are created in the cloud, not in browser storage; they survive reload', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(log.db.log).toEqual([]) // a signed-out visitor triggers no calendar requests at all

    await page.getByLabel('Email').fill(TEST_EMAIL)
    await page.getByLabel('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(appVisible(page)).toBeVisible()
    await expect(page.getByText('Your calendar is empty')).toBeVisible()

    await goToCalendar(page)
    await addEvent(page, { title: 'Cloud lecture', category: 'University', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:30', location: 'Room 1', courseCode: 'CS201', sessionType: 'Tutorial', groupLabel: 'Group B' })
    await expect(chip(page)).toHaveAttribute('data-state', 'saved')

    const [row] = rows(log.db, 'events')
    expect(row).toMatchObject({ title: 'Cloud lecture', user_id: USER_ID, category: 'university', starts_at: '2026-10-12T07:00:00.000Z', ends_at: '2026-10-12T08:30:00.000Z', time_zone: 'Europe/Berlin', location: 'Room 1', course_code: 'CS201', session_type: 'tutorial', group_label: 'Group B', description: null })
    expect(String(row.id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readStorage(page, 'orbit.events.v1')).toBeNull() // never written to the shared local storage

    await page.reload()
    await expect(appVisible(page)).toBeVisible().catch(() => {})
    await goToCalendar(page)
    await gotoMonth(page, 'October 2026')
    expect(await countOn(page, '2026-10-12')).toBe(1)
    await selectDay(page, '2026-10-12')
    await expect(dayItems(page).first()).toContainText('CS201 · Tutorial · Group B')
  })

  test('edit and delete are saved to the cloud', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    await goToCalendar(page)
    await addEvent(page, { title: 'Original', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:00' })
    await gotoMonth(page, 'October 2026')
    await selectDay(page, '2026-10-12')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByLabel('Title').fill('Renamed')
    await dialog(page).getByLabel('Location (optional)').fill('Hall')
    await submit(page, 'Save changes')
    await expect(dialog(page)).toBeHidden()
    expect(rows(log.db, 'events')).toHaveLength(1)
    expect(rows(log.db, 'events')[0]).toMatchObject({ title: 'Renamed', location: 'Hall' })
    // clearing the location writes NULL (optional values map to SQL NULL)
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByLabel('Location (optional)').fill('')
    await submit(page, 'Save changes')
    await expect(dialog(page)).toBeHidden()
    expect(rows(log.db, 'events')[0].location).toBeNull()

    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: 'Delete' }).click()
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).last().click()
    await expect(dialog(page)).toBeHidden()
    expect(rows(log.db, 'events')).toHaveLength(0)
    expect(await countOn(page, '2026-10-12')).toBe(0)
  })

  test('weekly series, cancel / restore / move are stored as one series + exceptions and survive reload (DST-correct)', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    await goToCalendar(page)
    await addEvent(page, { title: 'Weekly class', category: 'University', repeat: 'weekly', weekdays: ['Mon'], startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:30', until: '2026-11-30' })
    expect(rows(log.db, 'recurring_series')).toHaveLength(1)
    expect(rows(log.db, 'recurring_series')[0]).toMatchObject({ weekdays: [0], start_time: '09:00', end_time: '10:30', start_date: '2026-10-12', until_date: '2026-11-30', end_day_offset: 0 })
    expect(rows(log.db, 'events')).toHaveLength(0) // not 8 stored events

    await gotoMonth(page, 'October 2026')
    // cancel 19 Oct
    await selectDay(page, '2026-10-19')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
    await dialog(page).getByRole('button', { name: 'Cancel occurrence' }).click()
    await expect(dialog(page)).toBeHidden()
    // move 26 Oct to 27 Oct
    await selectDay(page, '2026-10-26')
    await dayItems(page).first().getByRole('button').click()
    await dialog(page).getByRole('button', { name: /Only this occurrence/ }).click()
    await fillForm(page, { startDate: '2026-10-27' })
    await submit(page, 'Save occurrence')
    await expect(dialog(page)).toBeHidden()

    const ex = rows(log.db, 'series_exceptions')
    expect(ex.map((x) => [x.original_date, x.cancelled]).sort()).toEqual([['2026-10-19', true], ['2026-10-26', false]])
    expect(ex.find((x) => x.original_date === '2026-10-26')!.override).toMatchObject({ start: '2026-10-27T08:00:00.000Z', end: '2026-10-27T09:30:00.000Z' }) // 09:00 Berlin (CET)

    await page.reload()
    await goToCalendar(page)
    await gotoMonth(page, 'October 2026')
    expect(await countOn(page, '2026-10-19')).toBe(0)
    expect(await countOn(page, '2026-10-26')).toBe(0)
    expect(await countOn(page, '2026-10-27')).toBe(1)
    await selectDay(page, '2026-10-19')
    await dayItems(page).first().getByRole('button', { name: /Restore/ }).click()
    await expect(chip(page)).toHaveAttribute('data-state', 'saved')
    expect(await countOn(page, '2026-10-19')).toBe(1)
    expect(rows(log.db, 'series_exceptions').map((x) => x.original_date)).toEqual(['2026-10-26']) // restore removed the exception row
    // the series is still ONE row; no duplicates anywhere
    expect(rows(log.db, 'recurring_series')).toHaveLength(1)
  })

  test('a failed save is shown as "not saved", nothing appears in the calendar, and retry saves exactly once', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    await goToCalendar(page)
    log.db.failWrites = { status: 500, code: 'XX000', message: 'boom (internal detail that must not be shown)' }
    await page.getByRole('button', { name: /Add event/ }).first().click()
    await fillForm(page, { title: 'Will fail first', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:00' })
    await submit(page)
    await expect(dialog(page).getByTestId('save-error')).toContainText('Not saved')
    await expect(dialog(page).getByTestId('save-error')).not.toContainText('boom')
    await expect(dialog(page)).toBeVisible()
    await expect(chip(page)).toHaveAttribute('data-state', 'error')
    expect(rows(log.db, 'events')).toHaveLength(0)

    log.db.failWrites = null
    await submit(page)
    await expect(dialog(page)).toBeHidden()
    expect(rows(log.db, 'events')).toHaveLength(1)
    await expect(chip(page)).toHaveAttribute('data-state', 'saved')
    await gotoMonth(page, 'October 2026')
    expect(await countOn(page, '2026-10-12')).toBe(1)
  })

  test('offline: the save fails visibly, the app keeps its data, and recovers when the network returns', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    log.db.seed('events', USER_ID, { id: '11111111-1111-4111-8111-111111111111', title: 'Already synced', category: 'personal', starts_at: '2026-10-12T07:00:00.000Z', ends_at: '2026-10-12T08:00:00.000Z', time_zone: 'Europe/Berlin', location: null, description: null, course_code: null, session_type: null, group_label: null })
    await signIn(page)
    await goToCalendar(page)
    await gotoMonth(page, 'October 2026')
    expect(await countOn(page, '2026-10-12')).toBe(1)

    log.db.offline = true
    await page.getByRole('button', { name: /Add event/ }).first().click()
    await fillForm(page, { title: 'While offline', startDate: '2026-10-13', startTime: '09:00', endDate: '2026-10-13', endTime: '10:00' })
    await submit(page)
    await expect(dialog(page).getByTestId('save-error')).toContainText(/reach the server/)
    await expect(chip(page)).toHaveAttribute('data-state', 'offline')
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await countOn(page, '2026-10-12')).toBe(1) // existing data still shown
    expect(await countOn(page, '2026-10-13')).toBe(0) // the unsaved event is not pretended to exist
    await expect(page.getByTestId('sync-error')).toBeVisible()

    log.db.offline = false
    await chip(page).click() // Retry
    await expect(chip(page)).toHaveAttribute('data-state', 'saved')
    await expect(page.getByTestId('sync-error')).toBeHidden()
  })

  test('slow network shows a loading state, never an empty-looking calendar', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    log.db.seed('events', USER_ID, { id: '22222222-2222-4222-8222-222222222222', title: 'Slow event', category: 'personal', starts_at: '2026-10-12T07:00:00.000Z', ends_at: '2026-10-12T08:00:00.000Z', time_zone: 'Europe/Berlin', location: null, description: null, course_code: null, session_type: null, group_label: null })
    log.db.delayMs = 1200
    await page.goto('/')
    await page.getByLabel('Email').fill(TEST_EMAIL)
    await page.getByLabel('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Loading your calendar…')).toBeVisible()
    await expect(page.getByText('Your calendar is empty')).toBeHidden()
    await expect(appVisible(page)).toBeVisible({ timeout: 10_000 })
  })

  test('two devices: changes made on one appear on the other without signing out; a stale edit is rejected', async ({ browser }) => {
    const db = new MockCloudDb()
    const ctxA = await browser.newContext({ baseURL: 'http://localhost:5198', timezoneId: 'America/Los_Angeles', locale: 'en-GB' })
    const phone = await ctxA.newPage()
    await mockSupabaseAuth(phone, { db })
    await signIn(phone)
    await goToCalendar(phone)
    await gotoMonth(phone, 'October 2026')

    const { page: laptop, ctx: ctxB } = await newDevice(ctxA, db)
    await goToCalendar(laptop)
    await gotoMonth(laptop, 'October 2026')
    await addEvent(laptop, { title: 'From laptop', startDate: '2026-10-14', startTime: '09:00', endDate: '2026-10-14', endTime: '10:00' })
    expect(await countOn(phone, '2026-10-14')).toBe(0) // phone has not looked yet

    // phone regains focus -> refreshes (the focus/visibility/poll refresh is the dependable sync path)
    await phone.waitForTimeout(2300)
    await phone.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => countOn(phone, '2026-10-14')).toBe(1)

    // laptop edits; phone (still on the old version) tries to edit the same event
    await selectDay(laptop, '2026-10-14')
    await dayItems(laptop).first().getByRole('button').click()
    await dialog(laptop).getByLabel('Title').fill('Edited on laptop')
    await submit(laptop, 'Save changes')
    await expect(dialog(laptop)).toBeHidden()

    await selectDay(phone, '2026-10-14')
    await dayItems(phone).first().getByRole('button').click()
    await dialog(phone).getByLabel('Title').fill('Edited on phone')
    await submit(phone, 'Save changes')
    await expect(dialog(phone).getByTestId('save-error')).toContainText('another device')
    expect(rows(db, 'events')[0].title).toBe('Edited on laptop') // the newer cloud data was not overwritten
    await ctxB.close()
    await ctxA.close()
  })

  test('accounts are isolated and sign-out clears private data from the page', async ({ page }) => {
    const log = await mockSupabaseAuth(page)
    await signIn(page, TEST_EMAIL, TEST_PASSWORD)
    await goToCalendar(page)
    await addEvent(page, { title: 'Alice private event', startDate: '2026-10-12', startTime: '09:00', endDate: '2026-10-12', endTime: '10:00' })
    await page.goto('/#/settings')
    await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(await page.content()).not.toContain('Alice private event') // gone from the DOM

    await page.getByLabel('Email').fill(TEST_EMAIL_2)
    await page.getByLabel('Password').fill(TEST_PASSWORD_2)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(appVisible(page)).toBeVisible()
    await goToCalendar(page)
    await gotoMonth(page, 'October 2026')
    expect(await countOn(page, '2026-10-12')).toBe(0) // Bob does not see Alice's event
    expect(await page.content()).not.toContain('Alice private event')
    await addEvent(page, { title: 'Bob private event', startDate: '2026-10-12', startTime: '11:00', endDate: '2026-10-12', endTime: '12:00' })

    expect(rows(log.db, 'events', USER_ID).map((r) => r.title)).toEqual(['Alice private event'])
    expect(rows(log.db, 'events', USER_ID_2).map((r) => r.title)).toEqual(['Bob private event'])

    // back to Alice: only hers
    await page.goto('/#/settings')
    await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).first().click()
    await page.getByLabel('Email').fill(TEST_EMAIL)
    await page.getByLabel('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(appVisible(page)).toBeVisible()
    await goToCalendar(page)
    await gotoMonth(page, 'October 2026')
    await selectDay(page, '2026-10-12')
    await expect(dayItems(page)).toHaveCount(1)
    await expect(dayItems(page).first()).toContainText('Alice private event')
    expect(await page.content()).not.toContain('Bob private event')
    expect(await readStorage(page, 'orbit.events.v1')).toBeNull()
  })
})

test.describe('local data import (mocked REST API)', () => {
  const legacyEvents = [
    ev({ id: 'e1', title: 'Legacy event one', category: 'personal', start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T09:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' }),
    ev({ id: '33333333-3333-4333-8333-333333333333', title: 'Legacy uuid event', start: '2026-10-10T08:00:00.000Z', end: '2026-10-10T09:00:00.000Z' }),
  ]
  const legacySeries = [
    weeklySeries({
      id: 'old-series',
      title: 'Legacy weekly',
      recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-12', untilDate: '2026-11-30' },
      exceptions: [
        { originalDate: '2026-10-19', cancelled: true },
        { originalDate: '2026-10-26', override: { start: '2026-10-27T08:00:00.000Z', end: '2026-10-27T09:30:00.000Z', location: 'Room 204' } },
      ],
      createdAt: TS,
    }),
  ]
  const RAW_E = JSON.stringify(legacyEvents)
  const RAW_S = JSON.stringify(legacySeries)

  async function openImport(page: Page) {
    await page.goto('/#/settings')
    const card = page.getByTestId('local-import')
    await expect(card).toBeVisible()
    return card
  }

  test('backup → preview → confirm → upload → verified; idempotent; local data untouched; imported items appear', async ({ page, context }) => {
    await seed(context, { raw: { 'orbit.events.v1': RAW_E, 'orbit.series.v1': RAW_S } })
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    expect(rows(log.db, 'events')).toHaveLength(0) // signing in does NOT upload anything

    const card = await openImport(page)
    await expect(card).toContainText('2 event(s)')
    await expect(card).toContainText('1 repeating series')
    expect(rows(log.db, 'events')).toHaveLength(0)

    await card.getByRole('button', { name: /Preview import/ }).click()
    const preview = page.getByTestId('import-preview')
    await expect(preview).toContainText('Events: 2 to upload')
    await expect(preview).toContainText('Repeating series: 1 to upload')
    await expect(preview).toContainText('Exceptions: 2 to upload')
    const upload = preview.getByRole('button', { name: /Upload to my account/ })
    await expect(upload).toBeDisabled() // backup + confirmation still missing

    const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: /Download backup/ }).click()])
    expect(download.suggestedFilename()).toMatch(/^orbit-local-backup-.*\.json$/)
    const backup = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8'))
    expect(backup.storage['orbit.events.v1']).toBe(RAW_E) // byte-exact original
    expect(backup.storage['orbit.series.v1']).toBe(RAW_S)
    await expect(upload).toBeDisabled() // still needs the explicit confirmation
    await preview.getByRole('checkbox').check()
    expect(rows(log.db, 'events')).toHaveLength(0) // nothing uploaded until the button is pressed

    await upload.click()
    await expect(page.getByTestId('import-result')).toContainText('Imported and verified: 2 event(s), 1 series, 2 exception(s)')
    expect(rows(log.db, 'events').map((r) => r.title).sort()).toEqual(['Legacy event one', 'Legacy uuid event'])
    const legacyRow = rows(log.db, 'events').find((r) => r.title === 'Legacy event one')!
    expect(String(legacyRow.id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(legacyRow.id).not.toBe('e1') // legacy id mapped to a deterministic UUID
    expect(new Date(String(legacyRow.created_at)).toISOString()).toBe('2026-09-01T10:00:00.000Z')
    expect(rows(log.db, 'recurring_series')).toHaveLength(1)
    expect(rows(log.db, 'series_exceptions')).toHaveLength(2)

    // local storage: byte-identical; progress marker lives under its own key
    expect(await readStorage(page, 'orbit.events.v1')).toBe(RAW_E)
    expect(await readStorage(page, 'orbit.series.v1')).toBe(RAW_S)
    expect(JSON.parse((await readStorage(page, 'orbit.cloudImport.v1'))!)[USER_ID].status).toBe('verified')

    // running it again changes nothing
    await card.getByRole('button', { name: /Preview import/ }).click()
    await expect(page.getByTestId('import-preview')).toContainText('Events: 0 to upload, 2 already in the cloud')
    await expect(page.getByTestId('import-preview')).toContainText('Nothing new to upload')
    expect(rows(log.db, 'events')).toHaveLength(2)

    // imported data is now part of the cloud calendar
    await goToCalendar(page)
    await gotoMonth(page, 'October 2026')
    expect(await countOn(page, '2026-10-12')).toBe(1)
    expect(await countOn(page, '2026-10-19')).toBe(0) // cancelled occurrence imported as cancelled
    expect(await countOn(page, '2026-10-27')).toBe(1) // moved occurrence imported at its new date
  })

  test('an interrupted import (series saved, exceptions failed) is reported honestly and can be resumed without duplicates', async ({ page, context }) => {
    await seed(context, { raw: { 'orbit.events.v1': RAW_E, 'orbit.series.v1': RAW_S } })
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    const card = await openImport(page)
    await card.getByRole('button', { name: /Download backup/ }).click()
    await card.getByRole('button', { name: /Preview import/ }).click()
    const preview = page.getByTestId('import-preview')
    await preview.getByRole('checkbox').check()

    log.db.failWrites = { status: 500, code: 'XX000', message: 'boom', tables: ['series_exceptions'] }
    await preview.getByRole('button', { name: /Upload to my account/ }).click()
    await expect(page.getByTestId('import-result')).toContainText('Import stopped')
    await expect(page.getByTestId('import-result')).toContainText('safe to run the import again')
    expect(rows(log.db, 'recurring_series')).toHaveLength(1)
    expect(rows(log.db, 'series_exceptions')).toHaveLength(0)
    expect(JSON.parse((await readStorage(page, 'orbit.cloudImport.v1'))!)[USER_ID].status).toBe('failed') // never "verified"
    expect(await readStorage(page, 'orbit.events.v1')).toBe(RAW_E)

    log.db.failWrites = null
    await page.getByTestId('import-result').getByRole('button', { name: 'Preview again' }).click()
    const again = page.getByTestId('import-preview')
    await expect(again).toContainText('Repeating series: 0 to upload, 1 already in the cloud') // only the missing part is left
    await expect(again).toContainText('Exceptions: 2 to upload')
    await again.getByRole('checkbox').check()
    await again.getByRole('button', { name: /Upload to my account/ }).click()
    await expect(page.getByTestId('import-result')).toContainText('Imported and verified')
    expect(rows(log.db, 'events')).toHaveLength(2)
    expect(rows(log.db, 'recurring_series')).toHaveLength(1)
    expect(rows(log.db, 'series_exceptions')).toHaveLength(2)
    expect(JSON.parse((await readStorage(page, 'orbit.cloudImport.v1'))!)[USER_ID].status).toBe('verified')
  })

  test('invalid local records are listed and skipped; a different cloud version is never overwritten', async ({ page, context }) => {
    const t = { start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T09:00:00.000Z' }
    const bad = [ev({ id: 'long', title: 'x'.repeat(130), ...t }), ev({ id: 'zone', title: 'Bad zone', timeZone: 'UTC+9', ...t }), ev({ id: 'ok', title: 'Fine event', ...t })]
    await seed(context, { raw: { 'orbit.events.v1': JSON.stringify(bad) } })
    const log = await mockSupabaseAuth(page)
    await signIn(page)
    const card = await openImport(page)
    await card.getByRole('button', { name: /Download backup/ }).click()
    await card.getByRole('button', { name: /Preview import/ }).click()
    const preview = page.getByTestId('import-preview')
    await expect(preview).toContainText('Events: 1 to upload, 0 already in the cloud, 0 conflicting, 2 invalid')
    await expect(preview).toContainText('Skipped: Event “Bad zone”')
    await expect(preview).toContainText('time zone')
    await preview.getByRole('checkbox').check()
    await preview.getByRole('button', { name: /Upload to my account/ }).click()
    await expect(page.getByTestId('import-result')).toContainText('Some items were skipped')
    expect(rows(log.db, 'events').map((r) => r.title)).toEqual(['Fine event'])

    // someone changes the imported event in the cloud; re-previewing shows a conflict and it is not overwritten
    log.db.tables.events[0].title = 'Changed in the cloud'
    await card.getByRole('button', { name: /Preview import/ }).click()
    await expect(page.getByTestId('import-preview')).toContainText('1 conflicting')
    await expect(page.getByTestId('import-preview')).toContainText('not overwritten')
    expect(rows(log.db, 'events')[0].title).toBe('Changed in the cloud')
  })

  test('import card works on a phone-sized screen without horizontal overflow', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await seed(context, { raw: { 'orbit.events.v1': RAW_E, 'orbit.series.v1': RAW_S } })
    await mockSupabaseAuth(page)
    await signIn(page)
    const card = await openImport(page)
    await card.getByRole('button', { name: /Preview import/ }).click()
    await expect(page.getByTestId('import-preview')).toBeVisible()
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
    expect(sw).toBeLessThanOrEqual(cw)
    for (const name of [/Download backup/, /Preview import/]) expect((await card.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await expect(chip(page)).toBeVisible()
    await page.screenshot({ path: 'e2e-artifacts/screenshots/cloud-import-mobile.png', fullPage: true })
    void cell
  })
})

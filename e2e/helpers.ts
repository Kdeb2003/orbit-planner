import { expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'

/** Fixed "now" used by most tests: Friday 9 Oct 2026, 12:00 Berlin (CEST). */
export const NOW = new Date('2026-10-09T10:00:00Z')

export const TS = '2026-01-01T00:00:00.000Z'

export interface Fixture {
  events?: unknown[]
  series?: unknown[]
  /** Raw strings to place under storage keys (for corrupt-data tests). */
  raw?: Record<string, string>
}

/** Pre-load localStorage once per context (not on reloads, so app writes survive). */
export async function seed(context: BrowserContext, fixture: Fixture) {
  await context.addInitScript((f) => {
    if (localStorage.getItem('__seeded')) return
    localStorage.setItem('__seeded', '1')
    if (f.events) localStorage.setItem('orbit.events.v1', JSON.stringify(f.events))
    if (f.series) localStorage.setItem('orbit.series.v1', JSON.stringify(f.series))
    for (const [k, v] of Object.entries(f.raw ?? {})) localStorage.setItem(k, v)
  }, fixture)
}

export async function openApp(page: Page, path = '/', now: Date = NOW) {
  await page.clock.install({ time: now })
  await page.goto(`/#${path}`)
}

export const dialog = (page: Page) => page.getByRole('dialog')

export interface FormInput {
  title?: string
  category?: string
  repeat?: 'none' | 'weekly'
  weekdays?: string[] // 'Mon', 'Wed'
  until?: string
  startDate?: string
  startTime?: string
  endDate?: string
  endTime?: string
  location?: string
  notes?: string
  courseCode?: string
  sessionType?: string
  groupLabel?: string
}

/** Fill the (already open) event form. Order matters: start date first, since it syncs the end date. */
export async function fillForm(page: Page, f: FormInput) {
  const d = dialog(page)
  if (f.title !== undefined) await d.getByLabel('Title').fill(f.title)
  if (f.category) await d.getByLabel('Category').selectOption({ label: f.category })
  if (f.repeat) await d.getByLabel('Repeat').selectOption(f.repeat)
  if (f.weekdays) {
    // reset toggles to exactly the requested set
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      const btn = d.getByRole('button', { name: day, exact: true })
      const on = (await btn.getAttribute('aria-pressed')) === 'true'
      if (on !== f.weekdays.includes(day)) await btn.click()
    }
  }
  if (f.startDate) await d.locator('#ev-startDate').fill(f.startDate)
  if (f.startTime) await d.locator('#ev-startTime').fill(f.startTime)
  if (f.endDate) await d.locator('#ev-endDate').fill(f.endDate)
  if (f.endTime) await d.locator('#ev-endTime').fill(f.endTime)
  if (f.until) await d.locator('#ev-until').fill(f.until)
  if (f.location !== undefined) await d.getByLabel('Location (optional)').fill(f.location)
  if (f.notes !== undefined) await d.getByLabel('Notes (optional)').fill(f.notes)
  if (f.courseCode !== undefined) await d.getByLabel('Course code').fill(f.courseCode)
  if (f.sessionType) await d.getByLabel('Session type').selectOption({ label: f.sessionType })
  if (f.groupLabel !== undefined) await d.getByLabel('Group label').fill(f.groupLabel)
}

export async function submit(page: Page, name: RegExp | string = /^Save/) {
  await dialog(page).getByRole('button', { name }).click()
}

/** Click "Add event" (Calendar header or Today quick action), fill, and save. */
export async function addEvent(page: Page, f: FormInput, opts: { save?: boolean } = {}) {
  await page.getByRole('button', { name: /Add event/ }).first().click()
  await expect(dialog(page)).toBeVisible()
  await fillForm(page, f)
  if (opts.save !== false) {
    await submit(page)
    await expect(dialog(page)).toBeHidden()
  }
}

// ---- Calendar helpers ----

export const cell = (page: Page, date: string) => page.locator(`[data-date="${date}"]`)

export async function countOn(page: Page, date: string): Promise<number> {
  return Number(await cell(page, date).getAttribute('data-count'))
}

export async function goToCalendar(page: Page) {
  await page.getByRole('link', { name: 'Calendar' }).filter({ visible: true }).click()
  await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible()
}

/** Select a day in the month grid; returns the locator of the day-detail card. */
export async function selectDay(page: Page, date: string) {
  await cell(page, date).click()
  await expect(cell(page, date)).toHaveAttribute('aria-pressed', 'true')
  return page.locator('section').filter({ has: page.getByRole('heading', { level: 2 }) }).last()
}

/** The list rows (buttons or cancelled rows) shown in the day-detail card for the selected day. */
export const dayItems = (page: Page) => page.locator('main section').last().locator('li')

export async function monthTitle(page: Page) {
  return (await page.getByRole('heading', { level: 1 }).textContent()) ?? ''
}

export async function gotoMonth(page: Page, title: string) {
  for (let i = 0; i < 24; i++) {
    if ((await monthTitle(page)).trim() === title) return
    // pick direction by comparing parsed dates
    const cur = new Date(`1 ${await monthTitle(page)} UTC`)
    const want = new Date(`1 ${title} UTC`)
    await page.getByRole('button', { name: cur < want ? 'Next month' : 'Previous month' }).click()
  }
  throw new Error(`could not navigate to ${title}`)
}

/** Expected active dates (Mondays/Wednesdays etc.) for a simple weekly series, inclusive range. */
export function expectedDates(weekdays: number[], from: string, to: string, skip: string[] = []): Set<string> {
  const out = new Set<string>()
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t)
    const wd = (d.getUTCDay() + 6) % 7
    const key = d.toISOString().slice(0, 10)
    if (weekdays.includes(wd) && !skip.includes(key)) out.add(key)
  }
  return out
}

/** All grid dates currently rendered in the month view. */
export async function visibleDates(page: Page): Promise<string[]> {
  return page.locator('[data-date]').evaluateAll((els) => els.map((e) => e.getAttribute('data-date') as string))
}

export async function readStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

export function ev(over: Record<string, unknown>) {
  return {
    category: 'university',
    timeZone: 'Europe/Berlin',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }
}

export function weeklySeries(over: Record<string, unknown> = {}) {
  return {
    id: 'ser1',
    title: 'QA Series',
    category: 'university',
    timeZone: 'Europe/Berlin',
    recurrence: { frequency: 'weekly', weekdays: [0, 2], startDate: '2026-10-12', untilDate: '2026-12-14' },
    startTime: '09:00',
    endTime: '10:30',
    endDayOffset: 0,
    exceptions: [],
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }
}

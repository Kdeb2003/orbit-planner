import { expect, test } from '@playwright/test'
import { fixturePdf, hasRealPdf, REAL_PDF, recordRequests, uploadAndWait } from './timetableFixtures'

// The PRODUCTION build served under /orbit-planner/ (the closest local approximation of GitHub Pages): the lazily
// loaded PDF.js chunk and its worker must resolve under the base path, and the PDF must not leave the page.

test.describe('timetable import on the production build at /orbit-planner/', () => {
  test('the import route survives a hard refresh and parses a PDF with the bundled worker', async ({ page }) => {
    const responses: { url: string; type: string; status: number }[] = []
    page.on('response', (r) => responses.push({ url: r.url(), type: r.headers()['content-type'] ?? '', status: r.status() }))
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const requests = recordRequests(page)

    await page.goto('#/import-timetable')
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()
    await page.reload() // GitHub Pages must serve the same document for a refresh on a hash route
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()

    await uploadAndWait(page, fixturePdf())
    await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Review sessions/ }).click()
    await expect(page.locator('li[data-session-id]').first()).toBeVisible()
    await expect(page.getByTestId('shown-count')).not.toHaveAttribute('data-count', '0')

    const assets = responses.filter((r) => /\/assets\//.test(r.url))
    expect(assets.length).toBeGreaterThan(3)
    for (const a of assets) expect(new URL(a.url).pathname.startsWith('/orbit-planner/assets/')).toBe(true)

    // the worker is a real JavaScript module under the base path, not index.html served for a missing file
    const worker = responses.find((r) => /\/assets\/pdf\.worker[^/]*\.mjs$/.test(r.url))
    expect(worker, 'pdf.worker module requested').toBeTruthy()
    expect(worker!.status).toBe(200)
    expect(worker!.type).toMatch(/javascript/)
    const lazy = responses.find((r) => /\/assets\/pdf-[^/]*\.js$/.test(r.url))
    expect(lazy, 'PDF.js chunk requested lazily').toBeTruthy()
    expect(lazy!.type).toMatch(/javascript/)

    expect(responses.filter((r) => r.status >= 400)).toEqual([])
    expect(errors).toEqual([])
    const origin = new URL(page.url()).origin
    expect(requests.every((r) => r.origin === origin)).toBe(true)
    expect(requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([])
    expect(requests.filter((r) => r.postData)).toEqual([])
  })

  test('PDF.js is not requested until the import page is opened', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))
    await page.goto('#/calendar')
    await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible()
    expect(urls.filter((u) => /\/assets\/(pdf|ImportTimetablePage)/.test(u))).toEqual([])
    await page.getByRole('link', { name: 'Import timetable' }).click()
    await expect(page.getByRole('heading', { name: 'Import timetable' })).toBeVisible()
    expect(urls.some((u) => /\/assets\/ImportTimetablePage/.test(u))).toBe(true)
    expect(urls.filter((u) => /\/assets\/pdf-/.test(u))).toEqual([]) // PDF.js itself waits for a file
  })
})

test.describe('optional: the real UTN PDF on the production build (skipped when it is not on this machine)', () => {
  test.skip(!hasRealPdf, `real timetable PDF not found at ${REAL_PDF}`)

  test('frozen baseline through the bundled worker: 168 sessions and 29 clashes', async ({ page }) => {
    await page.goto('#/import-timetable')
    await uploadAndWait(page, REAL_PDF)
    await expect(page.getByRole('heading', { name: 'Timetable source' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: /Review sessions/ }).click()
    await expect(page.getByTestId('shown-count')).toHaveAttribute('data-count', '168')
    await expect(page.getByTestId('clashes-count')).toHaveText('(29)')
  })
})

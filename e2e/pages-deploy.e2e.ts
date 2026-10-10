import { expect, test } from '@playwright/test'

// Verifies the GitHub Pages production build: `vite build` with base
// '/orbit-planner/' (see vite.config.ts), served by `vite preview` under that
// same path (see the "pages" project/webServer in playwright.config.ts).
// This is the closest local approximation of https://kdeb2003.github.io/orbit-planner/;
// it does not replace a real post-deployment check (see docs/deployment.md).

test.describe('production build at /orbit-planner/', () => {
  test('loads with no 404s for scripts, styles or the favicon', async ({ page }) => {
    const failed: string[] = []
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`)
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    // A leading slash would override the baseURL's /orbit-planner/ path
    // (new URL('/x', 'http://host/orbit-planner/') => 'http://host/x'), so
    // every goto() below is relative, matching how a real visitor arrives.
    await page.goto('')
    await expect(page.getByText('Quick actions')).toBeVisible()

    // Every asset actually loaded from under /orbit-planner/, not the site root.
    const srcs = await page.evaluate(() => [
      ...Array.from(document.querySelectorAll('script[src]')).map((s) => (s as HTMLScriptElement).src),
      ...Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => (l as HTMLLinkElement).href),
    ])
    expect(srcs.length).toBeGreaterThan(0)
    for (const src of srcs) expect(new URL(src).pathname).toContain('/orbit-planner/')

    expect(failed).toEqual([])
    expect(errors).toEqual([])
  })

  test('HashRouter routes resolve under the project path, including a hard refresh', async ({ page }) => {
    await page.goto('#/calendar')
    await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible()

    // A browser refresh on a hash route must not 404: GitHub Pages serves the
    // one real document (index.html at /orbit-planner/) and the hash is a
    // client-side concern only.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/orbit-planner/')
  })

  test('sign-in routes render instead of crashing (Supabase unconfigured in this build)', async ({ page }) => {
    await page.goto('#/login')
    await expect(page.getByRole('heading', { name: 'Sign-in isn’t set up' })).toBeVisible()
  })

  for (const size of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'small-mobile', width: 320, height: 700 },
  ] as const) {
    test(`renders without horizontal overflow at ${size.name} (${size.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.goto('')
      await expect(page.getByText('Quick actions')).toBeVisible()
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      expect(sw).toBeLessThanOrEqual(cw)
    })
  }
})

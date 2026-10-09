import { defineConfig } from '@playwright/test'

// Browser tests run against a dedicated dev server (port 5199) and always in a
// fresh browser context, so the developer's own browser data is never touched.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e-artifacts/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    channel: 'chrome', // system Chrome; no browser download needed
    timezoneId: 'America/Los_Angeles', // deliberately NOT Berlin: the app must not depend on the device zone
    locale: 'en-GB',
  },
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

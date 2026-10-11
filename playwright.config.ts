import { defineConfig } from '@playwright/test'

// Browser tests run against dedicated dev servers and always in a fresh browser
// context, so the developer's own browser data is never touched.
//
//  * "local" (port 5199): Supabase deliberately NOT configured -> local-only mode.
//    The variables are set to empty strings so a developer's real `.env.local` can
//    never leak into the tests (process env wins over .env files in Vite).
//  * "auth"  (port 5198): Supabase "configured" with a dummy key and a URL that points
//    at the dev server itself. Auth API calls are intercepted by Playwright (see
//    e2e/authMock.ts), so no real Supabase project, credentials or network are used.
//  * "courses" (port 5197): like "auth" but with VITE_ENABLE_PLANNER_COURSES=true (mock REST serves a synthetic courses table).
//    The "auth" server leaves the flag unset, which is what proves the feature is off by default.
//  * "pages" (port 5201): the real production build (`vite build`, base
//    '/orbit-planner/') served by `vite preview`, approximating GitHub Pages.
//    Supabase is unconfigured (same as "local"); see e2e/pages-deploy.e2e.ts.
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-artifacts/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    channel: 'chrome', // system Chrome; no browser download needed
    timezoneId: 'America/Los_Angeles', // deliberately NOT Berlin: the app must not depend on the device zone
    locale: 'en-GB',
  },
  projects: [
    { name: 'local', testMatch: '**/*.e2e.ts', testIgnore: ['**/auth.e2e.ts', '**/cloud.e2e.ts', '**/pages-deploy.e2e.ts', '**/import-timetable-auth.e2e.ts', '**/import-timetable-pages.e2e.ts', '**/courses.e2e.ts', '**/courses-disabled.e2e.ts'], use: { baseURL: 'http://localhost:5199' } },
    { name: 'auth', testMatch: ['**/auth.e2e.ts', '**/cloud.e2e.ts', '**/import-timetable-auth.e2e.ts', '**/courses-disabled.e2e.ts'], use: { baseURL: 'http://localhost:5198' } },
    // Same mocked Supabase as "auth", but with the Courses feature switched ON (see the server below).
    { name: 'courses', testMatch: ['**/courses.e2e.ts'], use: { baseURL: 'http://localhost:5197' } },
    { name: 'pages', testMatch: ['**/pages-deploy.e2e.ts', '**/import-timetable-pages.e2e.ts'], use: { baseURL: 'http://localhost:5201/orbit-planner/' } },
  ],
  webServer: [
    {
      command: 'npm run dev -- --port 5199 --strictPort',
      url: 'http://localhost:5199',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_ENABLE_SIGNUP: '' },
    },
    {
      command: 'npm run dev -- --port 5198 --strictPort',
      url: 'http://localhost:5198',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_SUPABASE_URL: 'http://localhost:5198',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_dummy_key',
        VITE_ENABLE_SIGNUP: 'true',
        VITE_ENABLE_PLANNER_COURSES: '', // off by default, whatever a developer's .env.local says
      },
    },
    {
      command: 'npm run dev -- --port 5197 --strictPort',
      url: 'http://localhost:5197',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_SUPABASE_URL: 'http://localhost:5197',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_dummy_key',
        VITE_ENABLE_SIGNUP: 'true',
        VITE_ENABLE_PLANNER_COURSES: 'true',
      },
    },
    {
      // Builds with the production base path and empty Supabase env (so this
      // project is deterministic regardless of the developer's own
      // .env.local — VITE_* values are inlined at build time, never read by
      // `vite preview`), then serves dist/ exactly as GitHub Pages would.
      command: 'npm run build && npm run preview -- --port 5201 --strictPort',
      url: 'http://localhost:5201/orbit-planner/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_ENABLE_SIGNUP: '' },
    },
  ],
})

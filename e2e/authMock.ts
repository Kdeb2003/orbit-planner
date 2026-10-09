import type { Page, Request } from '@playwright/test'

/**
 * A tiny stand-in for the Supabase Auth REST API (GoTrue), served through
 * Playwright route interception. The app under test is built with
 * VITE_SUPABASE_URL pointing at its OWN origin, so the real supabase-js client
 * runs unmodified but no request ever leaves the machine and no real credentials exist.
 */
export const TEST_EMAIL = 'qa.user@example.test'
export const TEST_PASSWORD = 'correct-horse-battery'
export const USER_ID = '00000000-0000-4000-8000-0000000000aa'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')

function jwt(email: string) {
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, email, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600 })}.mock-signature`
}

const user = (email: string) => ({
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email' },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

const session = (email: string) => ({
  access_token: jwt(email),
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'mock-refresh-token',
  user: user(email),
})

export interface MockLog {
  /** Every Auth API request: "METHOD /auth/v1/path?query" plus parsed JSON body. */
  requests: { method: string; url: URL; body: Record<string, unknown> }[]
  passwordUpdates: string[]
}

export async function mockSupabaseAuth(page: Page, opts: { signupSession?: boolean } = {}): Promise<MockLog> {
  const log: MockLog = { requests: [], passwordUpdates: [] }
  let currentEmail = TEST_EMAIL

  await page.route('**/auth/v1/**', async (route) => {
    const req: Request = route.request()
    const url = new URL(req.url())
    let body: Record<string, unknown> = {}
    try {
      body = req.postDataJSON() ?? {}
    } catch {
      /* no body */
    }
    log.requests.push({ method: req.method(), url, body })
    const json = (status: number, data: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    const path = url.pathname.replace('/auth/v1', '')
    const grant = url.searchParams.get('grant_type')

    if (path === '/token' && grant === 'password') {
      if (body.email === TEST_EMAIL && body.password === TEST_PASSWORD) {
        currentEmail = String(body.email)
        return json(200, session(currentEmail))
      }
      return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    if (path === '/token' && grant === 'pkce') return json(200, session(currentEmail))
    if (path === '/token' && grant === 'refresh_token') return json(200, session(currentEmail))
    if (path === '/user' && req.method() === 'GET') return json(200, user(currentEmail))
    if (path === '/user' && req.method() === 'PUT') {
      log.passwordUpdates.push(String(body.password))
      return json(200, user(currentEmail))
    }
    if (path === '/signup') {
      const email = String(body.email ?? 'new@example.test')
      return json(200, opts.signupSession ? session(email) : { ...user(email), email_confirmed_at: null, confirmation_sent_at: '2026-01-01T00:00:00Z' })
    }
    if (path === '/recover') return json(200, {})
    if (path === '/logout') return route.fulfill({ status: 204, body: '' })
    return json(404, { code: 404, msg: `unmocked ${req.method()} ${path}` })
  })
  return log
}

/** Names of origins the page talked to (to prove nothing unexpected was contacted). */
export function trackOrigins(page: Page): Set<string> {
  const origins = new Set<string>()
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.protocol.startsWith('http')) origins.add(u.origin)
  })
  return origins
}

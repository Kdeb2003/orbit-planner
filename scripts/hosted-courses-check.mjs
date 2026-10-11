// Hosted two-account verification of the COURSES table (RLS, privileges, constraints) with DISPOSABLE SYNTHETIC rows.
// NOT RUN against any hosted project yet. Companion of scripts/hosted-two-user-rls-check.mjs (calendar + provenance), which it
// does not change. Procedure and gates: docs/phase-4b/HOSTED_COURSES_RELEASE.md (Gate C).
//
// Run it only AFTER the owner approved the hosted migration, applied it (Gate B) and approved this run.
//
// Safety properties
//   * ONLY the public publishable key and normal email+password sign-ins; RLS applies to every request. It refuses a
//     service-role / secret key, a non-https URL (except a local stack) and two identical accounts.
//   * Credentials come from environment variables only; never printed, logged or written. Emails are masked, server
//     error text is never printed (codes only). Sessions are not persisted and are signed out at the end.
//   * Creates only courses whose name starts with this run's marker "ORBIT_RLS_CHECK_<run>" in each account's OWN space.
//     Cleanup deletes exactly the tracked ids and the rows carrying the marker (escaped LIKE), also after a failure or an
//     exception, and then VERIFIES (twice) that nothing is left. A failed delete, a leftover row or an unreadable
//     verification makes the run FAIL.
//   * A missing table, a failed assertion, a crash or a required check that did not run FAILS the run. There is no skip mode.
//   * Needs the explicit confirmation variable below and makes no request before it is validated. --dry-run validates the
//     configuration and stops: no client is created and no request is made.
//
// Environment (all required):
//   ORBIT_COURSES_CHECK_CONFIRM=I-HAVE-APPROVAL-TO-WRITE-SYNTHETIC-COURSES-TO-THE-HOSTED-PROJECT
//   ORBIT_SUPABASE_URL, ORBIT_SUPABASE_PUBLISHABLE_KEY
//   ORBIT_USER_A_EMAIL, ORBIT_USER_A_PASSWORD, ORBIT_USER_B_EMAIL, ORBIT_USER_B_PASSWORD
//
// Exit code: 0 = every required check passed and cleanup verified that no run-created record remains.
//            1 = a failed check, a crash, a cleanup problem, a leftover or a required check that did not run.
//            2 = refused to start (configuration, missing confirmation or sign-in failure); nothing was written.
import { maskEmail, runCoursesCheck, safeCode, validateConfig } from './hostedCoursesCore.mjs'

const env = (k) => process.env[k] ?? ''

function fail(msg) {
  console.error(`REFUSED: ${msg}`)
  process.exit(2)
}

const config = validateConfig(process.env)
if (!config.ok) fail(config.message)

if (process.argv.includes('--dry-run')) {
  console.log('Configuration is valid. --dry-run: no client was created and no request was made.')
  process.exit(0)
}

const { createClient } = await import('@supabase/supabase-js') // loaded only after the guards and never in --dry-run
const url = env('ORBIT_SUPABASE_URL')
const key = env('ORBIT_SUPABASE_PUBLISHABLE_KEY')
const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })

async function signIn(label, email, password) {
  const c = client()
  let res
  try {
    res = await c.auth.signInWithPassword({ email, password })
  } catch {
    fail(`could not sign in ${label} (${maskEmail(email)}): request failed`)
  }
  if (res.error || !res.data.user) fail(`could not sign in ${label} (${maskEmail(email)}): ${safeCode(res.error)}`)
  return { c, id: res.data.user.id }
}

const A = await signIn('A', env('ORBIT_USER_A_EMAIL'), env('ORBIT_USER_A_PASSWORD'))
const B = await signIn('B', env('ORBIT_USER_B_EMAIL'), env('ORBIT_USER_B_PASSWORD'))
const outcome = await runCoursesCheck({ A, B, anon: client() })
process.exit(outcome.exit)

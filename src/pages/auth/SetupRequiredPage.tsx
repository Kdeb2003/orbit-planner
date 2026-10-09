import { Link } from 'react-router-dom'
import { supabaseConfig } from '../../lib/supabase'
import { AuthShell } from './AuthShell'
import { authLinkClass } from './authStyles'

/** Shown instead of a sign-in form when Supabase is not configured. */
export function SetupRequiredPage({ problems }: { problems?: string[] }) {
  const list = problems ?? (supabaseConfig.configured ? [] : supabaseConfig.problems)
  return (
    <AuthShell title="Sign-in isn’t set up" subtitle="ORBIT is running in local-only mode.">
      <div className="space-y-3 text-sm">
        {list.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-deadline">
            {list.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <p className="text-muted">
          Developers: copy <code className="rounded bg-base px-1">.env.example</code> to{' '}
          <code className="rounded bg-base px-1">.env.local</code>, fill in your Supabase project URL and{' '}
          <strong>publishable</strong> key, then restart <code className="rounded bg-base px-1">npm run dev</code>.
        </p>
        <p className="text-muted">Your calendar still works and is stored only in this browser.</p>
        <Link to="/" className={authLinkClass}>
          Continue without signing in
        </Link>
      </div>
    </AuthShell>
  )
}

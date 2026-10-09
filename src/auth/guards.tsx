import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage'
import { SetupRequiredPage } from '../pages/auth/SetupRequiredPage'
import { Spinner } from '../pages/auth/AuthShell'
import { useAuth } from './AuthContext'

/**
 * Protects the application. When Supabase is NOT configured ORBIT runs in
 * local-only mode (no sign-in exists to require); when it IS configured, an
 * unauthenticated visitor is sent to the sign-in page and never sees app routes.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  switch (state.status) {
    case 'unconfigured':
    case 'signed-in':
      return <>{children}</>
    case 'loading':
      return <Spinner label="Checking your session…" />
    case 'recovery':
      return <ResetPasswordPage />
    case 'signed-out':
      return <Navigate to="/login" replace />
  }
}

/** Wraps sign-in / register / forgot-password pages. */
export function AuthRoute({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  switch (state.status) {
    case 'unconfigured':
      return <SetupRequiredPage />
    case 'loading':
      return <Spinner label="Loading…" />
    case 'recovery':
      return <ResetPasswordPage />
    case 'signed-in':
      return <Navigate to="/" replace />
    case 'signed-out':
      return <>{children}</>
  }
}

import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { supabase, supabaseConfig } from '../lib/supabase'
import { createAuthController, createUnconfiguredController } from './authController'
import type { AuthController } from './authController'
import { authRedirectUrl, hasFragmentAuthError, readAuthUrlError } from './authUrls'
import { AuthContext, useAuthState } from './AuthContext'

interface AuthProviderProps {
  children: ReactNode
  /** Tests inject a controller built on a fake client. */
  controller?: AuthController
  signupEnabled?: boolean
}

let defaultController: AuthController | null = null

/** One controller for the app lifetime (safe under React StrictMode double-mounting). */
function getDefaultController(): AuthController {
  defaultController ??= supabase
    ? createAuthController(supabase.auth, { redirectTo: authRedirectUrl() })
    : createUnconfiguredController()
  return defaultController
}

export function AuthProvider({ children, controller: injected, signupEnabled }: AuthProviderProps) {
  const controller = injected ?? getDefaultController()
  const state = useAuthState(controller)

  // Failed email links put an error in the URL fragment, which HashRouter would
  // misread as a route. Surface it on the sign-in page and restore a clean hash.
  useEffect(() => {
    const message = readAuthUrlError(window.location.search, window.location.hash)
    if (message) controller.setNotice(message)
    if (hasFragmentAuthError(window.location.hash)) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/login`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }, [controller])

  const value = useMemo(
    () => ({ state, controller, signupEnabled: signupEnabled ?? supabaseConfig.signupEnabled }),
    [state, controller, signupEnabled],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

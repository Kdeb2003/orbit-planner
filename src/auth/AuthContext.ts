import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ActionResult, AuthController, AuthState } from './authController'

export interface AuthContextValue {
  state: AuthState
  controller: AuthController
  /** Whether the registration form should be offered (UI flag; the server enforces the real rule). */
  signupEnabled: boolean
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** Subscribes a component to a controller's state. */
export function useAuthState(controller: AuthController): AuthState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}

export type { ActionResult }

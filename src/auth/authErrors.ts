export const MIN_PASSWORD_LENGTH = 12

interface ErrorLike {
  code?: string
  message?: string
  name?: string
  status?: number
}

/** Maps Supabase Auth errors to messages that are safe and useful to show. */
export function friendlyAuthError(error: unknown): string {
  const e = (error ?? {}) as ErrorLike
  const code = e.code ?? ''
  const msg = (e.message ?? '').toLowerCase()

  if (e.name === 'AuthRetryableFetchError' || e.status === 0 || msg.includes('failed to fetch') || msg.includes('network')) {
    return 'Can’t reach the sign-in service. Check your connection and try again.'
  }
  switch (code) {
    case 'invalid_credentials':
      return 'Incorrect email or password.'
    case 'email_not_confirmed':
      return 'Please confirm your email address first. Check your inbox for the confirmation link.'
    case 'user_already_exists':
    case 'email_exists':
      return 'An account with this email may already exist. Try signing in instead.'
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'New registrations are currently closed.'
    case 'weak_password':
      return `Choose a stronger password (at least ${MIN_PASSWORD_LENGTH} characters).`
    case 'same_password':
      return 'Your new password must be different from the old one.'
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Too many attempts. Please wait a few minutes and try again.'
    case 'otp_expired':
    case 'flow_state_expired':
    case 'flow_state_not_found':
      return 'That link has expired or was already used. Request a new one.'
    case 'session_expired':
    case 'session_not_found':
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
      return 'Your session has ended. Please sign in again.'
    case 'validation_failed':
      return 'Please check the details you entered.'
  }
  if (msg.includes('invalid login credentials')) return 'Incorrect email or password.'
  if (msg.includes('email not confirmed')) return 'Please confirm your email address first. Check your inbox for the confirmation link.'
  if (msg.includes('rate limit')) return 'Too many attempts. Please wait a few minutes and try again.'
  return 'Something went wrong. Please try again.'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(email: string): string | null {
  const v = email.trim()
  if (!v) return 'Enter your email address.'
  if (!EMAIL_RE.test(v)) return 'Enter a valid email address.'
  return null
}

export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}

import { CloudError } from './types'

interface PostgrestLike {
  code?: string
  message?: string
  details?: string
  hint?: string
}

/**
 * Turns a PostgREST / fetch failure into a CloudError with a user-safe message.
 * Never includes request URLs, headers or tokens.
 */
export function mapCloudError(error: unknown, status = 0): CloudError {
  if (error instanceof CloudError) return error
  const e = (error ?? {}) as PostgrestLike
  const code = e.code ?? ''
  const msg = e.message ?? ''

  if (status === 0 && !code) {
    return new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network')
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(msg)) {
    return new CloudError('network', 'Can’t reach the server. Your change was not saved.', 'network')
  }
  if (code === 'PGRST301' || code === 'PGRST303' || /jwt/i.test(msg)) {
    return new CloudError('auth', 'Your session has expired. Please sign in again.', code || 'jwt')
  }
  if (code === '42501' || status === 401 || status === 403) {
    return new CloudError('permission', 'Not allowed. You may be signed out; please sign in again.', code || String(status))
  }
  if (code === '23505' || status === 409) {
    return new CloudError('conflict', 'This item already exists or was changed elsewhere.', code || '409')
  }
  if (/^2[23]/.test(code) || status === 400) {
    return new CloudError('validation', 'The server rejected this data as invalid.', code || '400')
  }
  if (code === 'PGRST205' || status === 404) {
    return new CloudError('unknown', 'The calendar tables are not available through the API.', code || '404')
  }
  return new CloudError('unknown', 'Something went wrong while talking to the server.', code || String(status))
}

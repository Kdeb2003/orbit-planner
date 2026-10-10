/** Accepts any 8-4-4-4-12 hex UUID, which is what PostgreSQL's uuid type accepts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Deterministic UUID (version-5 layout, SHA-1) for `name` within `namespace`.
 * Used to give legacy, non-UUID local ids a stable cloud id: importing the same
 * record twice always yields the same row id, so a repeated or resumed import can
 * never create duplicates. The namespace includes the user id, so two users never
 * share row ids.
 */
export async function deterministicUuid(namespace: string, name: string): Promise<string> {
  const data = new TextEncoder().encode(`orbit:${namespace}:${name}`)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x50 // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Cloud id for a local record: valid UUIDs are kept as they are, anything else is mapped deterministically. */
export async function cloudIdFor(userId: string, kind: 'event' | 'series', legacyId: string): Promise<string> {
  return isUuid(legacyId) ? legacyId.toLowerCase() : deterministicUuid(`${userId}:${kind}`, legacyId)
}

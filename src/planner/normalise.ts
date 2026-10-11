/**
 * Normalisation rule N (DOMAIN_MODEL §6.1), the TypeScript twin of the database
 * generated key columns:
 *  1. every run of `[ \t\r\n\f\v]` or U+00A0 becomes one ASCII space; trim spaces at both ends;
 *  2. ASCII `a-z` become `A-Z`; every other character is left unchanged
 *     (no Unicode case folding, no JS `trim()`/`toUpperCase()`, which differ from PostgreSQL).
 * An empty key means "no code".
 */
export function normaliseKey(value: string): string {
  return value
    .replace(/[ \t\r\n\f\v\u00a0]+/g, ' ')
    .replace(/^ | $/g, '')
    .replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32))
}

/** The key under which a course code is matched and de-duplicated ('' = no code). */
export function normaliseCourseCode(code: string | undefined): string {
  return code === undefined ? '' : normaliseKey(code)
}

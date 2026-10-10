import type { Issue, SessionKind, SessionLocation } from './types.ts'

/** Course codes printed on cards: `W26M-AINBA`, `W26M-LiT`, `W26M-Deutsch A2`, `W26M-Deutsch A1.1`. */
export const COURSE_CODE_RE = /^W\d{2}M-[A-Za-z0-9]+(?: [A-Za-z0-9.]+)?$/

const PROGRAMS_RE = /^(?:AIR|HAI)\d(?:\s*,\s*(?:AIR|HAI)\d)*$/
const CAMPUS_LOCATION_RE = /^(NOP|UL)\s*\/\s*(.+)$/
const ONLINE_RE = /^online$/i

export interface ParsedCardText {
  courseCodes: string[]
  typeText: string
  programs: string[]
  location: SessionLocation | null
  issues: Issue[]
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export function parseLocation(raw: string): SessionLocation {
  const text = norm(raw)
  if (ONLINE_RE.test(text)) return { kind: 'online', raw: text }
  const m = CAMPUS_LOCATION_RE.exec(text)
  if (m) return { kind: 'room', campus: m[1], room: norm(m[2]), raw: text }
  return { kind: 'unknown', raw: text }
}

/**
 * Splits the lines of one card (top to bottom) into code(s), type text, programme
 * line and location. The layout is positional rather than keyword based:
 *
 *   W26M-AINBA            <- one or two code lines
 *   tutorial group B      <- type/group line(s)
 *   AIR1                  <- programme line (optional: German cards have none)
 *   NOP / ALC2            <- location line(s); a long room list wraps onto a second line
 */
export function parseCardLines(lines: string[]): ParsedCardText {
  const issues: Issue[] = []
  const rest = lines.map(norm).filter((l) => l !== '')

  const courseCodes: string[] = []
  while (rest.length && /^W\d{2}M-/.test(rest[0])) {
    const code = rest.shift() as string
    if (!COURSE_CODE_RE.test(code)) issues.push({ severity: 'warning', code: 'odd-course-code', message: `Unusual course code "${code}".` })
    courseCodes.push(code)
  }
  if (courseCodes.length === 0) issues.push({ severity: 'error', code: 'no-course-code', message: 'Card has no W26M course code line.' })

  const progIdx = rest.findIndex((l) => PROGRAMS_RE.test(l))
  let programs: string[] = []
  let typeLines: string[]
  let locationLines: string[]
  if (progIdx >= 0) {
    typeLines = rest.slice(0, progIdx)
    programs = rest[progIdx].split(',').map((p) => p.trim())
    locationLines = rest.slice(progIdx + 1)
  } else {
    // No programme line (German cards): the location is the trailing line(s) that look like one.
    let cut = rest.length
    while (cut > 0 && (CAMPUS_LOCATION_RE.test(rest[cut - 1]) || ONLINE_RE.test(rest[cut - 1]))) cut--
    typeLines = rest.slice(0, cut)
    locationLines = rest.slice(cut)
  }

  const location = locationLines.length ? parseLocation(locationLines.join(' ')) : null
  if (!location) issues.push({ severity: 'warning', code: 'no-location', message: 'Card has no location line.' })
  else if (location.kind === 'unknown') issues.push({ severity: 'warning', code: 'unrecognised-location', message: `Location "${location.raw}" has an unrecognised format.` })

  return { courseCodes, typeText: typeLines.join(' '), programs, location, issues }
}

export interface ParsedType {
  kind: SessionKind
  groups: string[]
  variant: string | null
  issues: Issue[]
}

/**
 * Interprets the printed type text. Observed forms: `main`, `tutorial`,
 * `main group A`, `tutorial group B`, `main group B,C`, `main a`, `main 2`,
 * `project group work`, `excursion`, `group A` (German A1.1 cards).
 * Unknown text is kept (never guessed) and flagged.
 */
export function parseTypeText(typeText: string, courseCode: string): ParsedType {
  const issues: Issue[] = []
  let text = norm(typeText).toLowerCase()
  let kind: SessionKind = 'other'
  const isGerman = /^W\d{2}M-Deutsch/i.test(courseCode)

  if (text === '') {
    kind = isGerman ? 'language' : 'other'
    if (!isGerman) issues.push({ severity: 'warning', code: 'no-type', message: 'Card prints no session type.' })
    return { kind, groups: [], variant: null, issues }
  }

  const strip = (re: RegExp) => {
    const m = re.exec(text)
    if (!m) return false
    text = norm(text.replace(re, ' '))
    return true
  }

  if (strip(/^project group work\b/)) kind = 'project'
  else if (strip(/^main\b/)) kind = 'main'
  else if (strip(/^tutorial\b/)) kind = 'tutorial'
  else if (strip(/^excursion\b/)) kind = 'excursion'
  else if (isGerman) kind = 'language'

  const groups: string[] = []
  const g = /^groups?\s+([a-z0-9](?:\s*[,&]\s*[a-z0-9])*)\b/.exec(text)
  if (g) {
    for (const part of g[1].split(/[,&]/)) groups.push(part.trim().toUpperCase())
    text = norm(text.slice(g[0].length))
  }

  let variant: string | null = null
  const v = /^([a-z0-9])$/.exec(text)
  if (v) {
    variant = v[1]
    text = ''
  }

  if (text !== '') issues.push({ severity: 'warning', code: 'unparsed-type-text', message: `Could not interpret "${text}" in the type line "${norm(typeText)}".` })
  if (kind === 'other' && !isGerman) issues.push({ severity: 'warning', code: 'unknown-type', message: `Unrecognised session type in "${norm(typeText)}".` })
  return { kind, groups, variant, issues }
}

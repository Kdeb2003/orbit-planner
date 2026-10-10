import { parseTypeText } from './cardText.ts'
import type { Legend } from './legend.ts'
import type { Confidence, Issue, RawCard, SourceAnomaly, TimetableSession, WeekTable } from './types.ts'
import { SLOTS } from './types.ts'
import { addIsoDays, parseDottedDate } from './tables.ts'

const dedupe = (issues: Issue[]): Issue[] => {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const k = `${i.severity}|${i.code}|${i.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Identity of the printed card content (what must match for two slot cards to be one session). */
function cardKey(c: RawCard): string {
  return [c.weekday, c.date ?? '', c.courseCodes.join('+'), norm(c.typeText), c.programs.join(','), c.location?.raw ?? '', c.fill].join('|')
}

export function sourceKeyFor(s: { semesterWeek: number; date: string | null; weekday: string; startTime: string; endTime: string; courseCodes: string[]; typeText: string }): string {
  const day = s.date ?? `week${String(s.semesterWeek).padStart(2, '0')}-${s.weekday}`
  return `utn-wise2627|${day}|${s.startTime}-${s.endTime}|${s.courseCodes.join('+')}|${norm(s.typeText) || '-'}`
}

function confidenceOf(issues: Issue[]): Confidence {
  if (issues.some((i) => i.severity === 'error')) return 'low'
  if (issues.some((i) => i.severity === 'warning')) return 'medium'
  return 'high'
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/** Slots are only joined across the 15-minute breaks; the 60-minute lunch gap (slot 2 to 3) always separates sessions. */
export const MAX_MERGE_GAP_MINUTES = 15

function isShortBreak(prevSlot: number, nextSlot: number): boolean {
  if (nextSlot !== prevSlot + 1) return false
  return minutesOf(SLOTS[nextSlot - 1].start) - minutesOf(SLOTS[prevSlot - 1].end) <= MAX_MERGE_GAP_MINUTES
}

/**
 * Turns slot cards into sessions. Consecutive slot cards with identical content
 * (same day, codes, type, programmes, location and colour) are one session, whether
 * the PDF drew them as one tall cell or as two adjacent cells. Cards in the SAME slot
 * are never merged (that would hide a duplicate), and a gap between slots breaks a chain.
 */
export function buildSessions(tables: WeekTable[], legend: Legend): TimetableSession[] {
  const sessions: TimetableSession[] = []

  for (const table of tables) {
    const groups = new Map<string, RawCard[]>()
    for (const card of table.cards) {
      const k = cardKey(card)
      groups.set(k, [...(groups.get(k) ?? []), card])
    }
    for (const cards of groups.values()) {
      cards.sort((a, b) => a.slots[0] - b.slots[0])
      const chains: RawCard[][] = []
      for (const card of cards) {
        const chain = chains.find((ch) => isShortBreak(ch[ch.length - 1].slots[ch[ch.length - 1].slots.length - 1], card.slots[0]))
        if (chain) chain.push(card)
        else chains.push([card])
      }
      for (const chain of chains) sessions.push(sessionFromChain(table, chain, legend))
    }
  }

  sessions.sort((a, b) => (a.date ?? `~${a.semesterWeek}`).localeCompare(b.date ?? `~${b.semesterWeek}`) || a.startTime.localeCompare(b.startTime) || a.courseCode.localeCompare(b.courseCode) || a.typeText.localeCompare(b.typeText))

  const byKey = new Map<string, TimetableSession[]>()
  for (const s of sessions) byKey.set(s.sourceKey, [...(byKey.get(s.sourceKey) ?? []), s])
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    for (const s of list) {
      s.issues.push({ severity: 'warning', code: 'duplicate-candidate', message: `${list.length} cards share the identity ${s.sourceKey}.` })
      s.confidence = confidenceOf(s.issues)
    }
  }
  return sessions
}

function sessionFromChain(table: WeekTable, chain: RawCard[], legend: Legend): TimetableSession {
  const first = chain[0]
  const slots = chain.flatMap((c) => c.slots)
  const startTime = SLOTS[slots[0] - 1].start
  const endTime = SLOTS[slots[slots.length - 1] - 1].end
  const [courseCode = '', ...jointWith] = first.courseCodes
  const parsedType = parseTypeText(first.typeText, courseCode)
  const issues: Issue[] = [...chain.flatMap((c) => c.issues), ...parsedType.issues]

  if (chain.length > 1) issues.push({ severity: 'info', code: 'merged-adjacent-cards', message: `Slots ${slots.join('+')} print identical cards and were merged into one session.` })

  const entry = legend.entries.get(courseCode)
  if (!entry) issues.push({ severity: 'info', code: 'code-not-in-legend', message: `${courseCode} is not listed in the legend page.` })
  else if (entry.fill && first.courseCodes.length === 1 && entry.fill !== first.fill.toLowerCase()) {
    issues.push({ severity: 'warning', code: 'fill-mismatch', message: `Card colour ${first.fill} differs from the legend colour ${entry.fill} for ${courseCode}.` })
  }
  if (jointWith.length) issues.push({ severity: 'info', code: 'joint-card', message: `Card prints several course codes: ${first.courseCodes.join(', ')}.` })

  const base = { semesterWeek: table.semesterWeek, date: first.date, weekday: first.weekday, startTime, endTime, courseCodes: first.courseCodes, typeText: first.typeText }
  const finalIssues = dedupe(issues)
  return {
    sourceKey: sourceKeyFor(base),
    semesterWeek: table.semesterWeek,
    date: first.date,
    weekday: first.weekday,
    startTime,
    endTime,
    timeZone: 'Europe/Berlin',
    slots,
    spansMultipleSlots: slots.length > 1,
    courseCode,
    jointWith,
    courseTitle: entry?.title ?? null,
    kind: parsedType.kind,
    typeText: first.typeText,
    groups: parsedType.groups,
    variant: parsedType.variant,
    programs: first.programs,
    location: first.location,
    fill: first.fill,
    source: chain.map((c) => c.source),
    confidence: confidenceOf(finalIssues),
    issues: finalIssues,
  }
}

/**
 * Cross-table checks of the printed calendar. Nothing is corrected: every finding is
 * returned for human confirmation.
 */
export function validateCalendar(tables: WeekTable[]): SourceAnomaly[] {
  const out: SourceAnomaly[] = []
  const push = (semesterWeek: number, code: string, message: string) => out.push({ semesterWeek, code, message })

  const nums = tables.map((t) => t.semesterWeek)
  tables.forEach((t, i) => {
    if (i > 0 && t.semesterWeek !== nums[i - 1] + 1) push(t.semesterWeek, 'week-sequence', `Week ${t.semesterWeek} follows week ${nums[i - 1]}.`)
    if (nums.indexOf(t.semesterWeek) !== i) push(t.semesterWeek, 'duplicate-week', `Week ${t.semesterWeek} is printed more than once.`)
    for (const issue of t.issues) push(t.semesterWeek, issue.code, issue.message)
  })

  const printed = new Map<string, string>()
  let prevMonday: string | null = null
  for (const t of tables) {
    const monday = t.days[0]?.date ?? null
    for (const d of t.days) {
      for (const issue of d.issues) push(t.semesterWeek, issue.code, issue.message)
      const printedIso = d.dateText ? parseDottedDate(d.dateText) : null
      if (printedIso) {
        const seen = printed.get(printedIso)
        if (seen) push(t.semesterWeek, 'duplicate-date', `${d.dateText} is printed twice (${seen} and week ${t.semesterWeek} ${d.weekday}).`)
        printed.set(printedIso, `week ${t.semesterWeek} ${d.weekday}`)
      }
    }
    if (monday && prevMonday && addIsoDays(prevMonday, 7) !== monday) push(t.semesterWeek, 'monday-gap', `Week ${t.semesterWeek} starts ${monday}, expected ${addIsoDays(prevMonday, 7)} after the previous week.`)
    if (monday) prevMonday = monday
  }
  return out
}

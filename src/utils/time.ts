export const TIME_ZONE = 'Europe/Berlin'

/** A calendar day as 'YYYY-MM-DD' (no time zone attached). */
export type DateKey = string

export function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d)
}

export function formatClock(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(d)
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function getZonedParts(d: Date, timeZone: string = TIME_ZONE): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(d)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Offset of `timeZone` from UTC at instant `d`, in ms (CET = +3600000). */
function zoneOffsetMs(d: Date, timeZone: string): number {
  const p = getZonedParts(d, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(d.getTime() / 1000) * 1000
}

/** The calendar day of instant `d` in `timeZone`. */
export function dateKey(d: Date, timeZone: string = TIME_ZONE): DateKey {
  const p = getZonedParts(d, timeZone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** 'HH:mm' wall-clock time of instant `d` in `timeZone`. */
export function timeKey(d: Date, timeZone: string = TIME_ZONE): string {
  const p = getZonedParts(d, timeZone)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

export type LocalTimeStatus = 'ok' | 'nonexistent' | 'ambiguous'

/**
 * Resolves a wall-clock date/time in `timeZone` to a UTC instant.
 * Policy: a time skipped by spring-forward is `nonexistent` and moves forward
 * by the gap (02:30 -> 03:30); a time repeated at fall-back is `ambiguous` and
 * resolves to the FIRST occurrence (the earlier instant, summer time).
 */
export function resolveLocalTime(
  day: DateKey,
  time: string,
  timeZone: string = TIME_ZONE,
): { status: LocalTimeStatus; utc: Date } {
  const [y, m, d] = day.split('-').map(Number)
  const [h, min] = time.split(':').map(Number)
  const wanted = Date.UTC(y, m - 1, d, h, min)
  const offsets = [
    ...new Set([
      zoneOffsetMs(new Date(wanted - 86_400_000), timeZone),
      zoneOffsetMs(new Date(wanted + 86_400_000), timeZone),
    ]),
  ]
  const candidates = offsets
    .map((o) => wanted - o)
    .filter((t) => {
      const p = getZonedParts(new Date(t), timeZone)
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wanted
    })
    .sort((a, b) => a - b)
  if (candidates.length === 0) {
    return { status: 'nonexistent', utc: new Date(wanted - Math.min(...offsets)) }
  }
  return { status: candidates.length > 1 ? 'ambiguous' : 'ok', utc: new Date(candidates[0]) }
}

/** See `resolveLocalTime` for the DST policy. */
export function zonedTimeToUtc(day: DateKey, time: string, timeZone: string = TIME_ZONE): Date {
  return resolveLocalTime(day, time, timeZone).utc
}

/** Whether `day` is a real calendar date in 'YYYY-MM-DD' form. */
export function isValidDateKey(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isValidTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60
}

// ---- Pure calendar-day arithmetic (no time zone involved) ----

function keyToUtc(day: DateKey): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function addDays(day: DateKey, n: number): DateKey {
  const dt = keyToUtc(day)
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}

export function addMonths(day: DateKey, n: number): DateKey {
  const [y, m, d] = day.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = total % 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(day: DateKey): number {
  return (keyToUtc(day).getUTCDay() + 6) % 7
}

export function startOfWeek(day: DateKey): DateKey {
  return addDays(day, -weekdayIndex(day))
}

export function weekDays(day: DateKey): DateKey[] {
  const start = startOfWeek(day)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/** 6 weeks (42 days), Monday-first, covering the month of `day`. */
export function monthGrid(day: DateKey): DateKey[] {
  const first = `${day.slice(0, 7)}-01`
  const start = startOfWeek(first)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/** Whole calendar days from `a` to `b` (negative if b is earlier). */
export function daysBetween(a: DateKey, b: DateKey): number {
  return Math.round((keyToUtc(b).getTime() - keyToUtc(a).getTime()) / 86_400_000)
}

export function isSameMonth(a: DateKey, b: DateKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7)
}

export function formatKey(day: DateKey, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(keyToUtc(day))
}

export function formatMonthTitle(day: DateKey): string {
  return formatKey(day, { month: 'long', year: 'numeric' })
}

export function formatWeekdayShort(day: DateKey): string {
  return formatKey(day, { weekday: 'short' })
}

export function formatDayLong(day: DateKey): string {
  return formatKey(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export function formatDayShort(day: DateKey): string {
  return formatKey(day, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Start (inclusive) and end (exclusive) of a calendar day; 23–25 h on DST days. */
export function dayRange(day: DateKey, timeZone: string = TIME_ZONE): { start: Date; end: Date } {
  return {
    start: zonedTimeToUtc(day, '00:00', timeZone),
    end: zonedTimeToUtc(addDays(day, 1), '00:00', timeZone),
  }
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h && m) return `${h}h ${m}m`
  return h ? `${h}h` : `${m}m`
}

export function greeting(d: Date): string {
  const h = getZonedParts(d).hour
  if (h < 5) return 'Working late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

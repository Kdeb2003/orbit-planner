import type { ReviewItem } from '../../timetable/utn/review.ts'
import { formatDayShort, formatKey } from '../../utils/time.ts'

export function dayLabel(date: string): string {
  return date ? formatDayShort(date) : 'No date'
}

export function pagesLabel(item: ReviewItem): string {
  const pages = [...new Set(item.session.source.map((s) => s.page))].sort((a, b) => a - b)
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`
}

export function typeLabel(item: ReviewItem): string {
  const { kind, typeText } = item.session
  const base = kind === 'main' ? 'Main' : kind === 'tutorial' ? 'Tutorial' : kind === 'language' ? 'Language course' : kind === 'project' ? 'Project' : kind === 'excursion' ? 'Excursion' : 'Other'
  return typeText && kind === 'other' ? `${base} (${typeText})` : base
}

export function groupLabel(item: ReviewItem): string | null {
  const { groups, variant } = item.session
  if (groups.length === 0) return null
  return `Group ${groups.join(', ')}${variant ? ` (${variant})` : ''}`
}

export const fullDate = (date: string) => formatKey(date, { day: 'numeric', month: 'short', year: 'numeric' })

const ANOMALY_TITLES: Record<string, string> = {
  'no-date': 'Days without a printed date',
  'date-weekday-mismatch': 'Invalid date header',
  'duplicate-date': 'A date is printed twice',
  'monday-gap': 'Weeks do not follow each other',
  'week-sequence': 'Week numbers are not consecutive',
}


export const anomalyTitle = (code: string): string => ANOMALY_TITLES[code] ?? code

export function weeksText(weeks: number[]): string {
  return `${weeks.length > 1 ? 'Weeks' : 'Week'} ${weeks.join(', ')}`
}


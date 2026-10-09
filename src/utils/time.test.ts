import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  dateKey,
  dayRange,
  isValidDateKey,
  isValidTime,
  monthGrid,
  startOfWeek,
  timeKey,
  weekDays,
  zonedTimeToUtc,
} from './time'

describe('zonedTimeToUtc (Europe/Berlin)', () => {
  it('uses CET (+1) in winter', () => {
    expect(zonedTimeToUtc('2026-01-15', '09:00').toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  it('uses CEST (+2) in summer', () => {
    expect(zonedTimeToUtc('2026-07-15', '09:00').toISOString()).toBe('2026-07-15T07:00:00.000Z')
  })

  it('moves a non-existent spring-forward time forward', () => {
    // 2026-03-29 02:30 does not exist in Berlin (02:00 -> 03:00).
    const d = zonedTimeToUtc('2026-03-29', '02:30')
    expect(dateKey(d)).toBe('2026-03-29')
    expect(timeKey(d)).toBe('03:30')
  })

  it('resolves an ambiguous autumn time to a valid instant on that day', () => {
    const d = zonedTimeToUtc('2026-10-25', '02:30')
    expect(timeKey(d)).toBe('02:30')
  })

  it('round-trips through dateKey/timeKey', () => {
    const d = zonedTimeToUtc('2026-12-31', '23:59')
    expect(dateKey(d)).toBe('2026-12-31')
    expect(timeKey(d)).toBe('23:59')
  })
})

describe('dayRange', () => {
  it('is 23 hours on the spring-forward day and 25 on fall-back', () => {
    const hours = (day: string) => {
      const { start, end } = dayRange(day)
      return (end.getTime() - start.getTime()) / 3_600_000
    }
    expect(hours('2026-03-29')).toBe(23)
    expect(hours('2026-10-25')).toBe(25)
    expect(hours('2026-06-01')).toBe(24)
  })
})

describe('date key arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('adds months and clamps the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
  })

  it('computes Monday-first weeks', () => {
    expect(startOfWeek('2026-10-09')).toBe('2026-10-05') // Friday -> Monday
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05') // Sunday
    expect(weekDays('2026-10-09')).toHaveLength(7)
  })

  it('builds a 42-day month grid starting on a Monday', () => {
    const grid = monthGrid('2026-10-09')
    expect(grid).toHaveLength(42)
    expect(grid[0]).toBe('2026-09-28')
    expect(grid).toContain('2026-10-31')
  })
})

describe('validation helpers', () => {
  it('validates dates', () => {
    expect(isValidDateKey('2026-02-28')).toBe(true)
    expect(isValidDateKey('2026-02-30')).toBe(false)
    expect(isValidDateKey('')).toBe(false)
  })

  it('validates times', () => {
    expect(isValidTime('23:59')).toBe(true)
    expect(isValidTime('24:00')).toBe(false)
    expect(isValidTime('9:00')).toBe(false)
  })
})

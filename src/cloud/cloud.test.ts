import { describe, expect, it } from 'vitest'
import type { CalendarEvent, RecurringSeries, SeriesException, SeriesInput } from '../types'
import { expandSeries } from '../utils/recurrence'
import { mapCloudError } from './errors'
import { cloudIdFor, deterministicUuid, isUuid } from './ids'
import {
  eventPatch,
  eventToWrite,
  exceptionToWrite,
  isOrphaned,
  isValidTimeZone,
  rowToEvent,
  rowToException,
  rowToSeries,
  seriesPatch,
  seriesToWrite,
  validateEventForCloud,
  validateExceptionForCloud,
  validateSeriesForCloud,
} from './mappers'
import { CloudError } from './types'
import type { EventRow, ExceptionRow, SeriesRow } from './types'

const ID = '11111111-1111-4111-8111-111111111111'
const TS = '2026-01-01T00:00:00.000Z'

const event: CalendarEvent = {
  id: ID,
  title: '  Databases  ',
  category: 'university',
  start: '2026-10-12T07:00:00.000Z',
  end: '2026-10-12T08:30:00.000Z',
  timeZone: 'Europe/Berlin',
  location: 'Room 204',
  courseCode: 'CS201',
  sessionType: 'tutorial',
  groupLabel: 'Group B',
  createdAt: TS,
  updatedAt: TS,
}

const seriesInput: SeriesInput = {
  title: 'Maths',
  category: 'university',
  timeZone: 'Europe/Berlin',
  courseCode: 'MA1',
  sessionType: 'main',
  recurrence: { frequency: 'weekly', weekdays: [0, 2], startDate: '2026-03-02', untilDate: '2026-04-27' },
  startTime: '09:00',
  endTime: '10:30',
  endDayOffset: 0,
}

describe('ids', () => {
  it('recognises UUIDs', () => {
    expect(isUuid(ID)).toBe(true)
    expect(isUuid('E1')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid('11111111-1111-4111-8111-11111111111')).toBe(false)
  })

  it('maps legacy ids deterministically, distinctly per user/kind/id, always to valid UUIDs', async () => {
    const a = await deterministicUuid('user-1:event', 'e1')
    expect(isUuid(a)).toBe(true)
    expect(a).toBe(await deterministicUuid('user-1:event', 'e1')) // stable across runs
    expect(a).not.toBe(await deterministicUuid('user-2:event', 'e1'))
    expect(a).not.toBe(await deterministicUuid('user-1:series', 'e1'))
    expect(a).not.toBe(await deterministicUuid('user-1:event', 'e2'))
  })

  it('keeps real UUIDs (lower-cased) and remaps everything else', async () => {
    expect(await cloudIdFor('u', 'event', ID.toUpperCase())).toBe(ID)
    const mapped = await cloudIdFor('u', 'event', 'legacy-1')
    expect(mapped).not.toBe('legacy-1')
    expect(isUuid(mapped)).toBe(true)
  })
})

describe('event mapping', () => {
  it('writes trimmed values, NULL for blanks, no server-managed columns', () => {
    const w = eventToWrite({ ...event, location: '   ', description: undefined }, ID)
    expect(w).toMatchObject({ id: ID, title: 'Databases', location: null, description: null, course_code: 'CS201', session_type: 'tutorial', group_label: 'Group B' })
    expect(w).not.toHaveProperty('user_id')
    expect(w).not.toHaveProperty('updated_at')
    expect(w).not.toHaveProperty('created_at')
  })

  it('only the import passes created_at; updates never send identity or timestamps', () => {
    expect(eventToWrite(event, ID, '2026-02-01T10:00:00Z').created_at).toBe('2026-02-01T10:00:00.000Z')
    const patch = eventPatch(event)
    for (const k of ['id', 'user_id', 'created_at', 'updated_at']) expect(patch).not.toHaveProperty(k)
  })

  it('round-trips through a database row; updated_at is kept raw as the version token', () => {
    const row: EventRow = {
      ...(eventToWrite(event, ID) as Omit<EventRow, 'created_at' | 'updated_at'>),
      created_at: '2026-10-01T10:00:00.123456+00:00',
      updated_at: '2026-10-01T10:00:00.654321+00:00',
    }
    const back = rowToEvent(row)
    expect(back).toMatchObject({ id: ID, title: 'Databases', start: event.start, end: event.end, location: 'Room 204', courseCode: 'CS201', sessionType: 'tutorial', groupLabel: 'Group B' })
    expect(back.updatedAt).toBe('2026-10-01T10:00:00.654321+00:00') // microseconds preserved
  })

  it('NULL columns become absent optional fields', () => {
    const row: EventRow = { ...(eventToWrite({ ...event, location: undefined, courseCode: undefined, sessionType: undefined, groupLabel: undefined }, ID) as Omit<EventRow, 'created_at' | 'updated_at'>), created_at: TS, updated_at: TS }
    const e = rowToEvent(row)
    for (const k of ['location', 'description', 'courseCode', 'sessionType', 'groupLabel']) expect(e).not.toHaveProperty(k)
  })

  it('normalises instants to UTC ISO regardless of input offset', () => {
    expect(eventPatch({ ...event, start: '2026-10-12T09:00:00+02:00', end: '2026-10-12T10:30:00+02:00' }).starts_at).toBe('2026-10-12T07:00:00.000Z')
  })
})

describe('series mapping', () => {
  const seriesRow = (): SeriesRow => ({ ...(seriesToWrite(seriesInput, ID) as Omit<SeriesRow, 'created_at' | 'updated_at'>), start_time: '09:00:00', end_time: '10:30:00', created_at: TS, updated_at: TS })

  it('sends local wall-clock times as HH:mm and reads HH:MM:SS back as HH:mm', () => {
    expect(seriesToWrite(seriesInput, ID)).toMatchObject({ start_time: '09:00', end_time: '10:30', weekdays: [0, 2], start_date: '2026-03-02', until_date: '2026-04-27', end_day_offset: 0, frequency: 'weekly' })
    const s = rowToSeries(seriesRow(), [])
    expect(s).toMatchObject({ startTime: '09:00', endTime: '10:30', courseCode: 'MA1', sessionType: 'main' })
    expect(s.recurrence.weekdays).toEqual([0, 2])
  })

  it('DST: a mapped series generates exactly the same instants as the original (local time preserved)', () => {
    const original: RecurringSeries = { ...seriesInput, id: ID, exceptions: [], createdAt: TS, updatedAt: TS }
    const viaDb = rowToSeries(seriesRow(), [])
    const range = ['2026-03-23', '2026-03-31'] as const // spans the 29 March spring-forward change
    const a = expandSeries(original, ...range).map((i) => [i.start, i.end])
    const b = expandSeries(viaDb, ...range).map((i) => [i.start, i.end])
    expect(b).toEqual(a)
    expect(a.map((x) => x[0])).toEqual(['2026-03-23T08:00:00.000Z', '2026-03-25T08:00:00.000Z', '2026-03-30T07:00:00.000Z'])
  })

  it('maps exceptions both ways; empty overrides and non-cancelled blanks are not stored', () => {
    const ex: SeriesException = { originalDate: '2026-03-09', override: { start: '2026-03-11T12:00:00+01:00', end: '2026-03-11T13:00:00+01:00', location: '' } }
    const w = exceptionToWrite(ID, ex)
    expect(w).toMatchObject({ series_id: ID, original_date: '2026-03-09', cancelled: false })
    expect(w.override).toEqual({ start: '2026-03-11T11:00:00.000Z', end: '2026-03-11T12:00:00.000Z', location: '' })
    expect(exceptionToWrite(ID, { originalDate: '2026-03-16', cancelled: true, override: {} }).override).toBeNull()
    const row: ExceptionRow = { ...w, created_at: TS, updated_at: TS }
    expect(rowToException(row)).toEqual({ originalDate: '2026-03-09', override: w.override })
    expect(rowToException({ ...row, cancelled: true, override: null })).toEqual({ originalDate: '2026-03-09', cancelled: true })
  })

  it('attaches exceptions to their own series only, sorted by original date', () => {
    const exs: ExceptionRow[] = [
      { series_id: ID, original_date: '2026-03-16', cancelled: true, override: null, created_at: TS, updated_at: TS },
      { series_id: 'other', original_date: '2026-03-02', cancelled: true, override: null, created_at: TS, updated_at: TS },
      { series_id: ID, original_date: '2026-03-09', cancelled: true, override: null, created_at: TS, updated_at: TS },
    ]
    expect(rowToSeries(seriesRow(), exs).exceptions.map((x) => x.originalDate)).toEqual(['2026-03-09', '2026-03-16'])
  })

  it('patches never contain identity or timestamps', () => {
    const p = seriesPatch(seriesInput)
    for (const k of ['id', 'user_id', 'created_at', 'updated_at']) expect(p).not.toHaveProperty(k)
  })
})

describe('validation against cloud constraints', () => {
  it('accepts valid data', () => {
    expect(validateEventForCloud(event)).toEqual([])
    expect(validateSeriesForCloud(seriesInput)).toEqual([])
  })

  it('checks text length limits', () => {
    expect(validateEventForCloud({ ...event, title: 'x'.repeat(121) })[0]).toMatch(/title/)
    expect(validateEventForCloud({ ...event, title: '   ' })[0]).toMatch(/title/)
    expect(validateEventForCloud({ ...event, location: 'x'.repeat(121) })[0]).toMatch(/location/)
    expect(validateEventForCloud({ ...event, description: 'x'.repeat(2001) })[0]).toMatch(/notes/)
    expect(validateEventForCloud({ ...event, courseCode: 'x'.repeat(31) })[0]).toMatch(/course code/)
    expect(validateEventForCloud({ ...event, groupLabel: 'x'.repeat(41) })[0]).toMatch(/group label/)
  })

  it('checks time zones', () => {
    for (const ok of ['Europe/Berlin', 'America/New_York', 'UTC']) expect(isValidTimeZone(ok)).toBe(true)
    for (const bad of ['', 'Nope/Zone', 'UTC+9', ' Europe/Berlin', 'x'.repeat(65)]) expect(isValidTimeZone(bad), bad).toBe(false)
    expect(validateEventForCloud({ ...event, timeZone: 'Mars/Olympus' })[0]).toMatch(/time zone/)
    expect(validateSeriesForCloud({ ...seriesInput, timeZone: 'UTC+9' })[0]).toMatch(/time zone/)
  })

  it('checks event times', () => {
    expect(validateEventForCloud({ ...event, end: '2026-10-12T06:00:00.000Z' })[0]).toMatch(/end is before start/)
    expect(validateEventForCloud({ ...event, start: 'garbage' })[0]).toMatch(/valid date/)
    expect(validateEventForCloud({ ...event, end: event.start })).toEqual([]) // zero-length (deadline) is allowed
  })

  it('enforces the 1100-day recurrence span and ordering', () => {
    const span = (until: string) => ({ ...seriesInput, recurrence: { ...seriesInput.recurrence, untilDate: until } })
    expect(validateSeriesForCloud(span('2029-03-06'))).toEqual([]) // exactly 1100 days
    expect(validateSeriesForCloud(span('2029-03-07'))[0]).toMatch(/1100/)
    expect(validateSeriesForCloud(span('2026-03-01'))[0]).toMatch(/before the start/)
  })

  it('enforces the same-day duration rule and weekday rules', () => {
    expect(validateSeriesForCloud({ ...seriesInput, startTime: '15:00', endTime: '10:00' })[0]).toMatch(/end after/)
    expect(validateSeriesForCloud({ ...seriesInput, startTime: '22:00', endTime: '02:00', endDayOffset: 1 })).toEqual([])
    expect(validateSeriesForCloud({ ...seriesInput, recurrence: { ...seriesInput.recurrence, weekdays: [] } })[0]).toMatch(/weekdays/)
    expect(validateSeriesForCloud({ ...seriesInput, recurrence: { ...seriesInput.recurrence, weekdays: [1, 1] } })[0]).toMatch(/weekdays/)
    expect(validateSeriesForCloud({ ...seriesInput, endDayOffset: 7 })[0]).toMatch(/7 days/)
  })

  it('rejects no-op and malformed exceptions', () => {
    expect(validateExceptionForCloud({ originalDate: '2026-03-09' })[0]).toMatch(/neither/)
    expect(validateExceptionForCloud({ originalDate: '2026-03-09', override: {} })[0]).toMatch(/neither/)
    expect(validateExceptionForCloud({ originalDate: '2026-03-09', cancelled: true })).toEqual([])
    expect(validateExceptionForCloud({ originalDate: '2026-02-30', cancelled: true })[0]).toMatch(/date/)
    expect(validateExceptionForCloud({ originalDate: '2026-03-09', override: { start: '2026-03-09T09:00:00Z' } })[0]).toMatch(/together/)
    expect(validateExceptionForCloud({ originalDate: '2026-03-09', override: { start: '2026-03-09T10:00:00Z', end: '2026-03-09T09:00:00Z' } })[0]).toMatch(/after/)
    expect(validateExceptionForCloud({ originalDate: '2026-03-09', override: { location: '' } })).toEqual([])
  })

  it('reports exception problems inside series validation', () => {
    expect(validateSeriesForCloud({ ...seriesInput, exceptions: [{ originalDate: '2026-03-09', override: {} }] })[0]).toMatch(/2026-03-09/)
  })
})

describe('orphaned exceptions are detected, not dropped', () => {
  it('flags dates outside the range or on unscheduled weekdays', () => {
    const s = { recurrence: seriesInput.recurrence }
    expect(isOrphaned(s, { originalDate: '2026-03-09', cancelled: true })).toBe(false) // Monday
    expect(isOrphaned(s, { originalDate: '2026-03-10', cancelled: true })).toBe(true) // Tuesday
    expect(isOrphaned(s, { originalDate: '2026-05-04', cancelled: true })).toBe(true) // after the end
  })
})

describe('error mapping', () => {
  it('classifies failures without leaking details', () => {
    expect(mapCloudError({ message: 'TypeError: Failed to fetch' }).kind).toBe('network')
    expect(mapCloudError({}, 0).kind).toBe('network')
    expect(mapCloudError({ code: 'PGRST301', message: 'JWT expired' }, 401).kind).toBe('auth')
    expect(mapCloudError({ code: '42501', message: 'permission denied for table events' }, 401).kind).toBe('permission')
    expect(mapCloudError({ code: '23505' }, 409).kind).toBe('conflict')
    expect(mapCloudError({ code: '22P02', message: 'invalid input syntax for type uuid' }, 400).kind).toBe('validation')
    expect(mapCloudError({ code: '23514' }, 400).kind).toBe('validation')
    expect(mapCloudError({ code: 'PGRST205' }, 404).message).toMatch(/not available/)
    expect(mapCloudError({ code: 'XX000', message: 'secret internal detail' }, 500).message).not.toMatch(/secret/)
    const e = new CloudError('conflict', 'x')
    expect(mapCloudError(e)).toBe(e)
  })
})

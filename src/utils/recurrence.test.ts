import { describe, expect, it } from 'vitest'
import type { CalendarEvent, RecurringSeries, SeriesException, Weekday } from '../types'
import { conflictLines, findConflicts, overlaps } from './conflicts'
import { eventsOnDay, summarizeDay, validateEventForm, validateSeriesForm } from './events'
import type { EventFormValues, RepeatFormValues } from './events'
import {
  dstWarnings,
  expandSeries,
  occurrenceId,
  orphanedExceptions,
  overrideFromInput,
  resolveOccurrence,
} from './recurrence'
import { conflictsFor, expandItems } from './schedule'
import { resolveLocalTime, zonedTimeToUtc } from './time'

const TS = '2026-01-01T00:00:00.000Z'

function makeSeries(over: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    id: 's1',
    title: 'Maths',
    category: 'university',
    timeZone: 'Europe/Berlin',
    recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-03-02', untilDate: '2026-04-27' },
    startTime: '09:00',
    endTime: '10:30',
    endDayOffset: 0,
    exceptions: [],
    createdAt: TS,
    updatedAt: TS,
    ...over,
  }
}

const dates = (items: { originalDate?: string }[]) => items.map((i) => i.originalDate)

describe('weekly recurrence', () => {
  it('generates only the selected weekdays', () => {
    const s = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [0, 2], startDate: '2026-03-02', untilDate: '2026-04-27' } })
    // Mon 2 Mar and Wed 4 Mar, but not the rest of the week.
    expect(dates(expandSeries(s, '2026-03-02', '2026-03-08'))).toEqual(['2026-03-02', '2026-03-04'])
  })

  it('respects the first and last active dates (inclusive)', () => {
    const s = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-03-02', untilDate: '2026-03-16' } })
    expect(dates(expandSeries(s, '2026-01-01', '2026-12-31'))).toEqual(['2026-03-02', '2026-03-09', '2026-03-16'])
    expect(expandSeries(s, '2026-02-01', '2026-03-01')).toEqual([])
    expect(expandSeries(s, '2026-03-17', '2026-06-01')).toEqual([])
  })

  it('first date need not be a selected weekday', () => {
    const s = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-03-04', untilDate: '2026-03-31' } })
    expect(dates(expandSeries(s, '2026-03-01', '2026-03-31'))[0]).toBe('2026-03-09')
  })

  it('only generates the requested range', () => {
    const s = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-01-05', untilDate: '2028-12-31' } })
    expect(expandSeries(s, '2026-06-01', '2026-06-30')).toHaveLength(5)
  })

  it('works across month, year and leap-day boundaries', () => {
    const s = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [6], startDate: '2027-12-01', untilDate: '2028-03-31' } })
    const d = dates(expandSeries(s, '2027-12-01', '2028-03-31'))
    expect(d).toContain('2027-12-26')
    expect(d).toContain('2028-01-02')
    expect(d).toContain('2028-02-27')
    expect(d).toContain('2028-03-05')
    // 2028-02-29 is a Tuesday: a Tuesday series includes the leap day.
    const tue = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [1], startDate: '2028-02-01', untilDate: '2028-03-01' } })
    expect(dates(expandSeries(tue, '2028-02-01', '2028-03-01'))).toContain('2028-02-29')
  })

  it('gives each occurrence a stable id from series + original date', () => {
    const item = expandSeries(makeSeries(), '2026-03-02', '2026-03-02')[0]
    expect(item.id).toBe(occurrenceId('s1', '2026-03-02'))
    expect(item.seriesId).toBe('s1')
  })
})

describe('DST: local wall-clock time is preserved', () => {
  it('keeps 09:00 across spring-forward', () => {
    const items = expandSeries(makeSeries(), '2026-03-23', '2026-03-30')
    expect(items.map((i) => i.start)).toEqual(['2026-03-23T08:00:00.000Z', '2026-03-30T07:00:00.000Z'])
  })

  it('keeps 09:00 across autumn fall-back', () => {
    const s = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [0], startDate: '2026-10-19', untilDate: '2026-11-02' } })
    const items = expandSeries(s, '2026-10-19', '2026-11-02')
    expect(items.map((i) => i.start)).toEqual([
      '2026-10-19T07:00:00.000Z', // CEST
      '2026-10-26T08:00:00.000Z', // CET
      '2026-11-02T08:00:00.000Z',
    ])
  })

  it('flags (not hides) an occurrence whose local time does not exist', () => {
    // Saturdays 22:00 -> 02:30 next day; on 29 Mar 2026 02:30 does not exist.
    const s = makeSeries({
      recurrence: { frequency: 'weekly', weekdays: [5], startDate: '2026-03-21', untilDate: '2026-04-04' },
      startTime: '22:00',
      endTime: '02:30',
      endDayOffset: 1,
    })
    const [normal, gap] = expandSeries(s, '2026-03-21', '2026-04-04')
    expect(normal.dstAdjusted).toBeUndefined()
    expect(gap.originalDate).toBe('2026-03-28')
    expect(gap.dstAdjusted).toBe(true)
    expect(dstWarnings({ ...s, exceptions: undefined } as never).join()).toMatch(/does not exist/)
  })

  it('reports ambiguous and nonexistent local times', () => {
    expect(resolveLocalTime('2026-03-29', '02:30').status).toBe('nonexistent')
    expect(resolveLocalTime('2026-10-25', '02:30').status).toBe('ambiguous')
    expect(resolveLocalTime('2026-10-25', '01:30').status).toBe('ok')
  })

  it('resolves an ambiguous time to the first occurrence', () => {
    // 02:30 CEST = 00:30Z (first); 02:30 CET = 01:30Z (second).
    expect(resolveLocalTime('2026-10-25', '02:30').utc.toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })
})

describe('overnight recurring events', () => {
  const s = makeSeries({
    recurrence: { frequency: 'weekly', weekdays: [4], startDate: '2026-10-02', untilDate: '2026-10-30' },
    startTime: '22:00',
    endTime: '02:00',
    endDayOffset: 1,
    category: 'work',
  })

  it('appears on both the start day and the following day', () => {
    expect(dates(expandSeries(s, '2026-10-09', '2026-10-09'))).toEqual(['2026-10-09'])
    expect(dates(expandSeries(s, '2026-10-10', '2026-10-10'))).toEqual(['2026-10-09'])
    expect(expandSeries(s, '2026-10-11', '2026-10-11')).toEqual([])
  })

  it('belongs to the next day in daily summaries (clipped minutes)', () => {
    const items = expandItems([], [s], '2026-10-09', '2026-10-10')
    expect(summarizeDay(eventsOnDay(items, '2026-10-09'), '2026-10-09', 'work').minutes).toBe(120)
    expect(summarizeDay(eventsOnDay(items, '2026-10-10'), '2026-10-10', 'work').minutes).toBe(120)
  })
})

describe('exceptions', () => {
  const cancelled: SeriesException = { originalDate: '2026-03-09', cancelled: true }

  it('cancelling one occurrence hides only that one', () => {
    const s = makeSeries({ exceptions: [cancelled] })
    expect(dates(expandSeries(s, '2026-03-02', '2026-03-23'))).toEqual(['2026-03-02', '2026-03-16', '2026-03-23'])
  })

  it('cancelled occurrences can be listed for restore, flagged as cancelled', () => {
    const s = makeSeries({ exceptions: [cancelled] })
    const all = expandSeries(s, '2026-03-09', '2026-03-09', { includeCancelled: true })
    expect(all).toHaveLength(1)
    expect(all[0].cancelled).toBe(true)
  })

  it('restoring (removing the exception) brings the occurrence back', () => {
    const restored = makeSeries({ exceptions: [] })
    expect(dates(expandSeries(restored, '2026-03-09', '2026-03-09'))).toEqual(['2026-03-09'])
  })

  it('editing one occurrence changes only that occurrence', () => {
    const s = makeSeries({
      location: 'Room 1',
      exceptions: [{ originalDate: '2026-03-09', override: { title: 'Maths (exam)', location: '' } }],
    })
    const [a, b] = expandSeries(s, '2026-03-02', '2026-03-09')
    expect(a.title).toBe('Maths')
    expect(a.location).toBe('Room 1')
    expect(a.modified).toBeUndefined()
    expect(b.title).toBe('Maths (exam)')
    expect(b.location).toBeUndefined() // '' clears the location
    expect(b.modified).toBe(true)
  })

  it('overrideFromInput stores only what changed', () => {
    const s = makeSeries()
    const base = resolveOccurrence(s, '2026-03-09')
    const input = { title: 'Maths', category: base.category, start: base.start, end: base.end, timeZone: s.timeZone }
    expect(overrideFromInput(s, '2026-03-09', input)).toBeUndefined()
    expect(overrideFromInput(s, '2026-03-09', { ...input, location: 'Hall' })).toEqual({ location: 'Hall' })
  })

  it('a moved occurrence appears on its new date only, keeping its identity', () => {
    const moved: SeriesException = {
      originalDate: '2026-03-09',
      override: { start: zonedTimeToUtc('2026-03-11', '14:00').toISOString(), end: zonedTimeToUtc('2026-03-11', '15:30').toISOString() },
    }
    const s = makeSeries({ exceptions: [moved] })
    expect(expandSeries(s, '2026-03-09', '2026-03-09')).toEqual([]) // not on the original Monday
    const onWed = expandSeries(s, '2026-03-11', '2026-03-11')
    expect(onWed).toHaveLength(1)
    expect(onWed[0].id).toBe('s1:2026-03-09')
    expect(onWed[0].originalDate).toBe('2026-03-09')
    expect(onWed[0].modified).toBe(true)
  })

  it('a moved occurrence is found even when its original date is outside the viewed range', () => {
    const moved: SeriesException = {
      originalDate: '2026-03-09',
      override: { start: zonedTimeToUtc('2026-04-22', '14:00').toISOString(), end: zonedTimeToUtc('2026-04-22', '15:00').toISOString() },
    }
    const s = makeSeries({ exceptions: [moved] })
    expect(dates(expandSeries(s, '2026-04-22', '2026-04-22'))).toEqual(['2026-03-09'])
  })

  it('editing the entire series affects every occurrence but keeps valid exceptions', () => {
    const s = makeSeries({ exceptions: [cancelled] })
    const edited = { ...s, startTime: '10:00', title: 'Algebra' }
    const items = expandSeries(edited, '2026-03-02', '2026-03-23')
    expect(items.every((i) => i.title === 'Algebra')).toBe(true)
    expect(dates(items)).not.toContain('2026-03-09')
    expect(orphanedExceptions(edited)).toEqual([])
  })

  it('reports exceptions that no longer match the schedule', () => {
    const s = makeSeries({ exceptions: [cancelled, { originalDate: '2026-03-16', cancelled: true }] })
    const shortened = { ...s, recurrence: { ...s.recurrence, untilDate: '2026-03-10' } }
    expect(orphanedExceptions(shortened).map((e) => e.originalDate)).toEqual(['2026-03-16'])
    const otherDay = { ...s, recurrence: { ...s.recurrence, weekdays: [2 as Weekday] } }
    expect(orphanedExceptions(otherDay)).toHaveLength(2)
  })
})

describe('conflict detection', () => {
  const event = (id: string, day: string, from: string, endDay: string, to: string, category: CalendarEvent['category'] = 'work'): CalendarEvent => ({
    id,
    title: id,
    category,
    start: zonedTimeToUtc(day, from).toISOString(),
    end: zonedTimeToUtc(endDay, to).toISOString(),
    timeZone: 'Europe/Berlin',
    createdAt: TS,
    updatedAt: TS,
  })

  it('detects overlapping events', () => {
    const a = event('class', '2026-10-09', '10:00', '2026-10-09', '11:30', 'university')
    const b = event('shift', '2026-10-09', '11:00', '2026-10-09', '15:00')
    expect(overlaps(a, b)).toBe(true)
    expect(findConflicts([a], [b])).toHaveLength(1)
  })

  it('does not treat adjacent (touching) events as overlapping', () => {
    const a = event('a', '2026-10-09', '10:00', '2026-10-09', '11:00')
    const b = event('b', '2026-10-09', '11:00', '2026-10-09', '12:00')
    expect(overlaps(a, b)).toBe(false)
    expect(findConflicts([a], [b])).toEqual([])
  })

  it('detects conflicts across midnight', () => {
    const night = event('night', '2026-10-09', '22:00', '2026-10-10', '02:00')
    const early = event('early', '2026-10-10', '01:00', '2026-10-10', '03:00')
    expect(overlaps(night, early)).toBe(true)
  })

  it('never reports an item as conflicting with itself', () => {
    const a = event('a', '2026-10-09', '10:00', '2026-10-09', '11:00')
    expect(findConflicts([a], [a])).toEqual([])
    expect(conflictsFor([a], [a], [], (i) => i.id === 'a')).toEqual([])
  })

  it('ignores deadlines', () => {
    const d = event('due', '2026-10-09', '10:00', '2026-10-09', '11:00', 'deadline')
    const b = event('b', '2026-10-09', '10:00', '2026-10-09', '11:00')
    expect(overlaps(d, b)).toBe(false)
  })

  it('finds conflicts between a one-time shift and a recurring class', () => {
    const s = makeSeries() // Mondays 09:00-10:30
    const shift = event('shift', '2026-03-09', '10:00', '2026-03-09', '12:00')
    const found = conflictsFor([shift], [], [s])
    expect(found).toHaveLength(1)
    expect(found[0].b.id).toBe('s1:2026-03-09')
    expect(conflictLines(found)[0]).toContain('Maths')
  })

  it('ignores a cancelled occurrence, and follows a moved one', () => {
    const shift = event('shift', '2026-03-09', '10:00', '2026-03-09', '12:00')
    const cancelled = makeSeries({ exceptions: [{ originalDate: '2026-03-09', cancelled: true }] })
    expect(conflictsFor([shift], [], [cancelled])).toEqual([])
    const moved = makeSeries({
      exceptions: [{ originalDate: '2026-03-09', override: { start: zonedTimeToUtc('2026-03-09', '11:00').toISOString(), end: zonedTimeToUtc('2026-03-09', '12:30').toISOString() } }],
    })
    expect(conflictsFor([shift], [], [moved])).toHaveLength(1)
  })

  it('does not flag a series against itself when editing it', () => {
    const s = makeSeries()
    const candidates = expandSeries(s, '2026-03-02', '2026-04-27')
    expect(conflictsFor(candidates, [], [s], (i) => i.seriesId === 's1')).toEqual([])
  })

  it('detects two overlapping recurring classes', () => {
    const a = makeSeries()
    const b = makeSeries({ id: 's2', title: 'Physics', startTime: '10:00', endTime: '11:00' })
    expect(conflictsFor(expandSeries(b, '2026-03-02', '2026-04-27'), [], [a], (i) => i.seriesId === 's2')).toHaveLength(9)
  })
})

describe('daily summaries count occurrences', () => {
  it('counts each occurrence, not the series', () => {
    const a = makeSeries({ recurrence: { frequency: 'weekly', weekdays: [0, 2], startDate: '2026-03-02', untilDate: '2026-03-31' } })
    const b = makeSeries({ id: 's2', startTime: '13:00', endTime: '14:00' })
    const items = expandItems([], [a, b], '2026-03-09', '2026-03-09')
    expect(summarizeDay(eventsOnDay(items, '2026-03-09'), '2026-03-09', 'university')).toEqual({ count: 2, minutes: 150 })
  })

  it('excludes cancelled occurrences', () => {
    const s = makeSeries({ exceptions: [{ originalDate: '2026-03-09', cancelled: true }] })
    const items = expandItems([], [s], '2026-03-09', '2026-03-09')
    expect(summarizeDay(items, '2026-03-09', 'university')).toEqual({ count: 0, minutes: 0 })
  })
})

describe('form validation', () => {
  const values: EventFormValues = {
    title: 'German A2',
    category: 'german',
    startDate: '2026-10-05',
    startTime: '18:00',
    endDate: '2026-10-05',
    endTime: '19:30',
    location: '',
    description: '',
    courseCode: '',
    sessionType: '',
    groupLabel: '',
  }
  const repeat: RepeatFormValues = { mode: 'weekly', weekdays: [2, 0], until: '2026-12-21' }

  it('builds a series from the form', () => {
    const r = validateSeriesForm(values, repeat)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.input.recurrence).toEqual({ frequency: 'weekly', weekdays: [0, 2], startDate: '2026-10-05', untilDate: '2026-12-21' })
      expect(r.input.endDayOffset).toBe(0)
    }
  })

  it('records overnight length as a day offset', () => {
    const r = validateSeriesForm({ ...values, startTime: '22:00', endDate: '2026-10-06', endTime: '02:00' }, repeat)
    expect(r.ok && r.input.endDayOffset).toBe(1)
  })

  it('rejects missing weekdays, bad until date, and overlong events', () => {
    const none = validateSeriesForm(values, { ...repeat, weekdays: [] })
    expect(!none.ok && none.errors.weekdays).toBeTruthy()
    const before = validateSeriesForm(values, { ...repeat, until: '2026-10-01' })
    expect(!before.ok && before.errors.until).toBeTruthy()
    const long = validateSeriesForm({ ...values, endDate: '2026-10-20' }, repeat)
    expect(!long.ok && long.errors.endDate).toBeTruthy()
  })

  it('rejects a one-off time that does not exist (DST gap) but accepts it for the series form as a warning', () => {
    const gap = { ...values, startDate: '2026-03-29', endDate: '2026-03-29', startTime: '02:30', endTime: '04:00' }
    const single = validateEventForm(gap)
    expect(!single.ok && single.errors.startTime).toMatch(/does not exist/)
    expect(validateSeriesForm(gap, { ...repeat, until: '2026-05-01' }).ok).toBe(true)
  })
})

describe('regression: summaries ignore items from other days', () => {
  it('summarizeDay only counts events overlapping the given day', () => {
    const mk = (id: string, day: string): CalendarEvent => ({
      id,
      title: id,
      category: 'university',
      start: zonedTimeToUtc(day, '09:00').toISOString(),
      end: zonedTimeToUtc(day, '10:00').toISOString(),
      timeZone: 'Europe/Berlin',
      createdAt: TS,
      updatedAt: TS,
    })
    const mixed = [mk('today', '2026-10-12'), mk('tomorrow', '2026-10-13'), mk('lastWeek', '2026-10-05')]
    expect(summarizeDay(mixed, '2026-10-12', 'university')).toEqual({ count: 1, minutes: 60 })
  })
})

describe('university metadata', () => {
  const values: EventFormValues = {
    title: 'Databases',
    category: 'university',
    startDate: '2026-10-12',
    startTime: '09:00',
    endDate: '2026-10-12',
    endTime: '10:30',
    location: '',
    description: '',
    courseCode: ' CS201 ',
    sessionType: 'tutorial',
    groupLabel: 'Group B',
  }

  it('flows from the form into one-off events and series (trimmed, optional)', () => {
    const one = validateEventForm(values)
    expect(one.ok && one.input).toMatchObject({ courseCode: 'CS201', sessionType: 'tutorial', groupLabel: 'Group B' })
    const series = validateSeriesForm(values, { mode: 'weekly', weekdays: [0], until: '2026-12-14' })
    expect(series.ok && series.input).toMatchObject({ courseCode: 'CS201', sessionType: 'tutorial', groupLabel: 'Group B' })
    const empty = validateEventForm({ ...values, courseCode: '', sessionType: '', groupLabel: '' })
    expect(empty.ok && empty.input).not.toHaveProperty('courseCode')
    expect(empty.ok && empty.input).not.toHaveProperty('sessionType')
  })

  it('rejects overlong values', () => {
    const r = validateEventForm({ ...values, courseCode: 'x'.repeat(31), groupLabel: 'y'.repeat(41) })
    expect(!r.ok && r.errors.courseCode).toBeTruthy()
    expect(!r.ok && r.errors.groupLabel).toBeTruthy()
  })

  it('occurrences inherit series metadata and can override or clear it', () => {
    const s = makeSeries({ courseCode: 'CS201', sessionType: 'main', groupLabel: 'Group A' })
    const base = resolveOccurrence(s, '2026-03-02')
    expect([base.courseCode, base.sessionType, base.groupLabel]).toEqual(['CS201', 'main', 'Group A'])
    const withOverride = makeSeries({
      courseCode: 'CS201',
      sessionType: 'main',
      groupLabel: 'Group A',
      exceptions: [{ originalDate: '2026-03-09', override: { groupLabel: 'Group C', sessionType: '' } }],
    })
    const o = resolveOccurrence(withOverride, '2026-03-09')
    expect(o.groupLabel).toBe('Group C')
    expect(o.sessionType).toBeUndefined() // '' clears
    expect(o.courseCode).toBe('CS201')
  })

  it('overrideFromInput records only changed metadata', () => {
    const s = makeSeries({ courseCode: 'CS201', groupLabel: 'Group A' })
    const base = resolveOccurrence(s, '2026-03-09')
    const input = { title: s.title, category: s.category, start: base.start, end: base.end, timeZone: s.timeZone, courseCode: 'CS201', groupLabel: 'Group B' }
    expect(overrideFromInput(s, '2026-03-09', input)).toEqual({ groupLabel: 'Group B' })
  })
})

import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../types'
import {
  currentEvent,
  emptyFormValues,
  eventsOnDay,
  eventTimeLabel,
  eventToFormValues,
  nextEvent,
  summarizeDay,
  validateEventForm,
} from './events'
import type { EventFormValues } from './events'
import { zonedTimeToUtc } from './time'

function ev(id: string, day: string, from: string, endDay: string, to: string, category: CalendarEvent['category'] = 'work'): CalendarEvent {
  return {
    id,
    title: id,
    category,
    start: zonedTimeToUtc(day, from).toISOString(),
    end: zonedTimeToUtc(endDay, to).toISOString(),
    timeZone: 'Europe/Berlin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const base: EventFormValues = {
  title: 'Lecture',
  category: 'university',
  startDate: '2026-10-09',
  startTime: '10:00',
  endDate: '2026-10-09',
  endTime: '11:30',
  location: '',
  description: '',
  courseCode: '',
  sessionType: '',
  groupLabel: '',
}

describe('eventsOnDay', () => {
  const night = ev('night', '2026-10-09', '22:00', '2026-10-10', '02:00')
  const morning = ev('morning', '2026-10-10', '09:00', '2026-10-10', '10:00')
  const endsAtMidnight = ev('late', '2026-10-09', '20:00', '2026-10-10', '00:00')
  const all = [morning, night, endsAtMidnight]

  it('includes events spanning midnight on both days', () => {
    expect(eventsOnDay(all, '2026-10-09').map((e) => e.id)).toEqual(['late', 'night'])
    expect(eventsOnDay(all, '2026-10-10').map((e) => e.id)).toEqual(['night', 'morning'])
  })

  it('does not include an event that ends exactly at midnight on the next day', () => {
    expect(eventsOnDay([endsAtMidnight], '2026-10-10')).toEqual([])
  })

  it('returns nothing for an empty day', () => {
    expect(eventsOnDay(all, '2026-10-12')).toEqual([])
  })
})

describe('currentEvent / nextEvent', () => {
  const a = ev('a', '2026-10-09', '09:00', '2026-10-09', '10:00')
  const b = ev('b', '2026-10-09', '14:00', '2026-10-09', '15:00')
  const c = ev('c', '2026-10-12', '09:00', '2026-10-12', '10:00')

  it('finds the running event, with end exclusive', () => {
    expect(currentEvent([a, b], zonedTimeToUtc('2026-10-09', '09:30'))?.id).toBe('a')
    expect(currentEvent([a, b], zonedTimeToUtc('2026-10-09', '10:00'))).toBeUndefined()
  })

  it('finds the next event, including on a later day', () => {
    expect(nextEvent([a, b, c], zonedTimeToUtc('2026-10-09', '09:30'))?.id).toBe('b')
    expect(nextEvent([a, b, c], zonedTimeToUtc('2026-10-09', '16:00'))?.id).toBe('c')
    expect(nextEvent([a, b, c], zonedTimeToUtc('2026-10-13', '08:00'))).toBeUndefined()
  })
})

describe('summarizeDay', () => {
  it('clips multi-day events to the day', () => {
    const night = ev('n', '2026-10-09', '22:00', '2026-10-10', '02:00', 'work')
    expect(summarizeDay([night], '2026-10-09', 'work')).toEqual({ count: 1, minutes: 120 })
    expect(summarizeDay([night], '2026-10-10', 'work')).toEqual({ count: 1, minutes: 120 })
    expect(summarizeDay([night], '2026-10-09', 'study')).toEqual({ count: 0, minutes: 0 })
  })
})

describe('eventTimeLabel', () => {
  it('formats same-day and multi-day events', () => {
    expect(eventTimeLabel(ev('x', '2026-10-09', '09:00', '2026-10-09', '10:30'), '2026-10-09')).toBe('09:00 – 10:30')
    const night = ev('n', '2026-10-09', '22:00', '2026-10-10', '02:00')
    expect(eventTimeLabel(night, '2026-10-09')).toBe('22:00 → 02:00 (+1d)')
    expect(eventTimeLabel(night, '2026-10-10')).toBe('until 02:00')
  })
})

describe('validateEventForm', () => {
  it('accepts a valid form and builds UTC instants', () => {
    const r = validateEventForm(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.input.start).toBe('2026-10-09T08:00:00.000Z')
      expect(r.input.end).toBe('2026-10-09T09:30:00.000Z')
      expect(r.input).not.toHaveProperty('location')
    }
  })

  it('requires a title', () => {
    const r = validateEventForm({ ...base, title: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.title).toBeDefined()
  })

  it('rejects end before or equal to start', () => {
    expect(validateEventForm({ ...base, endTime: '09:00' }).ok).toBe(false)
    expect(validateEventForm({ ...base, endTime: '10:00' }).ok).toBe(false)
  })

  it('accepts an event ending the next day', () => {
    const r = validateEventForm({ ...base, startTime: '23:00', endDate: '2026-10-10', endTime: '01:00' })
    expect(r.ok).toBe(true)
  })

  it('rejects missing or invalid dates and times', () => {
    const r = validateEventForm({ ...base, startDate: '', endTime: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.startDate).toBeDefined()
      expect(r.errors.endTime).toBeDefined()
    }
  })
})

describe('form values', () => {
  it('round-trips an event through the form', () => {
    const r = validateEventForm({ ...base, location: 'Room 1', description: 'Bring notes' })
    if (!r.ok) throw new Error('expected valid')
    const event: CalendarEvent = { ...r.input, id: '1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    expect(eventToFormValues(event)).toEqual({ ...base, location: 'Room 1', description: 'Bring notes' })
  })

  it('defaults a new event on another day to 09:00–10:00', () => {
    const v = emptyFormValues('2026-11-02', zonedTimeToUtc('2026-10-09', '12:00'))
    expect([v.startDate, v.startTime, v.endDate, v.endTime]).toEqual(['2026-11-02', '09:00', '2026-11-02', '10:00'])
  })

  it('defaults today to the next full hour and may cross midnight', () => {
    const v = emptyFormValues('2026-10-09', zonedTimeToUtc('2026-10-09', '23:10'))
    expect(v.startDate).toBe('2026-10-09') // 23:10 -> next hour is tomorrow, so falls back to 09:00
    expect(v.startTime).toBe('09:00')
    const w = emptyFormValues('2026-10-09', zonedTimeToUtc('2026-10-09', '14:10'))
    expect([w.startTime, w.endTime]).toEqual(['15:00', '16:00'])
  })
})

/**
 * Intermediate data model for the UTN semester timetable PDF.
 *
 * Nothing here is a CalendarEvent. Extracted sessions stay in this model until a
 * user explicitly confirms an import (a later phase); see docs/timetable-import/.
 */

/** A positioned run of text in UPRIGHT page coordinates (origin top-left, y grows downwards, PDF points). */
export interface TextBox {
  str: string
  x0: number
  x1: number
  /** Baseline y. */
  y: number
  size: number
}

/** A filled axis-aligned rectangle in upright page coordinates. `fill` is `#rrggbb`. */
export interface FillRect {
  x0: number
  y0: number
  x1: number
  y1: number
  fill: string
}

/** Everything the extractor needs from one PDF page. Serialisable, so it doubles as the test-fixture format. */
export interface PageLayout {
  /** 1-based page number in the source PDF. */
  page: number
  width: number
  height: number
  /** Rotation of the page as stored in the PDF (the layout is already un-rotated). */
  rotation: number
  texts: TextBox[]
  rects: FillRect[]
}

export type Weekday = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'

export const WEEKDAYS: readonly Weekday[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface SlotDef {
  slot: number
  start: string
  end: string
}

/** The five principal slots as printed in the PDF (validated against every table). */
export const SLOTS: readonly SlotDef[] = [
  { slot: 1, start: '09:00', end: '10:30' },
  { slot: 2, start: '10:45', end: '12:15' },
  { slot: 3, start: '13:15', end: '14:45' },
  { slot: 4, start: '15:00', end: '16:30' },
  { slot: 5, start: '16:45', end: '18:15' },
]

export type Severity = 'info' | 'warning' | 'error'

export interface Issue {
  severity: Severity
  /** Stable machine-readable code, e.g. `duplicate-date`. */
  code: string
  message: string
}

/** Where on the PDF something came from; enough to find it again on the rendered page. */
export interface SourceRef {
  page: number
  /** Cell rectangle(s) in upright page points, merged when the card spans slots. */
  bbox: { x0: number; y0: number; x1: number; y1: number }
  semesterWeek: number
  /** Exact text lines found in the cell(s), top to bottom. */
  rawLines: string[]
}

export type LocationKind = 'room' | 'online' | 'unknown'

export interface SessionLocation {
  kind: LocationKind
  /** e.g. `NOP` or `UL`. */
  campus?: string
  /** e.g. `ALC1` or `S31`. */
  room?: string
  /** The printed text, whitespace-normalised. */
  raw: string
}

/** One slot-sized card as drawn in the PDF, before neighbouring identical cards are merged. */
export interface RawCard {
  source: SourceRef
  fill: string
  weekday: Weekday
  /** `YYYY-MM-DD` taken from the day header; null when the header carries no (or an unusable) date. */
  date: string | null
  /** Slots covered by the printed cell, e.g. [4, 5] for a tall cell. */
  slots: number[]
  /** Codes printed on the card (a joint excursion card can carry two). */
  courseCodes: string[]
  /** Free text between the code lines and the programme line, e.g. `tutorial group B`. */
  typeText: string
  programs: string[]
  location: SessionLocation | null
  issues: Issue[]
}

export interface DayColumn {
  weekday: Weekday
  /** Printed date as `YYYY-MM-DD`, or null. */
  date: string | null
  /** The printed text (e.g. `05.03.2027`) or null. */
  dateText: string | null
  x0: number
  x1: number
  issues: Issue[]
}

export interface WeekTable {
  semesterWeek: number
  title: string
  /** Page where the title bar is printed. */
  titlePage: number
  /** Pages the table's rows are printed on (a table can break across pages). */
  pages: number[]
  /** Vertical extent (upright page points) the table occupies on each of its pages. */
  regions: { page: number; y0: number; y1: number }[]
  days: DayColumn[]
  cards: RawCard[]
  /** Text found in the table body that does not belong to any cell. */
  strayText: { page: number; text: string }[]
  issues: Issue[]
}

export type SessionKind = 'main' | 'tutorial' | 'project' | 'excursion' | 'language' | 'other'

export type Confidence = 'high' | 'medium' | 'low'

/**
 * A timetable session: one or more consecutive identical slot cards merged.
 * `rawCards` keeps the per-slot cards for provenance.
 */
export interface TimetableSession {
  /**
   * Stable key built from content only (course, date, times, kind, group); it never
   * contains page numbers or coordinates so it survives a re-export of the PDF.
   */
  sourceKey: string
  semesterWeek: number
  date: string | null
  weekday: Weekday
  startTime: string
  endTime: string
  timeZone: 'Europe/Berlin'
  slots: number[]
  spansMultipleSlots: boolean
  courseCode: string
  /** Extra codes on a joint card (e.g. an excursion shared by two courses). */
  jointWith: string[]
  courseTitle: string | null
  kind: SessionKind
  /** Printed type text, e.g. `main group A`. */
  typeText: string
  /** Parsed groups, e.g. ['B'] or ['B', 'C']; empty when none is printed. */
  groups: string[]
  /** Printed sub-group/variant token such as `a`, `b`, `1`, `2`; null when none. */
  variant: string | null
  programs: string[]
  location: SessionLocation | null
  fill: string
  source: SourceRef[]
  confidence: Confidence
  issues: Issue[]
}

/** A date or week header problem that needs human confirmation. */
export interface SourceAnomaly {
  semesterWeek: number
  code: string
  message: string
}

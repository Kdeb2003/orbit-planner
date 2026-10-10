import { parseCardLines } from './cardText.ts'
import type { DayColumn, FillRect, Issue, PageLayout, RawCard, TextBox, WeekTable } from './types.ts'
import { SLOTS, WEEKDAYS } from './types.ts'

/**
 * Geometric reconstruction of the week tables.
 *
 * Nothing here reads "reading order" text or regular expressions over the whole
 * page. The structure is rebuilt from the drawn geometry:
 *
 *  - a dark title bar (with "Semester Week NN") opens a table;
 *  - the light band directly under it carries the weekday names and dates;
 *  - "Slot N" labels plus the thin horizontal grid lines give the row bands, and
 *    rows keep belonging to the open table across page breaks;
 *  - coloured rectangles are the cards; their centre decides the weekday, their
 *    vertical extent decides the slot(s), and the text inside them is the card text.
 */

const TITLE_RE = /Semester Week\s+(\d+)/i
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/
const SLOT_LABEL_RE = /^Slot\s+(\d)$/
const TIME_RE = /^\d{2}:\d{2}-\d{2}:\d{2}$/

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const GRID_MAX_THICKNESS = 1.2
const ALIGN_TOL = 1.3

const round2 = (n: number) => Math.round(n * 100) / 100

const luminance = (hex: string): number => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return 0.5
  return (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255
}

const w = (r: FillRect) => r.x1 - r.x0
const h = (r: FillRect) => r.y1 - r.y0
const cx = (t: { x0: number; x1: number }) => (t.x0 + t.x1) / 2

const isGridLine = (r: FillRect) => Math.min(w(r), h(r)) < GRID_MAX_THICKNESS
const isTitleBar = (r: FillRect) => luminance(r.fill) < 0.35 && h(r) >= 5 && h(r) <= 30 && w(r) > 100
const isCardCandidate = (r: FillRect) => !isGridLine(r) && Math.min(w(r), h(r)) >= 8 && luminance(r.fill) < 0.97 && luminance(r.fill) > 0.35

export function parseDottedDate(text: string): string | null {
  const m = DATE_RE.exec(text.trim())
  if (!m) return null
  const [, dd, mm, yyyy] = m
  const iso = `${yyyy}-${mm}-${dd}`
  const d = new Date(`${iso}T00:00:00Z`)
  return d.getUTCFullYear() === Number(yyyy) && d.getUTCMonth() + 1 === Number(mm) && d.getUTCDate() === Number(dd) ? iso : null
}

/** 0 = Monday … 6 = Sunday for an ISO date. */
export function isoWeekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7
}

export function addIsoDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The width of one grid cell: the most common width of painted rectangles (merged ones are multiples of it). */
export function detectCellWidth(pages: PageLayout[]): number {
  const counts = new Map<number, number>()
  for (const p of pages) for (const r of p.rects) if (isCardCandidate(r)) counts.set(Math.round(w(r) * 10) / 10, (counts.get(Math.round(w(r) * 10) / 10) ?? 0) + 1)
  let best = 36.8
  let bestN = 0
  for (const [width, n] of counts) if (n > bestN) [best, bestN] = [width, n]
  return best
}

interface RowBand {
  slot: number
  page: number
  y0: number
  y1: number
  /** Printed time label, e.g. `09:00-10:30`. */
  time: string | null
}

interface TableBuild {
  table: WeekTable
  rows: RowBand[]
  /** Horizontal extent of the body (all day columns). */
  x0: number
  x1: number
  titleTop: number
  headerBottom: number
}

function groupLines(texts: TextBox[]): string[] {
  const sorted = [...texts].sort((a, b) => a.y - b.y || a.x0 - b.x0)
  const lines: { y: number; parts: TextBox[] }[] = []
  for (const t of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - t.y) < 0.8) last.parts.push(t)
    else lines.push({ y: t.y, parts: [t] })
  }
  return lines.map((l) => l.parts.sort((a, b) => a.x0 - b.x0).map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim())
}

function buildTitle(layout: PageLayout, title: TextBox, weekNo: number): TableBuild {
  const issues: Issue[] = []
  const bar = layout.rects.find((r) => isTitleBar(r) && title.y >= r.y0 - 1 && title.y <= r.y1 + 1 && title.x0 >= r.x0 - 1)
  if (!bar) issues.push({ severity: 'error', code: 'title-bar-not-found', message: `No title bar found behind "${title.str}".` })
  const bandTop = bar ? bar.y1 : title.y + 2
  const band = layout.rects.find((r) => !isGridLine(r) && bar && Math.abs(r.y0 - bar.y1) < 2 && Math.abs(r.x0 - bar.x0) < 2 && h(r) < 30 && luminance(r.fill) > 0.5)
  const bandBottom = band ? band.y1 : bandTop + 22

  const headerTexts = layout.texts.filter((t) => t.y > bandTop && t.y <= bandBottom + 0.5 && t.x0 >= (bar ? bar.x0 : 0) - 1 && (!bar || t.x1 <= bar.x1 + 1))
  const dayTexts = WEEKDAYS.map((name) => headerTexts.find((t) => t.str.trim() === name))
  const days: DayColumn[] = []
  let x0 = 0
  let x1 = 0
  if (dayTexts.some((d) => !d)) {
    issues.push({ severity: 'error', code: 'header-incomplete', message: `Week ${weekNo}: weekday header incomplete (found ${dayTexts.filter(Boolean).length}/6).` })
  } else {
    const centers = (dayTexts as TextBox[]).map(cx)
    const width = (centers[5] - centers[0]) / 5
    centers.forEach((c, i) => {
      if (i > 0 && Math.abs(c - centers[i - 1] - width) > 2) issues.push({ severity: 'warning', code: 'uneven-day-columns', message: `Week ${weekNo}: weekday columns are unevenly spaced.` })
    })
    x0 = centers[0] - width / 2
    x1 = centers[5] + width / 2
    const dateTexts = headerTexts.filter((t) => DATE_RE.test(t.str.trim()))
    WEEKDAYS.forEach((weekday, i) => {
      const colX0 = x0 + i * width
      const colX1 = colX0 + width
      const here = dateTexts.filter((t) => cx(t) >= colX0 && cx(t) < colX1)
      const dayIssues: Issue[] = []
      let date: string | null = null
      let dateText: string | null = null
      if (here.length === 0) {
        dayIssues.push({ severity: 'warning', code: 'no-date', message: `Week ${weekNo} ${weekday}: no date printed in the header.` })
      } else {
        if (here.length > 1) dayIssues.push({ severity: 'error', code: 'multiple-dates', message: `Week ${weekNo} ${weekday}: several dates in one column.` })
        dateText = here[0].str.trim()
        date = parseDottedDate(dateText)
        if (!date) dayIssues.push({ severity: 'error', code: 'invalid-date', message: `Week ${weekNo} ${weekday}: "${dateText}" is not a valid date.` })
        else if (isoWeekdayIndex(date) !== i) {
          // The source is never "fixed": the date is withheld and a human has to confirm the intended one.
          dayIssues.push({ severity: 'error', code: 'date-weekday-mismatch', message: `Week ${weekNo}: ${weekday} is printed as ${dateText}, which is a ${WEEKDAY_NAMES[isoWeekdayIndex(date)]}. Date withheld pending confirmation.` })
          date = null
        }
      }
      days.push({ weekday, date, dateText, x0: colX0, x1: colX1, issues: dayIssues })
    })
  }

  const table: WeekTable = { semesterWeek: weekNo, title: title.str.trim(), titlePage: layout.page, pages: [layout.page], regions: [], days, cards: [], strayText: [], issues }
  return { table, rows: [], x0, x1, titleTop: bar ? bar.y0 : title.y - 6, headerBottom: bandBottom }
}

interface RowEvent {
  page: number
  label: TextBox
}

function rowBandFor(layout: PageLayout, label: TextBox): RowBand | null {
  const slot = Number(SLOT_LABEL_RE.exec(label.str.trim())?.[1])
  const lines = layout.rects
    .filter((r) => isGridLine(r) && w(r) > 20 && h(r) <= GRID_MAX_THICKNESS && r.x0 <= label.x0 + 4 && r.x1 >= label.x0 + 4)
    .map((r) => (r.y0 + r.y1) / 2)
  const above = Math.max(...lines.filter((y) => y < label.y - 0.5), Number.NEGATIVE_INFINITY)
  const below = Math.min(...lines.filter((y) => y > label.y), Number.POSITIVE_INFINITY)
  if (!Number.isFinite(above) || !Number.isFinite(below)) return null
  const timeText = layout.texts.find((t) => TIME_RE.test(t.str.trim()) && Math.abs(t.x0 - label.x0) < 2 && t.y > label.y && t.y < below)
  return { slot, page: layout.page, y0: above, y1: below, time: timeText ? timeText.str.trim() : null }
}

/** Reconstructs every week table from the page layouts (table pages only; the legend page is ignored). */
export function extractWeekTables(pages: PageLayout[]): WeekTable[] {
  const builds: TableBuild[] = []
  let current: TableBuild | null = null

  for (const layout of pages) {
    type Ev = { y: number; kind: 'title'; text: TextBox; week: number } | { y: number; kind: 'row'; ev: RowEvent }
    const events: Ev[] = []
    for (const t of layout.texts) {
      const m = TITLE_RE.exec(t.str)
      if (m) events.push({ y: t.y, kind: 'title', text: t, week: Number(m[1]) })
      else if (SLOT_LABEL_RE.test(t.str.trim())) events.push({ y: t.y, kind: 'row', ev: { page: layout.page, label: t } })
    }
    events.sort((a, b) => a.y - b.y)

    for (const e of events) {
      if (e.kind === 'title') {
        current = buildTitle(layout, e.text, e.week)
        builds.push(current)
        continue
      }
      const band = rowBandFor(layout, e.ev.label)
      if (!current || !band) {
        const who = current ? `week ${current.table.semesterWeek}` : 'no open table'
        ;(current ?? builds[builds.length - 1])?.table.issues.push({ severity: 'error', code: 'row-not-resolved', message: `Row "${e.ev.label.str}" on page ${layout.page} could not be placed (${who}).` })
        continue
      }
      if (current.rows.some((r) => r.slot === band.slot)) {
        current.table.issues.push({ severity: 'error', code: 'duplicate-slot-row', message: `Week ${current.table.semesterWeek}: slot ${band.slot} appears twice (page ${layout.page}).` })
        continue
      }
      const canon = SLOTS[band.slot - 1]
      if (!canon || (band.time && band.time !== `${canon.start}-${canon.end}`)) {
        current.table.issues.push({ severity: 'error', code: 'unexpected-slot-time', message: `Week ${current.table.semesterWeek}: slot ${band.slot} prints time "${band.time}", expected ${canon ? `${canon.start}-${canon.end}` : 'a slot 1-5'}.` })
      }
      current.rows.push(band)
      if (!current.table.pages.includes(layout.page)) current.table.pages.push(layout.page)
    }
  }

  for (const b of builds) {
    b.table.regions = b.table.pages.map((page) => {
      const rows = b.rows.filter((r) => r.page === page)
      const ys = rows.flatMap((r) => [r.y0, r.y1])
      if (page === b.table.titlePage) ys.push(b.titleTop, b.headerBottom)
      return { page, y0: Math.min(...ys), y1: Math.max(...ys) }
    })
    const missing = SLOTS.filter((s) => !b.rows.some((r) => r.slot === s.slot)).map((s) => s.slot)
    if (missing.length) b.table.issues.push({ severity: 'error', code: 'missing-slot-rows', message: `Week ${b.table.semesterWeek}: slot row(s) ${missing.join(', ')} not found.` })
  }

  const cellWidth = detectCellWidth(pages)
  for (const layout of pages) assignCards(layout, builds, cellWidth)
  return builds.map((b) => b.table)
}

function assignCards(layout: PageLayout, builds: TableBuild[], cellWidth: number): void {
  const pageRows = builds.flatMap((b) => b.rows.filter((r) => r.page === layout.page).map((row) => ({ build: b, row })))
  if (pageRows.length === 0) return

  const used = new Set<TextBox>()
  const cardRects = layout.rects.filter(isCardCandidate)

  // The PDF producer paints neighbouring cells of the same colour as ONE merged rectangle
  // (wider and/or taller). A rectangle is therefore not a card: it is split on the grid
  // (one cell width x one slot row) and every unit cell is read on its own.
  for (const rect of cardRects) {
    const overlapping = pageRows.filter(({ row }) => Math.min(rect.y1, row.y1) - Math.max(rect.y0, row.y0) > (row.y1 - row.y0) * 0.5)
    if (overlapping.length === 0) continue
    const build = overlapping[0].build
    if (overlapping.some((o) => o.build !== build)) {
      build.table.issues.push({ severity: 'error', code: 'cell-spans-tables', message: `Week ${build.table.semesterWeek}: a painted cell overlaps rows of different tables.` })
      continue
    }
    const bands = overlapping.map((o) => o.row).sort((a, b) => a.slot - b.slot)
    const rectIssues: Issue[] = []
    if (Math.abs(rect.y0 - bands[0].y0) > ALIGN_TOL || Math.abs(rect.y1 - bands[bands.length - 1].y1) > ALIGN_TOL) {
      rectIssues.push({ severity: 'warning', code: 'cell-misaligned', message: 'Painted cell edges do not line up with the slot rows.' })
    }
    for (let i = 1; i < bands.length; i++) {
      if (bands[i].slot !== bands[i - 1].slot + 1) rectIssues.push({ severity: 'error', code: 'non-consecutive-slots', message: 'Painted cell covers non-consecutive slot rows.' })
    }
    const nCols = Math.max(1, Math.round((rect.x1 - rect.x0) / cellWidth))
    if (Math.abs((rect.x1 - rect.x0) - nCols * cellWidth) > 1.5) {
      rectIssues.push({ severity: 'warning', code: 'cell-width-irregular', message: `Painted cell is ${(rect.x1 - rect.x0).toFixed(1)}pt wide, not a multiple of ${cellWidth}pt.` })
    }
    const colWidth = (rect.x1 - rect.x0) / nCols

    for (let ci = 0; ci < nCols; ci++) {
      const ux0 = rect.x0 + ci * colWidth
      const ux1 = ux0 + colWidth
      const col = build.table.days.find((d) => (ux0 + ux1) / 2 >= d.x0 && (ux0 + ux1) / 2 < d.x1)
      if (!col) {
        build.table.issues.push({ severity: 'error', code: 'cell-outside-columns', message: `Week ${build.table.semesterWeek}: a painted cell at x=${ux0.toFixed(0)} lies outside all weekday columns.` })
        continue
      }
      for (const band of bands) {
        const inside = layout.texts.filter((t) => !used.has(t) && cx(t) >= ux0 - 0.5 && cx(t) <= ux1 + 0.5 && t.y >= band.y0 - 0.5 && t.y <= band.y1 + 0.5)
        inside.forEach((t) => used.add(t))
        if (inside.length === 0) {
          build.table.issues.push({ severity: 'warning', code: 'painted-cell-without-text', message: `Week ${build.table.semesterWeek} ${col.weekday} slot ${band.slot}: coloured cell without any text.` })
          continue
        }
        const issues: Issue[] = [...rectIssues]
        if (inside.some((t) => t.x1 - t.x0 > colWidth + 1)) issues.push({ severity: 'warning', code: 'text-wider-than-cell', message: 'Some text is wider than its cell and may be clipped.' })
        const lines = groupLines(inside)
        const parsed = parseCardLines(lines)
        const card: RawCard = {
          source: {
            page: layout.page,
            bbox: { x0: round2(ux0), y0: round2(band.y0), x1: round2(ux1), y1: round2(band.y1) },
            semesterWeek: build.table.semesterWeek,
            rawLines: lines,
          },
          fill: rect.fill,
          weekday: col.weekday,
          date: col.date,
          slots: [band.slot],
          courseCodes: parsed.courseCodes,
          typeText: parsed.typeText,
          programs: parsed.programs,
          location: parsed.location,
          issues: [...issues, ...parsed.issues],
        }
        if (col.date === null) card.issues.push({ severity: 'error', code: 'date-unusable', message: `No usable date for ${col.weekday} in week ${build.table.semesterWeek}${col.dateText ? ` (printed "${col.dateText}")` : ''}.` })
        build.table.cards.push(card)
      }
    }
  }

  // Text inside a table body that no cell claimed (e.g. the free-text notice on page 1).
  for (const build of builds) {
    const rows = build.rows.filter((r) => r.page === layout.page)
    if (rows.length === 0 || build.x1 <= build.x0) continue
    const top = Math.min(...rows.map((r) => r.y0))
    const bottom = Math.max(...rows.map((r) => r.y1))
    for (const t of layout.texts) {
      if (used.has(t) || t.x0 < build.x0 - 1 || t.y < top || t.y > bottom) continue
      build.table.strayText.push({ page: layout.page, text: t.str.trim() })
    }
  }
}

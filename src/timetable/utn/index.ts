import { extractDocumentLayouts } from './pdfLayout.ts'
import type { PdfDocumentLike } from './pdfLayout.ts'
import { parseLegend } from './legend.ts'
import type { Legend } from './legend.ts'
import { buildSessions, validateCalendar } from './sessions.ts'
import { extractWeekTables } from './tables.ts'
import type { Issue, PageLayout, SourceAnomaly, TimetableSession, WeekTable } from './types.ts'

export interface TimetableExtraction {
  layouts: PageLayout[]
  tables: WeekTable[]
  legend: Legend
  sessions: TimetableSession[]
  /** Calendar-level findings (undated weeks, duplicate dates, ...) for human confirmation. */
  anomalies: SourceAnomaly[]
  /**
   * Document-level problems. Any `error` here means the PDF is not a supported UTN timetable
   * (scanned/flattened, other layout, no week tables) and `sessions` must not be trusted.
   */
  problems: Issue[]
  /** False when `problems` contains an error. */
  supported: boolean
}

export function documentProblems(layouts: PageLayout[], tables: WeekTable[]): Issue[] {
  const out: Issue[] = []
  if (layouts.length === 0 || layouts.every((p) => p.texts.length === 0)) {
    out.push({ severity: 'error', code: 'no-text-layer', message: 'The PDF has no text layer (a scan or image-only file). OCR is not supported; no sessions were produced.' })
    return out
  }
  if (tables.length === 0) {
    out.push({ severity: 'error', code: 'no-week-tables', message: 'No "Semester Week" tables were found. This is not a supported UTN semester timetable.' })
    return out
  }
  if (tables.every((t) => t.cards.length === 0)) {
    out.push({ severity: 'error', code: 'no-cards', message: 'Week tables were found but no painted course cells. The drawing layout is not the supported one.' })
  }
  const broken = tables.filter((t) => t.issues.some((i) => i.severity === 'error'))
  if (broken.length) out.push({ severity: 'warning', code: 'structure-errors', message: `Structural errors in week(s) ${broken.map((t) => t.semesterWeek).join(', ')}; their sessions are low confidence.` })
  return out
}

/** Pure pipeline from stored page layouts (fixtures) to sessions. */
export function extractFromLayouts(layouts: PageLayout[]): TimetableExtraction {
  const tables = extractWeekTables(layouts)
  const legend = parseLegend(layouts)
  const sessions = buildSessions(tables, legend)
  const problems = documentProblems(layouts, tables)
  const supported = !problems.some((p) => p.severity === 'error')
  return { layouts, tables, legend, sessions: supported ? sessions : [], anomalies: validateCalendar(tables), problems, supported }
}

/** Reads a PDF.js document and runs the whole pipeline. Parsing is local; nothing is uploaded. */
export async function extractFromPdf(doc: PdfDocumentLike): Promise<TimetableExtraction> {
  return extractFromLayouts(await extractDocumentLayouts(doc))
}

export * from './types.ts'
export { SELECTED_COURSES, findSessionClashes, selectSessions } from './selection.ts'
export type { SelectedCourseDef, SelectedSession, SelectionResult, SessionClash } from './selection.ts'
export { toEventDraft } from './mapping.ts'
export type { EventDraft } from './mapping.ts'

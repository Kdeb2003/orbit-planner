import { extractFromPdf } from '../utn/index.ts'
import type { TimetableExtraction } from '../utn/index.ts'
import type { PdfDocumentLike } from '../utn/pdfLayout.ts'

/**
 * Browser-side loading of a UTN timetable PDF.
 *
 * The file is read into memory, parsed by PDF.js (loaded lazily, with its worker bundled by Vite so the URL
 * carries the production base path) and discarded. Nothing is stored and nothing is sent anywhere: no
 * network request carries the bytes, and the extracted schedule is never logged.
 */

/** Largest accepted file. The real timetable is ~200 KB; even image-heavy course lists stay far below this. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024

export type LoadErrorCode = 'empty' | 'too-large' | 'not-pdf' | 'encrypted' | 'malformed' | 'unsupported' | 'failed'

export class TimetableLoadError extends Error {
  readonly code: LoadErrorCode
  /** Short heading for the UI. */
  readonly title: string
  constructor(code: LoadErrorCode, title: string, message: string) {
    super(message)
    this.name = 'TimetableLoadError'
    this.code = code
    this.title = title
  }
}

export type LoadStage = 'reading' | 'engine' | 'parsing' | 'analysing'

export interface LoadProgress {
  stage: LoadStage
  /** Pages parsed so far (during `parsing`). */
  page?: number
  pages?: number
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

/** Cheap checks before any parsing. Returns an error, or null when the bytes may be a PDF. */
export function checkBytes(size: number, head: Uint8Array): TimetableLoadError | null {
  if (size === 0) return new TimetableLoadError('empty', 'This file is empty', 'The selected file has no content. Choose the timetable PDF you downloaded.')
  if (size > MAX_PDF_BYTES) {
    return new TimetableLoadError('too-large', 'This file is too large', `The file is ${formatBytes(size)}; the limit is ${formatBytes(MAX_PDF_BYTES)}. A semester timetable is normally well under 1 MB, so this is probably not the right file.`)
  }
  const text = new TextDecoder('latin1').decode(head.subarray(0, 1024))
  if (!text.includes('%PDF-')) return new TimetableLoadError('not-pdf', 'This is not a PDF', 'The file does not look like a PDF document. Choose the timetable as a .pdf file.')
  return null
}

/** Maps a PDF.js failure to a message a student can act on. Messages never include file content. */
export function classifyPdfError(err: unknown): TimetableLoadError {
  if (err instanceof TimetableLoadError) return err
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : ''
  if (name === 'PasswordException') {
    return new TimetableLoadError('encrypted', 'This PDF is password-protected', 'ORBIT cannot read encrypted or password-protected PDFs. Save an unprotected copy and choose that file instead.')
  }
  if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'XRefParseException') {
    return new TimetableLoadError('malformed', 'This PDF could not be read', 'The file is damaged or not a valid PDF. Download the timetable again and retry.')
  }
  return new TimetableLoadError('failed', 'The PDF could not be processed', 'Something went wrong while reading the file. Nothing was saved. Try again or choose a different file.')
}

interface OpenPdf {
  doc: PdfDocumentLike
  /** Releases the parsed document and stops the worker. */
  close(): Promise<void>
}

/** Opens bytes with PDF.js, loaded on demand. The worker is a bundled same-origin asset. */
async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({
    data: bytes,
    // Keep parsing inert and quiet: no scripts, no XFA, no fetching of fonts or extra data, no console noise.
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  })
  const doc = (await task.promise) as unknown as PdfDocumentLike
  return { doc, close: () => task.destroy() }
}

/** Counts pages as the extractor requests them, so the UI can show real progress. */
function withProgress(doc: PdfDocumentLike, onProgress: (p: LoadProgress) => void): PdfDocumentLike {
  return {
    numPages: doc.numPages,
    getPage: async (n) => {
      onProgress({ stage: 'parsing', page: n, pages: doc.numPages })
      return doc.getPage(n)
    },
  }
}

export async function loadTimetable(file: File, onProgress: (p: LoadProgress) => void = () => {}): Promise<TimetableExtraction> {
  const early = checkBytes(file.size, new Uint8Array(await file.slice(0, 1024).arrayBuffer()))
  if (early) throw early
  onProgress({ stage: 'reading' })
  const bytes = new Uint8Array(await file.arrayBuffer())
  onProgress({ stage: 'engine' })
  let open: OpenPdf | null = null
  try {
    open = await openPdf(bytes)
    const extraction = await extractFromPdf(withProgress(open.doc, onProgress))
    onProgress({ stage: 'analysing' })
    if (!extraction.supported) {
      const reason = extraction.problems.find((p) => p.severity === 'error')?.message ?? 'The layout is not supported.'
      throw new TimetableLoadError('unsupported', 'This is not a supported UTN timetable', `${reason} No sessions were extracted.`)
    }
    return extraction
  } catch (err) {
    throw classifyPdfError(err)
  } finally {
    // release the parsed document and stop the worker; the bytes are not kept anywhere
    void open?.close().catch(() => {})
  }
}

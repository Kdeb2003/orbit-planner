import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { PDFJS_OPS } from '../../src/timetable/utn/pdfLayout.ts'

// pdfLayout.ts hard-codes operator numbers so it does not import PDF.js itself.
// If a PDF.js upgrade renumbers them, this fails loudly instead of silently dropping every cell.
describe('PDF.js operator codes used by the timetable extractor', () => {
  it('match the installed pdfjs-dist', () => {
    for (const [name, code] of Object.entries(PDFJS_OPS)) expect(OPS[name as keyof typeof OPS], name).toBe(code)
  })
})

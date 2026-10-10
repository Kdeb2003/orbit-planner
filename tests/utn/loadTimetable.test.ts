import { readFileSync } from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { MAX_PDF_BYTES, TimetableLoadError, checkBytes, classifyPdfError, formatBytes } from '../../src/timetable/import/loadTimetable.ts'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('checkBytes (before any parsing)', () => {
  it('accepts something that starts like a PDF', () => {
    expect(checkBytes(2000, bytes('%PDF-1.7\n...'))).toBeNull()
  })

  it('rejects an empty file', () => {
    expect(checkBytes(0, new Uint8Array())?.code).toBe('empty')
  })

  it('rejects files above the size limit and says what the limit is', () => {
    const err = checkBytes(MAX_PDF_BYTES + 1, bytes('%PDF-1.7'))
    expect(err?.code).toBe('too-large')
    expect(err?.message).toContain('25.0 MB')
    expect(checkBytes(MAX_PDF_BYTES, bytes('%PDF-1.7'))).toBeNull()
  })

  it('rejects content that is not a PDF at all', () => {
    expect(checkBytes(30, bytes('PK\u0003\u0004 a zip file renamed to .pdf'))?.code).toBe('not-pdf')
    expect(checkBytes(30, bytes('<html>hello</html>'))?.code).toBe('not-pdf')
  })

  it('formats sizes for messages', () => {
    expect([formatBytes(10), formatBytes(2048), formatBytes(5 * 1024 * 1024)]).toEqual(['10 bytes', '2 KB', '5.0 MB'])
  })
})

describe('classifyPdfError', () => {
  it('maps PDF.js exception names to actionable messages without leaking content', () => {
    expect(classifyPdfError({ name: 'PasswordException', message: 'No password given' }).code).toBe('encrypted')
    expect(classifyPdfError({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' }).code).toBe('malformed')
    expect(classifyPdfError(new Error('boom: secret text')).code).toBe('failed')
    expect(classifyPdfError(new Error('boom: secret text')).message).not.toContain('secret')
    const own = new TimetableLoadError('unsupported', 't', 'm')
    expect(classifyPdfError(own)).toBe(own)
  })
})

describe('real PDF.js failures', () => {
  const open = (data: Uint8Array) => pdfjs.getDocument({ data, verbosity: 0 }).promise

  it('an encrypted PDF fails with PasswordException, which is reported as encrypted', async () => {
    // A tiny synthetic PDF (AES-256, user password required); it contains no real data.
    const data = new Uint8Array(readFileSync(new URL('../../src/timetable/utn/__fixtures__/encrypted-empty.pdf', import.meta.url)))
    const err = await open(data).then(() => null, (e: unknown) => e)
    expect(classifyPdfError(err).code).toBe('encrypted')
  })

  it('a truncated or garbage PDF fails and is reported as malformed or failed, never as success', async () => {
    const err = await open(bytes('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n')).then(() => null, (e: unknown) => e)
    expect(err).not.toBeNull()
    expect(['malformed', 'failed']).toContain(classifyPdfError(err).code)
  })
})

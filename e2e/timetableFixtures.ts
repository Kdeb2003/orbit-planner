import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page, Request } from '@playwright/test'
import { layoutsToPdf, noTextPdf, textOnlyPdf } from '../tests/utn/layoutPdf'
import type { PageLayout } from '../src/timetable/utn/types'

// A real (synthetic) PDF rendered from the committed minimal fixture layouts: no private file is needed.
const fixture = JSON.parse(readFileSync(resolve('src/timetable/utn/__fixtures__/utn-wise2627-layouts.json'), 'utf8')) as { pages: PageLayout[] }

export const fixturePdf = (): { name: string; mimeType: string; buffer: Buffer } => ({ name: 'test-timetable.pdf', mimeType: 'application/pdf', buffer: Buffer.from(layoutsToPdf(fixture.pages)) })
export const textOnly = () => ({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(textOnlyPdf()) })
export const scanned = () => ({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(noTextPdf()) })
export const garbage = () => ({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n') })
export const encrypted = () => ({ name: 'locked.pdf', mimeType: 'application/pdf', buffer: readFileSync(resolve('src/timetable/utn/__fixtures__/encrypted-empty.pdf')) })
export const notAPdf = () => ({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('PK\u0003\u0004 this is a zip, not a PDF') })
export const emptyFile = () => ({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) })
export const hugeFile = () => ({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024)]) })

/** The user's own PDF: used only when present (optional, never committed); see docs/timetable-import/baseline.md. */
export const REAL_PDF = process.env.UTN_TIMETABLE_PDF ?? resolve('..', 'orbit-import-inputs', 'timetable UTN WiSe26-27_AIR all courses(3).pdf')
export const hasRealPdf = existsSync(REAL_PDF)

export const importPage = (page: Page) => page.goto('#/import-timetable')

export async function uploadAndWait(page: Page, file: { name: string; mimeType: string; buffer: Buffer } | string) {
  await page.locator('input[type="file"]').setInputFiles(file)
}

/** Records every request so a test can prove nothing carried the PDF or left the origin. */
export function recordRequests(page: Page) {
  const seen: { method: string; url: string; postData: string | null; origin: string }[] = []
  page.on('request', (r: Request) => {
    const u = new URL(r.url())
    if (!u.protocol.startsWith('http')) return
    seen.push({ method: r.method(), url: r.url(), postData: r.postData(), origin: u.origin })
  })
  return seen
}

// Test helper: renders stored PageLayouts (the committed, minimal fixture format) into a tiny REAL PDF so the
// browser upload path and the PDF.js pipeline can be tested without the user's private timetable.
// Text is drawn with the built-in Helvetica; rectangles are plain filled `re f` paths. Only ASCII is supported
// (the fixture is ASCII). The result is never written to the repository.
import type { PageLayout } from '../../src/timetable/utn/types.ts'

const num = (n: number) => String(Math.round(n * 1000) / 1000)

function pdfString(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch
    else out += code >= 32 && code < 127 ? ch : '?'
  }
  return out
}

function rgb(hex: string): string {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return v.map((x) => num(x)).join(' ')
}

function pageStream(p: PageLayout): string {
  const lines: string[] = []
  for (const r of p.rects) {
    lines.push(`${rgb(r.fill)} rg ${num(r.x0)} ${num(p.height - r.y1)} ${num(r.x1 - r.x0)} ${num(r.y1 - r.y0)} re f`)
  }
  lines.push('0 0 0 rg')
  for (const t of p.texts) {
    lines.push(`BT /F1 ${num(t.size)} Tf 1 0 0 1 ${num(t.x0)} ${num(p.height - t.y)} Tm (${pdfString(t.str)}) Tj ET`)
  }
  return lines.join('\n')
}

/** Minimal valid PDF 1.4 with one page per layout (upright, unrotated). */
export function layoutsToPdf(layouts: readonly PageLayout[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => objects.push(body) // object number = index + 1
  add('<< /Type /Catalog /Pages 2 0 R >>')
  const first = 4
  const kids = layouts.map((_, i) => `${first + i * 2} 0 R`).join(' ')
  add(`<< /Type /Pages /Kids [${kids}] /Count ${layouts.length} >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  layouts.forEach((p, i) => {
    const stream = pageStream(p)
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + i * 2 + 1} 0 R >>`)
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A page with a few words and no tables: a valid PDF that is not a UTN timetable. */
export function textOnlyPdf(text = 'Meeting notes'): Uint8Array {
  return layoutsToPdf([{ page: 1, width: 595, height: 842, rotation: 0, texts: [{ str: text, x0: 72, x1: 160, y: 100, size: 12 }], rects: [] }])
}

/** A page with only a painted block and no text: what an image-only scan looks like to the text layer. */
export function noTextPdf(): Uint8Array {
  return layoutsToPdf([{ page: 1, width: 595, height: 842, rotation: 0, texts: [], rects: [{ x0: 50, y0: 50, x1: 500, y1: 700, fill: '#cccccc' }] }])
}

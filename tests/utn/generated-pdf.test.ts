// Always-run PDF.js round trip: the committed fixture layouts are rendered into a real (synthetic) PDF, parsed by
// PDF.js and must give the same sessions as the stored layouts. This exercises the real PDF.js path without any
// private file.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import raw from '../../src/timetable/utn/__fixtures__/utn-wise2627-layouts.json?raw'
import { extractFromLayouts, extractFromPdf } from '../../src/timetable/utn/index.ts'
import type { PageLayout } from '../../src/timetable/utn/types.ts'
import { layoutsToPdf, noTextPdf, textOnlyPdf } from './layoutPdf.ts'

const pages = (JSON.parse(raw) as { pages: PageLayout[] }).pages
const open = (bytes: Uint8Array) => pdfjs.getDocument({ data: bytes }).promise
const keys = (s: { sourceKey: string; slots: number[]; location: { raw: string } | null }[]) => s.map((x) => `${x.sourceKey}|${x.slots.join()}|${x.location?.raw}`)

describe('synthetic PDF generated from the fixture layouts', () => {
  it('parses through real PDF.js to the same sessions as the stored layouts', async () => {
    const direct = extractFromLayouts(structuredClone(pages))
    const viaPdf = await extractFromPdf((await open(layoutsToPdf(pages))) as never)
    expect(viaPdf.supported).toBe(true)
    expect(viaPdf.sessions.length).toBeGreaterThan(50)
    expect(keys(viaPdf.sessions)).toEqual(keys(direct.sessions))
    expect(viaPdf.anomalies.map((a) => a.code).sort()).toEqual(direct.anomalies.map((a) => a.code).sort())
  }, 60_000)

  it('a text-only PDF is not a supported timetable', async () => {
    const r = await extractFromPdf((await open(textOnlyPdf())) as never)
    expect([r.supported, r.sessions, r.problems.map((p) => p.code)]).toEqual([false, [], ['no-week-tables']])
  })

  it('a PDF without a text layer is rejected as scanned/unsupported', async () => {
    const r = await extractFromPdf((await open(noTextPdf())) as never)
    expect([r.supported, r.sessions, r.problems.map((p) => p.code)]).toEqual([false, [], ['no-text-layer']])
  })
})

import { describe, expect, it } from 'vitest'
import { PDFJS_OPS, extractPageLayout } from './pdfLayout.ts'
import type { PdfPageLike } from './pdfLayout.ts'

// Numbers below are copied from the real timetable's page 3 (a page stored rotated by 90 degrees).
const ROTATED_VIEWPORT = { width: 842, height: 595.22, transform: [0, 1, 1, 0, 0, 0] }

function page(over: Partial<PdfPageLike> & { items?: unknown[]; fnArray?: number[]; argsArray?: unknown[] }): PdfPageLike {
  return {
    pageNumber: 3,
    rotate: 90,
    getViewport: () => ROTATED_VIEWPORT,
    getTextContent: async () => ({ items: over.items ?? [] }),
    getOperatorList: async () => ({ fnArray: over.fnArray ?? [], argsArray: over.argsArray ?? [] }),
    ...over,
  }
}

describe('extractPageLayout on a rotated page', () => {
  it('turns vertical text into upright, left-to-right text boxes', async () => {
    const layout = await extractPageLayout(
      page({ items: [{ str: 'W26M-AINBA', width: 16.995, transform: [0, 3, -3, 0, 76.68, 208.7904] }, { str: ' ', width: 1, transform: [0, 3, -3, 0, 1, 1] }] }),
    )
    expect(layout.rotation).toBe(90)
    expect(layout.texts).toHaveLength(1) // whitespace-only runs are dropped
    const t = layout.texts[0]
    expect(t.x0).toBeCloseTo(208.79, 2)
    expect(t.x1).toBeCloseTo(225.79, 2)
    expect(t.y).toBeCloseTo(76.68, 2)
    expect(t.size).toBe(3)
  })

  it('maps a painted cell to upright coordinates with its fill colour', async () => {
    const layout = await extractPageLayout(
      page({
        fnArray: [PDFJS_OPS.setFillRGBColor, PDFJS_OPS.constructPath],
        argsArray: [['#e5bce0'], [PDFJS_OPS.fill, [[0, 72.36, 88.671, 1, 91.56, 88.671, 1, 91.56, 125.511, 1, 72.36, 125.511, 4]], [72.36, 88.671, 91.56, 125.511]]],
      }),
    )
    expect(layout.rects).toEqual([{ x0: 88.67, y0: 72.36, x1: 125.51, y1: 91.56, fill: '#e5bce0' }])
  })

  it('applies the current transformation matrix and restores it after save/restore', async () => {
    const square = [PDFJS_OPS.fill, [[0, 0, 0, 1, 10, 0, 1, 10, 5, 1, 0, 5, 4]], null]
    const layout = await extractPageLayout(
      page({
        fnArray: [PDFJS_OPS.setFillRGBColor, PDFJS_OPS.save, PDFJS_OPS.transform, PDFJS_OPS.constructPath, PDFJS_OPS.restore, PDFJS_OPS.constructPath],
        argsArray: [['#bee5bc'], null, [1, 0, 0, 1, 100, 200], square, null, square],
      }),
    )
    // rotated viewport swaps axes: (x, y) -> (y, x)
    expect(layout.rects[0]).toMatchObject({ x0: 200, y0: 100, x1: 205, y1: 110 })
    expect(layout.rects[1]).toMatchObject({ x0: 0, y0: 0, x1: 5, y1: 10 })
  })

  it('ignores strokes, curves and non-rectangular fills', async () => {
    const layout = await extractPageLayout(
      page({
        fnArray: [PDFJS_OPS.constructPath, PDFJS_OPS.constructPath, PDFJS_OPS.constructPath],
        argsArray: [
          [20, [[0, 0, 0, 1, 10, 0, 1, 10, 5, 1, 0, 5, 4]], null], // stroke (op 20), not a fill
          [PDFJS_OPS.fill, [[0, 0, 0, 2, 1, 1, 2, 2, 5, 5, 4]], null], // curve
          [PDFJS_OPS.fill, [[0, 0, 0, 1, 10, 3, 1, 10, 5, 4]], null], // triangle
        ],
      }),
    )
    expect(layout.rects).toEqual([])
  })
})

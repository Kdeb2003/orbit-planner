import type { FillRect, PageLayout, TextBox } from './types.ts'

/**
 * Turns a PDF.js page into a plain, serialisable PageLayout (positioned text +
 * filled rectangles, already un-rotated). Everything downstream is pure and works
 * on that structure, so it can be tested with stored fixtures and never needs PDF.js.
 *
 * PDF.js is injected (not imported) so the same code runs in Node tests and in a
 * browser build, whichever PDF.js bundle the caller prefers. The PDF never leaves
 * the machine: parsing is local and deterministic.
 */

/** Operator codes of pdfjs-dist 6.x (guarded by a test that compares them with the real `OPS`). */
export const PDFJS_OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  constructPath: 91,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  setFillRGBColor: 59,
} as const

/** Codes used inside the flat path data of a `constructPath` operation. */
const PATH = { moveTo: 0, lineTo: 1, curveTo: 2, quadTo: 3, close: 4 } as const

type Matrix = [number, number, number, number, number, number]

export interface PdfViewportLike {
  width: number
  height: number
  transform: number[]
}

export interface PdfPageLike {
  pageNumber: number
  rotate: number
  getViewport(params: { scale: number }): PdfViewportLike
  getTextContent(): Promise<{ items: unknown[] }>
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>
}

export interface PdfDocumentLike {
  numPages: number
  getPage(n: number): Promise<PdfPageLike>
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** a·b: apply `b` first, then `a` (PDF concatenation order for the `cm` operator is b·a, see multiplyCtm). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m: ArrayLike<number>, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

const round = (n: number) => Math.round(n * 100) / 100

interface RawTextItem {
  str: string
  width: number
  transform: number[]
}

function isTextItem(item: unknown): item is RawTextItem {
  const i = item as Partial<RawTextItem>
  return typeof i === 'object' && i !== null && typeof i.str === 'string' && Array.isArray(i.transform) && typeof i.width === 'number'
}

function extractTexts(items: unknown[], viewport: PdfViewportLike): TextBox[] {
  const out: TextBox[] = []
  for (const item of items) {
    if (!isTextItem(item) || item.str.trim() === '') continue
    const [a, b, , , e, f] = item.transform
    const len = Math.hypot(a, b) || 1
    const size = len
    // Baseline runs along (a, b); `width` is measured along it.
    const [x0, y0] = apply(viewport.transform, e, f)
    const [x1, y1] = apply(viewport.transform, e + (item.width * a) / len, f + (item.width * b) / len)
    out.push({
      str: item.str,
      x0: round(Math.min(x0, x1)),
      x1: round(Math.max(x0, x1)),
      y: round((y0 + y1) / 2),
      size: round(size),
    })
  }
  return out
}

function extractRects(ops: { fnArray: number[]; argsArray: unknown[] }, viewport: PdfViewportLike): FillRect[] {
  const rects: FillRect[] = []
  const stack: Matrix[] = []
  let ctm: Matrix = IDENTITY
  let fill = '#000000'
  const paintOps = new Set<number>([PDFJS_OPS.fill, PDFJS_OPS.eoFill, PDFJS_OPS.fillStroke, PDFJS_OPS.eoFillStroke])

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i] as unknown
    switch (fn) {
      case PDFJS_OPS.save:
        stack.push(ctm)
        break
      case PDFJS_OPS.restore:
        ctm = stack.pop() ?? IDENTITY
        break
      case PDFJS_OPS.transform:
        ctm = multiply(ctm, args as Matrix)
        break
      case PDFJS_OPS.setFillRGBColor:
        fill = String((args as string[])[0])
        break
      case PDFJS_OPS.constructPath: {
        // pdfjs 6: args = [paintOp, [flatPathData, ...], boundingBox]; each entry is one sub-path.
        const [paintOp, subPaths] = args as [number, ArrayLike<number>[]]
        if (!paintOps.has(paintOp)) break
        const m = multiply(viewport.transform as Matrix, ctm)
        for (const data of subPaths) {
          const rect = pathToRect(data, m)
          if (rect) rects.push({ ...rect, fill })
        }
        break
      }
    }
  }
  return rects
}

/** Returns the bounding box when the path is a single axis-aligned rectangle, otherwise null. */
function pathToRect(data: ArrayLike<number>, m: Matrix): Omit<FillRect, 'fill'> | null {
  const pts: [number, number][] = []
  let i = 0
  while (i < data.length) {
    const op = data[i++]
    if (op === PATH.moveTo || op === PATH.lineTo) {
      pts.push(apply(m, data[i], data[i + 1]))
      i += 2
    } else if (op === PATH.close) {
      /* nothing to read */
    } else {
      return null // curves: not a cell
    }
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
  if (pts.length !== 4) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const eps = 0.01
  // every corner must sit on a bounding-box corner, otherwise the path is not an axis-aligned rectangle
  const onCorner = pts.every(([x, y]) => (Math.abs(x - x0) < eps || Math.abs(x - x1) < eps) && (Math.abs(y - y0) < eps || Math.abs(y - y1) < eps))
  if (!onCorner) return null
  return { x0: round(x0), y0: round(y0), x1: round(x1), y1: round(y1) }
}

export async function extractPageLayout(page: PdfPageLike): Promise<PageLayout> {
  const viewport = page.getViewport({ scale: 1 })
  const [content, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()])
  return {
    page: page.pageNumber,
    width: round(viewport.width),
    height: round(viewport.height),
    rotation: page.rotate,
    texts: extractTexts(content.items, viewport),
    rects: extractRects(ops, viewport),
  }
}

export async function extractDocumentLayouts(doc: PdfDocumentLike): Promise<PageLayout[]> {
  const out: PageLayout[] = []
  for (let n = 1; n <= doc.numPages; n++) out.push(await extractPageLayout(await doc.getPage(n)))
  return out
}

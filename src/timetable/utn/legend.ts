import type { Issue, PageLayout } from './types.ts'

export interface LegendEntry {
  code: string
  /** Title as printed in the legend; null when the legend prints a code without a title (e.g. `W26M-LiT`). */
  title: string | null
  /** Colour swatch printed next to the entry, `#rrggbb`; null when none was found. */
  fill: string | null
}

export interface Legend {
  entries: Map<string, LegendEntry>
  issues: Issue[]
}

const hex = (c: string) => c.toLowerCase()

/**
 * Parses the course-number / title / colour legend (last PDF page). Rows are matched
 * by vertical position, because the three columns are separate text runs.
 */
export function parseLegend(pages: PageLayout[]): Legend {
  const entries = new Map<string, LegendEntry>()
  const issues: Issue[] = []
  const page = pages.find((p) => p.texts.some((t) => t.str.trim() === 'Course number'))
  if (!page) {
    issues.push({ severity: 'warning', code: 'legend-missing', message: 'No course-code legend page found.' })
    return { entries, issues }
  }
  const header = page.texts.find((t) => t.str.trim() === 'Course number')!
  const codes = page.texts.filter((t) => /^W\d{2}M-/.test(t.str.trim()) && t.y > header.y)
  const titleX = (page.texts.find((t) => t.str.trim() === 'Course title')?.x0 ?? 150) - 200
  for (const c of codes) {
    const code = c.str.trim()
    const title = page.texts
      .filter((t) => Math.abs(t.y - c.y) < 2 && t.x0 > c.x1 + 5 && t.x0 > titleX && !/^W\d{2}M-/.test(t.str.trim()))
      .sort((a, b) => a.x0 - b.x0)
      .map((t) => t.str.trim())
      .join(' ')
    const swatch = page.rects.find((r) => r.x0 > 400 && r.y0 <= c.y - 3 && r.y1 >= c.y - 3 && r.y1 - r.y0 > 5 && r.y1 - r.y0 < 20)
    if (entries.has(code)) issues.push({ severity: 'warning', code: 'legend-duplicate', message: `Legend lists ${code} twice.` })
    entries.set(code, { code, title: title || null, fill: swatch ? hex(swatch.fill) : null })
  }
  if (entries.size === 0) issues.push({ severity: 'warning', code: 'legend-empty', message: 'Legend page contains no course codes.' })
  return { entries, issues }
}

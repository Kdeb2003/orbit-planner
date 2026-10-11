import type { CourseColor } from '../../types/planner'

// Full class names (not built dynamically) so Tailwind can see them. The values come from the theme tokens
// --color-c1..c8 in src/styles/index.css; no colour values live in components.
export const COURSE_COLOR_CLASSES: Record<CourseColor, { bg: string; border: string }> = {
  c1: { bg: 'bg-c1', border: 'border-l-c1' },
  c2: { bg: 'bg-c2', border: 'border-l-c2' },
  c3: { bg: 'bg-c3', border: 'border-l-c3' },
  c4: { bg: 'bg-c4', border: 'border-l-c4' },
  c5: { bg: 'bg-c5', border: 'border-l-c5' },
  c6: { bg: 'bg-c6', border: 'border-l-c6' },
  c7: { bg: 'bg-c7', border: 'border-l-c7' },
  c8: { bg: 'bg-c8', border: 'border-l-c8' },
}

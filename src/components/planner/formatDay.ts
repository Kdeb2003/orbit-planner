/** 'YYYY-MM-DD' -> "12 Oct 2026" (a plain calendar date, never shifted by a time zone). */
export const formatDay = (d: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))

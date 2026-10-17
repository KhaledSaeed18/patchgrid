/** The ranges a report offers: the last N days, ending now, as the API's half-open ISO range. */
export const RANGE_DAYS = [7, 30, 90, 365] as const
export type RangeDays = (typeof RANGE_DAYS)[number]

export function rangeFor(days: number, now: Date): { from: string; to: string } {
  // Rounded to the minute, so the server's first render and the client's first query ask the same thing.
  const to = new Date(Math.ceil(now.getTime() / 60_000) * 60_000)
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() }
}

/** A share of a whole, as a percentage, or `null` when there is no whole. */
export function percent(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10
}

/**
 * One CSV cell: quoted, quotes doubled, and a leading `=`, `+`, `-`, `@`, tab
 * or carriage return defused with a `'`, or a spreadsheet would run a team's
 * or a person's name as a formula (M12 review).
 */
export function csvCell(value: string | number): string {
  const text = String(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

/** Minutes as a person reads them: 45 min, 3.5 h, 2.1 d. */
export function duration(minutes: number | null): string {
  if (minutes === null) return "—"
  if (minutes < 90) return `${String(minutes)} min`
  if (minutes < 48 * 60) return `${String(Math.round((minutes / 60) * 10) / 10)} h`
  return `${String(Math.round((minutes / 1440) * 10) / 10)} d`
}

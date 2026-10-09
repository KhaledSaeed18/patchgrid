/**
 * "3 hours ago", "in 25 minutes" — the unit that keeps the number small. Pure,
 * with `now` passed in, so a deadline badge can be tested without a clock.
 */
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["week", 7 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
]

const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

export function relativeTime(at: Date, now: Date): string {
  const delta = at.getTime() - now.getTime()
  for (const [unit, size] of STEPS) {
    if (Math.abs(delta) >= size)
      return format.format(Math.trunc(delta / size), unit)
  }
  return delta >= 0 ? "in under a minute" : "just now"
}

/**
 * SLA targets are minutes on the wire and 24×7 (DOMAIN.md §4); people think
 * in "4h" and "3d". These two convert between the forms, and agree with each
 * other: `parseDuration(formatDuration(n)) === n`.
 */

const UNITS = { d: 24 * 60, h: 60, m: 1 } as const

/** `75` → `"1h 15m"`, `4320` → `"3d"`. */
export function formatDuration(minutes: number): string {
  const parts: string[] = []
  let rest = minutes
  for (const [unit, size] of Object.entries(UNITS)) {
    const count = Math.floor(rest / size)
    if (count > 0) parts.push(`${count}${unit}`)
    rest -= count * size
  }
  return parts.length === 0 ? "0m" : parts.join(" ")
}

/**
 * `"1h 15m"`, `"90m"`, `"2d4h"`, or a bare number of minutes. `null` for
 * anything else, or for zero — no target is zero.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase()
  if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) : null
  if (!/^(\s*\d+\s*[dhm])+\s*$/.test(text)) return null
  let total = 0
  for (const match of text.matchAll(/(\d+)\s*([dhm])/g)) {
    const unit = match[2] as keyof typeof UNITS
    total += Number(match[1]) * UNITS[unit]
  }
  return total > 0 ? total : null
}

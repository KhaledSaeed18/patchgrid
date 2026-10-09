/**
 * The quiet panel beside the sign-in forms: a board of ticket-sized cells, a
 * few of them open, most resolved — the product's name taken literally. Purely
 * decorative and deterministic, so it renders the same on the server and the
 * client and is hidden from assistive technology.
 */
const COLUMNS = 24
const ROWS = 30

/** A fixed pseudo-random value per cell (mulberry32): the same board on every render, no visible pattern. */
function noise(index: number): number {
  let t = (index + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function toneOf(index: number): string {
  const n = noise(index)
  if (n < 0.025) return "bg-primary"
  if (n < 0.07) return "bg-primary/30"
  if (n < 0.62) return "bg-foreground/[0.07]"
  return "bg-transparent"
}

export function PatchGrid() {
  return (
    <div aria-hidden className="flex h-full items-center">
      <div
        className="grid w-full gap-1"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: COLUMNS * ROWS }, (_, i) => (
          <span
            key={i}
            className={`aspect-square rounded-[2px] ${toneOf(i)}`}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Which tenants get their own metric series (ADR-0030: "a tenant beyond the
 * top-N by volume is bucketed as `other`"). `org.id` is free on a span and a
 * time series on a metric; a thousand tenants with a hundred routes each is
 * what takes Prometheus down. Volume is counted here, in memory, per process:
 * cheap, approximate, and reset on restart — which is fine for a label.
 */
export class TenantLabels {
  private readonly counts = new Map<string, number>()

  constructor(
    private readonly top: number,
    /** Forget the counts once this many observations have been made, so a tenant that went quiet makes room. */
    private readonly window = 100_000,
  ) {}

  /** The label value for this request's tenant: its id while it is among the busiest, `other` otherwise, `none` without a tenant. */
  labelFor(orgId: string | null | undefined): string {
    if (orgId === undefined || orgId === null) return "none"
    // Ranked on the count before this observation: the tenant being asked about
    // must not leap ahead of equal-volume peers just by being asked.
    const mine = this.counts.get(orgId) ?? 0
    this.observe(orgId)
    return this.isTop(orgId, mine) ? orgId : "other"
  }

  private observe(orgId: string): void {
    this.counts.set(orgId, (this.counts.get(orgId) ?? 0) + 1)
    let total = 0
    for (const n of this.counts.values()) total += n
    if (total >= this.window) {
      // Halve rather than clear: the busy stay recognisable across the boundary.
      for (const [id, n] of this.counts) {
        const half = Math.floor(n / 2)
        if (half === 0) this.counts.delete(id)
        else this.counts.set(id, half)
      }
    }
  }

  /** Rank by count, ties by id, so the same tenants always answer whichever one asks. */
  private isTop(orgId: string, mine: number): boolean {
    let ahead = 0
    for (const [id, n] of this.counts) {
      if (id === orgId) continue
      if (n > mine || (n === mine && id < orgId)) ahead += 1
      if (ahead >= this.top) return false
    }
    return true
  }
}

import { describe, expect, it } from "vitest"

import { TenantLabels } from "./tenant-labels"

describe("TenantLabels", () => {
  it("names the busiest tenants and buckets the rest as other; no tenant is none", () => {
    const labels = new TenantLabels(2)
    for (let i = 0; i < 10; i += 1) labels.labelFor("o-busy")
    for (let i = 0; i < 5; i += 1) labels.labelFor("o-second")
    expect(labels.labelFor("o-busy")).toBe("o-busy")
    expect(labels.labelFor("o-second")).toBe("o-second")
    // A third tenant with one observation is behind two busier ones: bucketed.
    expect(labels.labelFor("o-quiet")).toBe("other")
    expect(labels.labelFor(null)).toBe("none")
    expect(labels.labelFor(undefined)).toBe("none")
  })

  it("lets a tenant that becomes busy earn its own series, and one that goes quiet lose it", () => {
    const labels = new TenantLabels(1, 40)
    for (let i = 0; i < 10; i += 1) labels.labelFor("o-a")
    expect(labels.labelFor("o-b")).toBe("other")
    for (let i = 0; i < 30; i += 1) labels.labelFor("o-b")
    // Past the window the counts halve: a's 10 becomes 5, b's 31 becomes 15 — b leads.
    expect(labels.labelFor("o-b")).toBe("o-b")
    expect(labels.labelFor("o-a")).toBe("other")
  })

  it("names at most top tenants at any one time, however many there are", () => {
    const labels = new TenantLabels(3)
    for (let i = 0; i < 500; i += 1) labels.labelFor(`o-${String(i % 50)}`)
    // Once the counts have settled, one pass over every tenant yields the top three and `other`.
    const seen = new Set<string>()
    for (let i = 0; i < 50; i += 1) seen.add(labels.labelFor(`o-${String(i)}`))
    expect(seen.size).toBeLessThanOrEqual(3 + 1)
    expect(seen.has("other")).toBe(true)
  })
})

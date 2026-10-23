import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import type { OrgExportRepository } from "../../exports/repositories/org-export.repository"
import type { PrismaService } from "../../prisma/prisma.service"
import type { StorageService } from "../../storage/storage.service"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import type { EventConsumers } from "../../events/consumer"
import type { RetentionRepository } from "./repositories/retention.repository"
import { RetentionSweepService } from "./retention-sweep"

const NOW = new Date("2026-10-15T12:00:00Z")

function harness(plan: "FREE" | "PRO" | null = "PRO", auditBatches: number[] = [0]) {
  const steps: string[] = []
  const batches = [...auditBatches]
  const retention = {
    plan: vi.fn(async () => plan),
    deleteAuditBefore: vi.fn(async () => (steps.push("audit"), batches.shift() ?? 0)),
    deleteNotificationsBefore: vi.fn(async () => 3),
    deleteFinishedDeliveriesBefore: vi.fn(async () => (steps.push("deliveries"), 2)),
    deleteConsumedEventsBefore: vi.fn(async () => (steps.push("events"), 7)),
  }
  const exportsRepo = {
    lapsed: vi.fn(async () => [{ id: "x-1", storageKey: "org/o-1/exports/x-1.zip" }]),
    expire: vi.fn(async () => void steps.push("expire")),
  }
  const storage = { remove: vi.fn(async () => void steps.push("remove")) }
  const service = new RetentionSweepService(
    retention as unknown as RetentionRepository,
    exportsRepo as unknown as OrgExportRepository,
    storage as unknown as StorageService,
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    { names: () => ["notify", "webhooks"] } as unknown as EventConsumers,
    new FixedClock(NOW),
  )
  return { service, retention, steps }
}

describe("RetentionSweepService", () => {
  it("drops notifications past 90 days, and a lapsed export's object before its row says so", async () => {
    const { service, retention, steps } = harness()
    expect(await service.sweep()).toEqual({ notifications: 3, exports: 1, deliveries: 2, events: 7, audit: 0 })
    expect(retention.deleteNotificationsBefore).toHaveBeenCalledWith("o-1", new Date("2026-07-17T12:00:00Z"))
    // Deliveries before events: an event a delivery points at is never deleted.
    expect(steps).toEqual(["remove", "expire", "deliveries", "events"])
    expect(retention.deleteConsumedEventsBefore).toHaveBeenCalledWith(
      "o-1",
      new Date("2026-09-15T12:00:00Z"),
      ["notify", "webhooks"],
      5_000,
    )
  })

  it("leaves a PRO workspace's audit log to the partition archival's seven years", async () => {
    const { service, retention } = harness("PRO")
    await service.sweep()
    expect(retention.deleteAuditBefore).not.toHaveBeenCalled()
  })

  it("trims a FREE workspace's audit log past two years, a batch at a time until one comes back short", async () => {
    const { service, retention } = harness("FREE", [5_000, 5_000, 12])
    expect((await service.sweep()).audit).toBe(10_012)
    expect(retention.deleteAuditBefore).toHaveBeenCalledTimes(3)
    expect(retention.deleteAuditBefore).toHaveBeenCalledWith("o-1", new Date("2024-10-15T12:00:00Z"), 5_000)
  })
})

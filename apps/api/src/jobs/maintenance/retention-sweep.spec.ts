import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import type { OrgExportRepository } from "../../exports/repositories/org-export.repository"
import type { PrismaService } from "../../prisma/prisma.service"
import type { StorageService } from "../../storage/storage.service"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import type { RetentionRepository } from "./repositories/retention.repository"
import { RetentionSweepService } from "./retention-sweep"

const NOW = new Date("2026-10-15T12:00:00Z")

describe("RetentionSweepService", () => {
  it("drops notifications past 90 days, and a lapsed export's object before its row says so", async () => {
    const steps: string[] = []
    const retention = { deleteNotificationsBefore: vi.fn(async () => 3) }
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
      new FixedClock(NOW),
    )
    expect(await service.sweep()).toEqual({ notifications: 3, exports: 1 })
    expect(retention.deleteNotificationsBefore).toHaveBeenCalledWith("o-1", new Date("2026-07-17T12:00:00Z"))
    expect(steps).toEqual(["remove", "expire"])
  })
})

import { Logger } from "@nestjs/common"
import type { Queue } from "bullmq"
import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../common/clock/clock"
import type { AppConfig } from "../config/app-config"
import { AuditPartitionService, nextMonth } from "./audit-partitions"
import type { AuditLogRepository } from "./repositories/audit-log.repository"

function harness(mode: AppConfig["WORKER_MODE"], archived: string[] = []) {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
  const repository = {
    ensurePartition: vi.fn(async (at: Date) => `AuditLog_${String(at.getUTCFullYear())}_${String(at.getUTCMonth() + 1).padStart(2, "0")}`),
    archiveExpiredPartitions: vi.fn(async () => archived),
  }
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) }
  const service = new AuditPartitionService(
    repository as unknown as AuditLogRepository,
    new FixedClock(new Date("2026-12-31T23:30:00Z")),
    { WORKER_MODE: mode } as AppConfig,
    queue as unknown as Queue,
  )
  return { service, repository, queue }
}

describe("AuditPartitionService", () => {
  it("counts months by the calendar", () => {
    expect(nextMonth(new Date("2026-01-31T12:00:00Z"))).toEqual(new Date("2026-02-01T00:00:00Z"))
    expect(nextMonth(new Date("2026-12-31T23:30:00Z"))).toEqual(new Date("2027-01-01T00:00:00Z"))
  })

  it("ensures this month and the next at boot, and schedules the daily run only where workers run", async () => {
    const worker = harness("worker")
    await worker.service.onApplicationBootstrap()
    expect(worker.repository.ensurePartition).toHaveBeenCalledTimes(2)
    expect(worker.queue.upsertJobScheduler).toHaveBeenCalledWith("daily", { pattern: "17 3 * * *", tz: "UTC" }, { data: { orgId: null } })
    const api = harness("api")
    await api.service.onApplicationBootstrap()
    expect(api.repository.ensurePartition).toHaveBeenCalledTimes(2)
    expect(api.queue.upsertJobScheduler).not.toHaveBeenCalled()
  })

  it("daily, keeps a month ahead and archives what retention has passed", async () => {
    const h = harness("all", ["AuditLog_2019_09"])
    expect(await h.service.maintain()).toEqual({ ensured: ["AuditLog_2026_12", "AuditLog_2027_01"], archived: ["AuditLog_2019_09"] })
  })
})

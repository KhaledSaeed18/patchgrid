import { Logger } from "@nestjs/common"
import type { Queue } from "bullmq"
import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import type { AppConfig } from "../../config/app-config"
import type { DispatchRepository } from "./repositories/dispatch.repository"
import { TenantDispatchService } from "./tenant-dispatch"

const A = "0190b2f0-0000-7000-8000-00000000000a"
const B = "0190b2f0-0000-7000-8000-00000000000b"

function harness(mode: AppConfig["WORKER_MODE"] = "all") {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
  const queue = () => ({ addBulk: vi.fn(async () => []), upsertJobScheduler: vi.fn(async () => undefined) })
  const dispatch = queue()
  const slaScan = queue()
  const autoClose = queue()
  const service = new TenantDispatchService(
    { listDispatchable: async () => [{ id: A, plan: "FREE" }, { id: B, plan: "PRO" }] } as unknown as DispatchRepository,
    new FixedClock(new Date(3_600_000)),
    { WORKER_MODE: mode } as AppConfig,
    dispatch as unknown as Queue,
    slaScan as unknown as Queue,
    autoClose as unknown as Queue,
  )
  return { service, dispatch, slaScan, autoClose }
}

describe("TenantDispatchService", () => {
  it("fans a sweep out as one job per tenant, on the sweep's queue, idempotent per tick", async () => {
    const h = harness()
    expect(await h.service.fanOut("sla-scan")).toEqual([A, B])
    expect(h.autoClose.addBulk).not.toHaveBeenCalled()
    expect(h.slaScan.addBulk).toHaveBeenCalledWith([
      { name: "sla-scan", data: { orgId: A, tick: 60 }, opts: { jobId: `sla-scan/${A}/60/tick`, priority: 2 } },
      { name: "sla-scan", data: { orgId: B, tick: 60 }, opts: { jobId: `sla-scan/${B}/60/tick`, priority: 1 } },
    ])
  })

  it("schedules every sweep in a worker process, and none in an api-only one", async () => {
    const worker = harness("worker")
    await worker.service.onApplicationBootstrap()
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("sla-scan", { every: 60_000 }, { data: { orgId: null, sweep: "sla-scan" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("auto-close", { every: 900_000 }, { data: { orgId: null, sweep: "auto-close" } })
    const api = harness("api")
    await api.service.onApplicationBootstrap()
    expect(api.dispatch.upsertJobScheduler).not.toHaveBeenCalled()
  })
})

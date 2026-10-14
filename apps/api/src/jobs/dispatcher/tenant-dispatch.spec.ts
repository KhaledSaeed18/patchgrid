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
  const attachmentSweep = queue()
  const inboundSweep = queue()
  const supportSweep = queue()
  const apiTokenSweep = queue()
  const orgPurge = queue()
  const retentionSweep = queue()
  const projectionReconcile = queue()
  const service = new TenantDispatchService(
    {
      listDispatchable: async () => [{ id: A, plan: "FREE" }, { id: B, plan: "PRO" }],
      listDueForPurge: vi.fn(async () => [{ id: B, plan: "PRO" }]),
    } as unknown as DispatchRepository,
    new FixedClock(new Date(3_600_000)),
    { WORKER_MODE: mode } as AppConfig,
    dispatch as unknown as Queue,
    slaScan as unknown as Queue,
    autoClose as unknown as Queue,
    attachmentSweep as unknown as Queue,
    inboundSweep as unknown as Queue,
    supportSweep as unknown as Queue,
    apiTokenSweep as unknown as Queue,
    orgPurge as unknown as Queue,
    retentionSweep as unknown as Queue,
    projectionReconcile as unknown as Queue,
  )
  return { service, dispatch, slaScan, autoClose, projectionReconcile, orgPurge }
}

describe("TenantDispatchService", () => {
  it("purges only the workspaces past their window and its grace, never an active one (ADR-0043)", async () => {
    const h = harness()
    expect(await h.service.fanOut("org-purge")).toEqual([B])
    expect(h.slaScan.addBulk).not.toHaveBeenCalled()
    expect(h.orgPurge.addBulk).toHaveBeenCalledWith([expect.objectContaining({ data: { orgId: B, tick: 0 } })])
  })

  it("fans a sweep out as one job per tenant, on the sweep's queue, idempotent per tick", async () => {
    const h = harness()
    expect(await h.service.fanOut("sla-scan")).toEqual([A, B])
    expect(h.autoClose.addBulk).not.toHaveBeenCalled()
    expect(h.projectionReconcile.addBulk).not.toHaveBeenCalled()
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
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("attachment-sweep", { every: 3_600_000 }, { data: { orgId: null, sweep: "attachment-sweep" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("inbound-sweep", { every: 3_600_000 }, { data: { orgId: null, sweep: "inbound-sweep" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("support-sweep", { every: 300_000 }, { data: { orgId: null, sweep: "support-sweep" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("api-token-sweep", { every: 3_600_000 }, { data: { orgId: null, sweep: "api-token-sweep" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("org-purge", { every: 86_400_000 }, { data: { orgId: null, sweep: "org-purge" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("retention-sweep", { every: 86_400_000 }, { data: { orgId: null, sweep: "retention-sweep" } })
    expect(worker.dispatch.upsertJobScheduler).toHaveBeenCalledWith("projection-reconcile", { every: 86_400_000 }, { data: { orgId: null, sweep: "projection-reconcile" } })
    const api = harness("api")
    await api.service.onApplicationBootstrap()
    expect(api.dispatch.upsertJobScheduler).not.toHaveBeenCalled()
  })
})

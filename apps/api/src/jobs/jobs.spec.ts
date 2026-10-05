import { ClsServiceManager } from "nestjs-cls"
import { describe, expect, it, vi } from "vitest"
import { Logger } from "@nestjs/common"

import type { RequestContextStore } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { jobId } from "./job-id"
import { runJob } from "./dispatcher/run-job"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const context = new TenantContextService(ClsServiceManager.getClsService<RequestContextStore>())

describe("jobId", () => {
  it("is queue/org/entity/discriminator, with platform where an org would be", () => {
    expect(jobId("mail", ORG, "inv-1", "invite")).toBe(`mail/${ORG}/inv-1/invite`)
    expect(jobId("mail", null, "usr-1", "verify-email")).toBe("mail/platform/usr-1/verify-email")
  })

  it("refuses parts that would make the id ambiguous or that BullMQ reserves", () => {
    expect(() => jobId("mail", ORG, "a/b", "x")).toThrow(/reserved/)
    expect(() => jobId("mail", ORG, "a:b", "x")).toThrow(/reserved/)
    expect(() => jobId("mail", ORG, "", "x")).toThrow(/empty/)
  })
})

describe("runJob", () => {
  it("runs a tenant payload inside that tenant and a platform payload in none", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
    expect(await runJob({ orgId: ORG }, "job:test", "spec", async () => context.current()?.orgId)).toBe(ORG)
    expect(await runJob({ orgId: null }, "job:test", "spec", async () => context.current())).toBeUndefined()
  })
})

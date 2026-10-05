import { ClsServiceManager } from "nestjs-cls"
import { describe, expect, it } from "vitest"

import { type RequestContextStore, TenantContextMissingError } from "./request-context"
import { TenantContextService } from "./tenant-context.service"

const cls = ClsServiceManager.getClsService<RequestContextStore>()
const service = new TenantContextService(cls)
const ORG = "0190b2f0-0000-7000-8000-000000000001"

describe("TenantContextService", () => {
  it("reports no tenant outside any context", () => {
    expect(service.current()).toBeUndefined()
    expect(service.requestId()).toBeUndefined()
  })

  it("reports no tenant inside a context that has not resolved one", () => {
    cls.run(() => {
      expect(service.current()).toBeUndefined()
    })
  })

  it("returns the tenant the context holds", () => {
    cls.runWith({ tenant: { orgId: ORG, inTransaction: false } }, () => {
      expect(service.current()).toEqual({ orgId: ORG, inTransaction: false })
      expect(service.requireOrgId()).toBe(ORG)
    })
  })

  it("throws a programming error, not a request error, when a tenant is required", () => {
    expect(() => service.requireOrgId("listing teams")).toThrow(TenantContextMissingError)
    expect(() => service.requireOrgId("listing teams")).toThrow(/listing teams/)
  })

  it("does not let a nested context leak its tenant back out", async () => {
    await cls.run(async () => {
      await cls.run({ ifNested: "inherit" }, async () => {
        cls.set("tenant", { orgId: ORG, inTransaction: false })
        expect(service.current()?.orgId).toBe(ORG)
      })
      expect(service.current()).toBeUndefined()
    })
  })
})

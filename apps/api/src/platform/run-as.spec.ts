import { Logger } from "@nestjs/common"
import { ClsServiceManager } from "nestjs-cls"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RequestContextStore } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { runAsPlatform } from "./run-as-platform"
import { runAsTenant } from "./run-as-tenant"

const cls = ClsServiceManager.getClsService<RequestContextStore>()
const context = new TenantContextService(cls)
const ACME = "0190b2f0-0000-7000-8000-00000000000a"
const GLOBEX = "0190b2f0-0000-7000-8000-00000000000b"
const crossing = { actor: "test", reason: "spec" }

let logged: unknown[]
beforeEach(() => {
  logged = []
  vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
    logged.push(message)
  })
})
afterEach(() => vi.restoreAllMocks())

describe("runAsTenant", () => {
  it("establishes the tenant for the awaited callback, from no context", async () => {
    const seen = await runAsTenant(ACME, crossing, async () => context.current())
    expect(seen).toEqual({ orgId: ACME, inTransaction: false })
    expect(context.current()).toBeUndefined()
  })

  it("replaces the request's tenant and restores it afterwards", async () => {
    await cls.runWith({ tenant: { orgId: ACME, inTransaction: false } }, async () => {
      const inner = await runAsTenant(GLOBEX, crossing, async () => context.requireOrgId())
      expect(inner).toBe(GLOBEX)
      expect(context.requireOrgId()).toBe(ACME)
    })
  })

  it("hides the caller's open transaction and the inTransaction flag", async () => {
    const acmeTx = { orgId: ACME, client: {} as never }
    await cls.runWith(
      { tenant: { orgId: ACME, inTransaction: true }, prismaTransaction: acmeTx },
      async () => {
        await runAsTenant(GLOBEX, crossing, async () => {
          expect(cls.get("prismaTransaction")).toBeUndefined()
          expect(context.current()).toEqual({ orgId: GLOBEX, inTransaction: false })
        })
        expect(cls.get("prismaTransaction")).toBe(acmeTx)
        expect(context.current()?.inTransaction).toBe(true)
      },
    )
  })

  it("refuses an orgId that is not a UUID before touching anything", async () => {
    const fn = vi.fn(async () => undefined)
    await expect(runAsTenant("acme", crossing, fn)).rejects.toThrow(/not a UUID/)
    expect(fn).not.toHaveBeenCalled()
  })

  it("logs who crossed, to where, from where, and why", async () => {
    await cls.runWith({ tenant: { orgId: ACME, inTransaction: false } }, async () => {
      await runAsTenant(GLOBEX, { actor: "job:sla-scan", reason: "nightly" }, async () => undefined)
    })
    expect(logged).toContainEqual({
      msg: "runAsTenant",
      orgId: GLOBEX,
      from: ACME,
      actor: "job:sla-scan",
      reason: "nightly",
    })
  })

  it("does not cover a promise awaited after the callback returned", async () => {
    // The hazard ENGINEERING.md names: `fn` must await inside. A lazy promise
    // created inside and awaited outside runs with the OUTER context.
    let later: () => string | undefined = () => "unset"
    await runAsTenant(ACME, crossing, async () => {
      later = () => context.current()?.orgId
    })
    expect(later()).toBeUndefined()
  })
})

describe("runAsPlatform", () => {
  it("removes the tenant for the callback and restores it afterwards", async () => {
    await cls.runWith({ tenant: { orgId: ACME, inTransaction: false } }, async () => {
      const inner = await runAsPlatform(crossing, async () => context.current())
      expect(inner).toBeUndefined()
      expect(context.requireOrgId()).toBe(ACME)
    })
  })

  it("hides the caller's open transaction", async () => {
    const acmeTx = { orgId: ACME, client: {} as never }
    await cls.runWith(
      { tenant: { orgId: ACME, inTransaction: true }, prismaTransaction: acmeTx },
      async () => {
        await runAsPlatform(crossing, async () => {
          expect(cls.get("prismaTransaction")).toBeUndefined()
        })
        expect(cls.get("prismaTransaction")).toBe(acmeTx)
      },
    )
  })

  it("logs the crossing", async () => {
    await runAsPlatform({ actor: "job:dispatcher", reason: "fan out" }, async () => undefined)
    expect(logged).toContainEqual({
      msg: "runAsPlatform",
      from: "none",
      actor: "job:dispatcher",
      reason: "fan out",
    })
  })
})

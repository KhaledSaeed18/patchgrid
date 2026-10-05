import type { TenantTransactionClient } from "@patchgrid/database"
import { ClsServiceManager } from "nestjs-cls"
import { describe, expect, it } from "vitest"

import type { AppConfig } from "../config/app-config"
import type { RequestContextStore } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { PrismaService } from "./prisma.service"

const cls = ClsServiceManager.getClsService<RequestContextStore>()
const ACME = "0190b2f0-0000-7000-8000-00000000000a"
const GLOBEX = "0190b2f0-0000-7000-8000-00000000000b"

// Nothing connects: the adapter opens its pool lazily, and `$extends` is pure.
const config = {
  DATABASE_URL: "postgresql://patchgrid_app:app@localhost:5432/patchgrid",
  DATABASE_POOL_MAX: 1,
} as AppConfig

const service = new PrismaService(config, cls, new TenantContextService(cls))
const acmeTx = { tag: "acme-tx" } as unknown as TenantTransactionClient

describe("PrismaService.db", () => {
  it("is the tenant-isolated client outside any context", () => {
    expect(service.db).not.toBe(acmeTx)
    expect(typeof service.db.$queryRaw).toBe("function")
  })

  it("is the open transaction when it was opened for the current tenant", () => {
    cls.runWith(
      {
        tenant: { orgId: ACME, inTransaction: true },
        prismaTransaction: { orgId: ACME, client: acmeTx },
      },
      () => expect(service.db).toBe(acmeTx),
    )
  })

  it("never hands another tenant's open transaction to the current one", () => {
    // What a runAsTenant(globex) inside an acme transaction would look like if
    // the helper forgot to clear the slot. The getter does not rely on it.
    cls.runWith(
      {
        tenant: { orgId: GLOBEX, inTransaction: false },
        prismaTransaction: { orgId: ACME, client: acmeTx },
      },
      () => expect(service.db).not.toBe(acmeTx),
    )
  })

  it("never hands a tenant transaction to platform-scope code, or vice versa", () => {
    cls.runWith({ prismaTransaction: { orgId: ACME, client: acmeTx } }, () =>
      expect(service.db).not.toBe(acmeTx),
    )
    cls.runWith(
      {
        tenant: { orgId: ACME, inTransaction: false },
        prismaTransaction: { orgId: null, client: acmeTx },
      },
      () => expect(service.db).not.toBe(acmeTx),
    )
  })
})

import { API_TOKEN_PATTERN } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor, TenantActor } from "../auth/actor"
import type { PasswordService } from "../auth/passwords/password.service"
import type { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem } from "../common/problems/problem.exception"
import type { ApiTokenIndexRepository } from "../platform/repositories/api-token-index.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { ApiTokensService } from "./api-tokens.service"
import type { ApiTokenRepository, ApiTokenRow } from "./repositories/api-token.repository"

const ORG = "o-1"
const NOW = new Date("2026-10-15T12:00:00Z")

function harness(role: MemberActor["role"] = "ADMIN", found: Partial<ApiTokenRow> | null = {}) {
  const actor: TenantActor = {
    kind: "member",
    userId: "u",
    orgId: ORG,
    membershipId: "m-admin",
    role,
    teamIds: [],
    leadOfTeamIds: [],
  }
  const steps: string[] = []
  const row = (): ApiTokenRow => ({
    id: "tok-1",
    name: "Monitoring",
    prefix: "abcdefabcdef",
    scopes: ["tickets:write"],
    membershipId: "m-svc",
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    membership: { role: "AGENT", status: "ACTIVE" },
    createdBy: { id: "m-admin", displayName: "Alice" },
    ...found,
  })
  const tokens = {
    create: vi.fn(async () => {
      steps.push("token")
      return "tok-1"
    }),
    find: vi.fn(async () => (found === null ? null : row())),
    list: vi.fn(async () => [row()]),
    revoke: vi.fn(async () => {
      steps.push("revoke")
      return found?.revokedAt == null
    }),
  }
  const index = {
    create: vi.fn(async () => void steps.push("index")),
    revoke: vi.fn(async () => void steps.push("index-revoke")),
  }
  const lookup = {
    invalidateToken: vi.fn(async () => void steps.push("invalidate")),
  }
  const audit = { record: vi.fn(async () => void steps.push("audit")) }
  const prisma = {
    transaction: async (fn: () => Promise<unknown>) => {
      steps.push("begin")
      const result = await fn()
      steps.push("commit")
      return result
    },
  }
  const service = new ApiTokensService(
    tokens as unknown as ApiTokenRepository,
    index as unknown as ApiTokenIndexRepository,
    lookup as unknown as OrganizationLookupService,
    {
      hash: vi.fn(async (secret: string) => `hashed:${secret.length}`),
    } as unknown as PasswordService,
    audit as unknown as AuditService,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    prisma as unknown as PrismaService,
    new FixedClock(NOW),
  )
  return { service, tokens, index, lookup, audit, steps }
}

const request = {
  name: "Monitoring",
  role: "AGENT" as const,
  scopes: ["tickets:write" as const],
  expiresInDays: 30 as const,
}

describe("ApiTokensService", () => {
  it("creates the service account, its index row and its audit row in one transaction, and shows the secret once", async () => {
    const h = harness()
    const created = await h.service.create(request)
    expect(h.steps).toEqual(["begin", "token", "index", "audit", "commit"])
    expect(created.secret).toMatch(API_TOKEN_PATTERN)
    const [, prefix] = API_TOKEN_PATTERN.exec(created.secret) ?? []
    expect(h.tokens.create).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        prefix,
        tokenHash: "hashed:43",
        role: "AGENT",
        createdByMembershipId: "m-admin",
        expiresAt: new Date("2026-11-14T12:00:00Z"),
      }),
      NOW,
    )
    // The audit row names the token; it never holds the secret.
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain(created.secret.split("_")[2])
  })

  it("lets only admins and owners hold tokens", async () => {
    await expect(harness("AGENT").service.create(request)).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("AGENT").service.list()).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("AGENT").service.revoke("tok-1")).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("revokes once, mirrors it into the index, and drops the cached prefix after commit", async () => {
    const h = harness()
    await h.service.revoke("tok-1")
    expect(h.steps).toEqual(["begin", "revoke", "index-revoke", "audit", "commit", "invalidate"])
    expect(h.lookup.invalidateToken).toHaveBeenCalledWith("abcdefabcdef")
    await expect(harness("ADMIN", { revokedAt: NOW }).service.revoke("tok-1")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness("ADMIN", null).service.revoke("tok-1")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

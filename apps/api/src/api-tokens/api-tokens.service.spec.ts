import { API_TOKEN_PATTERN } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor, TenantActor } from "../auth/actor"
import { StepUpService } from "../auth/mfa/step-up.service"
import type { PasswordService } from "../auth/passwords/password.service"
import type { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, StepUpRequiredProblem } from "../common/problems/problem.exception"
import type { ApiTokenIndexRepository } from "../platform/repositories/api-token-index.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { ApiTokensService } from "./api-tokens.service"
import type { ApiTokenRepository, ApiTokenRow } from "./repositories/api-token.repository"

const ORG = "o-1"
const NOW = new Date("2026-10-15T12:00:00Z")

function harness(role: MemberActor["role"] = "ADMIN", found: Partial<ApiTokenRow> | null = {}, options: { stepUpAt?: number | undefined } = { stepUpAt: Math.floor(NOW.getTime() / 1000) }) {
  const actor: TenantActor = {
    kind: "member",
    userId: "u",
    orgId: ORG,
    membershipId: "m-admin",
    role,
    teamIds: [],
    leadOfTeamIds: [],
    ...(options.stepUpAt === undefined ? {} : { stepUpAt: options.stepUpAt }),
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
    stepUpWith(NOW),
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

/** The real condition, on a fixed clock: the window is what is under test, not a stub of it. */
function stepUpWith(now: Date): StepUpService {
  return new StepUpService({} as never, {} as never, {} as never, new FixedClock(now))
}

describe("ApiTokensService", () => {
  it("creates the service account, its index row and its audit row in one transaction, and shows the secret once", async () => {
    const h = harness()
    const created = await h.service.create(request)
    expect(h.steps).toEqual(["begin", "token", "index", "audit", "commit"])
    expect(created.secret).toMatch(API_TOKEN_PATTERN)
    const [, prefix, secret] = API_TOKEN_PATTERN.exec(created.secret) ?? []
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
    // The audit row names the token; it never holds the secret. The secret is
    // base64url, so it may itself contain "_": take it from the pattern, not a split.
    expect(secret).toHaveLength(43)
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain(secret)
  })

  it("asks for a fresh proof before minting: none, or one older than five minutes, is a step-up refusal before any write (ADR-0029)", async () => {
    const stale = harness("ADMIN", {}, { stepUpAt: Math.floor(NOW.getTime() / 1000) - 301 })
    await expect(stale.service.create(request)).rejects.toBeInstanceOf(StepUpRequiredProblem)
    const never = harness("ADMIN", {}, { stepUpAt: undefined })
    await expect(never.service.create(request)).rejects.toBeInstanceOf(StepUpRequiredProblem)
    expect(never.steps).toEqual([])
    // Listing and revoking are not irreversible in the same way; they stay a permission check.
    expect(await never.service.list()).toHaveLength(1)
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

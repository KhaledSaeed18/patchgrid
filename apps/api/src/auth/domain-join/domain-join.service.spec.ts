import { describe, expect, it, vi } from "vitest"

import type { AuditService } from "../../audit/audit.service"
import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, PlanLimitProblem } from "../../common/problems/problem.exception"
import type { MembershipRepository } from "../../memberships/repositories/membership.repository"
import type { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { PrismaService } from "../../prisma/prisma.service"
import type { QuotaService } from "../../quota/quota.service"
import type { OrgDomainRecord, OrgDomainRepository } from "../../sso/repositories/org-domain.repository"
import { DomainJoinService } from "./domain-join.service"

vi.mock("../../platform/run-as-tenant", () => ({ runAsTenant: (_o: string, _c: unknown, fn: () => Promise<unknown>) => fn() }))

const NOW = new Date("2026-10-23T12:00:00Z")

type Options = {
  org?: Partial<OrgDomainRecord> | null
  account?: Partial<AccountRecord>
  known?: string[]
  member?: boolean
  seatFull?: boolean
  /** The id of an external requester writing from the account's address. */
  external?: string
}

function harness(options: Options = {}) {
  const org: OrgDomainRecord | null =
    options.org === null
      ? null
      : {
          id: "o-1",
          slug: "acme",
          name: "Acme",
          status: "ACTIVE",
          domain: "acme.test",
          domainVerifiedAt: NOW,
          domainChallenge: null,
          requireSso: false,
          allowDomainJoin: true,
          defaultJoinRole: "REQUESTER",
          ...options.org,
        }
  const account = {
    id: "u-1",
    email: "kim@acme.test",
    name: "Kim",
    passwordHash: "h",
    emailVerifiedAt: NOW,
    anonymisedAt: null,
    ...options.account,
  } as AccountRecord
  const created: unknown[] = []
  const memberships = {
    lockOrganization: vi.fn(async () => undefined),
    findByUser: vi.fn(async () => (options.member === true ? { id: "m-old" } : null)),
    claimExternal: vi.fn(async () => options.external ?? null),
    create: vi.fn(async (_o: string, data: unknown) => (created.push(data), "m-new")),
  }
  const quota = {
    consume: vi.fn(async () => {
      if (options.seatFull === true) throw new PlanLimitProblem("AGENT_SEATS", "full")
    }),
  }
  const workspaces = { allOrgIdsForUser: vi.fn(async () => options.known ?? []), upsert: vi.fn(async () => undefined) }
  const audit = { record: vi.fn(async () => undefined) }
  const service = new DomainJoinService(
    {
      findByVerifiedDomain: vi.fn(async (d: string) => (org?.domain === d ? org : null)),
      find: vi.fn(async () => org),
    } as unknown as OrgDomainRepository,
    { findById: vi.fn(async () => account) } as unknown as UserRepository,
    memberships as unknown as MembershipRepository,
    workspaces as unknown as UserOrgIndexRepository,
    quota as unknown as QuotaService,
    audit as unknown as AuditService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    new FixedClock(NOW),
  )
  return { service, memberships, quota, workspaces, audit, created }
}

const session = { userId: "u-1", ssoOrgId: null }

describe("DomainJoinService (TENANCY.md §5)", () => {
  it("offers the workspace that proved the address's domain and lets its people in", async () => {
    expect(await harness().service.joinableFor(session)).toEqual({ slug: "acme", name: "Acme", role: "REQUESTER" })
  })

  it("offers nothing when it is off, unproved, SSO-required, not active, or to an SSO session", async () => {
    for (const org of [{ allowDomainJoin: false }, { domainVerifiedAt: null }, { requireSso: true }, { status: "SUSPENDED" }]) {
      expect(await harness({ org }).service.joinableFor(session), JSON.stringify(org)).toBeNull()
    }
    expect(await harness().service.joinableFor({ userId: "u-1", ssoOrgId: "o-1" })).toBeNull()
  })

  it("offers nothing to an address that is not verified, or one ever a member — a removed member stays out", async () => {
    expect(await harness({ account: { emailVerifiedAt: null } }).service.joinableFor(session)).toBeNull()
    expect(await harness({ known: ["o-1"] }).service.joinableFor(session)).toBeNull()
  })

  it("joins at the owner's role, taking a seat for an agent, mirrored and audited", async () => {
    const h = harness({ org: { defaultJoinRole: "AGENT" } })
    expect(await h.service.join(session, "acme")).toEqual({ slug: "acme", role: "AGENT" })
    expect(h.quota.consume).toHaveBeenCalledWith("o-1", "AGENT_SEATS")
    expect(h.created).toEqual([expect.objectContaining({ userId: "u-1", role: "AGENT", invitedByMembershipId: null })])
    expect(h.workspaces.upsert).toHaveBeenCalledWith(expect.objectContaining({ orgId: "o-1", role: "AGENT", status: "ACTIVE" }))
    expect(h.audit.record).toHaveBeenCalledWith(
      "o-1",
      [
        expect.objectContaining({
          action: "MEMBER_JOINED",
          diff: { via: "domain", role: "AGENT", domain: "acme.test", claimedExternal: false },
        }),
      ],
      expect.anything(),
    )
    // A requester holds no seat.
    const requester = harness()
    await requester.service.join(session, "acme")
    expect(requester.quota.consume).not.toHaveBeenCalled()
  })

  it("takes over the external requester writing from the address rather than making a second membership", async () => {
    const h = harness({ external: "m-ext" })
    await h.service.join(session, "acme")
    expect(h.memberships.claimExternal).toHaveBeenCalledWith("o-1", "kim@acme.test", expect.objectContaining({ userId: "u-1" }))
    expect(h.created).toEqual([])
    expect(h.audit.record).toHaveBeenCalledWith(
      "o-1",
      [expect.objectContaining({ entityId: "m-ext", diff: expect.objectContaining({ claimedExternal: true }) })],
      { kind: "member", membershipId: "m-ext" },
    )
  })

  it("answers a workspace it may not join as one that is not there, and refuses an SSO session", async () => {
    await expect(harness().service.join(session, "globex")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(harness({ org: { allowDomainJoin: false } }).service.join(session, "acme")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(harness().service.join({ userId: "u-1", ssoOrgId: "o-1" }, "acme")).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("lets a racing second join find the first's membership, and passes a full plan's 402 through", async () => {
    await expect(harness({ member: true }).service.join(session, "acme")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness({ org: { defaultJoinRole: "AGENT" }, seatFull: true }).service.join(session, "acme")).rejects.toBeInstanceOf(
      PlanLimitProblem,
    )
  })
})

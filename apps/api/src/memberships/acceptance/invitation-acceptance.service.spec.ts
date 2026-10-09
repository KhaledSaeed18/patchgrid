import { Logger } from "@nestjs/common"
import type { MembershipStatus, OrganizationStatus } from "@patchgrid/contracts"
import { ClsServiceManager } from "nestjs-cls"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PasswordService } from "../../auth/passwords/password.service"
import { hash, type SessionService } from "../../auth/sessions/session.service"
import type { AuditActorOverride, AuditEntry, AuditService } from "../../audit/audit.service"
import { FixedClock } from "../../common/clock/clock"
import {
  ConflictProblem,
  NotFoundProblem,
  OrganizationSuspendedProblem,
} from "../../common/problems/problem.exception"
import type { OrganizationRepository } from "../../platform/repositories/organization.repository"
import type { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { PrismaService } from "../../prisma/prisma.service"
import type { RequestContextStore } from "../../tenancy/request-context"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import type { TeamRepository } from "../../teams/repositories/team.repository"
import { newInvitationToken } from "../invitations/invitation-token"
import type { InvitationRecord, InvitationRepository } from "../repositories/invitation.repository"
import type { MembershipRecord, MembershipRepository } from "../repositories/membership.repository"
import { InvitationAcceptanceService } from "./invitation-acceptance.service"

const ORG = "01929f5e-7a2b-7c3d-8e4f-a1b2c3d4e5f6"
const NOW = new Date("2026-10-09T12:00:00Z")
const client = { userAgent: "vitest", ip: "127.0.0.1" }
const context = new TenantContextService(ClsServiceManager.getClsService<RequestContextStore>())

const alice: AccountRecord = {
  id: "u-alice",
  email: "alice@acme.test",
  name: "Alice",
  passwordHash: "h",
  emailVerifiedAt: NOW,
  anonymisedAt: null,
}

type Options = {
  orgStatus?: OrganizationStatus
  invitation?: Partial<InvitationRecord>
  existing?: MembershipStatus
  accounts?: AccountRecord[]
  teamActive?: boolean
  consumes?: boolean
}

function harness(options: Options = {}) {
  const { token, secret } = newInvitationToken(ORG)
  const invitation: InvitationRecord = {
    id: "inv-1",
    orgId: ORG,
    email: "alice@acme.test",
    role: "AGENT",
    teamId: "t-1",
    invitedByMembershipId: "m-admin",
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    acceptedAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...options.invitation,
  }
  const accounts = [...(options.accounts ?? [alice])]
  const audit: { entries: AuditEntry[]; actor: AuditActorOverride | undefined }[] = []
  const tenantsSeen: (string | undefined)[] = []

  const invitations = {
    findByTokenHash: vi.fn(async (orgId: string, tokenHash: string) => {
      tenantsSeen.push(context.current()?.orgId)
      return orgId === ORG && tokenHash === hash(secret) ? invitation : null
    }),
    consume: vi.fn(async () => options.consumes ?? true),
  }
  const memberships = {
    findByUser: vi.fn(async (): Promise<MembershipRecord | null> =>
      options.existing === undefined
        ? null
        : { id: "m-old", orgId: ORG, userId: alice.id, role: "REQUESTER", status: options.existing, kind: "HUMAN", displayName: "Alice", teamIds: [], leadOfTeamIds: [] },
    ),
    create: vi.fn(async () => "m-new"),
    reactivate: vi.fn(async () => undefined),
    joinTeam: vi.fn(async () => undefined),
  }
  const users = {
    findByEmail: vi.fn(async (email: string) => accounts.find((a) => a.email === email) ?? null),
    findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id) ?? null),
    createVerified: vi.fn(async (a: { email: string; name: string; passwordHash: string; verifiedAt: Date }) => {
      const account = { id: "u-new", email: a.email, name: a.name, passwordHash: a.passwordHash, emailVerifiedAt: a.verifiedAt, anonymisedAt: null }
      accounts.push(account)
      return account
    }),
  }
  const workspaces = { upsert: vi.fn(async () => undefined) }
  const sessions = {
    open: vi.fn(async (_u: string, slug: string) => [{ name: `pg_at_${slug}`, value: "t", path: "/", maxAgeSeconds: 1 }]),
    startIdentity: vi.fn(async (_a: AccountRecord, _c: unknown, slug?: string) => ({
      response: {},
      cookies: [{ name: "pg_id", value: "i", path: "/", maxAgeSeconds: 1 }, { name: `pg_at_${slug ?? ""}`, value: "t", path: "/", maxAgeSeconds: 1 }],
    })),
  }
  const service = new InvitationAcceptanceService(
    invitations as unknown as InvitationRepository,
    memberships as unknown as MembershipRepository,
    { findById: async () => ({ id: "t-1", orgId: ORG, name: "Network", isActive: options.teamActive ?? true }) } as unknown as TeamRepository,
    { findProfileById: async (id: string) => (id === ORG ? { id: ORG, name: "Acme", slug: "acme", status: options.orgStatus ?? "ACTIVE" } : null) } as unknown as OrganizationRepository,
    users as unknown as UserRepository,
    workspaces as unknown as UserOrgIndexRepository,
    { hash: async () => "argon2-hash" } as unknown as PasswordService,
    sessions as unknown as SessionService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    { record: async (_o: string, entries: AuditEntry[], actor?: AuditActorOverride) => void audit.push({ entries, actor }) } as unknown as AuditService,
    new FixedClock(NOW),
  )
  return { service, token, secret, memberships, users, workspaces, sessions, audit, invitations, tenantsSeen }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("InvitationAcceptanceService — one answer for every bad token", () => {
  it.each([
    ["malformed", (t: string) => `${t}x`],
    ["another org's id", (t: string) => `1${t}`],
    ["the wrong secret", (t: string) => `${t.slice(0, -4)}AAAA`],
  ])("%s is the generic 404", async (_name, mangle) => {
    const h = harness()
    await expect(h.service.preview(mangle(h.token))).rejects.toThrow(new NotFoundProblem("This invitation is invalid or has expired"))
  })

  it.each([
    ["expired", { expiresAt: NOW }],
    ["accepted", { acceptedAt: NOW }],
    ["revoked", { revokedAt: NOW }],
  ])("an %s invitation is the generic 404", async (_name, invitation) => {
    const h = harness({ invitation })
    await expect(h.service.preview(h.token)).rejects.toThrow("This invitation is invalid or has expired")
  })

  it("a workspace pending deletion is the generic 404; a suspended one says so only for a valid token", async () => {
    await expect(harness({ orgStatus: "PENDING_DELETION" }).service.preview(harness().token)).rejects.toBeInstanceOf(NotFoundProblem)
    const suspended = harness({ orgStatus: "SUSPENDED" })
    await expect(suspended.service.preview(suspended.token)).rejects.toBeInstanceOf(OrganizationSuspendedProblem)
  })

  it("reads the invitation inside the token's tenant", async () => {
    const h = harness()
    await h.service.preview(h.token)
    expect(h.tenantsSeen).toEqual([ORG])
  })
})

describe("InvitationAcceptanceService.preview", () => {
  it("names the workspace and role, and whether the address has an account", async () => {
    const h = harness()
    expect(await h.service.preview(h.token)).toEqual({ organization: { name: "Acme", slug: "acme" }, role: "AGENT", accountExists: true })
    const fresh = harness({ accounts: [] })
    expect((await fresh.service.preview(fresh.token)).accountExists).toBe(false)
  })
})

describe("InvitationAcceptanceService.accept", () => {
  it("joins the signed-in invitee with the team, the picker row, an audit by the joiner, and a session", async () => {
    const h = harness()
    const result = await h.service.accept(alice.id, h.token, client)
    expect(result.response).toEqual({ organization: { id: ORG, name: "Acme", slug: "acme" }, membershipId: "m-new", session: { slug: "acme" } })
    expect(h.memberships.create).toHaveBeenCalledWith(ORG, expect.objectContaining({ userId: alice.id, role: "AGENT", invitedByMembershipId: "m-admin" }))
    expect(h.memberships.joinTeam).toHaveBeenCalledWith(ORG, "m-new", "t-1")
    expect(h.workspaces.upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: alice.id, orgId: ORG, role: "AGENT", status: "ACTIVE" }))
    expect(h.audit[0]).toMatchObject({ entries: [{ action: "MEMBER_JOINED", entityId: "m-new" }], actor: { kind: "member", membershipId: "m-new" } })
    expect(h.sessions.open).toHaveBeenCalledWith(alice.id, "acme", client)
  })

  it("tells a different signed-in account the link was not theirs — and nothing more", async () => {
    const bob = { ...alice, id: "u-bob", email: "bob@acme.test" }
    const h = harness({ accounts: [alice, bob] })
    const failure = h.service.accept(bob.id, h.token, client)
    await expect(failure).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(failure).rejects.toThrow("This invitation was sent to a different address")
    await expect(failure).rejects.not.toThrow("alice")
    expect(h.invitations.consume).not.toHaveBeenCalled()
  })

  it("brings a removed member back as the same row, and refuses a current one", async () => {
    const removed = harness({ existing: "REMOVED" })
    expect((await removed.service.accept(alice.id, removed.token, client)).response.membershipId).toBe("m-old")
    expect(removed.memberships.reactivate).toHaveBeenCalled()
    expect(removed.audit[0]?.entries[0]?.diff).toMatchObject({ rejoined: true })

    for (const status of ["ACTIVE", "DISABLED"] as const) {
      const current = harness({ existing: status })
      await expect(current.service.accept(alice.id, current.token, client)).rejects.toBeInstanceOf(ConflictProblem)
    }
  })

  it("loses cleanly to a concurrent acceptance of the same token", async () => {
    const h = harness({ consumes: false })
    await expect(h.service.accept(alice.id, h.token, client)).rejects.toBeInstanceOf(NotFoundProblem)
    expect(h.memberships.create).not.toHaveBeenCalled()
  })

  it("skips a team deactivated since the invitation was sent", async () => {
    const h = harness({ teamActive: false })
    await h.service.accept(alice.id, h.token, client)
    expect(h.memberships.joinTeam).not.toHaveBeenCalled()
  })
})

describe("InvitationAcceptanceService.acceptNew", () => {
  it("creates the account verified, as the invited address, and signs it in to the workspace", async () => {
    const h = harness({ accounts: [] })
    const result = await h.service.acceptNew(h.token, "Alice", "correct horse battery", client)
    expect(h.users.createVerified).toHaveBeenCalledWith({ email: "alice@acme.test", name: "Alice", passwordHash: "argon2-hash", verifiedAt: NOW })
    expect(result.cookies.map((c) => c.name)).toEqual(["pg_id", "pg_at_acme"])
    expect(result.response.membershipId).toBe("m-new")
  })

  it("sends an existing account to sign in instead", async () => {
    const h = harness()
    await expect(h.service.acceptNew(h.token, "Alice", "correct horse battery", client)).rejects.toBeInstanceOf(ConflictProblem)
    expect(h.users.createVerified).not.toHaveBeenCalled()
  })

  it("creates no account when the invitation cannot be consumed", async () => {
    const h = harness({ accounts: [], consumes: false })
    await expect(h.service.acceptNew(h.token, "Alice", "correct horse battery", client)).rejects.toBeInstanceOf(NotFoundProblem)
    expect(h.users.createVerified).not.toHaveBeenCalled()
  })
})

import { Logger } from "@nestjs/common"
import type { CreateInvitationRequest, MembershipStatus, Role } from "@patchgrid/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../../auth/actor"
import { hash } from "../../auth/sessions/session.service"
import type { AuditEntry, AuditService } from "../../audit/audit.service"
import { PermissionService } from "../../authz/permission.service"
import { FixedClock } from "../../common/clock/clock"
import {
  ConflictProblem,
  NotFoundProblem,
  NotPermittedProblem,
  PlanLimitProblem,
  ValidationProblem,
} from "../../common/problems/problem.exception"
import type { PublicUrls } from "../../common/urls"
import type { MailService } from "../../mail/mail.service"
import type { MailJob } from "../../mail/templates"
import type { OrganizationRepository } from "../../platform/repositories/organization.repository"
import type { PrismaService } from "../../prisma/prisma.service"
import type { QuotaService } from "../../quota/quota.service"
import type { TeamRecord, TeamRepository } from "../../teams/repositories/team.repository"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import type { InvitationRecord, InvitationRepository } from "../repositories/invitation.repository"
import type { MembershipRecord, MembershipRepository } from "../repositories/membership.repository"
import { parseInvitationToken } from "./invitation-token"
import { InvitationsService } from "./invitations.service"

const ORG = "01929f5e-7a2b-7c3d-8e4f-a1b2c3d4e5f6"
const NOW = new Date("2026-10-09T12:00:00Z")

type Options = {
  role?: Role
  existing?: MembershipStatus
  teams?: TeamRecord[]
  mailFails?: boolean
  revokes?: boolean
  seatsFull?: boolean
}

function harness(options: Options = {}) {
  const events: string[] = []
  const audit: AuditEntry[] = []
  const created: (Parameters<InvitationRepository["create"]>[1] & { id: string })[] = []
  const mail: MailJob[] = []

  const invitations = {
    revokePendingFor: vi.fn(async () => ["inv-old"]),
    create: vi.fn(async (orgId: string, data: Parameters<InvitationRepository["create"]>[1]): Promise<InvitationRecord> => {
      events.push("create")
      created.push({ ...data, id: "inv-1" })
      return { id: "inv-1", orgId, ...data, acceptedAt: null, revokedAt: null, createdAt: NOW }
    }),
    revoke: vi.fn(async () => options.revokes ?? true),
    listPending: vi.fn(async () => []),
  }
  const memberships = {
    findByEmail: vi.fn(async (): Promise<MembershipRecord | null> =>
      options.existing === undefined
        ? null
        : { id: "m-x", orgId: ORG, userId: "u-x", role: "AGENT", status: options.existing, kind: "HUMAN", displayName: "X", teamIds: [], leadOfTeamIds: [] },
    ),
    findById: vi.fn(async () => ({ displayName: "Ada Admin" })),
  }
  const teams = {
    findById: vi.fn(async (_o: string, id: string) => (options.teams ?? []).find((t) => t.id === id) ?? null),
  }
  const actor: MemberActor = {
    kind: "member",
    userId: "u-1",
    orgId: ORG,
    membershipId: "m-1",
    role: options.role ?? "ADMIN",
    teamIds: [],
    leadOfTeamIds: [],
  }
  const service = new InvitationsService(
    invitations as unknown as InvitationRepository,
    memberships as unknown as MembershipRepository,
    teams as unknown as TeamRepository,
    { findProfileById: async () => ({ id: ORG, name: "Acme", slug: "acme", status: "ACTIVE" }) } as unknown as OrganizationRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    {
      transaction: async (fn: () => Promise<unknown>) => {
        const result = await fn()
        events.push("commit")
        return result
      },
    } as unknown as PrismaService,
    { record: async (_o: string, e: AuditEntry[]) => void audit.push(...e) } as unknown as AuditService,
    {
      enqueue: async (job: MailJob) => {
        if (options.mailFails === true) throw new Error("redis down")
        events.push("mail")
        mail.push(job)
      },
    } as unknown as MailService,
    { app: (path: string) => `http://app.lvh.me:3001${path}` } as unknown as PublicUrls,
    { hasRoom: async () => options.seatsFull !== true } as unknown as QuotaService,
    new FixedClock(NOW),
  )
  return { service, events, audit, created, mail, invitations }
}

const request = (over: Partial<CreateInvitationRequest> = {}): CreateInvitationRequest => ({
  email: "new@acme.test",
  role: "AGENT",
  ...over,
})

beforeEach(() => {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
})

describe("InvitationsService.create", () => {
  it("stores only the hash, expires in seven days, supersedes the old one, audits, then mails", async () => {
    const h = harness()
    const invitation = await h.service.create(request())
    expect(invitation).toMatchObject({ id: "inv-1", email: "new@acme.test", role: "AGENT", expiresAt: "2026-10-16T12:00:00.000Z" })
    expect(h.events).toEqual(["create", "commit", "mail"])
    expect(h.audit[0]).toMatchObject({ action: "MEMBER_INVITED", entityId: "inv-1", diff: { supersedes: ["inv-old"] } })

    // The mailed token carries this org and the secret whose hash was stored.
    const url = new URL(h.mail[0]?.kind === "invite" ? h.mail[0].params.acceptUrl : "")
    const parsed = parseInvitationToken(url.searchParams.get("token") ?? "")
    expect(parsed?.orgId).toBe(ORG)
    expect(h.created[0]?.tokenHash).toBe(hash(parsed?.secret ?? ""))
    expect(JSON.stringify(h.created)).not.toContain(parsed?.secret)
    expect(h.mail[0]).toMatchObject({ to: "new@acme.test", orgId: ORG, fromName: "Acme", params: { inviterName: "Ada Admin" } })
  })

  it("lets only an owner invite at admin or above", async () => {
    await expect(harness({ role: "ADMIN" }).service.create(request({ role: "ADMIN" }))).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness({ role: "ADMIN" }).service.create(request({ role: "OWNER" }))).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness({ role: "OWNER" }).service.create(request({ role: "ADMIN" }))).resolves.toMatchObject({ role: "ADMIN" })
  })

  it("is not an agent's to do", async () => {
    await expect(harness({ role: "AGENT" }).service.create(request())).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("refuses an active or disabled member's address, but re-invites a removed one", async () => {
    await expect(harness({ existing: "ACTIVE" }).service.create(request())).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness({ existing: "DISABLED" }).service.create(request())).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness({ existing: "REMOVED" }).service.create(request())).resolves.toMatchObject({ id: "inv-1" })
  })

  it("seeds only an active team", async () => {
    const teams: TeamRecord[] = [
      { id: "t-live", orgId: ORG, name: "Network", isActive: true },
      { id: "t-dead", orgId: ORG, name: "Old", isActive: false },
    ]
    await expect(harness({ teams }).service.create(request({ teamId: "t-live" }))).resolves.toMatchObject({ teamId: "t-live" })
    await expect(harness({ teams }).service.create(request({ teamId: "t-dead" }))).rejects.toBeInstanceOf(ValidationProblem)
    await expect(harness({ teams }).service.create(request({ teamId: "t-none" }))).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("still reports the invitation when the mail cannot be enqueued", async () => {
    const h = harness({ mailFails: true })
    await expect(h.service.create(request())).resolves.toMatchObject({ id: "inv-1" })
    expect(Logger.prototype.error).toHaveBeenCalled()
  })
})

describe("InvitationsService.create — seats", () => {
  it("is a 402 to invite an agent with every seat in use, but a requester is always welcome", async () => {
    await expect(harness({ seatsFull: true }).service.create(request())).rejects.toBeInstanceOf(PlanLimitProblem)
    await expect(harness({ seatsFull: true }).service.create(request({ role: "REQUESTER" }))).resolves.toMatchObject({ role: "REQUESTER" })
  })
})

describe("InvitationsService.revoke", () => {
  it("audits a revocation, and is 404 for anything not pending", async () => {
    const h = harness()
    await h.service.revoke("inv-1")
    expect(h.audit).toEqual([{ action: "INVITATION_REVOKED", entityType: "Invitation", entityId: "inv-1" }])
    await expect(harness({ revokes: false }).service.revoke("inv-1")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

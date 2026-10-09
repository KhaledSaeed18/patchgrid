import { randomBytes, createHash } from "node:crypto"

import type { PrismaClient } from "../generated/client/client.ts"
import type { Priority, Role } from "../generated/client/enums.ts"

/**
 * Two organizations with deliberately similar data (TENANCY.md §10): the same
 * team names, people with the same display names and roles, a pending
 * invitation to the same address in each, and one account that is a member of
 * both with different roles. A leak between them is visible at a glance
 * rather than plausible-looking.
 *
 * Written as the owner role, because a seed is not a request — and shared by
 * `db:seed` (fixed slugs, for development) and the isolation suite (a random
 * suffix per run, so it never collides with the development data in the same
 * database). Ticket and category data join with their tables in M2.
 */

export type LookalikeOptions = {
  /** `acme` and `globex` in development; suffixed in tests. */
  slugs: { acme: string; globex: string }
  /** Appended to every local part, so a test run's accounts never collide with the seed's. */
  emailSuffix: string
  /** One Argon2id hash for every seeded account — the caller hashes; this package does not. */
  passwordHash: string
  /** `DEFAULT_SLA_TARGETS` from contracts — passed in, so this package keeps no copy of them. */
  slaTargets: Record<Priority, { response: number; responseWarning: number; resolution: number; resolutionWarning: number }>
}

export type SeededOrg = {
  id: string
  slug: string
  teams: Record<(typeof TEAMS)[number], string>
  members: Record<string, string>
  invitationId: string
  categories: { hardware: string; laptop: string }
  ticketId: string
  commentIds: { public: string; internal: string }
}

export type SeededPerson = { userId: string; email: string }

export type Lookalikes = {
  acme: SeededOrg
  globex: SeededOrg
  people: Record<PersonKey, SeededPerson>
}

const TEAMS = ["IT Support", "Network", "Security"] as const

type PersonKey = "alice" | "sam" | "rita" | "gus" | "tina" | "rosa" | "dana"

/** Who is where, as what. Dana is the dual member: an admin at Acme, an agent at Globex. */
const PEOPLE: Record<PersonKey, { name: string; memberships: Partial<Record<"acme" | "globex", Role>>; team?: string }> = {
  alice: { name: "Alice Owner", memberships: { acme: "OWNER" } },
  sam: { name: "Sam Agent", memberships: { acme: "AGENT" }, team: "Network" },
  rita: { name: "Rita Requester", memberships: { acme: "REQUESTER" } },
  gus: { name: "Gus Owner", memberships: { globex: "OWNER" } },
  // Same display name and role as Acme's Sam — on purpose.
  tina: { name: "Sam Agent", memberships: { globex: "AGENT" }, team: "Network" },
  rosa: { name: "Rita Requester", memberships: { globex: "REQUESTER" } },
  dana: { name: "Dana Dual", memberships: { acme: "ADMIN", globex: "AGENT" }, team: "Security" },
}

/** The addresses `seedLookalikes` creates for a suffix — how a reseed finds the accounts to remove. */
export function lookalikeEmails(emailSuffix: string): string[] {
  return Object.keys(PEOPLE).map((key) => `${key}${emailSuffix}@patchgrid.test`)
}

export async function seedLookalikes(db: PrismaClient, options: LookalikeOptions): Promise<Lookalikes> {
  const people = {} as Record<PersonKey, SeededPerson>
  for (const [key, person] of Object.entries(PEOPLE) as [PersonKey, (typeof PEOPLE)[PersonKey]][]) {
    const email = `${key}${options.emailSuffix}@patchgrid.test` // lookalikeEmails mirrors this
    const user = await db.user.upsert({
      where: { email },
      create: { email, name: person.name, passwordHash: options.passwordHash, emailVerifiedAt: new Date() },
      update: {},
      select: { id: true },
    })
    people[key] = { userId: user.id, email }
  }

  const seedOrg = async (which: "acme" | "globex", name: string): Promise<SeededOrg> => {
    const slug = options.slugs[which]
    const org = await db.organization.create({ data: { name, slug }, select: { id: true } })
    const teams = {} as SeededOrg["teams"]
    for (const team of TEAMS) {
      teams[team] = (await db.team.create({ data: { orgId: org.id, name: team }, select: { id: true } })).id
    }

    const members: Record<string, string> = {}
    let seats = 0
    for (const [key, person] of Object.entries(PEOPLE) as [PersonKey, (typeof PEOPLE)[PersonKey]][]) {
      const role = person.memberships[which]
      if (role === undefined) continue
      const membership = await db.membership.create({
        data: { orgId: org.id, userId: people[key].userId, role, displayName: person.name, joinedAt: new Date() },
        select: { id: true },
      })
      members[key] = membership.id
      if (role !== "REQUESTER") seats += 1
      await db.userOrgIndex.create({
        data: {
          userId: people[key].userId,
          orgId: org.id,
          roleForDisplay: role,
          statusForDisplay: "ACTIVE",
          orgSlug: slug,
          orgName: name,
          orgStatus: "ACTIVE",
        },
      })
      const team = person.team as (typeof TEAMS)[number] | undefined
      if (team !== undefined && role !== "REQUESTER") {
        await db.teamMembership.create({
          data: { orgId: org.id, teamId: teams[team], membershipId: membership.id, isLead: key !== "dana" },
        })
      }
    }
    await db.usageCounter.create({ data: { orgId: org.id, period: "current", metric: "AGENT_SEATS", value: BigInt(seats) } })

    // The same address invited to both: one row each, unusable tokens (only the hash exists).
    const owner = Object.entries(members).find(([key]) => PEOPLE[key as PersonKey].memberships[which] === "OWNER")?.[1] ?? ""
    const invitation = await db.invitation.create({
      data: {
        orgId: org.id,
        email: `new.hire${options.emailSuffix}@patchgrid.test`,
        role: "AGENT",
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        invitedByMembershipId: owner,
      },
      select: { id: true },
    })
    // The ticket world, alike on both sides: the same tree, the same policies,
    // the same incident title with a public reply and an internal note.
    const hardware = await db.category.create({ data: { orgId: org.id, name: "Hardware", depth: 1, defaultTeamId: teams["IT Support"] } })
    const laptop = await db.category.create({ data: { orgId: org.id, name: "Laptop", depth: 2, parentId: hardware.id } })
    for (const ticketType of ["INCIDENT", "SERVICE_REQUEST"] as const) {
      for (const [priority, t] of Object.entries(options.slaTargets) as [Priority, LookalikeOptions["slaTargets"][Priority]][]) {
        await db.sLAPolicy.create({
          data: {
            orgId: org.id,
            ticketType,
            priority,
            responseTargetMinutes: t.response,
            resolutionTargetMinutes: t.resolution,
            responseWarningMinutes: t.responseWarning,
            resolutionWarningMinutes: t.resolutionWarning,
          },
        })
      }
    }
    const requesterKey = which === "acme" ? "rita" : "rosa"
    const agentKey = which === "acme" ? "sam" : "tina"
    const now = new Date()
    const ticket = await db.ticket.create({
      data: {
        orgId: org.id,
        number: 1,
        type: "INCIDENT",
        title: "VPN drops every hour",
        description: "Since this morning the VPN disconnects on the hour.",
        status: "IN_PROGRESS",
        impact: "MEDIUM",
        urgency: "HIGH",
        priority: "HIGH",
        categoryId: laptop.id,
        requesterMembershipId: members[requesterKey] ?? "",
        assigneeMembershipId: members[agentKey] ?? null,
        teamId: teams.Network,
        responseClockStartedAt: now,
        resolutionClockStartedAt: now,
        respondedAt: now,
        source: "PORTAL",
      },
    })
    await db.ticketCounter.create({ data: { orgId: org.id, type: "INCIDENT", nextValue: 2 } })
    const reply = await db.comment.create({
      data: { orgId: org.id, ticketId: ticket.id, authorMembershipId: members[agentKey] ?? null, authorKind: "MEMBER", body: "Looking into it.", visibility: "PUBLIC" },
    })
    const note = await db.comment.create({
      data: { orgId: org.id, ticketId: ticket.id, authorMembershipId: members[agentKey] ?? null, authorKind: "MEMBER", body: "Looks like the concentrator's lease.", visibility: "INTERNAL" },
    })
    await db.ticketWatcher.create({
      data: { orgId: org.id, ticketId: ticket.id, membershipId: members.dana ?? "", addedByMembershipId: members[agentKey] ?? "" },
    })

    return {
      id: org.id,
      slug,
      teams,
      members,
      invitationId: invitation.id,
      categories: { hardware: hardware.id, laptop: laptop.id },
      ticketId: ticket.id,
      commentIds: { public: reply.id, internal: note.id },
    }
  }

  return { acme: await seedOrg("acme", "Acme"), globex: await seedOrg("globex", "Globex"), people }
}

/** Removes everything `seedLookalikes` wrote — for the suite's teardown, and to reseed development. */
export async function removeLookalikes(db: PrismaClient, seeded: { orgIds: string[]; userIds: string[] }): Promise<void> {
  const { orgIds, userIds } = seeded
  await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticketWatcher.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.comment.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticket.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticketCounter.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.sLAPolicy.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.category.deleteMany({ where: { orgId: { in: orgIds }, parentId: { not: null } } })
  await db.category.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.invitation.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.teamMembership.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.membership.updateMany({ where: { orgId: { in: orgIds } }, data: { invitedByMembershipId: null } })
  await db.membership.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.team.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.usageCounter.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.userOrgIndex.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.organizationSlugHistory.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.refreshToken.deleteMany({ where: { OR: [{ orgId: { in: orgIds } }, { userId: { in: userIds } }] } })
  await db.organization.deleteMany({ where: { id: { in: orgIds } } })
  await db.emailVerification.deleteMany({ where: { userId: { in: userIds } } })
  await db.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
}

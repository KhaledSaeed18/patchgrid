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
 * database). Ticket and category data joined with their tables in M2, notifications in M3.
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
  /** A Problem the incident is CAUSED_BY, and a Change that RESOLVES it, once rejected and resubmitted. */
  problemId: string
  changeId: string
  assetId: string
  articleId: string
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
  // The support session's operator is an account too (ADR-0041).
  return [...Object.keys(PEOPLE), "lookalike-operator"].map((key) => `${key}${emailSuffix}@patchgrid.test`)
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
      data: {
        orgId: org.id,
        ticketId: ticket.id,
        authorMembershipId: members[agentKey] ?? null,
        authorKind: "MEMBER",
        body: "Looking into it.",
        visibility: "PUBLIC",
      },
    })
    const note = await db.comment.create({
      data: {
        orgId: org.id,
        ticketId: ticket.id,
        authorMembershipId: members[agentKey] ?? null,
        authorKind: "MEMBER",
        body: "Looks like the concentrator's lease.",
        visibility: "INTERNAL",
      },
    })
    await db.ticketWatcher.create({
      data: { orgId: org.id, ticketId: ticket.id, membershipId: members.dana ?? "", addedByMembershipId: members[agentKey] ?? "" },
    })
    // The requester is told about the reply: the same title on both sides.
    await db.notification.create({
      data: {
        orgId: org.id,
        userId: people[requesterKey].userId,
        membershipId: members[requesterKey] ?? "",
        type: "COMMENT_PUBLIC",
        title: "New reply on VPN drops every hour",
        ticketId: ticket.id,
        dedupeKey: `comment:${ticket.id}`,
      },
    })

    // M4's record types: a known error behind the incident, and a change to fix it
    // that was rejected once and now waits on approval again.
    const clockless = { responseClockStartedAt: now, resolutionClockStartedAt: now, source: "CONSOLE" as const }
    const problem = await db.ticket.create({
      data: {
        orgId: org.id,
        number: 1,
        type: "PROBLEM",
        title: "VPN concentrator drops leases",
        description: "Several hourly VPN drops trace back to one concentrator.",
        status: "KNOWN_ERROR",
        impact: "MEDIUM",
        urgency: "MEDIUM",
        priority: "MEDIUM",
        requesterMembershipId: members[agentKey] ?? "",
        assigneeMembershipId: members[agentKey] ?? null,
        teamId: teams.Network,
        ...clockless,
        problem: { create: { rootCause: null, workaround: "Reconnect; leases renew within a minute.", knownErrorAt: now } },
      },
    })
    const change = await db.ticket.create({
      data: {
        orgId: org.id,
        number: 1,
        type: "CHANGE",
        title: "Replace the VPN concentrator",
        description: "Swap the failing unit for the spare.",
        status: "AWAITING_APPROVAL",
        impact: "MEDIUM",
        urgency: "MEDIUM",
        priority: "MEDIUM",
        requesterMembershipId: members[agentKey] ?? "",
        teamId: teams.Network,
        ...clockless,
        change: {
          create: {
            plannedStart: new Date(now.getTime() + 2 * 86_400_000),
            plannedEnd: new Date(now.getTime() + 2 * 86_400_000 + 3_600_000),
            risk: "MEDIUM",
            implementationPlan: "Fail over to the spare, swap, fail back.",
            rollbackPlan: "Stay on the spare.",
          },
        },
      },
    })
    await db.ticketCounter.createMany({
      data: [
        { orgId: org.id, type: "PROBLEM", nextValue: 2 },
        { orgId: org.id, type: "CHANGE", nextValue: 2 },
      ],
    })
    const approver = which === "acme" ? "alice" : "gus"
    await db.changeApproval.create({
      data: {
        orgId: org.id,
        ticketId: change.id,
        approverMembershipId: members[approver] ?? "",
        decision: "REJECTED",
        reason: "Needs a rollback plan.",
        decidedAt: now,
      },
    })
    // A file on the incident's public reply — a row only; the isolation suite never fetches bytes.
    await db.attachment.create({
      data: {
        orgId: org.id,
        ticketId: ticket.id,
        commentId: reply.id,
        uploaderMembershipId: members[agentKey] ?? "",
        filename: "vpn-log.txt",
        declaredMimeType: "text/plain",
        mimeType: "text/plain",
        sizeBytes: 2048,
        storageKey: `org/${org.id}/tickets/${ticket.id}/seed-vpn-log.txt`,
        status: "READY",
        completedAt: now,
      },
    })
    await db.ticketLink.createMany({
      data: [
        {
          orgId: org.id,
          fromTicketId: ticket.id,
          toTicketId: problem.id,
          relation: "CAUSED_BY",
          createdByMembershipId: members[agentKey] ?? "",
        },
        {
          orgId: org.id,
          fromTicketId: problem.id,
          toTicketId: change.id,
          relation: "RESOLVED_BY",
          createdByMembershipId: members[agentKey] ?? "",
        },
      ],
    })

    // The same serial in both orgs — unique per org, never globally (ADR-0013).
    const asset = await db.asset.create({
      data: {
        orgId: org.id,
        name: "ThinkPad T14",
        type: "LAPTOP",
        status: "IN_USE",
        serialNumber: "PF-LOOKALIKE-1",
        ownerMembershipId: members[requesterKey] ?? null,
      },
    })
    await db.ticketAsset.create({ data: { orgId: org.id, ticketId: ticket.id, assetId: asset.id } })
    // The same slug in both orgs — unique per org — and a draft, so visibility has something to hide.
    const article = await db.knowledgeArticle.create({
      data: {
        orgId: org.id,
        categoryId: laptop.id,
        authorMembershipId: members[agentKey] ?? "",
        title: "Connecting to the VPN",
        slug: "connecting-to-the-vpn",
        body: "Open the VPN client and sign in with your work account.",
        visibility: "PUBLISHED",
        publishedAt: now,
      },
    })
    await db.knowledgeArticle.create({
      data: {
        orgId: org.id,
        authorMembershipId: members[agentKey] ?? "",
        title: "Concentrator lease runbook",
        slug: "concentrator-lease-runbook",
        body: "Renew the lease before it lapses.",
      },
    })

    // The same Message-ID in both orgs — one per org, never globally — and one message dropped as forged.
    await db.inboundEmail.createMany({
      data: [
        {
          orgId: org.id,
          messageKey: "<lookalike-1@patchgrid.test>",
          fromAddress: `${requesterKey}@patchgrid.test`,
          subject: "VPN drops every hour",
          authVerdict: "PASS",
          outcome: "CREATED",
          senderMembershipId: members[requesterKey] ?? null,
          ticketId: ticket.id,
          rawStorageKey: `org/${org.id}/inbound/lookalike-1.eml`,
          processedAt: now,
        },
        {
          orgId: org.id,
          messageKey: "<lookalike-2@patchgrid.test>",
          fromAddress: "ceo@patchgrid.test",
          subject: "Urgent: wire transfer",
          authVerdict: "FAIL",
          outcome: "UNAUTHENTICATED",
          rawStorageKey: `org/${org.id}/inbound/lookalike-2.eml`,
          processedAt: now,
        },
      ],
    })

    // A support session requested and declined, so isolation has a row on each side (ADR-0041).
    const operator = await db.user.upsert({
      where: { email: `lookalike-operator${options.emailSuffix}@patchgrid.test` },
      create: {
        email: `lookalike-operator${options.emailSuffix}@patchgrid.test`,
        name: "Lookalike Operator",
        passwordHash: options.passwordHash,
        emailVerifiedAt: now,
      },
      update: {},
      select: { id: true },
    })
    const operatorAdmin = await db.platformAdmin.upsert({
      where: { userId: operator.id },
      create: { userId: operator.id },
      update: {},
      select: { id: true },
    })
    await db.supportSession.create({
      data: {
        orgId: org.id,
        platformAdminId: operatorAdmin.id,
        reason: "Diagnose a VPN ticket",
        decidedByMembershipId: owner,
        declinedAt: now,
      },
    })

    // A revoked API token and its service account, so isolation has a row on each side (ADR-0042).
    const robot = await db.membership.create({
      data: { orgId: org.id, kind: "SERVICE_ACCOUNT", role: "AGENT", status: "DISABLED", displayName: "Lookalike monitor" },
      select: { id: true },
    })
    const tokenPrefix = randomBytes(6).toString("hex")
    await db.apiToken.create({
      data: {
        orgId: org.id,
        name: "Lookalike monitor",
        prefix: tokenPrefix,
        tokenHash: "revoked-seed-token-has-no-secret",
        scopes: ["tickets:read"],
        membershipId: robot.id,
        createdByMembershipId: owner,
        revokedAt: now,
        revokedByMembershipId: owner,
      },
    })
    await db.apiTokenIndex.create({ data: { prefix: tokenPrefix, orgId: org.id, revokedAt: now } })

    // An export that failed, so isolation has a row on each side (ADR-0044).
    await db.orgExport.create({ data: { orgId: org.id, requestedByMembershipId: owner, status: "FAILED", failure: "Lookalike export" } })

    // An event in the log, a consumer's cursor and a parked event, so isolation has a row on each side (ADR-0049).
    const event = await db.outboxEvent.create({
      // A type no consumer reads, so seeding it notifies nobody.
      data: { orgId: org.id, type: "lookalike-seeded", payload: { ticketId: ticket.id } },
      select: { id: true },
    })
    await db.eventConsumer.create({ data: { orgId: org.id, consumer: "lookalike" } })
    await db.eventDeadLetter.create({
      data: { orgId: org.id, consumer: "lookalike", eventId: event.id, failures: 3, error: "Lookalike failure" },
    })

    // A saved view, so isolation has a row on each side (ADR-0052).
    await db.savedView.create({
      data: { orgId: org.id, ownerMembershipId: owner, name: "Lookalike view", query: { view: "open", sort: "newest" } },
    })

    // A reporting fact for the ticket, so isolation has a row on each side (ADR-0051). An upsert: a
    // running app's reporting consumer may already have written this ticket's fact from the log.
    const fact = {
      orgId: org.id,
      ticketId: ticket.id,
      sourceVersion: 1,
      type: "INCIDENT",
      priority: "MEDIUM",
      state: "OPEN",
      createdAt: now,
      response: "RUNNING",
      resolution: "RUNNING",
      reopenCount: 0,
    } as const
    await db.ticketFact.upsert({ where: { orgId_ticketId: { orgId: org.id, ticketId: ticket.id } }, create: fact, update: fact })

    // A disabled endpoint and a dead delivery, so isolation has a row on each side (ADR-0050). Disabled, so nothing sends.
    const endpoint = await db.webhookEndpoint.create({
      data: {
        orgId: org.id,
        url: "https://hooks.example.com/lookalike",
        eventTypes: ["ticket.created"],
        status: "DISABLED",
        disabledReason: "Lookalike endpoint",
        secretSealed: "lookalike-not-a-sealed-secret",
        createdByMembershipId: owner,
      },
      select: { id: true },
    })
    await db.webhookDelivery.create({
      data: {
        orgId: org.id,
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: "ticket.created",
        payload: {},
        status: "DEAD",
        attempts: 7,
        lastError: "Lookalike failure",
      },
    })

    // A disabled SSO connection and one linked identity, so isolation has a row on each side (ADR-0054).
    // Disabled, and its secret is not a sealed one, so no sign-in can route to it.
    const connection = await db.ssoConnection.create({
      data: {
        orgId: org.id,
        issuer: `https://idp.example.com/realms/${slug}`,
        clientId: "lookalike",
        clientSecretSealed: "lookalike-not-a-sealed-secret",
        defaultRole: "REQUESTER",
        enabled: false,
      },
      select: { id: true },
    })
    await db.ssoIdentity.create({ data: { orgId: org.id, connectionId: connection.id, subject: "lookalike-subject", membershipId: owner } })

    // What the rows above use of the plan, so a delete releases what a create consumed (TENANCY.md §8).
    await db.usageCounter.createMany({
      data: [
        { orgId: org.id, period: "current", metric: "KB_ARTICLES", value: 2n },
        { orgId: org.id, period: "current", metric: "STORAGE_BYTES", value: 2048n },
      ],
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
      problemId: problem.id,
      changeId: change.id,
      assetId: asset.id,
      articleId: article.id,
    }
  }

  return { acme: await seedOrg("acme", "Acme"), globex: await seedOrg("globex", "Globex"), people }
}

/** Removes everything `seedLookalikes` wrote — for the suite's teardown, and to reseed development. */
export async function removeLookalikes(db: PrismaClient, seeded: { orgIds: string[]; userIds: string[] }): Promise<void> {
  const { orgIds, userIds } = seeded
  await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.notification.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticketWatcher.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.attachment.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.inboundEmail.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.supportSession.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.apiToken.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.orgExport.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticketFact.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.savedView.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ssoIdentity.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ssoConnection.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.webhookDelivery.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.webhookEndpoint.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.eventDeadLetter.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.eventConsumer.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.apiTokenIndex.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticketAsset.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.asset.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.knowledgeArticle.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.ticketLink.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.changeApproval.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.problemDetails.deleteMany({ where: { orgId: { in: orgIds } } })
  await db.changeDetails.deleteMany({ where: { orgId: { in: orgIds } } })
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
  // An operator grant and its log point at the account; they go first (ADR-0040).
  const admins = await db.platformAdmin.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
  await db.platformAuditLog.deleteMany({
    where: { OR: [{ platformAdminId: { in: admins.map((a) => a.id) } }, { targetUserId: { in: userIds } }] },
  })
  await db.platformAdmin.deleteMany({ where: { userId: { in: userIds } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
}

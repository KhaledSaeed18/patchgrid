/**
 * Demo volume for the seed (FEATURES.md M2): a fuller category tree and
 * about thirty incidents per workspace, of every status and age, with SLA
 * clocks that agree with their history — some met, some breached, some
 * counting down — so the queues and the deadline badges have something to say.
 *
 * Seed-only. The lookalike fixture the isolation suite shares stays small;
 * this file never runs in a test.
 *
 * Deterministic: the same seed gives the same tickets, relative to `now`.
 */
import { computePriority, type Impact, type Priority, type Urgency } from "@patchgrid/contracts"

import type { PrismaClient } from "../src/index.ts"
import type { SeededOrg } from "../src/lookalikes.ts"

type Status = "NEW" | "ASSIGNED" | "IN_PROGRESS" | "PENDING" | "RESOLVED" | "CLOSED" | "CANCELLED"

/** Title, details, and the category it belongs to (by name below). */
const INCIDENTS: [string, string, CategoryKey][] = [
  ["Outlook keeps asking for my password", "Every few minutes since the update last night.", "email"],
  ["Shared mailbox missing from Outlook", "The support@ mailbox disappeared from the folder list.", "email"],
  ["Laptop won't wake from sleep", "Have to hold the power button every morning.", "laptop"],
  ["Laptop battery drains in an hour", "It's a few months old; it used to last all day.", "laptop"],
  ["Cracked screen on my laptop", "Dropped it on the way in. It still works but the corner is shattered.", "laptop"],
  ["Monitor flickers on the left desk", "Second screen at desk 22 flickers when anything moves.", "hardware"],
  ["Keyboard keys sticking", "The E and R keys stick. Coffee may have been involved.", "hardware"],
  ["Printer on floor 3 says offline", "Shows offline from every laptop; the panel says ready.", "hardware"],
  ["VPN disconnects every hour", "Drops on the hour, reconnects after a minute.", "vpn"],
  ["Can't reach the file share over VPN", "VPN connects but \\\\files\\finance times out.", "vpn"],
  ["Wi-Fi is very slow in meeting room B", "Video calls freeze; the rest of the floor is fine.", "wifi"],
  ["Guest Wi-Fi password not working", "Visitors get 'incorrect password' with today's code.", "wifi"],
  ["Locked out after password change", "Changed it this morning and now nothing accepts it.", "password"],
  ["MFA prompt never arrives", "The authenticator app shows nothing when I sign in.", "password"],
  ["Need access to the finance share", "Starting in finance on Monday; my manager approved.", "access"],
  ["Remove access for a leaver", "Jordan left on Friday; their accounts are still active.", "access"],
  ["Excel crashes opening the budget file", "Only that file. Others open fine.", "software"],
  ["Teams calls have no audio", "I can see people but nobody hears me, or me them.", "software"],
  ["Browser blocks the expenses site", "Says the certificate isn't valid.", "software"],
  ["Calendar invites arrive an hour late", "Started after the clocks changed.", "email"],
  ["Phishing email reported by three people", "Pretends to be a parcel delivery, asks for a login.", "access"],
  ["Projector in the boardroom shows no signal", "HDMI and USB-C both, from two different laptops.", "hardware"],
  ["Docking station not charging", "The USB-C dock stopped charging this morning.", "laptop"],
  ["Slow login on the shared PC", "Takes about ten minutes to reach the desktop.", "software"],
  ["Network drive mapped to the wrong letter", "Finance is on Z: but the macros expect F:.", "software"],
  ["Wi-Fi drops in the warehouse", "Scanners lose connection near the loading bay.", "wifi"],
  ["Email bounces to one client", "Anything to their domain comes back as rejected.", "email"],
  ["New starter needs a laptop", "Starts on the 20th, needs the standard setup.", "laptop"],
  ["Password reset link expired", "The link in the email says it has already expired.", "password"],
]

type CategoryKey = "hardware" | "laptop" | "software" | "email" | "network" | "vpn" | "wifi" | "accessRoot" | "access" | "password"

/** The status mix a lived-in queue has: mostly open, a tail of finished. */
const STATUSES: Status[] = [
  ...Array<Status>(5).fill("NEW"),
  ...Array<Status>(3).fill("ASSIGNED"),
  ...Array<Status>(7).fill("IN_PROGRESS"),
  ...Array<Status>(3).fill("PENDING"),
  ...Array<Status>(4).fill("RESOLVED"),
  ...Array<Status>(5).fill("CLOSED"),
  ...Array<Status>(2).fill("CANCELLED"),
]

const MINUTE = 60_000
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE)

/** A small seeded generator (mulberry32), so a reset reproduces the same demo. */
function random(seed: number) {
  let state = seed
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  return { next, pick }
}

export async function seedDemoTickets(
  db: PrismaClient,
  org: SeededOrg,
  people: { requesters: string[]; agents: string[] },
  seed: number,
  now = new Date(),
): Promise<number> {
  const rng = random(seed)
  const categories = await demoCategories(db, org)
  const policies = await db.sLAPolicy.findMany({ where: { orgId: org.id, ticketType: "INCIDENT" } })
  const policyFor = (priority: Priority) => policies.find((p) => p.priority === priority)
  const counter = await db.ticketCounter.findUniqueOrThrow({ where: { orgId_type: { orgId: org.id, type: "INCIDENT" } } })

  let number = counter.nextValue
  const levels: (Impact & Urgency)[] = ["LOW", "MEDIUM", "HIGH"]
  for (const [index, status] of STATUSES.entries()) {
    const [title, description, categoryKey] = INCIDENTS[index % INCIDENTS.length] ?? INCIDENTS[0] ?? ["", "", "hardware"]
    const category = categories[categoryKey]
    // Untouched work is minutes to hours old, worked tickets a day or two,
    // finished ones weeks — the ages a desk that keeps up actually has.
    const ageMinutes = ["RESOLVED", "CLOSED", "CANCELLED"].includes(status)
      ? Math.floor(2 * 1440 + rng.next() * 18 * 1440)
      : ["NEW", "ASSIGNED"].includes(status)
        ? Math.floor(5 + rng.next() * 240)
        : Math.floor(60 + rng.next() * 2 * 1440)
    const createdAt = at(now, -ageMinutes)
    const impact = rng.pick(levels)
    const urgency = rng.pick(levels)
    const priority = computePriority(impact, urgency)
    const policy = policyFor(priority)
    const respondBy = policy === undefined ? null : at(createdAt, policy.responseTargetMinutes)
    const assignee = status === "NEW" ? null : rng.pick(people.agents)
    const requester = rng.next() < 0.8 ? rng.pick(people.requesters) : rng.pick(people.agents)

    // History, in order: a response, a pause, a resolution, a close.
    const worked = !["NEW", "ASSIGNED"].includes(status) && !(status === "CANCELLED" && rng.next() < 0.5)
    // One in five answers late, which is what a breach badge is for.
    const late = rng.next() < 0.2
    const responseTarget = policy?.responseTargetMinutes ?? 60
    const respondedAt = worked
      ? at(createdAt, Math.min(ageMinutes - 1, Math.floor(responseTarget * (late ? 1.5 : 0.3 + rng.next() * 0.5))))
      : null
    const resolutionTarget = policy?.resolutionTargetMinutes ?? 1440
    const resolvedAt = ["RESOLVED", "CLOSED"].includes(status)
      ? at(createdAt, Math.min(ageMinutes - 2, Math.floor(resolutionTarget * (late ? 1.3 : 0.2 + rng.next() * 0.6))))
      : null
    const closedAt = status === "CLOSED" && resolvedAt !== null ? at(resolvedAt, 1) : null
    const cancelledAt = status === "CANCELLED" ? at(createdAt, Math.floor(ageMinutes / 2)) : null
    const pausedAt = status === "PENDING" && respondedAt !== null ? at(respondedAt, 5) : null
    const resolveBy = policy === undefined ? null : at(createdAt, policy.resolutionTargetMinutes)

    const stopped = cancelledAt !== null
    const responseBreached = !stopped && respondBy !== null && (respondedAt ?? resolvedAt ?? now) > respondBy
    const resolutionBreached = !stopped && pausedAt === null && resolveBy !== null && (resolvedAt ?? now) > resolveBy
    const updatedAt = closedAt ?? resolvedAt ?? cancelledAt ?? pausedAt ?? respondedAt ?? createdAt

    const ticket = await db.ticket.create({
      data: {
        orgId: org.id,
        number,
        type: "INCIDENT",
        title,
        description,
        status,
        impact,
        urgency,
        priority,
        source: "PORTAL",
        categoryId: category.id,
        requesterMembershipId: requester,
        assigneeMembershipId: assignee,
        teamId: status === "NEW" && rng.next() < 0.5 ? null : category.teamId,
        slaPolicyId: policy?.id ?? null,
        responseClockStartedAt: createdAt,
        resolutionClockStartedAt: createdAt,
        respondedAt: respondedAt ?? resolvedAt,
        resolvedAt,
        closedAt,
        cancelledAt,
        pausedAt,
        respondBy,
        resolveBy,
        responseBreached,
        resolutionBreached,
        createdAt,
        updatedAt,
      },
      select: { id: true },
    })
    number += 1

    const comment = (body: string, minute: Date, author: string, visibility: "PUBLIC" | "INTERNAL" = "PUBLIC") =>
      db.comment.create({
        data: { orgId: org.id, ticketId: ticket.id, authorMembershipId: author, authorKind: "MEMBER", body, visibility, createdAt: minute },
      })
    if (assignee !== null && respondedAt !== null) {
      await comment("Thanks — I'm looking at this now.", respondedAt, assignee)
      if (rng.next() < 0.4) await comment("Checked the logs; nothing obvious yet.", at(respondedAt, 3), assignee, "INTERNAL")
    }
    if (assignee !== null && pausedAt !== null) {
      await comment("Could you tell me when this last worked, and send a screenshot of the error?", pausedAt, assignee)
    }
    if (assignee !== null && resolvedAt !== null) {
      await comment("This should be sorted now — let me know if it comes back.", resolvedAt, assignee)
    }
  }
  await db.ticketCounter.update({ where: { orgId_type: { orgId: org.id, type: "INCIDENT" } }, data: { nextValue: number } })
  return STATUSES.length
}

/** The lookalike tree (Hardware → Laptop) grown into one a real service desk would use. */
async function demoCategories(db: PrismaClient, org: SeededOrg) {
  const support = org.teams["IT Support"]
  const network = org.teams.Network
  const security = org.teams.Security
  const create = async (name: string, parentId: string | null, depth: number, defaultTeamId: string | null) =>
    (await db.category.create({ data: { orgId: org.id, name, parentId, depth, defaultTeamId }, select: { id: true } })).id

  const software = await create("Software", null, 1, support)
  const networkRoot = await create("Network", null, 1, network)
  const accessRoot = await create("Accounts and access", null, 1, security)
  const ids: Record<CategoryKey, { id: string; teamId: string | null }> = {
    hardware: { id: org.categories.hardware, teamId: support },
    laptop: { id: org.categories.laptop, teamId: support },
    software: { id: software, teamId: support },
    email: { id: await create("Email", software, 2, null), teamId: support },
    network: { id: networkRoot, teamId: network },
    vpn: { id: await create("VPN", networkRoot, 2, null), teamId: network },
    wifi: { id: await create("Wi-Fi", networkRoot, 2, null), teamId: network },
    accessRoot: { id: accessRoot, teamId: security },
    access: { id: await create("Permissions", accessRoot, 2, null), teamId: security },
    password: { id: await create("Passwords and MFA", accessRoot, 2, null), teamId: security },
  }
  // "Other" under two parents: names are unique per parent, not per workspace.
  await create("Other", software, 2, null)
  await create("Other", org.categories.hardware, 2, null)
  return ids
}

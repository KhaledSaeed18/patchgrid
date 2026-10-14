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

/**
 * M4's record types on top of the incidents (FEATURES.md M4): Problems at
 * every stage, each caused by some of the incidents above; Changes in every
 * state, with their plans, outcomes and decisions — one rejected then
 * approved — one of them resolving a Problem; and some watched tickets.
 * `lead` leads the changes' team, so their approval inbox has something in
 * it.
 */
export async function seedDemoProblemsAndChanges(
  db: PrismaClient,
  org: SeededOrg,
  people: { lead: string; agents: string[]; admin: string; watchers: string[] },
  seed: number,
  now = new Date(),
): Promise<{ problems: number; changes: number }> {
  const rng = random(seed + 100)
  const team = org.teams.Network
  // The lookalikes already make them the team's lead; say so rather than assume it.
  const led = await db.teamMembership.count({ where: { orgId: org.id, teamId: team, membershipId: people.lead, isLead: true } })
  if (led !== 1) throw new Error(`demo seed: the approver must lead ${org.slug}'s Network team`)
  const incidents = await db.ticket.findMany({
    where: { orgId: org.id, type: "INCIDENT", id: { not: org.ticketId } },
    orderBy: { number: "asc" },
    select: { id: true },
  })
  const counters = await db.ticketCounter.findMany({ where: { orgId: org.id, type: { in: ["PROBLEM", "CHANGE"] } } })
  let problemNumber = counters.find((c) => c.type === "PROBLEM")?.nextValue ?? 1
  let changeNumber = counters.find((c) => c.type === "CHANGE")?.nextValue ?? 1
  const day = (n: number) => at(now, -n * 1440)
  const base = { orgId: org.id, impact: "MEDIUM" as const, urgency: "MEDIUM" as const, priority: "MEDIUM" as const, source: "CONSOLE" as const, teamId: team }

  const PROBLEMS = [
    { title: "Outlook password prompts after the update", status: "NEW", workaround: null, rootCause: null, age: 1 },
    { title: "Laptops failing to wake from sleep", status: "IN_PROGRESS", workaround: null, rootCause: null, age: 4 },
    { title: "Wi-Fi drops in the warehouse", status: "KNOWN_ERROR", workaround: "Pin scanners to the 5 GHz access point by the bay door.", rootCause: null, age: 9 },
    { title: "Calendar invites arriving late", status: "RESOLVED", workaround: "Send from the web client.", rootCause: "The mail relay kept the old daylight-saving offset.", age: 20 },
  ] as const
  const problemIds: string[] = []
  for (const [index, p] of PROBLEMS.entries()) {
    const createdAt = day(p.age)
    const problem = await db.ticket.create({
      data: {
        ...base,
        number: problemNumber,
        type: "PROBLEM",
        title: p.title,
        description: "Several incidents point the same way; finding the cause.",
        status: p.status,
        requesterMembershipId: rng.pick(people.agents),
        assigneeMembershipId: p.status === "NEW" ? null : rng.pick(people.agents),
        responseClockStartedAt: createdAt,
        resolutionClockStartedAt: createdAt,
        resolvedAt: p.status === "RESOLVED" ? day(p.age - 3) : null,
        createdAt,
        updatedAt: createdAt,
        problem: { create: { workaround: p.workaround, rootCause: p.rootCause, knownErrorAt: p.workaround === null ? null : day(p.age - 1) } },
      },
      select: { id: true },
    })
    problemNumber += 1
    problemIds.push(problem.id)
    const caused = incidents.slice(index * 3, index * 3 + 2 + (index % 2))
    await db.ticketLink.createMany({
      data: caused.map((i) => ({ orgId: org.id, fromTicketId: i.id, toTicketId: problem.id, relation: "CAUSED_BY" as const, createdByMembershipId: people.lead })),
    })
  }

  const plan = (offsetDays: number) => ({
    plannedStart: at(now, offsetDays * 1440),
    plannedEnd: at(now, offsetDays * 1440 + 120),
    risk: rng.pick(["LOW", "MEDIUM", "HIGH"] as const),
    implementationPlan: "Announce the window, apply in the maintenance slot, verify, close the announcement.",
    rollbackPlan: "Restore the previous configuration from the nightly backup.",
  })
  const CHANGES = [
    { title: "Replace the warehouse access points", status: "DRAFT", plan: { risk: "MEDIUM" as const }, decisions: [], outcome: null, offset: 7 },
    { title: "Move the mail relay to the new cluster", status: "AWAITING_APPROVAL", decisions: ["REJECTED"], outcome: null, offset: 3 },
    { title: "Raise the VPN lease table size", status: "AWAITING_APPROVAL", decisions: [], outcome: null, offset: 2 },
    { title: "Upgrade the core switch firmware", status: "APPROVED", decisions: ["APPROVED"], outcome: null, offset: 1 },
    { title: "Roll out the new laptop sleep policy", status: "IN_PROGRESS", decisions: ["APPROVED"], outcome: null, offset: 0 },
    { title: "Rotate the guest Wi-Fi password weekly", status: "IMPLEMENTED", decisions: ["APPROVED"], outcome: "Rotation scheduled; the reception screen shows the new code.", offset: -2 },
    { title: "Enable the new spam filter rules", status: "ROLLED_BACK", decisions: ["APPROVED"], outcome: "Blocked two clients' invoices; rolled back within the hour.", offset: -4 },
    { title: "Fix the daylight-saving offset on the relay", status: "CLOSED", decisions: ["REJECTED", "APPROVED"], outcome: "Offset corrected; invites arrive on time.", offset: -15 },
    { title: "Retire the old print server", status: "CANCELLED", decisions: [], outcome: null, offset: 10 },
  ] as const
  for (const c of CHANGES) {
    const createdAt = at(now, Math.min(-1, c.offset - 3) * 1440)
    const details = "plan" in c ? c.plan : plan(c.offset)
    const doneAt = c.outcome === null ? null : at(now, c.offset * 1440 + 150)
    const change = await db.ticket.create({
      data: {
        ...base,
        number: changeNumber,
        type: "CHANGE",
        title: c.title,
        description: "Planned work, approved before it is carried out.",
        status: c.status,
        requesterMembershipId: people.admin,
        assigneeMembershipId: ["IN_PROGRESS", "IMPLEMENTED", "ROLLED_BACK", "CLOSED"].includes(c.status) ? rng.pick(people.agents) : null,
        responseClockStartedAt: createdAt,
        resolutionClockStartedAt: createdAt,
        resolvedAt: doneAt,
        closedAt: c.status === "CLOSED" && doneAt !== null ? at(doneAt, 1440) : null,
        cancelledAt: c.status === "CANCELLED" ? at(createdAt, 60) : null,
        createdAt,
        updatedAt: doneAt ?? createdAt,
        change: { create: { ...details, outcomeNotes: c.outcome } },
      },
      select: { id: true },
    })
    changeNumber += 1
    for (const [i, decision] of c.decisions.entries()) {
      await db.changeApproval.create({
        data: {
          orgId: org.id,
          ticketId: change.id,
          approverMembershipId: people.lead,
          decision,
          reason: decision === "REJECTED" ? "Pick a window outside the month-end close." : null,
          decidedAt: at(createdAt, 120 + i * 600),
        },
      })
    }
    if (c.title.startsWith("Fix the daylight-saving")) {
      await db.ticketLink.create({
        data: { orgId: org.id, fromTicketId: problemIds[3] ?? "", toTicketId: change.id, relation: "RESOLVED_BY", createdByMembershipId: people.lead },
      })
    }
  }
  await db.ticketCounter.update({ where: { orgId_type: { orgId: org.id, type: "PROBLEM" } }, data: { nextValue: problemNumber } })
  await db.ticketCounter.update({ where: { orgId_type: { orgId: org.id, type: "CHANGE" } }, data: { nextValue: changeNumber } })

  // A few watched incidents, so the watcher panel and "tickets I watch" have rows.
  for (const [i, incident] of incidents.slice(12, 16).entries()) {
    const watcher = people.watchers[i % people.watchers.length]
    if (watcher === undefined) continue
    await db.ticketWatcher.createMany({
      data: [{ orgId: org.id, ticketId: incident.id, membershipId: watcher, addedByMembershipId: people.lead }],
      skipDuplicates: true,
    })
  }
  return { problems: PROBLEMS.length, changes: CHANGES.length }
}

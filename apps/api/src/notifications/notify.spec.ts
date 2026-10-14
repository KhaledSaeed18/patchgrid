import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { PublicUrls } from "../common/urls"
import type { AppConfig } from "../config/app-config"
import type { MailService } from "../mail/mail.service"
import type { MailJob } from "../mail/templates"
import type { PrismaService } from "../prisma/prisma.service"
import { TicketAudience } from "./audience"
import type { Person, TicketCircle } from "./fan-out"
import { NotifyService } from "./notify"
import type { NewNotification, NotificationRepository } from "./repositories/notification.repository"
import type { TicketCircleRepository } from "./repositories/ticket-circle.repository"

const ORG = "0190b2f0-0000-7000-8000-000000000000"
const NOW = new Date("2026-10-14T09:00:00.000Z")
const person = (id: string, role: Person["role"], teamIds: string[] = []): Person => ({
  membershipId: id,
  userId: `u-${id}`,
  email: `${id}@example.test`,
  emailPrefs: {},
  role,
  teamIds,
  leadOfTeamIds: [],
  active: true,
})

function harness(circle: TicketCircle | null) {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
  const written: NewNotification[] = []
  const notifications = {
    addMany: vi.fn(async (_org: string, notes: NewNotification[], now: Date) => {
      written.push(...notes)
      return notes.map((n, i) => ({
        id: `n-${String(i)}`,
        membershipId: n.membershipId,
        type: n.type,
        title: n.title,
        body: n.body,
        ticketId: n.ticketId,
        count: 1,
        readAt: null,
        createdAt: now,
        updatedAt: now,
        inserted: true,
      }))
    }),
  }
  const order: string[] = []
  const mail = { enqueueAll: vi.fn(async (mails: { job: MailJob; entityId: string }[]) => void order.push(`mail:${String(mails.length)}`)) }
  const service = new NotifyService(
    { load: vi.fn(async () => circle) } as unknown as TicketCircleRepository,
    notifications as unknown as NotificationRepository,
    new TicketAudience(new PermissionService()),
    {
      transaction: async (fn: () => Promise<unknown>) => {
        const result = await fn()
        order.push("commit")
        return result
      },
    } as unknown as PrismaService,
    mail as unknown as MailService,
    new PublicUrls({ ROOT_DOMAIN: "lvh.me", WEB_APP_PORT: 3001, WEB_ORIGIN_PORTS: [3000], isProduction: false } as unknown as AppConfig),
    new FixedClock(NOW),
  )
  return { service, notifications, written, mail, order }
}

const circle = (over: Partial<TicketCircle> = {}): TicketCircle => ({
  ticket: {
    id: "t-1",
    type: "INCIDENT",
    number: 7,
    title: "VPN",
    status: "IN_PROGRESS",
    teamId: "team-net",
    requesterMembershipId: "m-req",
    assigneeMembershipId: "m-agent",
  },
  org: { name: "Acme", slug: "acme", visibility: "OWN_TEAM_ONLY", emailEnabled: true },
  requester: person("m-req", "REQUESTER"),
  assignee: person("m-agent", "AGENT", ["team-net"]),
  teamMembers: [],
  teamLeads: [],
  watchers: [],
  admins: [],
  actorName: null,
  ...over,
})

describe("NotifyService.deliver", () => {
  it("writes every delivery in one statement, with the ticket and dedupe key", async () => {
    const h = harness(circle())
    const out = await h.service.deliver(ORG, { kind: "comment-added", ticketId: "t-1", actorMembershipId: "m-agent", visibility: "PUBLIC" })
    expect(h.notifications.addMany).toHaveBeenCalledTimes(1)
    expect(h.written).toEqual([
      { userId: "u-m-req", membershipId: "m-req", type: "COMMENT_PUBLIC", title: "New reply on INC-000007: VPN", body: null, ticketId: "t-1", dedupeKey: "comment:t-1" },
    ])
    expect(out.map((d) => d.person.membershipId)).toEqual(["m-req"])
  })

  it("drops anyone who could not open the ticket: a requester on the team, an agent of another team", async () => {
    const h = harness(
      circle({
        teamMembers: [person("m-req-on-team", "REQUESTER", ["team-net"]), person("m-mate", "AGENT", ["team-net"])],
        watchers: [person("m-sec", "AGENT", ["team-sec"])],
      }),
    )
    await h.service.deliver(ORG, { kind: "ticket-created", ticketId: "t-1", actorMembershipId: "m-req" })
    expect(h.written.map((n) => n.membershipId)).toEqual(["m-mate"])
  })

  it("never tells a demoted assignee about an internal note", async () => {
    const h = harness(circle({ assignee: person("m-agent", "REQUESTER") }))
    await h.service.deliver(ORG, { kind: "comment-added", ticketId: "t-1", actorMembershipId: "m-lead", visibility: "INTERNAL" })
    expect(h.notifications.addMany).toHaveBeenCalledWith(ORG, [], NOW)
  })

  it("queues the emails after the rows commit, from the workspace, linking to the ticket", async () => {
    const h = harness(circle())
    await h.service.deliver(ORG, { kind: "ticket-assigned", ticketId: "t-1", actorMembershipId: "m-lead", assigneeMembershipId: "m-agent" })
    expect(h.order).toEqual(["commit", "mail:1"])
    expect(h.mail.enqueueAll).toHaveBeenCalledWith([
      {
        entityId: "n-0",
        job: {
          kind: "ticket-notification",
          to: "m-agent@example.test",
          orgId: ORG,
          fromName: "Acme",
          params: {
            orgName: "Acme",
            headline: "Assigned to you — INC-000007: VPN",
            reason: "this ticket is assigned to you",
            ticketUrl: "http://acme.lvh.me:3001/tickets/t-1",
            preferencesUrl: "http://acme.lvh.me:3001/notifications/preferences",
            ticketId: "t-1",
            ticketNumber: "INC-000007",
            replyTo: "acme@inbound.lvh.me",
          },
        },
      },
    ])
  })

  it("keeps the rows when the mail queue is down — the job must not retry and fold them twice", async () => {
    const h = harness(circle())
    h.mail.enqueueAll.mockRejectedValue(new Error("redis down"))
    const out = await h.service.deliver(ORG, { kind: "ticket-assigned", ticketId: "t-1", actorMembershipId: "m-lead", assigneeMembershipId: "m-agent" })
    expect(out).toHaveLength(1)
  })

  it("does nothing for a ticket that is gone", async () => {
    const h = harness(null)
    expect(await h.service.deliver(ORG, { kind: "ticket-reopened", ticketId: "t-1", actorMembershipId: null, comment: null })).toEqual([])
    expect(h.notifications.addMany).not.toHaveBeenCalled()
  })
})

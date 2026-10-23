import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { PublicUrls } from "../common/urls"
import type { AppConfig } from "../config/app-config"
import type { MailService } from "../mail/mail.service"
import type { MailJob } from "../mail/templates"
import { EventConsumers } from "../events/consumer"
import { isTransient, TransientFailure } from "../events/relay"
import type { StoredEvent } from "../events/repositories/outbox.repository"
import { TicketAudience } from "./audience"
import type { Person, TicketCircle } from "./fan-out"
import type { StreamBus } from "./live/stream-bus"
import { NotifyConsumer, NotifyService } from "./notify"
import type { NotifyEvent } from "./notify-events"
import type { NewNotification, NotificationRepository } from "./repositories/notification.repository"
import type { TicketCircleRepository } from "./repositories/ticket-circle.repository"

const ORG = "0190b2f0-0000-7000-8000-000000000000"
/** A UUID per name: the consumer reads events as the wire would, ids and all. */
const M = (name: string) => `0190b2f0-0000-7000-8000-${Buffer.from(name).toString("hex").slice(-12).padStart(12, "0")}`
const T1 = "0190b2f0-0000-7000-8000-0000000000f1"
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
    mail as unknown as MailService,
    new PublicUrls({ ROOT_DOMAIN: "lvh.me", WEB_APP_PORT: 3001, WEB_ORIGIN_PORTS: [3000], isProduction: false } as unknown as AppConfig),
    new FixedClock(NOW),
  )
  const bus = { publish: vi.fn(async () => undefined) }
  const consumer = new NotifyConsumer(new EventConsumers(), service, bus as unknown as StreamBus)
  /** The consumer's transaction for one event; the returned function is what runs after its commit. */
  const handle = (...events: NotifyEvent[]) => consumer.handle(ORG, events.map(stored))
  return { handle, consumer, notifications, written, mail, order, bus }
}

let seq = 0
const stored = (event: NotifyEvent): StoredEvent => ({
  id: `e-${String((seq += 1))}`,
  txn: BigInt(seq),
  type: event.kind,
  payload: event,
  occurredAt: NOW,
})

const circle = (over: Partial<TicketCircle> = {}): TicketCircle => ({
  ticket: {
    id: T1,
    type: "INCIDENT",
    number: 7,
    title: "VPN",
    status: "IN_PROGRESS",
    teamId: "team-net",
    requesterMembershipId: M("m-req"),
    assigneeMembershipId: M("m-agent"),
  },
  org: { name: "Acme", slug: "acme", visibility: "OWN_TEAM_ONLY", emailEnabled: true },
  requester: person(M("m-req"), "REQUESTER"),
  assignee: person(M("m-agent"), "AGENT", ["team-net"]),
  teamMembers: [],
  teamLeads: [],
  watchers: [],
  admins: [],
  actorName: null,
  ...over,
})

describe("NotifyConsumer", () => {
  it("writes every delivery in one statement, with the ticket and dedupe key", async () => {
    const h = harness(circle())
    const after = await h.handle({ kind: "comment-added", ticketId: T1, actorMembershipId: M("m-agent"), visibility: "PUBLIC" })
    expect(h.notifications.addMany).toHaveBeenCalledTimes(1)
    expect(h.written).toEqual([
      { userId: `u-${M("m-req")}`, membershipId: M("m-req"), type: "COMMENT_PUBLIC", title: "New reply on INC-000007: VPN", body: null, ticketId: T1, dedupeKey: `comment:${T1}` },
    ])
    // The stream hears of the row only once the cursor that wrote it has committed.
    expect(h.bus.publish).not.toHaveBeenCalled()
    await after()
    expect(h.bus.publish).toHaveBeenCalledWith(ORG, expect.objectContaining({ kind: "notification", membershipId: M("m-req") }))
  })

  it("drops anyone who could not open the ticket: a requester on the team, an agent of another team", async () => {
    const h = harness(
      circle({
        teamMembers: [person(M("m-req-on-team"), "REQUESTER", ["team-net"]), person(M("m-mate"), "AGENT", ["team-net"])],
        watchers: [person(M("m-sec"), "AGENT", ["team-sec"])],
      }),
    )
    await h.handle({ kind: "ticket-created", ticketId: T1, actorMembershipId: M("m-req") })
    expect(h.written.map((n) => n.membershipId)).toEqual([M("m-mate")])
  })

  it("never tells a demoted assignee about an internal note", async () => {
    const h = harness(circle({ assignee: person(M("m-agent"), "REQUESTER") }))
    await h.handle({ kind: "comment-added", ticketId: T1, actorMembershipId: M("m-lead"), visibility: "INTERNAL" })
    expect(h.notifications.addMany).toHaveBeenCalledWith(ORG, [], NOW)
  })

  it("queues the emails before the cursor commits, from the workspace, linking to the ticket", async () => {
    const h = harness(circle())
    const event = stored({ kind: "ticket-assigned", ticketId: T1, actorMembershipId: M("m-lead"), assigneeMembershipId: M("m-agent") })
    const after = await h.consumer.handle(ORG, [event])
    // In the transaction, so a queue that refuses rolls the batch back instead of losing the email.
    expect(h.order).toEqual(["mail:1"])
    await after()
    expect(h.order).toEqual(["mail:1"])
    expect(h.mail.enqueueAll).toHaveBeenCalledWith([
      {
        entityId: `${event.id}-${M("m-agent")}`,
        job: {
          kind: "ticket-notification",
          to: `${M("m-agent")}@example.test`,
          orgId: ORG,
          fromName: "Acme",
          params: {
            orgName: "Acme",
            headline: "Assigned to you — INC-000007: VPN",
            reason: "this ticket is assigned to you",
            ticketUrl: `http://acme.lvh.me:3001/tickets/${T1}`,
            preferencesUrl: "http://acme.lvh.me:3001/notifications/preferences",
            ticketId: T1,
            ticketNumber: "INC-000007",
            replyTo: "acme@inbound.lvh.me",
          },
        },
      },
    ])
  })

  it("fails the batch, as the job's trouble and not the event's, when the mail queue refuses", async () => {
    const h = harness(circle())
    h.mail.enqueueAll.mockRejectedValue(new Error("redis down"))
    const failure = await h.handle({ kind: "ticket-assigned", ticketId: T1, actorMembershipId: M("m-lead"), assigneeMembershipId: M("m-agent") }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransientFailure)
    expect(isTransient(failure)).toBe(true)
    expect(h.bus.publish).not.toHaveBeenCalled()
  })

  it("does nothing for a ticket that is gone", async () => {
    const h = harness(null)
    await (await h.handle({ kind: "ticket-reopened", ticketId: T1, actorMembershipId: null, comment: null }))()
    expect(h.notifications.addMany).not.toHaveBeenCalled()
    expect(h.bus.publish).not.toHaveBeenCalled()
  })

  it("skips the log's other event types, and fails on a notify event it cannot read", async () => {
    const h = harness(circle())
    await h.consumer.handle(ORG, [{ id: "e-x", txn: 1n, type: "webhook-only", payload: {}, occurredAt: NOW }])
    expect(h.notifications.addMany).not.toHaveBeenCalled()
    await expect(h.consumer.handle(ORG, [{ id: "e-y", txn: 2n, type: "ticket-created", payload: { ticketId: 7 }, occurredAt: NOW }])).rejects.toThrow()
  })

  it("registers itself as the notify consumer", () => {
    const consumers = new EventConsumers()
    const h = harness(circle())
    const consumer = new NotifyConsumer(consumers, {} as NotifyService, h.bus as unknown as StreamBus)
    consumer.onModuleInit()
    expect(consumers.get("notify")).toBe(consumer)
  })
})

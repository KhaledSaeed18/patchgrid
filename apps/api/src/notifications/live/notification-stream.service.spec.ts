import { Logger } from "@nestjs/common"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ActorService, Credential, MemberActor } from "../../auth/actor"
import type { StandingService } from "../../auth/sessions/standing.service"
import { PermissionService } from "../../authz/permission.service"
import { FixedClock } from "../../common/clock/clock"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import { TicketAudience } from "../audience"
import type { NotificationRepository, NotificationRow } from "../repositories/notification.repository"
import {
  HEARTBEAT_MS,
  MAX_STREAM_MS,
  MAX_STREAMS_PER_MEMBER,
  NotificationStreamService,
  readerOf,
  type StreamFrame,
} from "./notification-stream.service"
import type { StreamBus, StreamListener, StreamMessage } from "./stream-bus"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const ID = (n: number) => `0190b2f0-0000-7000-8000-${String(n).padStart(12, "0")}`
const NOW = new Date("2026-10-14T09:00:00.000Z")
const nowSeconds = NOW.getTime() / 1000

const agent = (over: Partial<MemberActor> = {}): MemberActor => ({
  kind: "member",
  userId: ID(100),
  orgId: ORG,
  membershipId: ID(1),
  role: "AGENT",
  teamIds: [ID(50)],
  leadOfTeamIds: [],
  ...over,
})

const ticketUpdated = (over: Partial<Extract<StreamMessage, { kind: "ticket-updated" }>["ticket"]> = {}): StreamMessage => ({
  kind: "ticket-updated",
  ticket: {
    type: "INCIDENT",
    status: "IN_PROGRESS",
    teamId: ID(50),
    requesterMembershipId: ID(9),
    assigneeMembershipId: null,
    watcherMembershipIds: [],
    ...over,
  },
  visibility: "OWN_TEAM_ONLY",
  content: "ticket",
  event: { ticketId: ID(77), updatedAt: NOW.toISOString() },
})

function harness(options: { actor?: MemberActor; credential?: Credential; replay?: NotificationRow[] } = {}) {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
  const listeners: { orgId: string; listener: StreamListener }[] = []
  const unsubscribe = vi.fn()
  const bus = {
    subscribe: vi.fn(async (orgId: string, listener: StreamListener) => {
      listeners.push({ orgId, listener })
      return unsubscribe
    }),
  }
  const notifications = { since: vi.fn(async () => options.replay ?? []) }
  const standing = { check: vi.fn(async (actor: MemberActor): Promise<MemberActor | null> => actor) }
  const actor = options.actor ?? agent()
  const service = new NotificationStreamService(
    bus as unknown as StreamBus,
    new TicketAudience(new PermissionService()),
    notifications as unknown as NotificationRepository,
    standing as unknown as StandingService,
    new PermissionService(),
    {
      requireTenantActor: () => actor,
      credential: () => options.credential ?? { issuedAt: nowSeconds - 60, expiresAt: nowSeconds + 840 },
    } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    new FixedClock(NOW),
  )
  const send = (message: StreamMessage) => {
    for (const l of listeners) l.listener(message)
  }
  return { service, bus, listeners, send, unsubscribe, standing, notifications }
}

async function collect(h: ReturnType<typeof harness>, lastEventId?: string) {
  const frames: StreamFrame[] = []
  let done = false
  const subscription = (await h.service.open(lastEventId)).subscribe({ next: (f) => frames.push(f), complete: () => (done = true) })
  return { frames, isDone: () => done, subscription }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("NotificationStreamService", () => {
  it("listens on the credential's org alone", async () => {
    const h = harness()
    await collect(h)
    expect(h.listeners.map((l) => l.orgId)).toEqual([ORG])
  })

  it("passes a notification only to its recipient", async () => {
    const h = harness()
    const s = await collect(h)
    const event = { id: ID(500), type: "TICKET_ASSIGNED" as const, title: "Assigned to you", ticketId: ID(77) }
    h.send({ kind: "notification", membershipId: ID(2), event })
    h.send({ kind: "notification", membershipId: ID(1), event })
    expect(s.frames).toEqual([{ event: "notification", id: ID(500), data: event }])
  })

  it("passes a ticket update only when the member may read the ticket", async () => {
    const h = harness()
    const s = await collect(h)
    h.send(ticketUpdated({ teamId: ID(51) }))
    h.send(ticketUpdated({ teamId: ID(51), watcherMembershipIds: [ID(1)] }))
    h.send(ticketUpdated())
    expect(s.frames).toHaveLength(2)
    const requester = harness({ actor: agent({ role: "REQUESTER", teamIds: [ID(50)] }) })
    const r = await collect(requester)
    requester.send(ticketUpdated())
    requester.send(ticketUpdated({ requesterMembershipId: ID(1) }))
    expect(r.frames).toHaveLength(1)
  })

  it("replays what came after Last-Event-ID first, and ignores one that is not an id", async () => {
    const row: NotificationRow = {
      id: ID(600),
      type: "COMMENT_PUBLIC",
      title: "New reply",
      body: null,
      ticketId: ID(77),
      count: 2,
      readAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const h = harness({ replay: [row] })
    const s = await collect(h, ID(599))
    expect(h.notifications.since).toHaveBeenCalledWith(ORG, ID(100), ID(599), 50)
    expect(s.frames[0]).toEqual({
      event: "notification",
      id: ID(600),
      data: { id: ID(600), type: "COMMENT_PUBLIC", title: "New reply", ticketId: ID(77) },
    })
    const bogus = harness()
    await collect(bogus, "'; drop table")
    expect(bogus.notifications.since).not.toHaveBeenCalled()
  })

  it("beats every 25 seconds while the session stands, and ends when it no longer does", async () => {
    const h = harness()
    const s = await collect(h)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.frames).toEqual([{ comment: "heartbeat" }])
    expect(h.standing.check).toHaveBeenCalledWith(agent(), nowSeconds - 60)
    h.standing.check.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.isDone()).toBe(true)
    expect(h.unsubscribe).toHaveBeenCalled()
  })

  it("decides on the member as the last heartbeat found them — a team change takes effect within one", async () => {
    const h = harness()
    const s = await collect(h)
    h.send(ticketUpdated())
    expect(s.frames).toHaveLength(1)
    h.standing.check.mockResolvedValue(agent({ teamIds: [] }))
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    h.send(ticketUpdated())
    expect(s.frames.filter((f) => "event" in f)).toHaveLength(1)
  })

  it("ends rather than guess when the check itself fails", async () => {
    const h = harness()
    const s = await collect(h)
    h.standing.check.mockRejectedValue(new Error("database unreachable"))
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.isDone()).toBe(true)
  })

  it("keeps an internal note's activity from those who may not read notes", async () => {
    const requester = harness({ actor: agent({ role: "REQUESTER" }) })
    const r = await collect(requester)
    requester.send({ ...ticketUpdated({ requesterMembershipId: ID(1) }), content: "internal" } as StreamMessage)
    expect(r.frames).toEqual([])
    const h = harness()
    const s = await collect(h)
    h.send({ ...ticketUpdated(), content: "internal" } as StreamMessage)
    expect(s.frames).toHaveLength(1)
  })

  it("ends a member's oldest stream past the cap", async () => {
    const h = harness()
    const streams = []
    for (let i = 0; i <= MAX_STREAMS_PER_MEMBER; i += 1) streams.push(await collect(h))
    expect(streams.map((s) => s.isDone())).toEqual([true, ...Array.from({ length: MAX_STREAMS_PER_MEMBER }, () => false)])
  })

  it("ends when the access token lapses, and never later than thirty minutes", async () => {
    const short = harness({ credential: { issuedAt: nowSeconds - 800, expiresAt: nowSeconds + 100 } })
    const s = await collect(short)
    await vi.advanceTimersByTimeAsync(99_000)
    expect(s.isDone()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.isDone()).toBe(true)

    const long = harness({ credential: { issuedAt: nowSeconds, expiresAt: nowSeconds + 3_600 } })
    const l = await collect(long)
    await vi.advanceTimersByTimeAsync(MAX_STREAM_MS)
    expect(l.isDone()).toBe(true)
  })

  it("lets the client's disconnect stop the subscription", async () => {
    const h = harness()
    const s = await collect(h)
    s.subscription.unsubscribe()
    expect(h.unsubscribe).toHaveBeenCalled()
  })

  it("refuses a service account — it has no inbox", async () => {
    const h = harness()
    const service = new NotificationStreamService(
      h.bus as unknown as StreamBus,
      new TicketAudience(new PermissionService()),
      h.notifications as unknown as NotificationRepository,
      h.standing as unknown as StandingService,
      new PermissionService(),
      {
        requireTenantActor: () => ({ kind: "service", orgId: ORG, membershipId: ID(3), role: "AGENT", scopes: ["tickets:read"] }),
        credential: () => undefined,
      } as unknown as ActorService,
      { requireOrgId: () => ORG } as unknown as TenantContextService,
      new FixedClock(NOW),
    )
    await expect(service.open(undefined)).rejects.toThrow()
    expect(h.bus.subscribe).not.toHaveBeenCalled()
  })

  it("reads the member as authorization does", () => {
    expect(readerOf(agent())).toEqual({ membershipId: ID(1), userId: ID(100), role: "AGENT", teamIds: [ID(50)], leadOfTeamIds: [] })
  })
})

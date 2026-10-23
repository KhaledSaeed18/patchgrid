import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../../auth/actor"
import type { AuditEntry, AuditService } from "../../audit/audit.service"
import { PermissionService } from "../../authz/permission.service"
import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, ReplayFailedProblem } from "../../common/problems/problem.exception"
import type { PrismaService } from "../../prisma/prisma.service"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import { EventConsumers } from "../consumer"
import { TransientFailure } from "../relay"
import type { DeadLetterRepository, DeadLetterRow } from "../repositories/dead-letter.repository"
import type { OutboxRepository } from "../repositories/outbox.repository"
import { DeadLettersService } from "./dead-letters.service"

const NOW = new Date("2026-10-23T12:00:00Z")
const ID = "0190b2f0-0000-7000-8000-0000000000d1"
const EVENT = "0190b2f0-0000-7000-8000-0000000000e1"

type Options = { role?: Role; row?: Partial<DeadLetterRow> | null; handle?: Error }

function harness(options: Options = {}) {
  const order: string[] = []
  const row: DeadLetterRow | null =
    options.row === null
      ? null
      : {
          id: ID,
          consumer: "notify",
          failures: 3,
          error: "gave up after repeated failures",
          parkedAt: new Date("2026-10-22T09:00:00Z"),
          replayedAt: null,
          event: { id: EVENT, txn: 42n, type: "ticket-assigned", payload: {}, occurredAt: new Date("2026-10-22T08:59:00Z") },
          ...options.row,
        }
  const letters = {
    list: vi.fn(async () => (row === null ? [] : [row])),
    lockOne: vi.fn(async () => (row === null ? null : { ...row })),
    markReplayed: vi.fn(async (_o: string, _id: string, at: Date) => {
      order.push("marked")
      return { ...(row as DeadLetterRow), replayedAt: at }
    }),
    recordFailure: vi.fn(async () => void order.push("failure recorded")),
  }
  const outbox = { lock: vi.fn(async (_o: string, consumer: string) => void order.push(`lock:${consumer}`)) }
  const consumers = new EventConsumers()
  const handle = vi.fn(async () => {
    order.push("handled")
    if (options.handle !== undefined) throw options.handle
    return async () => void order.push("after commit")
  })
  consumers.register({ name: "notify", handle })
  const audit: AuditEntry[] = []
  const actor: MemberActor = {
    kind: "member",
    userId: "u-1",
    orgId: "o-1",
    membershipId: "m-1",
    role: options.role ?? "ADMIN",
    teamIds: [],
    leadOfTeamIds: [],
  }
  const service = new DeadLettersService(
    letters as unknown as DeadLetterRepository,
    outbox as unknown as OutboxRepository,
    consumers,
    { record: async (_o: string, e: AuditEntry[]) => void audit.push(...e) } as unknown as AuditService,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    {
      transaction: async (fn: () => Promise<unknown>) => {
        const result = await fn()
        order.push("commit")
        return result
      },
    } as unknown as PrismaService,
    new FixedClock(NOW),
  )
  return { service, letters, outbox, handle, audit, order }
}

const problem = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  )

describe("DeadLettersService", () => {
  it("is for admins and owners", async () => {
    for (const role of ["REQUESTER", "AGENT"] as const) {
      expect(await problem(harness({ role }).service.list())).toBeInstanceOf(NotPermittedProblem)
      expect(await problem(harness({ role }).service.replay(ID))).toBeInstanceOf(NotPermittedProblem)
    }
    expect((await harness({ role: "OWNER" }).service.list()).items).toHaveLength(1)
  })

  it("lists what was parked, with the event it holds back", async () => {
    const { items } = await harness().service.list()
    expect(items).toEqual([
      {
        id: ID,
        consumer: "notify",
        eventId: EVENT,
        eventType: "ticket-assigned",
        occurredAt: "2026-10-22T08:59:00.000Z",
        failures: 3,
        error: "gave up after repeated failures",
        parkedAt: "2026-10-22T09:00:00.000Z",
        replayedAt: null,
      },
    ])
  })

  it("replays through the consumer under its lock, audited with the mark, the after-commit work last", async () => {
    const h = harness()
    const replayed = await h.service.replay(ID)
    expect(replayed.replayedAt).toBe(NOW.toISOString())
    expect(h.order).toEqual(["lock:notify", "handled", "marked", "commit", "after commit"])
    expect(h.audit).toEqual([
      {
        action: "EVENT_REPLAYED",
        entityType: "EventDeadLetter",
        entityId: ID,
        diff: { consumer: "notify", eventId: EVENT, eventType: "ticket-assigned" },
      },
    ])
  })

  it("is 404 for a dead letter that is not this workspace's, and 409 once replayed", async () => {
    expect(await problem(harness({ row: null }).service.replay(ID))).toBeInstanceOf(NotFoundProblem)
    const done = harness({ row: { replayedAt: NOW } })
    expect(await problem(done.service.replay(ID))).toBeInstanceOf(ConflictProblem)
    expect(done.handle).not.toHaveBeenCalled()
  })

  it("keeps a replay that fails again parked, with its newer error", async () => {
    const h = harness({ handle: new Error("payload does not parse") })
    const failure = await problem(h.service.replay(ID))
    expect(failure).toBeInstanceOf(ReplayFailedProblem)
    expect((failure as ReplayFailedProblem).detail).toBe("payload does not parse")
    expect(h.letters.markReplayed).not.toHaveBeenCalled()
    expect(h.letters.recordFailure).toHaveBeenCalledWith("o-1", ID, "payload does not parse")
  })

  it("does not blame the event for the database's or a queue's moment of trouble", async () => {
    const h = harness({ handle: new TransientFailure("mail queue refused") })
    expect(await problem(h.service.replay(ID))).toBeInstanceOf(TransientFailure)
    expect(h.letters.recordFailure).not.toHaveBeenCalled()
  })
})

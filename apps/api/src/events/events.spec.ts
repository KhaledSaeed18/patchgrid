import { Logger } from "@nestjs/common"
import type { Job, Queue } from "bullmq"
import { UnrecoverableError } from "bullmq"
import { describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../config/app-config"
import type { RedisService } from "../redis/redis.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { EventConsumers, type EventConsumer } from "./consumer"
import { DrainProcessor, RETRY_SOON_MS } from "./drain.processor"
import { DrainRequests, pendingKey } from "./drain-requests"
import { Outbox } from "./outbox"
import { type DrainOutcome, type EventRelay, failureBackoffMs, isTransient, TransientFailure } from "./relay"
import type { OutboxRepository } from "./repositories/outbox.repository"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"

/** A Redis that honours `SET … NX` and `DEL`, and a queue that records what it was given. */
function requests(options: { queueFails?: boolean } = {}) {
  const keys = new Set<string>()
  const redis = {
    client: {
      set: vi.fn(async (key: string) => {
        if (keys.has(key)) return null
        keys.add(key)
        return "OK"
      }),
      del: vi.fn(async (key: string) => Number(keys.delete(key))),
    },
  }
  const added: { data: unknown; opts: { jobId: string; delay?: number } }[] = []
  const queue = {
    add: vi.fn(async (...[, data, opts]: [string, unknown, { jobId: string; delay?: number }]) => {
      if (options.queueFails === true) throw new Error("redis down")
      added.push({ data, opts })
    }),
  }
  return { keys, added, service: new DrainRequests(redis as unknown as RedisService, queue as unknown as Queue) }
}

describe("DrainRequests", () => {
  it("keeps at most one waiting drain per tenant and consumer", async () => {
    const r = requests()
    expect(await r.service.request(ORG, "notify")).toBe(true)
    expect(await r.service.request(ORG, "notify")).toBe(false)
    expect(r.added).toHaveLength(1)
    expect(r.added[0]?.data).toEqual({ orgId: ORG, consumer: "notify" })
    expect(r.added[0]?.opts.jobId).toMatch(new RegExp(`^outbox-drain/${ORG}/notify/`))
  })

  it("lets a request made after the drain started enqueue the next drain", async () => {
    const r = requests()
    await r.service.request(ORG, "notify")
    await r.service.started(ORG, "notify")
    expect(await r.service.request(ORG, "notify")).toBe(true)
    expect(r.added).toHaveLength(2)
    // Each drain is its own job: the second does not collide with the first's id.
    expect(r.added[0]?.opts.jobId).not.toBe(r.added[1]?.opts.jobId)
  })

  it("delays when asked, and frees the flag when the queue refuses, without throwing", async () => {
    const delayed = requests()
    await delayed.service.request(ORG, "notify", 250)
    expect(delayed.added[0]?.opts.delay).toBe(250)

    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    const down = requests({ queueFails: true })
    expect(await down.service.request(ORG, "notify")).toBe(false)
    expect(down.keys.has(pendingKey(ORG, "notify"))).toBe(false)
  })
})

describe("DrainProcessor", () => {
  function processor(outcome: DrainOutcome) {
    const order: string[] = []
    const relay = { drain: vi.fn(async () => (order.push("drain"), outcome)) }
    const drains = {
      started: vi.fn(async () => void order.push("started")),
      request: vi.fn(async (...[, , delay]: [string, string, number?]) => (order.push(`request:${String(delay ?? 0)}`), true)),
    }
    const p = new DrainProcessor(relay as unknown as EventRelay, drains as unknown as DrainRequests, { WORKER_MODE: "api" } as AppConfig)
    const job = { id: "j-1", data: { orgId: ORG, consumer: "notify" } } as unknown as Job
    return { p, job, order }
  }

  it("clears the flag before it reads, so a wake during the drain is never lost", async () => {
    const h = processor({ kind: "idle", heldBack: false })
    await h.p.process(h.job)
    expect(h.order).toEqual(["started", "drain"])
  })

  it("goes to the back of the queue after a full batch, and comes back soon when locked out or held back", async () => {
    const full = processor({ kind: "drained", count: 100, parked: 0, more: true })
    await full.p.process(full.job)
    expect(full.order.at(-1)).toBe("request:0")

    const busy = processor({ kind: "busy" })
    await busy.p.process(busy.job)
    expect(busy.order.at(-1)).toBe(`request:${String(RETRY_SOON_MS)}`)

    const held = processor({ kind: "idle", heldBack: true })
    await held.p.process(held.job)
    expect(held.order.at(-1)).toBe(`request:${String(RETRY_SOON_MS)}`)

    const done = processor({ kind: "drained", count: 3, parked: 0, more: false })
    await done.p.process(done.job)
    expect(done.order).toEqual(["started", "drain"])
  })

  it("refuses a job that names no tenant or no known consumer", async () => {
    const h = processor({ kind: "idle", heldBack: false })
    await expect(h.p.process({ id: "j", data: { consumer: "notify" } } as unknown as Job)).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(h.p.process({ id: "j", data: { orgId: ORG, consumer: "nobody" } } as unknown as Job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(h.order).toEqual([])
  })
})

describe("Outbox.append", () => {
  function outbox(tenant: { orgId: string; inTransaction: boolean } | undefined) {
    const repository = { append: vi.fn(async () => undefined) }
    return {
      repository,
      outbox: new Outbox(repository as unknown as OutboxRepository, { current: () => tenant } as unknown as TenantContextService),
    }
  }

  it("writes inside the change's transaction, for its tenant", async () => {
    const h = outbox({ orgId: ORG, inTransaction: true })
    await h.outbox.append(ORG, [{ type: "ticket-created", payload: {} }])
    expect(h.repository.append).toHaveBeenCalledWith(ORG, [{ type: "ticket-created", payload: {} }])
  })

  it("refuses outside a transaction, or for another tenant than the one it is in", async () => {
    await expect(outbox({ orgId: ORG, inTransaction: false }).outbox.append(ORG, [{ type: "x", payload: {} }])).rejects.toThrow()
    await expect(outbox(undefined).outbox.append(ORG, [{ type: "x", payload: {} }])).rejects.toThrow()
    await expect(
      outbox({ orgId: "0190b2f0-0000-7000-8000-00000000000b", inTransaction: true }).outbox.append(ORG, [{ type: "x", payload: {} }]),
    ).rejects.toThrow()
  })

  it("does nothing for nothing, wherever it is", async () => {
    const h = outbox(undefined)
    await h.outbox.append(ORG, [])
    expect(h.repository.append).not.toHaveBeenCalled()
  })
})

describe("EventConsumers", () => {
  it("registers each consumer once and finds it by name", () => {
    const consumers = new EventConsumers()
    const notify = { name: "notify", handle: vi.fn() } as unknown as EventConsumer
    consumers.register(notify)
    expect(consumers.get("notify")).toBe(notify)
    expect(consumers.names()).toEqual(["notify"])
    expect(() => consumers.register(notify)).toThrow(/twice/)
  })
})

describe("event failures", () => {
  it("wait longer after each failure of the same event: 2 s, 8 s, 32 s", () => {
    expect([1, 2, 3].map(failureBackoffMs)).toEqual([2_000, 8_000, 32_000])
  })

  it("tell the database's trouble from the event's, wherever the driver wrapped the code", () => {
    expect(isTransient({ code: "40P01" })).toBe(true)
    expect(isTransient({ message: "wrapped", meta: { driverAdapterError: { cause: { code: "40001" } } } })).toBe(true)
    expect(isTransient({ code: "P2028" })).toBe(true)
    expect(isTransient(new Error("ticket payload does not parse"))).toBe(false)
    // A consumer's own word for it: a dependency that refused for a moment.
    expect(isTransient(new TransientFailure("mail queue refused"))).toBe(true)
    expect(isTransient({ code: "23505" })).toBe(false)
  })
})

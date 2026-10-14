import { Logger } from "@nestjs/common"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../../config/app-config"
import type { RedisService } from "../../redis/redis.service"
import { channelFor, StreamBus, type StreamMessage } from "./stream-bus"

/** A subscriber connection whose SUBSCRIBE replies when the spec says so. */
const fake = vi.hoisted(() => {
  type Pending = { channel: string; resolve: () => void; reject: (e: Error) => void }
  type OnMessage = (channel: string, message: string) => void
  const state: { pending: Pending[]; commands: string[]; onMessage: OnMessage } = { pending: [], commands: [], onMessage: () => undefined }
  class FakeRedis {
    on(event: string, handler: (channel: string, message: string) => void) {
      if (event === "message") state.onMessage = handler
      return this
    }
    subscribe(channel: string) {
      state.commands.push(`SUBSCRIBE ${channel}`)
      return new Promise<void>((resolve, reject) => state.pending.push({ channel, resolve, reject }))
    }
    unsubscribe(channel: string) {
      state.commands.push(`UNSUBSCRIBE ${channel}`)
      return Promise.resolve()
    }
    disconnect() {}
  }
  return { state, FakeRedis }
})
vi.mock("ioredis", () => ({ default: fake.FakeRedis }))

const A = "0190b2f0-0000-7000-8000-00000000000a"
const B = "0190b2f0-0000-7000-8000-00000000000b"
const message = (id: string): StreamMessage => ({
  kind: "notification",
  membershipId: A,
  event: { id, type: "TICKET_ASSIGNED", title: "t", ticketId: null },
})
const deliver = (orgId: string, m: unknown) => fake.state.onMessage(channelFor(orgId), JSON.stringify(m))
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

let bus: StreamBus
beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  fake.state.pending = []
  fake.state.commands = []
  bus = new StreamBus({ client: { publish: vi.fn() } } as unknown as RedisService, { REDIS_URL: "redis://x" } as AppConfig)
})

describe("StreamBus", () => {
  it("names a channel by org, and refuses anything that is not an org id", () => {
    expect(channelFor(A)).toBe(`org:${A}:notifications`)
    expect(() => channelFor("*")).toThrow()
  })

  it("delivers a channel's messages to that org's listeners only", async () => {
    const [a, b] = [vi.fn(), vi.fn()]
    const subscribing = [bus.subscribe(A, a), bus.subscribe(B, b)]
    for (const p of fake.state.pending) p.resolve()
    await Promise.all(subscribing)
    deliver(A, message(A))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it("does not lose a stream whose SUBSCRIBE is in flight when another on the channel leaves", async () => {
    const first = vi.fn()
    const second = vi.fn()
    const waiting = bus.subscribe(A, first)
    const joining = bus.subscribe(A, second)
    expect(fake.state.commands).toEqual([`SUBSCRIBE ${channelFor(A)}`])
    fake.state.pending[0]?.resolve()
    const [, leaveSecond] = await Promise.all([waiting, joining])
    leaveSecond()
    expect(fake.state.commands).toEqual([`SUBSCRIBE ${channelFor(A)}`])
    deliver(A, message(A))
    expect(first).toHaveBeenCalledTimes(1)
  })

  it("forgets a channel whose SUBSCRIBE failed, so the next stream subscribes again", async () => {
    const failed = bus.subscribe(A, vi.fn())
    fake.state.pending[0]?.reject(new Error("redis down"))
    await expect(failed).rejects.toThrow("redis down")
    const retried = bus.subscribe(A, vi.fn())
    expect(fake.state.commands).toEqual([`SUBSCRIBE ${channelFor(A)}`, `SUBSCRIBE ${channelFor(A)}`])
    fake.state.pending[1]?.resolve()
    await retried
  })

  it("unsubscribes when the last stream leaves, and only once", async () => {
    const p = bus.subscribe(A, vi.fn())
    fake.state.pending[0]?.resolve()
    const leave = await p
    leave()
    leave()
    await settle()
    expect(fake.state.commands).toEqual([`SUBSCRIBE ${channelFor(A)}`, `UNSUBSCRIBE ${channelFor(A)}`])
  })

  it("keeps delivering to the others when one listener throws, and drops what it cannot read", async () => {
    const after = vi.fn()
    const p = Promise.all([
      bus.subscribe(A, () => {
        throw new Error("boom")
      }),
      bus.subscribe(A, after),
    ])
    fake.state.pending[0]?.resolve()
    await p
    deliver(A, message(A))
    expect(after).toHaveBeenCalledTimes(1)
    fake.state.onMessage(channelFor(A), "not json")
    deliver(A, { kind: "ticket-updated" })
    expect(after).toHaveBeenCalledTimes(1)
  })
})

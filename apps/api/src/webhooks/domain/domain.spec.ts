import { describe, expect, it } from "vitest"

import { WEBHOOK_SECRET_PATTERN } from "@patchgrid/contracts"

import { afterFailure, afterSuccess, CIRCUIT_MAX_OPEN_MS, CIRCUIT_THRESHOLD, MAX_ATTEMPTS, nextDelayMs, waitForCircuit } from "./schedule"
import { newWebhookSecret, sign, signatureHeaders, verify } from "./signature"

describe("the Standard Webhooks signature", () => {
  it("matches the specification's published test vector", () => {
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" // gitleaks:allow
    expect(sign(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=") // gitleaks:allow
  })

  it("signs with every secret in force, and a receiver holding either verifies", () => {
    const current = newWebhookSecret()
    const previous = newWebhookSecret()
    const headers = signatureHeaders([current, previous], "d-1", 1_000, "{}")
    const received = { id: headers["webhook-id"] ?? "", timestamp: headers["webhook-timestamp"] ?? "", signature: headers["webhook-signature"] ?? "" }
    expect(received.signature.split(" ")).toHaveLength(2)
    expect(verify(current, received, "{}", 1_000)).toBe(true)
    expect(verify(previous, received, "{}", 1_000)).toBe(true)
    expect(verify(newWebhookSecret(), received, "{}", 1_000)).toBe(false)
  })

  it("fails a changed body, a changed id and a stale timestamp", () => {
    const secret = newWebhookSecret()
    const signature = sign(secret, "d-1", 1_000, '{"a":1}')
    expect(verify(secret, { id: "d-1", timestamp: "1000", signature }, '{"a":2}', 1_000)).toBe(false)
    expect(verify(secret, { id: "d-2", timestamp: "1000", signature }, '{"a":1}', 1_000)).toBe(false)
    expect(verify(secret, { id: "d-1", timestamp: "1000", signature }, '{"a":1}', 1_000 + 301)).toBe(false)
  })

  it("makes secrets of the published shape", () => {
    expect(newWebhookSecret()).toMatch(WEBHOOK_SECRET_PATTERN)
    expect(newWebhookSecret()).not.toBe(newWebhookSecret())
  })
})

describe("the retry schedule", () => {
  it("waits longer each time, within the jitter, and stops after the last attempt", () => {
    expect(nextDelayMs(0, 0.5)).toBe(0)
    expect(nextDelayMs(1, 0.5)).toBe(5_000)
    expect(nextDelayMs(2, 0)).toBe(Math.round(5 * 60_000 * 0.8))
    expect(nextDelayMs(2, 0.999999)).toBeLessThanOrEqual(Math.round(5 * 60_000 * 1.2))
    expect(nextDelayMs(MAX_ATTEMPTS - 1, 0.5)).toBe(10 * 3_600_000)
    expect(nextDelayMs(MAX_ATTEMPTS, 0.5)).toBeNull()
  })
})

describe("the circuit", () => {
  const t0 = new Date("2026-10-17T00:00:00Z")
  const at = (ms: number) => new Date(t0.getTime() + ms)

  it("stays closed below the threshold and opens at it, for a minute", () => {
    let state = afterSuccess()
    for (let i = 1; i < CIRCUIT_THRESHOLD; i += 1) state = afterFailure(state, t0)
    expect(state.circuitOpenUntil).toBeNull()
    const opened = afterFailure(state, t0)
    expect(opened.circuitOpenUntil).toEqual(at(60_000))
    expect(waitForCircuit(opened, at(30_000))).toEqual(at(60_000))
    expect(waitForCircuit(opened, at(60_000))).toBeNull()
  })

  it("doubles after each failed probe, to an hour, and a success closes it", () => {
    let state = afterSuccess()
    for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) state = afterFailure(state, t0)
    const second = afterFailure(state, t0)
    expect(second.circuitOpenUntil).toEqual(at(120_000))
    let long = second
    for (let i = 0; i < 20; i += 1) long = afterFailure(long, t0)
    expect(long.circuitOpenUntil).toEqual(at(CIRCUIT_MAX_OPEN_MS))
    expect(afterSuccess()).toEqual({ consecutiveFailures: 0, circuitOpenUntil: null, failingSince: null })
  })

  it("disables an endpoint that has failed for five days without a success", () => {
    const failing = afterFailure(afterSuccess(), t0)
    expect(failing.disable).toBe(false)
    expect(afterFailure(failing, at(4 * 24 * 3_600_000)).disable).toBe(false)
    expect(afterFailure(failing, at(5 * 24 * 3_600_000)).disable).toBe(true)
  })
})

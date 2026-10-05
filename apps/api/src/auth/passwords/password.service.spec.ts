import { describe, expect, it } from "vitest"

import { PasswordService } from "./password.service"

describe("PasswordService", () => {
  const service = new PasswordService()

  it("hashes with Argon2id and verifies the same password", async () => {
    const hashed = await service.hash("correct horse battery staple")
    expect(hashed.startsWith("$argon2id$")).toBe(true)
    expect(await service.verify(hashed, "correct horse battery staple")).toBe(true)
    expect(await service.verify(hashed, "Correct horse battery staple")).toBe(false)
  })

  it("salts, so two hashes of one password differ", async () => {
    expect(await service.hash("same")).not.toBe(await service.hash("same"))
  })

  it("answers false for an account with no hash, after paying for a verification", async () => {
    const start = process.hrtime.bigint()
    expect(await service.verify(null, "anything")).toBe(false)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    // Argon2id at these parameters is tens of milliseconds; a short-circuit is sub-millisecond.
    expect(elapsedMs).toBeGreaterThan(5)
  })

  it("answers false, not an exception, for a corrupt stored hash", async () => {
    expect(await service.verify("not-a-hash", "anything")).toBe(false)
  })
})

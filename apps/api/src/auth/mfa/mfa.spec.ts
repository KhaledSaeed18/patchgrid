import { describe, expect, it } from "vitest"

import { SecretBox } from "./secret-box"
import { acceptedStep, codeAt, newTotpSecret, otpauthUri, stepAt } from "./totp"

const KEY = Buffer.alloc(32, 7).toString("base64")

describe("the secret box", () => {
  it("opens what it sealed, and nothing tampered with or sealed under another key", () => {
    const box = new SecretBox(KEY)
    const sealed = box.seal("JBSWY3DPEHPK3PXP")
    expect(sealed).toMatch(/^v1\./)
    expect(box.open(sealed)).toBe("JBSWY3DPEHPK3PXP")
    expect(box.seal("same")).not.toBe(box.seal("same"))
    const [v, iv, tag, ct] = sealed.split(".")
    expect(box.open([v, iv, tag, `${ct ?? ""}A`].join("."))).toBeNull()
    expect(new SecretBox(Buffer.alloc(32, 8).toString("base64")).open(sealed)).toBeNull()
    expect(box.open("garbage")).toBeNull()
  })
})

describe("TOTP", () => {
  const secret = newTotpSecret()
  const now = new Date("2026-10-15T12:00:10Z")

  it("names the issuer and the account in its URI", () => {
    expect(otpauthUri(secret, "dana@patchgrid.test")).toMatch(/^otpauth:\/\/totp\/Patchgrid:dana%40patchgrid\.test\?.*secret=/)
  })

  it("accepts this step's code and one either side, never a code twice", () => {
    const code = codeAt(secret, now)
    const step = acceptedStep(secret, code, now, null)
    expect(step).toBe(stepAt(now))
    expect(acceptedStep(secret, codeAt(secret, new Date(now.getTime() - 30_000)), now, null)).toBe(stepAt(now) - 1)
    expect(acceptedStep(secret, code, now, step)).toBeNull()
    expect(acceptedStep(secret, codeAt(secret, new Date(now.getTime() - 120_000)), now, null)).toBeNull()
    expect(acceptedStep(secret, "000000", now, null) === null || codeAt(secret, now) === "000000").toBe(true)
  })
})

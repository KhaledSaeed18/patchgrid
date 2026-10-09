import { describe, expect, it } from "vitest"

import { newInvitationToken, parseInvitationToken } from "./invitation-token"

const ORG = "01929f5e-7a2b-7c3d-8e4f-a1b2c3d4e5f6"

describe("invitation tokens", () => {
  it("round-trip the org id, and carry a 256-bit secret", () => {
    const { token, secret } = newInvitationToken(ORG)
    expect(parseInvitationToken(token)).toEqual({ orgId: ORG, secret })
    expect(Buffer.from(secret, "base64url")).toHaveLength(32)
  })

  it("round-trip the extremes of the id space", () => {
    for (const orgId of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
      expect(parseInvitationToken(newInvitationToken(orgId).token)?.orgId).toBe(orgId)
    }
  })

  it("never issue the same secret twice", () => {
    expect(newInvitationToken(ORG).secret).not.toBe(newInvitationToken(ORG).secret)
  })

  it("refuse anything malformed rather than guessing", () => {
    const { token } = newInvitationToken(ORG)
    const [org = "", secret = ""] = token.split(".")
    for (const bad of [
      "",
      token.toUpperCase(),
      `${org}.${secret}x`,
      `${org}${secret}`,
      `${"z".repeat(25)}.${secret}`, // larger than 128 bits
      `${org}.${secret.slice(1)}=`,
    ]) {
      expect(parseInvitationToken(bad), bad).toBeNull()
    }
  })
})

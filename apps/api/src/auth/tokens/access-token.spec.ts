import { describe, expect, it } from "vitest"

import { accessCookieName, peekOrgClaim, refreshCookieName } from "./access-token"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (payload: unknown) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2ln`

describe("cookie names", () => {
  it("put the slug in the name, per tenant", () => {
    expect(accessCookieName("acme")).toBe("pg_at_acme")
    expect(refreshCookieName("acme")).toBe("pg_rt_acme")
  })
})

describe("peekOrgClaim", () => {
  it("reads the org claim from an unverified token", () => {
    expect(peekOrgClaim(jwt({ sub: "u", org: ORG, mem: "m" }))).toBe(ORG)
  })

  it.each([
    ["not a jwt", "nope"],
    ["two parts", "a.b"],
    ["four parts", "a.b.c.d"],
    ["payload is not json", `${b64({})}.not-json.sig`],
    ["payload is not an object", `${b64({})}.${b64("str")}.sig`],
    ["org missing", jwt({ sub: "u" })],
    ["org is not a uuid", jwt({ org: "acme" })],
  ])("returns null for %s", (_label, token) => {
    expect(peekOrgClaim(token)).toBeNull()
  })
})

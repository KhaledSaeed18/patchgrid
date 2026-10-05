import { describe, expect, it } from "vitest"

import type { OriginPolicy } from "../common/http/origin-policy"
import { assertedSlug, locateCredential } from "./credential-locator"

const policy: OriginPolicy = { rootDomain: "lvh.me", allowHttp: true, allowedPorts: [3000, 3001] }
const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (org: string) => `${b64({ alg: "HS256" })}.${b64({ org })}.c2ln`

describe("locateCredential — bearer", () => {
  it("takes the prefix from a well-formed token and ignores cookies", () => {
    const located = locateCredential(
      {
        authorization: "Bearer pg_abc123_s3cr3t-xyz",
        cookie: `pg_at_acme=${jwt(ORG)}`,
        origin: "http://acme.lvh.me:3001",
      },
      policy,
    )
    expect(located.credential).toEqual({ kind: "bearer", prefix: "abc123" })
    expect(located.assertion.origin).toEqual({ kind: "tenant", slug: "acme" })
  })

  it.each([
    ["wrong scheme", "Basic pg_abc_def"],
    ["no token", "Bearer"],
    ["two tokens", "Bearer pg_a_b pg_c_d"],
    ["not ours", "Bearer eyJhbGciOi.payload.sig"],
    ["no secret", "Bearer pg_abc"],
  ])("reports a malformed bearer for %s", (_label, authorization) => {
    expect(locateCredential({ authorization }, policy).credential).toEqual({
      kind: "bearer",
      prefix: null,
    })
  })
})

describe("locateCredential — cookie", () => {
  it("picks the cookie named by the Origin's slug and peeks its org claim", () => {
    const located = locateCredential(
      {
        cookie: `pg_at_globex=${jwt("0190b2f0-0000-7000-8000-00000000000b")}; pg_at_acme=${jwt(ORG)}; pg_id=x`,
        origin: "http://acme.lvh.me:3001",
      },
      policy,
    )
    expect(located.credential).toEqual({ kind: "cookie", slug: "acme", orgId: ORG })
  })

  it("picks the cookie named by X-Patchgrid-Tenant when Origin is absent", () => {
    const located = locateCredential(
      { cookie: `pg_at_acme=${jwt(ORG)}`, "x-patchgrid-tenant": " Acme " },
      policy,
    )
    expect(located.credential).toEqual({ kind: "cookie", slug: "acme", orgId: ORG })
    expect(located.assertion).toEqual({ origin: { kind: "absent" }, header: "acme" })
  })

  it("reports an unreadable claim as a cookie with no org", () => {
    const located = locateCredential(
      { cookie: "pg_at_acme=garbage", origin: "http://acme.lvh.me:3001" },
      policy,
    )
    expect(located.credential).toEqual({ kind: "cookie", slug: "acme", orgId: null })
  })

  it("never falls back to another tenant's cookie", () => {
    const located = locateCredential(
      { cookie: `pg_at_globex=${jwt(ORG)}`, origin: "http://acme.lvh.me:3001" },
      policy,
    )
    expect(located.credential).toEqual({ kind: "none" })
  })

  it("has no cookie to pick when nothing asserts a slug", () => {
    const located = locateCredential({ cookie: `pg_at_acme=${jwt(ORG)}` }, policy)
    expect(located.credential).toEqual({ kind: "none" })
    expect(located.assertion).toEqual({ origin: { kind: "absent" }, header: null })
  })

  it("classifies infrastructure and foreign origins", () => {
    expect(locateCredential({ origin: "http://app.lvh.me:3001" }, policy).assertion.origin).toEqual({
      kind: "infrastructure",
      label: "app",
    })
    expect(locateCredential({ origin: "https://evil.example" }, policy).assertion.origin).toEqual({
      kind: "foreign",
    })
  })
})

describe("assertedSlug", () => {
  it("is undefined with nothing asserted, null when Origin and header disagree", () => {
    expect(assertedSlug({ origin: { kind: "absent" }, header: null })).toBeUndefined()
    expect(assertedSlug({ origin: { kind: "infrastructure", label: "app" }, header: null })).toBeUndefined()
    expect(assertedSlug({ origin: { kind: "tenant", slug: "acme" }, header: "globex" })).toBeNull()
    expect(assertedSlug({ origin: { kind: "tenant", slug: "acme" }, header: "acme" })).toBe("acme")
    expect(assertedSlug({ origin: { kind: "absent" }, header: "acme" })).toBe("acme")
  })
})

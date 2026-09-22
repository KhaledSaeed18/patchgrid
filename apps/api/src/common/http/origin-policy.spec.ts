import { describe, expect, it } from "vitest"

import { isAllowedOrigin, type OriginPolicy } from "./origin-policy"

const prod: OriginPolicy = { rootDomain: "patchgrid.xyz", allowHttp: false, allowedPorts: [] }
const dev: OriginPolicy = { rootDomain: "lvh.me", allowHttp: true, allowedPorts: [3000, 3001] }

describe("isAllowedOrigin — production", () => {
  it.each([
    "https://patchgrid.xyz",
    "https://www.patchgrid.xyz",
    "https://app.patchgrid.xyz",
    "https://admin.patchgrid.xyz",
    "https://acme.patchgrid.xyz",
    "https://globex-industries.patchgrid.xyz",
  ])("allows %s", (origin) => {
    expect(isAllowedOrigin(origin, prod)).toBe(true)
  })

  it.each([
    ["http://acme.patchgrid.xyz", "plain http in production"],
    ["https://acme.patchgrid.xyz.evil.com", "suffix smuggling — the dangerous one"],
    ["https://notpatchgrid.xyz", "domain that merely ends with the same letters"],
    ["https://evil.com", "unrelated origin"],
    ["https://a.b.patchgrid.xyz", "two labels — not a tenant, and the wildcard cert would not cover it"],
    ["https://patchgrid.xyz.evil.com", "root as a prefix of something else"],
    ["https://ac--me.patchgrid.xyz", "label that is not a valid slug"],
    ["https://-acme.patchgrid.xyz", "leading hyphen"],
    ["https://ab.patchgrid.xyz", "label below the slug minimum"],
    ["https://acme.patchgrid.xyz:8443", "unexpected port"],
    ["https://acme.patchgrid.xyz/path", "not an origin — carries a path"],
    ["https://user:pw@acme.patchgrid.xyz", "embedded credentials"],
    ["null", "sandboxed iframe"],
    ["", "empty"],
    ["not a url", "garbage"],
  ])("rejects %s (%s)", (origin) => {
    expect(isAllowedOrigin(origin, prod)).toBe(false)
  })

  it("is case-insensitive about the host, as DNS is", () => {
    expect(isAllowedOrigin("https://ACME.PatchGrid.xyz", prod)).toBe(true)
  })
})

describe("isAllowedOrigin — development", () => {
  it.each([
    "http://lvh.me:3000",
    "http://app.lvh.me:3001",
    "http://acme.lvh.me:3001",
    "http://globex.lvh.me:3000",
  ])("allows %s", (origin) => {
    expect(isAllowedOrigin(origin, dev)).toBe(true)
  })

  it.each([
    ["http://acme.lvh.me:9999", "port outside the allow-list"],
    ["http://acme.lvh.me", "no port, where ports are expected"],
    ["http://acme.evil.me:3001", "right port, wrong domain"],
  ])("rejects %s (%s)", (origin) => {
    expect(isAllowedOrigin(origin, dev)).toBe(false)
  })

  it("does not leak the development policy into production", () => {
    expect(isAllowedOrigin("http://acme.lvh.me:3001", prod)).toBe(false)
  })
})
